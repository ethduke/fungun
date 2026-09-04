import assert from "node:assert/strict";
import test from "node:test";
import { FeeRpc } from "./fee-rpc.mjs";
import { ServiceError } from "./errors.mjs";

const calls = [
  { method: "eth_blockNumber", params: [] },
  { method: "eth_gasPrice", params: [] },
];
const config = (rpcBatchRequests) => ({
  rpcUrl: "<ROBINHOOD_RPC_URL>",
  baseRpcUrl: "<BASE_RPC_URL>",
  rpcBatchRequests,
});

test("default RPC transport keeps one charged batch and restores response order", async () => {
  for (const setting of [undefined, true]) {
    let requests = 0;
    const rpc = new FeeRpc(config(setting), {
      async json(provider, url, request, bytes, units) {
        requests++;
        assert.equal(provider, "rpc");
        assert.equal(url, config().rpcUrl);
        assert.equal(bytes, 256 * 1024);
        assert.equal(units, calls.length);
        const body = JSON.parse(request.body);
        assert.deepEqual(
          body,
          calls.map((call, id) => ({ jsonrpc: "2.0", id, ...call })),
        );
        return body.map(({ id }) => ({ jsonrpc: "2.0", id, result: `0x${id + 1}` })).reverse();
      },
    });
    assert.deepEqual(await rpc.batch(4663, calls), ["0x1", "0x2"]);
    assert.equal(requests, 1);
  }
});

test("individual RPC reads stay sequential, charge each request and retain chain and ID binding", async () => {
  for (const chainId of [4663, 8453]) {
    const requests = [];
    let active = 0;
    const rpc = new FeeRpc(config(false), {
      async json(provider, url, request, bytes, units) {
        assert.equal(++active, 1);
        assert.equal(provider, "rpc");
        assert.equal(url, chainId === 4663 ? config().rpcUrl : config().baseRpcUrl);
        assert.equal(request.method, "POST");
        assert.equal(request.headers["content-type"], "application/json");
        assert.equal(bytes, 256 * 1024);
        assert.equal(units, 1);
        const body = JSON.parse(request.body);
        assert.ok(!Array.isArray(body));
        requests.push(body);
        await Promise.resolve();
        assert.equal(active--, 1);
        return { jsonrpc: "2.0", id: body.id, result: `0x${body.id + 1}` };
      },
    });
    assert.deepEqual(await rpc.batch(chainId, calls), ["0x1", "0x2"]);
    assert.deepEqual(
      requests,
      calls.map((call, id) => ({ jsonrpc: "2.0", id, ...call })),
    );
  }
});

test("individual RPC responses reject malformed identity and stop before another request", async () => {
  for (const response of [
    null,
    [],
    [{ jsonrpc: "2.0", id: 0, result: "0x1" }],
    { jsonrpc: "2.0", id: 1, result: "0x1" },
    { jsonrpc: "2.0", id: "0", result: "0x1" },
    { jsonrpc: "1.0", id: 0, result: "0x1" },
    { jsonrpc: "2.0", id: 0 },
  ]) {
    let requests = 0;
    const rpc = new FeeRpc(config(false), {
      async json() {
        requests++;
        return response;
      },
    });
    await assert.rejects(rpc.batch(4663, calls), { code: "invalid_response" });
    assert.equal(requests, 1);
  }
  let requests = 0;
  const rpc = new FeeRpc(config(false), {
    async json() {
      requests++;
      return { jsonrpc: "2.0", id: 0, result: "0x1" };
    },
  });
  await assert.rejects(rpc.batch(4663, calls), { code: "invalid_response" });
  assert.equal(requests, 2);
});

test("provider failures never retry or switch RPC transport and hide provider error details", async () => {
  for (const batching of [false, true]) {
    for (const mode of ["revert", "network", "quota"]) {
      let requests = 0;
      const rpc = new FeeRpc(config(batching), {
        async json(_provider, _url, request) {
          requests++;
          assert.equal(Array.isArray(JSON.parse(request.body)), batching);
          if (mode === "network") throw new ServiceError("unavailable");
          if (mode === "quota") throw new ServiceError("rate_limited", 429, 5);
          const response = {
            jsonrpc: "2.0",
            id: 0,
            error: {
              code: 3,
              message: "execution reverted: confidential provider detail",
            },
          };
          return batching ? [response] : response;
        },
      });
      await assert.rejects(rpc.batch(4663, calls.slice(0, 1)), (error) => {
        assert.equal(
          error.code,
          mode === "revert" ? "reverted" : mode === "quota" ? "rate_limited" : "unavailable",
        );
        assert.ok(!error.message.includes("confidential"));
        return true;
      });
      assert.equal(requests, 1);
    }
  }
});

test("both RPC transports reject writes and oversized work before sending anything", async () => {
  for (const batching of [false, true]) {
    let requests = 0;
    const rpc = new FeeRpc(config(batching), {
      async json() {
        requests++;
      },
    });
    for (const invalid of [
      [],
      Array.from({ length: 13 }, () => calls[0]),
      [{ method: "eth_sendTransaction", params: [] }],
      [{ method: "eth_sendRawTransaction", params: ["0x"] }],
    ])
      await assert.rejects(rpc.batch(4663, invalid), { code: "invalid_request" });
    await assert.rejects(rpc.batch(1, calls), { code: "invalid_request" });
    assert.equal(requests, 0);
  }
});
