import assert from "node:assert/strict";
import test from "node:test";
import { FeeRpc } from "./fee-rpc.mjs";
import { ServiceError } from "./errors.mjs";
import { Upstream } from "./upstream.mjs";

const calls = [
  { method: "eth_blockNumber", params: [] },
  { method: "eth_gasPrice", params: [] },
];
const config = (rpcBatchRequests) => ({
  rpcUrl: "<ROBINHOOD_RPC_URL>",
  baseRpcUrl: "<BASE_RPC_URL>",
  rpcBatchRequests,
});
const readPolicy = { queue: true, retry: true, parallel: true };

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

test("individual RPC reads use two workers, charge each request and retain chain and ID binding", async () => {
  for (const chainId of [4663, 8453]) {
    const requests = [];
    let active = 0;
    let peak = 0;
    const rpc = new FeeRpc(
      config(false),
      {
        async json(provider, url, request, bytes, units) {
          peak = Math.max(peak, ++active);
          assert.ok(active <= 2);
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
          active--;
          return { jsonrpc: "2.0", id: body.id, result: `0x${body.id + 1}` };
        },
      },
      Date.now,
      readPolicy,
    );
    assert.deepEqual(await rpc.batch(chainId, calls), ["0x1", "0x2"]);
    assert.equal(peak, 2);
    assert.deepEqual(
      requests,
      calls.map((call, id) => ({ jsonrpc: "2.0", id, ...call })),
    );
  }
});

test("individual RPC responses reject malformed identity and stop before further work", async () => {
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
    const rpc = new FeeRpc(
      config(false),
      {
        async json() {
          requests++;
          return response;
        },
      },
      Date.now,
      readPolicy,
    );
    await assert.rejects(rpc.batch(4663, [...calls, ...calls]), { code: "invalid_response" });
    assert.equal(requests, 2);
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

test("RPC errors never replay batches or switch transport and hide provider error details", async () => {
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

test("parallel fee pages share RPC admission and retry only the failed individual read", async () => {
  const counts = new Map();
  let active = 0;
  let peak = 0;
  let debits = 0;
  const upstream = new Upstream(
    {
      upstream(provider, units) {
        assert.equal(provider, "rpc");
        debits += units;
      },
    },
    async (_url, request) => {
      const body = JSON.parse(request.body);
      const key = body.params[0];
      counts.set(key, (counts.get(key) ?? 0) + 1);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      if (key === "a2" && counts.get(key) === 1) return new Response(null, { status: 503 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: key });
    },
  );
  const rpc = new FeeRpc(config(false), upstream, Date.now, readPolicy);
  const page = (prefix) =>
    Array.from({ length: 4 }, (_, i) => ({ method: "eth_call", params: [`${prefix}${i}`] }));
  const results = await Promise.all([rpc.batch(4663, page("a")), rpc.batch(4663, page("b"))]);
  assert.deepEqual(results, [
    ["a0", "a1", "a2", "a3"],
    ["b0", "b1", "b2", "b3"],
  ]);
  assert.equal(peak, 2);
  assert.equal(debits, 9);
  assert.equal(counts.get("a2"), 2);
  assert.ok([...counts].filter(([key]) => key !== "a2").every(([, count]) => count === 1));
  assert.equal(upstream.active, 0);
  assert.equal(upstream.waiting.size, 0);
});

test("a transient batch transport failure retries the same batch with all units charged", async () => {
  let attempts = 0;
  let debits = 0;
  const upstream = new Upstream(
    {
      upstream(_provider, units) {
        debits += units;
      },
    },
    async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.equal(body.length, 2);
      if (++attempts === 1) throw new TypeError("fetch failed with confidential URL");
      return Response.json(body.map(({ id }) => ({ jsonrpc: "2.0", id, result: `0x${id + 1}` })));
    },
  );
  assert.deepEqual(
    await new FeeRpc(config(true), upstream, Date.now, readPolicy).batch(4663, calls),
    ["0x1", "0x2"],
  );
  assert.equal(attempts, 2);
  assert.equal(debits, 4);
});

test("other RPC readers retain sequential transport without retry or queue opt-in", async () => {
  let active = 0;
  let count = 0;
  const rpc = new FeeRpc(config(false), {
    async json(_provider, _url, request, _bytes, _units, policy) {
      assert.deepEqual(policy, {});
      assert.equal(++active, 1);
      await Promise.resolve();
      active--;
      count++;
      return { jsonrpc: "2.0", id: JSON.parse(request.body).id, result: "0x1" };
    },
  });
  await rpc.batch(4663, calls);
  assert.equal(count, 2);
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
