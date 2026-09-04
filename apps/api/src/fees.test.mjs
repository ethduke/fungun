import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex } from "viem";
import { readConfig } from "./config.mjs";
import {
  beneficiaryFees,
  escrowAbi,
  managerAbi,
  oracleAbi,
  readFeeContracts,
} from "./fee-contracts.mjs";
import { Fees, parseO1Positions } from "./fees.mjs";
import { FeeRpc } from "./fee-rpc.mjs";
import { Budget } from "./budget.mjs";
import { validateInput } from "./service.mjs";

const address = (digit) => `0x${digit.repeat(40)}`;
const owner = address("a");
const bytecode = "0x60016000";
const codeHash = keccak256(bytecode);
const pool = {
  asset: address("1"),
  currency0: { address: address("1"), symbol: "TEST", decimals: 18 },
  currency1: { address: address("2"), symbol: "PAIR", decimals: 6 },
  fee: 3000,
  tickSpacing: 60,
};
const contracts = () => ({
  long: {
    manager: address("3"),
    managerCodeHash: codeHash,
    hook: address("4"),
    hookCodeHash: codeHash,
    pools: [pool],
  },
  o1: [{ chainId: 8453, escrow: address("5"), codeHash }],
  baseOracle: {
    address: address("6"),
    codeHash,
    implementation: address("7"),
    implementationCodeHash: codeHash,
  },
});
const config = () => ({
  ...readConfig({}),
  feesEnabled: true,
  claimsEnabled: true,
  o1Key: "EXAMPLE",
  rpcUrl: "EXAMPLE",
  baseRpcUrl: "EXAMPLE",
  feeContracts: readFeeContracts(JSON.stringify(contracts())),
});
const indexed = (overrides = {}) => ({
  chain_id: 8453,
  recipient: owner,
  fee_escrow_address: address("5"),
  currency: { address: address("1"), quote: pool.currency0 },
  claimable_raw: "100",
  reconciliation: "confirmed",
  ...overrides,
});
const body = (entries = [indexed()], more = false) => ({
  data: entries,
  pagination: { has_more: more },
});

function mockRuntime(options = {}) {
  let now = 1000;
  const budget = new Budget(":memory:", () => now);
  let calls = 0;
  const upstream = {
    async json(provider, _url, request, _bytes, units) {
      budget.upstream(provider, units);
      calls += units;
      if (provider === "o1") {
        const chainId = Number(_url.searchParams.get("chain_id"));
        assert.equal(_url.searchParams.get("limit"), "25");
        return body([indexed({ chain_id: chainId })], true);
      }
      const chainId = options.chainId ?? 4663;
      return JSON.parse(request.body).map((call) => {
        let result;
        if (call.method === "eth_chainId") result = toHex(chainId);
        else if (call.method === "eth_getCode") result = options.changedCode ? "0x6000" : bytecode;
        else if (call.method === "eth_getStorageAt")
          result = toHex(BigInt(address(options.changedImplementation ? "8" : "7")), { size: 32 });
        else if (call.method === "eth_blockNumber") result = "0x123";
        else if (call.method === "eth_estimateGas") result = options.gas ?? toHex(100_000);
        else if (call.method === "eth_gasPrice") result = toHex(1000);
        else if (call.method === "eth_getBalance") result = toHex(options.balance ?? 10n ** 18n);
        else if (call.method === "eth_getTransactionCount") result = "0x0";
        else if (call.method === "eth_call") {
          const abi = [...managerAbi, ...escrowAbi, ...oracleAbi];
          const { functionName, args } = decodeFunctionData({ abi, data: call.params[0].data });
          const values = {
            getState: [
              pool.currency1.address,
              1n,
              options.changedHook ? address("8") : address("4"),
              "0x",
              2,
              {
                currency0: pool.currency0.address,
                currency1: pool.currency1.address,
                fee: pool.fee,
                tickSpacing: pool.tickSpacing,
                hooks: address("3"),
              },
              1,
            ],
            getShares: options.shares ?? 5n * 10n ** 17n,
            getCumulatedFees0: 100n,
            getCumulatedFees1: 200n,
            getLastCumulatedFees0: 10n,
            getLastCumulatedFees1: 20n,
            collectFees: [10n, 20n],
            owed: options.owed ?? 150n,
            getL1Fee: 12n,
            getOperatorFee: args[0] === 100_000n ? 3n : 4n,
            claimFor: undefined,
          };
          if (
            (functionName.startsWith("get") &&
              !["getL1Fee", "getOperatorFee"].includes(functionName)) ||
            functionName === "owed"
          )
            assert.equal(call.params[1], "0x123");
          if (functionName === "collectFees") assert.equal(call.params[0].from, owner);
          result = encodeFunctionResult({ abi, functionName, result: values[functionName] });
        } else throw new Error("Unexpected method");
        return { jsonrpc: "2.0", id: call.id, result };
      });
    },
  };
  return {
    service: new Fees(config(), upstream, () => now),
    upstream,
    budget,
    advance: () => {
      now += 61_000;
    },
    calls: () => calls,
  };
}

