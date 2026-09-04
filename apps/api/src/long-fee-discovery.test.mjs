import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, toHex, zeroAddress } from "viem";
import { poolId } from "./fee-contracts.mjs";
import { ServiceError } from "./errors.mjs";
import { discoverLongFeePools, longDiscoveryAbi } from "./long-fee-discovery.mjs";

const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const owner = address(101);
const stranger = address(102);
const manager = address(103);
const hook = address(104);
const profile = () => ({ manager, hook, discovery: { fromBlock: 100, blockRange: 10 } });
const pool = (asset = address(1)) => ({ asset, currency0: { address: asset }, currency1: { address: address(99) }, fee: 8388608, tickSpacing: 10 });
const key = (p) => ({ currency0: p.currency0.address, currency1: p.currency1.address, fee: p.fee, tickSpacing: p.tickSpacing, hooks: manager });
const lock = (asset, index = 0, beneficiary = owner) => ({
  address: manager, removed: false, blockNumber: "0x64", blockHash: hash(1), transactionHash: hash(2), logIndex: toHex(index),
  topics: encodeEventTopics({ abi: longDiscoveryAbi, eventName: "Lock", args: { pool: asset } }),
  data: encodeAbiParameters(parseAbiParameters("(address beneficiary,uint96 shares)[] beneficiaries"), [[{ beneficiary, shares: 10n ** 18n }]]),
});
const transfer = (p, beneficiary = owner) => ({
  address: manager, removed: false, blockNumber: "0x64", blockHash: hash(1), transactionHash: hash(2), logIndex: "0x9",
  topics: encodeEventTopics({ abi: longDiscoveryAbi, eventName: "UpdateBeneficiary" }),
  data: encodeAbiParameters(parseAbiParameters("bytes32,address,address"), [poolId(p, manager), stranger, beneficiary]),
});

function fixture(logs, options = {}) {
  const pools = options.pools ?? [pool()];
  const requests = [];
  const metadataRequests = [];
  const rpc = {
    async batch(chainId, calls) {
      assert.equal(chainId, 4663);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, "eth_getLogs");
      const filter = calls[0].params[0];
      assert.equal(filter.address, manager);
      requests.push(filter);
      if (options.error) throw options.error;
      return [typeof logs === "function" ? logs(filter) : logs];
    },
    async calls(chainId, calls, block) {
      assert.equal(chainId, 4663);
      assert.equal(block, options.block ?? "0x6d");
      if (calls.some((call) => call.functionName === "symbol")) metadataRequests.push(calls);
      return calls.map((call) => {
        if (["getState", "getShares", "getPoolKey"].includes(call.functionName)) assert.equal(call.address, manager);
        if (call.functionName === "getState") {
          const p = pools.find((p) => p.asset === call.args[0]);
          return p ? [p.currency0.address === p.asset ? p.currency1.address : p.currency0.address, 0n, options.hook ?? hook, "0x", options.status ?? 2, key(p), 0] : [zeroAddress, 0n, zeroAddress, "0x", 0, {}, 0];
        }
        if (call.functionName === "getPoolKey") {
          const p = pools.find((p) => poolId(p, manager) === call.args[0]);
          return Object.values(key(p));
        }
        if (call.functionName === "getShares") {
          assert.equal(call.args[1], options.owner ?? owner);
          return options.shares ?? 10n ** 18n;
        }
        if (call.functionName === "symbol") return options.symbol ?? "COIN";
        if (call.functionName === "decimals") return options.decimals ?? 18;
        assert.fail(`Unexpected read ${call.functionName}`);
      });
    },
  };
  return { rpc, requests, metadataRequests };
}

test("discovers only beneficiary locks, verifies live ownership, and reads exact pool currency metadata", async () => {
  const { rpc, requests, metadataRequests } = fixture([lock(address(1)), lock(address(2), 1, stranger)]);
  const result = await discoverLongFeePools(rpc, profile(), owner, "0x6d");
  assert.equal(result.pools.length, 1);
  assert.equal(result.pools[0].asset, address(1));
  assert.deepEqual(result.pools[0].currency0, { address: address(1), symbol: "COIN", decimals: 18 });
  assert.equal(result.nextState, null);
  assert.equal(result.partial, false);
  assert.deepEqual(result.progress, { scannedThroughBlock: "109", toBlock: "109" });
  assert.equal(requests[0].fromBlock, "0x64");
  assert.equal(requests[0].toBlock, "0x6d");
  assert.equal(requests[0].topics[0].length, 2);
  assert.equal(metadataRequests.length, 1);
  assert.equal(metadataRequests[0].length, 4);
});

