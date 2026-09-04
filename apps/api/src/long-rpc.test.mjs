import assert from "node:assert/strict";
import test from "node:test";
import { LongRpc } from "./long-rpc.mjs";
import { Upstream } from "./upstream.mjs";

const txHash = `0x${"ab".repeat(32)}`;
const config = {
  rpcUrl: "https://rpc.example.invalid",
  baseRpcUrl: "https://base-rpc.example.invalid",
  rpcBatchRequests: true,
};
const extraCalls = [
  { method: "eth_getTransactionByHash", params: [txHash] },
  { method: "eth_getTransactionReceipt", params: [txHash] },
  { method: "eth_getBlockByNumber", params: ["0x10", false] },
];

function fixture(fetcher) {
  let debits = 0;
  const upstream = new Upstream(
    {
      upstream(provider, units) {
        assert.equal(provider, "rpc");
        debits += units;
      },
    },
    fetcher,
  );
  return { rpc: new LongRpc(config, upstream), debits: () => debits };
}

test("Long RPC transaction reads use fixed bounded JSON-RPC requests", async () => {
  const requests = [];
  const f = fixture(async (url, options) => {
    assert.equal(url, config.rpcUrl);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["content-type"], "application/json");
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    requests.push(body);
    assert.deepEqual(Object.keys(body).sort(), ["id", "jsonrpc", "method", "params"]);
    return Response.json({ jsonrpc: "2.0", id: 1, result: body.method });
  });
  assert.deepEqual(await f.rpc.batch(4663, extraCalls), extraCalls.map(({ method }) => method));
  assert.deepEqual(requests, extraCalls.map((call) => ({ jsonrpc: "2.0", id: 1, ...call })));
  assert.equal(f.debits(), 3);
});

test("Long RPC rejects unapproved chains, methods, shapes and oversized batches before fetch", async () => {
  let requests = 0;
  const f = fixture(async () => {
    requests++;
    return Response.json({ jsonrpc: "2.0", id: 1, result: null });
  });
  const invalid = [
    [8453, extraCalls.slice(0, 1)],
    [4663, Array.from({ length: 13 }, () => extraCalls[0])],
    [4663, [extraCalls[0], { method: "eth_sendRawTransaction", params: ["0x"] }]],
    [4663, [{ ...extraCalls[0], id: 7 }]],
    [4663, [extraCalls[0], null]],
    [4663, [{ method: "eth_getTransactionByHash", params: ["0x1234"] }]],
    [4663, [{ method: "eth_getTransactionReceipt", params: [] }]],
    [4663, [{ method: "eth_getBlockByNumber", params: ["pending", false] }]],
    [4663, [{ method: "eth_getBlockByNumber", params: ["0x10", "false"] }]],
  ];
  for (const [chainId, calls] of invalid)
    await assert.rejects(f.rpc.batch(chainId, calls), { code: "invalid_request", status: 400 });
  assert.equal(requests, 0);
  assert.equal(f.debits(), 0);
});

test("Long RPC retains inherited read-only methods and chain routing", async () => {
  const seen = [];
  const f = fixture(async (url, options) => {
    seen.push([url, JSON.parse(options.body)]);
    return Response.json([{ jsonrpc: "2.0", id: 0, result: "0x10" }]);
  });
  assert.deepEqual(
    await f.rpc.batch(8453, [{ method: "eth_blockNumber", params: [] }]),
    ["0x10"],
  );
  assert.deepEqual(seen, [[config.baseRpcUrl, [{ jsonrpc: "2.0", id: 0, method: "eth_blockNumber", params: [] }]]]);
  assert.equal(f.debits(), 1);
});

test("Long RPC rejects malformed response identity and provider errors without leaking details", async () => {
  for (const body of [
    null,
    [],
    { jsonrpc: "1.0", id: 1, result: null },
    { jsonrpc: "2.0", id: 0, result: null },
    { jsonrpc: "2.0", id: 1 },
  ]) {
    const f = fixture(async () => Response.json(body));
    await assert.rejects(f.rpc.batch(4663, extraCalls.slice(0, 1)), { code: "invalid_response" });
    assert.equal(f.debits(), 1);
  }
  const f = fixture(async () => Response.json({
    jsonrpc: "2.0",
    id: 1,
    error: { code: 3, message: "execution reverted: confidential provider detail" },
  }));
  await assert.rejects(f.rpc.batch(4663, extraCalls.slice(0, 1)), (error) => {
    assert.equal(error.code, "reverted");
    assert.ok(!error.message.includes("confidential"));
    return true;
  });
  assert.equal(f.debits(), 1);
});

test("Long RPC bounds transport bodies, rate limits and retries", async () => {
  let requests = 0;
  let f = fixture(async () => {
    requests++;
    return Response.json({ jsonrpc: "2.0", id: 1, result: "a".repeat(300 * 1024) });
  });
  await assert.rejects(f.rpc.batch(4663, extraCalls.slice(0, 1)), { code: "upstream_unavailable" });
  assert.equal(requests, 1);
  assert.equal(f.debits(), 1);

  requests = 0;
  f = fixture(async () => {
    requests++;
    return Response.json({ error: "limited" }, { status: 429, headers: { "retry-after": "999999" } });
  });
  await assert.rejects(f.rpc.batch(4663, extraCalls.slice(0, 1)), (error) => {
    assert.equal(error.code, "rate_limited");
    assert.equal(error.status, 429);
    assert.equal(error.retryAfter, 86400);
    assert.equal(error.retryScope, "operation");
    return true;
  });
  assert.equal(requests, 1);
  assert.equal(f.debits(), 1);
});