test("configuration and fee inputs reject arbitrary targets, methods and unsupported claim profiles", () => {
  assert.deepEqual(readFeeContracts(), { o1: [], long: undefined, baseOracle: undefined });
  assert.throws(() =>
    readFeeContracts(JSON.stringify({ o1: [{ ...contracts().o1[0], chainId: 4663 }] })),
  );
  assert.throws(() =>
    readFeeContracts(JSON.stringify({ baseOracle: { address: address("6"), codeHash } })),
  );
  assert.throws(() => validateInput("fees", { address: owner, chainId: 8453, padId: "long" }));
  assert.throws(() =>
    validateInput("claim-prepare", { address: owner, positionId: "a".repeat(64), to: owner }),
  );
  assert.throws(() =>
    validateInput("claim-prepare", { address: owner, positionId: "https://example.invalid" }),
  );
});

test("O1 selects metadata by currency identity and deduplicates shared escrow positions", () => {
  const item = indexed({
    currency: {
      address: address("1"),
      quote: pool.currency1,
      token: { ...pool.currency0, chain_id: 8453 },
    },
  });
  assert.equal(parseO1Positions(body([item, item]), owner, 8453).positions.length, 1);
  for (const invalid of [
    indexed({ recipient: address("b") }),
    indexed({ claimable_raw: "-1" }),
    indexed({ currency: { address: address("1") } }),
    indexed({
      currency: {
        address: address("1"),
        quote: pool.currency0,
        token: { ...pool.currency0, decimals: 6 },
      },
    }),
  ])
    assert.throws(() => parseO1Positions(body([invalid]), owner, 8453));
  assert.throws(() =>
    parseO1Positions(body([indexed(), indexed({ claimable_raw: "1" })]), owner, 8453),
  );
});

test("beneficiary math includes accrued fees, rounds down and rejects impossible checkpoints", () => {
  assert.equal(beneficiaryFees(100n, 10n, 10n, 5n * 10n ** 17n), 50n);
  assert.equal(beneficiaryFees(1n, 0n, 0n, 1n), 0n);
  assert.throws(() => beneficiaryFees(0n, 0n, 1n, 1n));
  assert.throws(() => beneficiaryFees(1n, 0n, 0n, 10n ** 18n + 1n));
  assert.throws(() => beneficiaryFees((1n << 256n) - 1n, 0n, 0n, 10n ** 18n));
});

test("cold Long reads and wallet preflight fit the durable burst allowance, coalesce and encode only collectFees", async (t) => {
  const runtime = mockRuntime();
  t.after(() => runtime.budget.close());
  const input = { address: owner, chainId: 4663, padId: "long" };
  const results = await Promise.all(Array.from({ length: 10 }, () => runtime.service.list(input)));
  assert.equal(runtime.calls(), 11);
  const result = results[0];
  assert.equal(result.status, "partial");
  assert.equal(result.positions[0].payouts[0].claimableRaw, "50");
  const positionId = result.positions[0].id;
  await assert.rejects(runtime.service.prepare({ address: address("b"), positionId }), {
    code: "quote_expired",
  });
  const quote = await runtime.service.prepare({ address: owner, positionId });
  assert.equal(quote.value, "0");
  assert.equal(quote.gas, "120000");
  assert.equal(quote.estimatedWei, "100000000");
  assert.equal(
    decodeFunctionData({ abi: managerAbi, data: quote.data }).functionName,
    "collectFees",
  );
  assert.equal(runtime.calls(), 25);
  await runtime.service.prepare({ address: owner, positionId });
  assert.equal(runtime.calls(), 25);
  runtime.advance();
  runtime.advance();
  await assert.rejects(runtime.service.prepare({ address: owner, positionId }), {
    code: "quote_expired",
  });
});