test("native currency stays ETH/18 while only the ERC20 metadata is fetched", async () => {
  const p = { ...pool(), currency0: { address: zeroAddress }, currency1: { address: address(1) } };
  const { rpc, metadataRequests } = fixture([lock(p.asset)], { pools: [p], decimals: 6 });
  const result = await discoverLongFeePools(rpc, profile(), owner, "0x6d");
  assert.deepEqual(result.pools[0].currency0, { address: zeroAddress, symbol: "ETH", decimals: 18 });
  assert.equal(result.pools[0].currency1.decimals, 6);
  assert.equal(metadataRequests.length, 1);
  assert.equal(metadataRequests[0].length, 2);
  assert.ok(metadataRequests[0].every((call) => call.address === p.asset));
});

test("finds transferred fee rights even when wallet was not an initial beneficiary", async () => {
  const p = pool();
  const { rpc } = fixture([transfer(p)]);
  const result = await discoverLongFeePools(rpc, profile(), owner, "0x6d");
  assert.equal(result.pools[0].asset, p.asset);
});

test("continues all candidates from a dense matching page without rescanning logs", async () => {
  const pools = [1, 2, 3, 4, 5].map((n) => pool(address(n)));
  const { rpc, requests } = fixture(pools.map((p, i) => lock(p.asset, i)), { pools });
  let state;
  const found = [];
  for (let i = 0; i < 3; i++) {
    const page = await discoverLongFeePools(rpc, profile(), owner, "0x6d", state);
    assert.ok(page.pools.length <= 2);
    found.push(...page.pools.map((p) => p.asset));
    state = page.nextState;
  }
  assert.deepEqual(found, pools.map((p) => p.asset));
  assert.equal(state, null);
  assert.equal(requests.length, 1);
});

test("empty windows advance to the pinned snapshot and share cached logs across wallets", async () => {
  const { rpc, requests } = fixture([], { block: "0x79" });
  let page = await discoverLongFeePools(rpc, profile(), owner, "0x79");
  await discoverLongFeePools(rpc, profile(), stranger, "0x79");
  assert.equal(requests.length, 1);
  assert.equal(page.nextState.nextBlock, "110");
  page = await discoverLongFeePools(rpc, profile(), owner, "0x79", page.nextState);
  assert.equal(page.nextState.nextBlock, "120");
  page = await discoverLongFeePools(rpc, profile(), owner, "0x79", page.nextState);
  assert.equal(page.nextState, null);
  assert.equal(requests.at(-1).toBlock, "0x79");
});

test("transferred-away shares yield no claimable pool and unsupported states stay partial", async () => {
  let runtime = fixture([lock(address(1))], { shares: 0n });
  assert.deepEqual((await discoverLongFeePools(runtime.rpc, profile(), owner, "0x6d")).pools, []);
  for (const options of [{ hook: stranger }, { status: 3 }]) {
    runtime = fixture([lock(address(1))], options);
    const result = await discoverLongFeePools(runtime.rpc, profile(), owner, "0x6d");
    assert.deepEqual(result.pools, []);
    assert.equal(result.partial, true);
  }
});

test("malformed, removed, wrong-contract and out-of-range events fail closed", async () => {
  for (const change of [{ removed: true }, { address: stranger }, { blockNumber: "0x63" }, { topics: [hash(99)] }, { data: "0x00" }]) {
    const { rpc } = fixture([{ ...lock(address(1)), ...change }]);
    await assert.rejects(discoverLongFeePools(rpc, profile(), owner, "0x6d"), { code: "invalid_response" });
  }
});

test("deduplicates repeated logs but rejects contradictory duplicate identities", async () => {
  let runtime = fixture([lock(address(1)), lock(address(1))]);
  assert.equal((await discoverLongFeePools(runtime.rpc, profile(), owner, "0x6d")).pools.length, 1);
  runtime = fixture([lock(address(1)), lock(address(2))]);
  await assert.rejects(discoverLongFeePools(runtime.rpc, profile(), owner, "0x6d"), { code: "invalid_response" });
});

test("dense or provider-limited ranges shrink without skipping failed blocks", async () => {
  for (const runtime of [fixture(Array.from({ length: 257 }, (_, i) => lock(address(1), i))), fixture([], { error: new ServiceError("upstream_unavailable") })]) {
    const page = await discoverLongFeePools(runtime.rpc, profile(), owner, "0x6d");
    assert.equal(page.nextState.blockRange, 5);
    assert.equal(page.nextState.nextBlock, "100");
    assert.equal(page.progress.scannedThroughBlock, null);
    assert.deepEqual(page.pools, []);
  }
  const runtime = fixture([], { error: new ServiceError("rate_limited", 429, 10) });
  await assert.rejects(discoverLongFeePools(runtime.rpc, profile(), owner, "0x6d"), { code: "rate_limited" });
});

test("unknown decimals and spoofable symbol content cannot become trusted fee payouts", async () => {
  for (const options of [{ decimals: 255 }, { symbol: "<script>" }, { shares: 10n ** 18n + 1n }]) {
    const { rpc } = fixture([lock(address(1))], options);
    await assert.rejects(discoverLongFeePools(rpc, profile(), owner, "0x6d"), { code: "invalid_response" });
  }
});
