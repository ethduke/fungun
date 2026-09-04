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
import { readJson } from "./upstream.mjs";

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
  pagination: { has_more: more, next_cursor: more ? "next-page" : null },
});

function mockRuntime(options = {}) {
  let now = 1000;
  const budget = new Budget(":memory:", () => now);
  let calls = 0;
  const upstream = {
    async json(provider, _url, request, _bytes, units = 1) {
      budget.upstream(provider, units);
      calls += units;
      if (provider === "market") {
        if (options.priceUnavailable) throw new Error("price unavailable");
        return { data: { base: "ETH", currency: "USD", amount: "2500" } };
      }
      if (provider === "o1") {
        const chainId = Number(_url.searchParams.get("chain_id"));
        assert.equal(_url.searchParams.get("limit"), "8");
        return options.o1 ? options.o1(_url) : body([indexed({ chain_id: chainId })], true);
      }
      const chainId = options.chainId ?? 4663;
      return JSON.parse(request.body).map((call) => {
        let result;
        if (call.method === "eth_chainId") result = toHex(chainId);
        else if (call.method === "eth_getCode")
          result = (
            typeof options.changedCode === "function"
              ? options.changedCode(call.params[0])
              : options.changedCode
          )
            ? "0x6000"
            : bytecode;
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
          if (functionName === "claimFor" && options.revertClaim)
            return {
              jsonrpc: "2.0",
              id: call.id,
              error: { code: 3, message: "execution reverted" },
            };
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
            getCumulatedFees0: options.emptyFees ? 0n : 100n,
            getCumulatedFees1: options.emptyFees ? 0n : 200n,
            getLastCumulatedFees0: options.emptyFees ? 0n : 10n,
            getLastCumulatedFees1: options.emptyFees ? 0n : 20n,
            collectFees: options.emptyFees ? [0n, 0n] : [10n, 20n],
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
  const cfg = config();
  if (options.padId === "longbow") {
    cfg.feeContracts = readFeeContracts(
      JSON.stringify({ ...contracts(), long: undefined, longbow: contracts().long }),
    );
  }
  return {
    service: new Fees(cfg, upstream, () => now),
    upstream,
    budget,
    advance: (milliseconds = 61_000) => {
      now += milliseconds;
    },
    calls: () => calls,
  };
}

test("configuration and fee inputs reject arbitrary targets, methods and unsupported claim profiles", () => {
  assert.deepEqual(readFeeContracts(), {
    o1: [],
    long: undefined,
    longbow: undefined,
    baseOracle: undefined,
  });
  assert.throws(() =>
    readFeeContracts(JSON.stringify({ o1: [{ ...contracts().o1[0], chainId: 1 }] })),
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
  assert.deepEqual(quote.gasUsd, {
    amount: "0.00000025",
    ethPrice: "2500",
    observedAt: 1000,
    source: "coinbase",
  });
  assert.equal(
    decodeFunctionData({ abi: managerAbi, data: quote.data }).functionName,
    "collectFees",
  );
  assert.equal(runtime.calls(), 27);
  await runtime.service.prepare({ address: owner, positionId });
  assert.equal(runtime.calls(), 27);
  runtime.advance(30 * 60_000);
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

test("a failed USD price request leaves a valid simulated claim available", async (t) => {
  const runtime = mockRuntime({ priceUnavailable: true });
  t.after(() => runtime.budget.close());
  const result = await runtime.service.list({ address: owner, chainId: 4663, padId: "long" });
  const quote = await runtime.service.prepare({
    address: owner,
    positionId: result.positions[0].id,
  });
  assert.equal(quote.gasUsd, null);
  assert.equal(quote.estimatedWei, "100000000");
  assert.equal(quote.value, "0");
  assert.equal(
    decodeFunctionData({ abi: managerAbi, data: quote.data }).functionName,
    "collectFees",
  );
});

test("Longbow uses its own profile and prepares only beneficiary-bound collectFees", async (t) => {
  const runtime = mockRuntime({ padId: "longbow" });
  t.after(() => runtime.budget.close());
  const input = { address: owner, chainId: 4663, padId: "longbow" };
  assert.deepEqual(validateInput("fees", input), input);
  assert.throws(() => validateInput("fees", { ...input, chainId: 8453 }));
  const results = await Promise.all(Array.from({ length: 10 }, () => runtime.service.list(input)));
  assert.equal(runtime.calls(), 11);
  const result = results[0];
  assert.equal(result.padId, "longbow");
  assert.equal(result.coverage, "configured_pools");
  assert.equal(result.status, "partial");
  assert.deepEqual(
    result.positions[0].payouts.map((payout) => payout.claimableRaw),
    ["50", "100"],
  );
  assert.equal(result.positions[0].claimable, true);
  const long = await runtime.service.list({ ...input, padId: "long" });
  assert.equal(long.status, "unavailable");
  assert.equal(long.reason, "contracts_not_configured");
  const positionId = result.positions[0].id;
  await assert.rejects(runtime.service.prepare({ address: address("b"), positionId }), {
    code: "quote_expired",
  });
  const quote = await runtime.service.prepare({ address: owner, positionId });
  assert.equal(quote.kind, "longbow");
  assert.equal(quote.chainId, 4663);
  assert.equal(quote.target, contracts().long.manager);
  assert.equal(quote.value, "0");
  const decoded = decodeFunctionData({ abi: managerAbi, data: quote.data });
  assert.equal(decoded.functionName, "collectFees");
  assert.deepEqual(decoded.args, [quote.poolId]);
  assert.equal(runtime.calls(), 27);
  await runtime.service.prepare({ address: owner, positionId });
  assert.equal(runtime.calls(), 27);
});

test("Longbow refuses claims after shares transfer or code and hook changes", async (t) => {
  for (const mode of ["shares", "code", "hook"]) {
    const options = { padId: "longbow" };
    const runtime = mockRuntime(options);
    t.after(() => runtime.budget.close());
    const result = await runtime.service.list({ address: owner, chainId: 4663, padId: "longbow" });
    if (mode === "shares") options.shares = 0n;
    if (mode === "code") options.changedCode = true;
    if (mode === "hook") options.changedHook = true;
    await assert.rejects(
      runtime.service.prepare({ address: owner, positionId: result.positions[0].id }),
      {
        code: mode === "shares" ? "nothing_to_claim" : "contract_unverified",
      },
    );
  }
});

test("locked-pool lists omit nonbeneficiaries but retain owned positions with zero fees", async (t) => {
  for (const padId of ["long", "longbow"]) {
    for (const shares of [0n, 95n * 10n ** 16n]) {
      const runtime = mockRuntime({ padId, shares, emptyFees: true });
      t.after(() => runtime.budget.close());
      const result = await runtime.service.list({ address: owner, chainId: 4663, padId });
      assert.equal(result.positions.length, shares === 0n ? 0 : 1);
      if (shares > 0n) {
        assert.deepEqual(
          result.positions[0].payouts.map((payout) => payout.claimableRaw),
          ["0", "0"],
        );
        assert.equal(result.positions[0].claimable, false);
        assert.equal(result.positions[0].claimDisabledReason, "nothing_to_claim");
      }
    }
  }
});

test("locked-pool handles cannot survive reassignment or reuse cached quotes after profile edits", async (t) => {
  for (const padId of ["long", "longbow"]) {
    for (const field of ["manager", "managerCodeHash", "hook", "hookCodeHash", "pools"]) {
      const runtime = mockRuntime({ padId });
      t.after(() => runtime.budget.close());
      const result = await runtime.service.list({ address: owner, chainId: 4663, padId });
      const input = { address: owner, positionId: result.positions[0].id };
      await runtime.service.prepare(input);
      const before = runtime.calls();
      runtime.service.config.feeContracts[padId][field] =
        field === "pools" ? [] : field.endsWith("Hash") ? keccak256("0x6000") : address("9");
      await assert.rejects(runtime.service.prepare(input), { code: "contract_unverified" });
      assert.equal(runtime.calls(), before);
    }
  }
});

test("Long and Longbow cannot count the same pool, disagree on pins, or share unlabelled discovery", () => {
  const profile = contracts().long;
  const distinct = {
    ...pool,
    asset: address("8"),
    currency0: { ...pool.currency0, address: address("8") },
    currency1: { ...pool.currency1, address: address("9") },
  };
  const longbow = { ...profile, pools: [distinct] };
  assert.equal(
    readFeeContracts(JSON.stringify({ long: profile, longbow })).longbow.pools.length,
    1,
  );
  for (const changed of [
    profile,
    { ...profile, pools: [{ ...pool, currency0: { ...pool.currency0, symbol: "RENAMED" } }] },
    { ...profile, pools: [{ ...pool, fee: pool.fee + 1 }] },
    { ...longbow, managerCodeHash: keccak256("0x6000") },
    { ...longbow, hookCodeHash: keccak256("0x6000") },
    { ...longbow, discovery: { fromBlock: 0 } },
    null,
    [],
  ])
    assert.throws(() => readFeeContracts(JSON.stringify({ long: profile, longbow: changed })), {
      code: "invalid_fee_configuration",
    });
  assert.throws(
    () =>
      readFeeContracts(
        JSON.stringify({
          long: { ...profile, discovery: { fromBlock: 0 } },
          longbow,
        }),
      ),
    { code: "invalid_fee_configuration" },
  );
  assert.equal(
    readFeeContracts(
      JSON.stringify({
        long: { ...profile, discovery: { fromBlock: 0 } },
        longbow: { ...longbow, manager: address("b") },
      }),
    ).long.discovery.blockRange,
    2000,
  );
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

test("disabled and unconfigured fee sources report the cause without upstream work", async () => {
  const cases = [
    { padId: "o1", settings: { feesEnabled: false }, reason: "fees_disabled" },
    { padId: "long", settings: { feesEnabled: false }, reason: "fees_disabled" },
    { padId: "longbow", settings: { feesEnabled: false }, reason: "fees_disabled" },
    { padId: "o1", settings: { o1Key: "" }, reason: "provider_not_configured" },
    { padId: "long", settings: { rpcUrl: "" }, reason: "provider_not_configured" },
    { padId: "longbow", settings: { rpcUrl: "" }, reason: "provider_not_configured" },
    { padId: "longbow", settings: {}, reason: "contracts_not_configured" },
    {
      padId: "long",
      settings: { feeContracts: readFeeContracts() },
      reason: "contracts_not_configured",
    },
  ];
  for (const { padId, settings, reason } of cases) {
    const service = new Fees(
      { ...config(), ...settings },
      {
        json() {
          assert.fail("Unavailable fees cannot contact providers");
        },
      },
    );
    const result = await service.list({ address: owner, chainId: 4663, padId });
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, reason);
    assert.deepEqual(result.positions, []);
    assert.equal(result.nextCursor, null);
  }
});

test("O1 positions without a reviewed chain-specific escrow explain why claims are disabled", async (t) => {
  const runtime = mockRuntime();
  t.after(() => runtime.budget.close());
  const result = await runtime.service.list({ address: owner, chainId: 4663, padId: "o1" });
  assert.equal(result.positions[0].verification, "indexed");
  assert.equal(result.positions[0].claimable, false);
  assert.equal(result.positions[0].claimDisabledReason, "contract_unverified");
  assert.equal(result.positions[0].payouts[0].claimableRaw, "100");
  assert.equal(runtime.calls(), 3);
});

test("live balances retain disabled-claim reasons for switches, gas configuration and empty fees", async (t) => {
  const cases = [
    {
      padId: "long",
      chainId: 4663,
      settings: { claimsEnabled: false },
      reason: "claims_disabled",
      amount: "50",
    },
    {
      padId: "o1",
      chainId: 8453,
      settings: { claimsEnabled: false },
      reason: "claims_disabled",
      amount: "150",
    },
    {
      padId: "o1",
      chainId: 8453,
      noOracle: true,
      reason: "gas_oracle_not_configured",
      amount: "150",
    },
    { padId: "o1", chainId: 8453, options: { owed: 0n }, reason: "nothing_to_claim", amount: "0" },
    {
      padId: "long",
      chainId: 4663,
      options: { emptyFees: true },
      reason: "nothing_to_claim",
      amount: "0",
    },
  ];
  for (const scenario of cases) {
    const runtime = mockRuntime({ chainId: scenario.chainId, ...scenario.options });
    t.after(() => runtime.budget.close());
    Object.assign(runtime.service.config, scenario.settings);
    if (scenario.noOracle) runtime.service.config.feeContracts.baseOracle = undefined;
    const result = await runtime.service.list({
      address: owner,
      chainId: scenario.chainId,
      padId: scenario.padId,
    });
    assert.equal(result.positions[0].verification, "live");
    assert.equal(result.positions[0].claimable, false);
    assert.equal(result.positions[0].claimDisabledReason, scenario.reason);
    assert.equal(result.positions[0].payouts[0].claimableRaw, scenario.amount);
  }
});

test("all O1 positions are reached through bounded opaque pages and every reviewed position is live", async (t) => {
  const entries = Array.from({ length: 33 }, (_, index) => {
    const currency = `0x${(index + 1).toString(16).padStart(40, "0")}`;
    return indexed({
      currency: { address: currency, token: { address: currency, symbol: "TEST", decimals: 18 } },
    });
  });
  const requested = [];
  const runtime = mockRuntime({
    chainId: 8453,
    o1: (url) => {
      const cursor = url.searchParams.get("cursor");
      requested.push(cursor);
      const offset = cursor ? Number(cursor.slice(5)) : 0;
      return {
        data: entries.slice(offset, offset + 8),
        pagination: {
          has_more: offset + 8 < entries.length,
          next_cursor: offset + 8 < entries.length ? `page-${offset + 8}` : null,
        },
      };
    },
  });
  t.after(() => runtime.budget.close());
  const input = { address: owner, chainId: 8453, padId: "o1" };
  const positions = [];
  let cursor;
  do {
    const page = await runtime.service.list({ ...input, ...(cursor ? { cursor } : {}) });
    assert.equal(page.coverage, "wallet_index");
    assert.ok(page.positions.length <= 8);
    assert.ok(
      page.positions.every((position) => position.verification === "live" && position.claimable),
    );
    positions.push(...page.positions);
    cursor = page.nextCursor;
    if (cursor) assert.match(cursor, /^[a-f0-9]{64}$/);
    else assert.equal(page.status, "ready");
    runtime.advance();
  } while (cursor);
  assert.equal(positions.length, 33);
  assert.equal(new Set(positions.map((position) => position.id)).size, 33);
  assert.deepEqual(requested, [null, "page-8", "page-16", "page-24", "page-32"]);
  // The scan lasted over five minutes: early handles still prepare from a live read.
  const quote = await runtime.service.prepare({ address: owner, positionId: positions[0].id });
  assert.equal(quote.payouts[0].claimableRaw, "150");
});

test("cursor identity, expiry, invalid upstream pagination and repeated cursors fail closed", async (t) => {
  const runtime = mockRuntime();
  t.after(() => runtime.budget.close());
  const input = { address: owner, chainId: 4663, padId: "o1" };
  const first = await runtime.service.list(input);
  const cursor = first.nextCursor;
  for (const changed of [
    { address: address("b") },
    { chainId: 8453 },
    { padId: "long" },
    { cursor: "a".repeat(64) },
  ]) {
    await assert.rejects(runtime.service.list({ ...input, cursor, ...changed }), {
      code: "cursor_expired",
    });
  }
  await assert.rejects(runtime.service.list({ ...input, cursor }), { code: "cursor_expired" });
  runtime.advance(30 * 60_000);
  await assert.rejects(runtime.service.list({ ...input, cursor }), { code: "cursor_expired" });
  assert.equal(runtime.calls(), 6);
  for (const pagination of [
    { has_more: true, next_cursor: null },
    { has_more: true, next_cursor: "" },
    { has_more: true, next_cursor: "x".repeat(4097) },
    { has_more: false, next_cursor: "remaining" },
  ])
    assert.throws(() => parseO1Positions({ data: [], pagination }, owner, 8453), {
      code: "invalid_response",
    });
  assert.equal(validateInput("fees", { ...input, cursor }).cursor, cursor);
  for (const invalid of ["", null, "next-page", "a".repeat(65)]) {
    assert.throws(() => validateInput("fees", { ...input, cursor: invalid }), {
      code: "invalid_request",
    });
  }
});

test("reviewed Robinhood escrows are chain-scoped and simulate the owner-bound claim", async (t) => {
  const runtime = mockRuntime({ chainId: 4663 });
  t.after(() => runtime.budget.close());
  runtime.service.config.feeContracts = readFeeContracts(
    JSON.stringify({
      o1: [contracts().o1[0], { ...contracts().o1[0], chainId: 4663 }],
    }),
  );
  const result = await runtime.service.list({ address: owner, chainId: 4663, padId: "o1" });
  assert.equal(result.positions[0].verification, "live");
  assert.equal(result.positions[0].claimable, true);
  const quote = await runtime.service.prepare({
    address: owner,
    positionId: result.positions[0].id,
  });
  assert.equal(quote.chainId, 4663);
  assert.equal(quote.l1FeeWei, "0");
  assert.equal(quote.estimatedWei, "100000000");
  const decoded = decodeFunctionData({ abi: escrowAbi, data: quote.data });
  assert.equal(decoded.functionName, "claimFor");
  assert.equal(decoded.args[0].toLowerCase(), owner);
});

test("changed escrow remains indexed and cannot claim", async (t) => {
  const runtime = mockRuntime({ chainId: 8453, changedCode: true });
  t.after(() => runtime.budget.close());
  const result = await runtime.service.list({ address: owner, chainId: 8453, padId: "o1" });
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].verification, "indexed");
  assert.equal(result.positions[0].claimable, false);
  assert.equal(result.positions[0].claimDisabledReason, "contract_unverified");
  await assert.rejects(
    runtime.service.prepare({ address: owner, positionId: result.positions[0].id }),
    { code: "contract_unverified" },
  );
});

test("one changed escrow cannot hide other verified fee positions", async (t) => {
  const runtime = mockRuntime({
    chainId: 8453,
    changedCode: (target) => target === address("8"),
    o1: () => body([indexed(), indexed({ fee_escrow_address: address("8") })]),
  });
  t.after(() => runtime.budget.close());
  runtime.service.config.feeContracts.o1.push({ ...contracts().o1[0], escrow: address("8") });
  const result = await runtime.service.list({ address: owner, chainId: 8453, padId: "o1" });
  assert.deepEqual(
    result.positions.map((position) => position.verification),
    ["live", "indexed"],
  );
  assert.deepEqual(
    result.positions.map((position) => position.claimable),
    [true, false],
  );
  assert.equal(result.status, "partial");
  assert.equal(result.nextCursor, null);
  assert.equal(runtime.calls(), 8);
});

test("Robinhood preflight cannot pass a reverting exact claim simulation", async (t) => {
  const runtime = mockRuntime({ chainId: 4663, revertClaim: true });
  t.after(() => runtime.budget.close());
  runtime.service.config.feeContracts.o1 = [{ ...contracts().o1[0], chainId: 4663 }];
  const result = await runtime.service.list({ address: owner, chainId: 4663, padId: "o1" });
  await assert.rejects(
    runtime.service.prepare({ address: owner, positionId: result.positions[0].id }),
    { code: "reverted" },
  );
});

test("upstream stale cursors become a bounded safe restart error", async () => {
  for (const code of ["cursor_stale", "cursor_filter_mismatch"]) {
    await assert.rejects(
      readJson(
        new Response(JSON.stringify({ code, detail: "confidential provider message" }), {
          status: 409,
          headers: { "content-type": "application/problem+json" },
        }),
        256 * 1024,
      ),
      (error) =>
        error.code === "cursor_expired" &&
        error.status === 409 &&
        !error.message.includes("confidential"),
    );
  }
  await assert.rejects(
    readJson(
      new Response(JSON.stringify({ code: "something_private" }), {
        status: 409,
        headers: { "content-type": "application/problem+json" },
      }),
      256 * 1024,
    ),
    { code: "upstream_unavailable" },
  );
  await assert.rejects(
    readJson(
      new Response(JSON.stringify({ code: "cursor_stale", detail: "x".repeat(4096) }), {
        status: 409,
        headers: { "content-type": "application/problem+json" },
      }),
      256 * 1024,
    ),
    { code: "upstream_unavailable" },
  );
});

test("configured Long pools paginate beyond two without changing the scan block", async (t) => {
  const runtime = mockRuntime();
  t.after(() => runtime.budget.close());
  const pools = Array.from({ length: 5 }, (_, index) => ({ ...pool, fee: 3000 + index }));
  runtime.service.config.feeContracts = readFeeContracts(
    JSON.stringify({ long: { ...contracts().long, pools } }),
  );
  const blocks = [];
  runtime.service.longPosition = async (address, selected, block) => {
    blocks.push(block);
    return {
      kind: "long",
      beneficiary: true,
      chainId: 4663,
      address,
      target: contracts().long.manager,
      poolId: toHex(selected.fee, { size: 32 }),
      payouts: [{ ...pool.currency0, asset: pool.currency0.address, claimableRaw: "1" }],
      verification: "live",
      claimable: true,
    };
  };
  const input = { address: owner, chainId: 4663, padId: "long" };
  const first = await runtime.service.list(input);
  const second = await runtime.service.list({ ...input, cursor: first.nextCursor });
  const last = await runtime.service.list({ ...input, cursor: second.nextCursor });
  assert.deepEqual(
    [first, second, last].map((page) => page.positions.length),
    [2, 2, 1],
  );
  assert.equal(last.nextCursor, null);
  assert.equal(last.coverage, "configured_pools");
  assert.equal(last.status, "partial");
  assert.deepEqual(blocks, Array(5).fill("0x123"));
  assert.equal(runtime.calls(), 4);
  assert.deepEqual(
    readFeeContracts(
      JSON.stringify({
        long: { ...contracts().long, pools: undefined, discovery: { fromBlock: 0 } },
      }),
    ).long.pools,
    [],
  );
});

test("Longbow paginates all configured pools with source-bound cursors and one scan block", async (t) => {
  const runtime = mockRuntime({ padId: "longbow" });
  t.after(() => runtime.budget.close());
  const pools = Array.from({ length: 5 }, (_, index) => ({ ...pool, fee: 3000 + index }));
  runtime.service.config.feeContracts = readFeeContracts(
    JSON.stringify({
      long: { ...contracts().long, manager: address("b") },
      longbow: { ...contracts().long, pools },
    }),
  );
  const blocks = [];
  runtime.service.longPosition = async (address, selected, block, padId) => {
    assert.equal(padId, "longbow");
    blocks.push(block);
    return {
      kind: padId,
      beneficiary: true,
      chainId: 4663,
      address,
      target: contracts().long.manager,
      poolId: toHex(selected.fee, { size: 32 }),
      payouts: [{ ...pool.currency0, asset: pool.currency0.address, claimableRaw: "1" }],
      verification: "live",
      claimable: true,
    };
  };
  const input = { address: owner, chainId: 4663, padId: "longbow" };
  const first = await runtime.service.list(input);
  await assert.rejects(
    runtime.service.list({ ...input, padId: "long", cursor: first.nextCursor }),
    {
      code: "cursor_expired",
    },
  );
  const second = await runtime.service.list({ ...input, cursor: first.nextCursor });
  const last = await runtime.service.list({ ...input, cursor: second.nextCursor });
  assert.deepEqual(
    [first, second, last].map((page) => page.positions.length),
    [2, 2, 1],
  );
  assert.equal(last.nextCursor, null);
  assert.equal(last.padId, "longbow");
  assert.equal(last.coverage, "configured_pools");
  assert.equal(last.status, "partial");
  assert.deepEqual(blocks, Array(5).fill("0x123"));
  assert.equal(runtime.calls(), 4);
  runtime.service.config.feeContracts.longbow.hookCodeHash = keccak256("0x6000");
  await assert.rejects(runtime.service.list({ ...input, cursor: first.nextCursor }), {
    code: "cursor_expired",
  });
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