test("transferred Long shares and wrong hook fail closed", async (t) => {
  const options = {};
  const runtime = mockRuntime(options);
  t.after(() => runtime.budget.close());
  const result = await runtime.service.list({ address: owner, chainId: 4663, padId: "long" });
  options.shares = 0n;
  await assert.rejects(
    runtime.service.prepare({ address: owner, positionId: result.positions[0].id }),
    { code: "nothing_to_claim" },
  );
  runtime.advance();
  options.changedHook = true;
  await assert.rejects(runtime.service.list({ address: owner, chainId: 4663, padId: "long" }), {
    code: "contract_unverified",
  });
});

test("Base escrow uses live owed and requires complete execution, L1 and operator fee estimates", async (t) => {
  const runtime = mockRuntime({ chainId: 8453 });
  t.after(() => runtime.budget.close());
  const result = await runtime.service.list({ address: owner, chainId: 8453, padId: "o1" });
  assert.equal(result.positions[0].payouts[0].claimableRaw, "150");
  const quote = await runtime.service.prepare({
    address: owner,
    positionId: result.positions[0].id,
  });
  assert.equal(quote.l1FeeWei, "12");
  assert.equal(quote.operatorFeeWei, "3");
  assert.equal(quote.estimatedWei, "100000015");
  const decoded = decodeFunctionData({ abi: escrowAbi, data: quote.data });
  assert.equal(decoded.functionName, "claimFor");
  assert.equal(decoded.args[0].toLowerCase(), owner);
});

test("unchanged proxy runtime with changed implementation blocks the Base claim", async (t) => {
  const runtime = mockRuntime({ chainId: 8453, changedImplementation: true });
  t.after(() => runtime.budget.close());
  const result = await runtime.service.list({ address: owner, chainId: 8453, padId: "o1" });
  await assert.rejects(
    runtime.service.prepare({ address: owner, positionId: result.positions[0].id }),
    { code: "contract_unverified" },
  );
});

test("disabled fees perform no upstream work and O1 Robinhood remains indexed only", async (t) => {
  const disabled = new Fees(readConfig({}), {
    json() {
      throw new Error("No reads expected");
    },
  });
  assert.equal(
    (await disabled.list({ address: owner, chainId: 4663, padId: "o1" })).status,
    "unavailable",
  );
  const runtime = mockRuntime();
  t.after(() => runtime.budget.close());
  const result = await runtime.service.list({ address: owner, chainId: 4663, padId: "o1" });
  assert.equal(result.positions[0].verification, "indexed");
  assert.equal(result.positions[0].claimable, false);
  assert.equal(runtime.calls(), 3);
});

test("batch RPC debits every method, rejects duplicate IDs and never exposes provider errors", async () => {
  const methods = [
    { method: "eth_gasPrice", params: [] },
    { method: "eth_getBalance", params: [owner, "latest"] },
  ];
  let units;
  const rpc = new FeeRpc(config(), {
    async json(_provider, _url, _options, _bytes, charged) {
      units = charged;
      return [
        { jsonrpc: "2.0", id: 0, result: "0x1" },
        { jsonrpc: "2.0", id: 0, result: "0x2" },
      ];
    },
  });
  await assert.rejects(rpc.batch(4663, methods), { code: "invalid_response" });
  assert.equal(units, 2);
  rpc.upstream = {
    async json() {
      return [
        {
          jsonrpc: "2.0",
          id: 0,
          error: { code: -32000, message: "insufficient funds: synthetic confidential details" },
        },
      ];
    },
  };
  await assert.rejects(
    rpc.batch(4663, methods.slice(0, 1)),
    (error) => error.code === "insufficient_funds" && !error.message.includes("confidential"),
  );
});

test("weighted budget debits atomically and retains daily caps", () => {
  const budget = new Budget(":memory:", () => 1000);
  try {
    budget.upstream("rpc", 30);
    budget.upstream("rpc", 30);
    assert.throws(() => budget.upstream("rpc"), { code: "rate_limited" });
    const used = budget.db
      .prepare("SELECT used FROM counters WHERE scope = ?")
      .get("upstream:86400000:0").used;
    assert.equal(used, 60);
    assert.throws(() => budget.upstream("rpc", 0));
  } finally {
    budget.close();
  }
});
