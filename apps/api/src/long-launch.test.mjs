import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getCreate2Address,
  toHex,
  zeroAddress,
} from "viem";
import {
  assertUnsignedLongTransaction,
  buildUnsignedLongLaunch,
  buildUnsignedLongLaunchAsync,
  LONG_CREATE_ABI,
  LONG_HOOK_PARAMETERS,
  LONG_POOL_PARAMETERS,
  LONG_TOKEN_PARAMETERS,
  readLongLaunchProfile,
} from "./long-launch.mjs";

const address = (value) => toHex(BigInt(value), { size: 20 });
const hash = (value) => toHex(BigInt(value), { size: 32 });
const contract = (value) => ({ address: address(value), codeHash: hash(value) });
function profile() {
  return {
    chainId: 4663,
    launcher: contract(1),
    airlock: contract(2),
    tokenFactory: { ...contract(3), initCodeHash: hash(103) },
    governanceFactory: contract(4),
    poolInitializer: contract(5),
    liquidityMigrator: contract(6),
    dopplerHook: contract(7),
    integrator: address(8),
    protocolBeneficiary: address(9),
    quotes: [
      {
        id: "long-EXAMPLE",
        token: { ...contract(10), address: address(2n ** 160n - 1n) },
        oracle: contract(11),
        decimals: 18,
        oracleDecimals: 8,
      },
    ],
  };
}
const publicOrigin = "https://assets.example.com";
function input() {
  return {
    chainId: 4663,
    wallet: address(1001),
    draft: { name: "Moon", ticker: "MOON", description: "A simple coin." },
    pairId: "long-EXAMPLE",
    metadataUri: `${publicOrigin}/launch-assets/${"a".repeat(64)}.json`,
    startingTick: -160000,
    intentId: "00000000-0000-4000-8000-000000000001",
  };
}

test("ordinary Long encodes exact nonpayable create parameters without creator allocations", () => {
  const plan = buildUnsignedLongLaunch(input(), profile(), publicOrigin);
  assert.equal(plan.status, "requires_verification");
  assert.equal(plan.transaction.chainId, 4663);
  assert.equal(plan.transaction.from, input().wallet);
  assert.equal(plan.transaction.to, profile().launcher.address);
  assert.equal(plan.transaction.value, "0");
  assert.equal(plan.transaction.data.slice(0, 10), "0x882db707");
  const {
    args: [params],
  } = decodeFunctionData({ abi: LONG_CREATE_ABI, data: plan.transaction.data });
  assert.equal(params.initialSupply, 10n ** 27n);
  assert.equal(params.numTokensToSell, params.initialSupply);
  assert.equal(params.numeraire.toLowerCase(), profile().quotes[0].token.address);
  for (const role of ["tokenFactory", "governanceFactory", "poolInitializer", "liquidityMigrator"])
    assert.equal(params[role].toLowerCase(), profile()[role].address);
  assert.equal(params.integrator.toLowerCase(), profile().integrator);
  assert.equal(params.governanceFactoryData, "0x");
  assert.equal(params.liquidityMigratorData, "0x");
  const token = decodeAbiParameters(LONG_TOKEN_PARAMETERS, params.tokenFactoryData);
  assert.deepEqual(token, [
    "Moon",
    "MOON",
    [],
    [],
    [],
    [],
    input().metadataUri,
    0n,
    0,
    zeroAddress,
    [],
  ]);
  assert.equal(BigInt(params.tokenFactoryData.slice(0, 66)), 352n);
  assert.equal(encodeAbiParameters(LONG_TOKEN_PARAMETERS, token), params.tokenFactoryData);
  assert.equal(plan.review.creatorAllocation, "0");
  assert.equal(plan.review.metadataMutable, false);
});

test("Long pool and hook preserve reviewed curve and connected-wallet recipient parameters", () => {
  const plan = buildUnsignedLongLaunch(input(), profile(), publicOrigin);
  const {
    args: [params],
  } = decodeFunctionData({ abi: LONG_CREATE_ABI, data: plan.transaction.data });
  assert.equal(BigInt(params.poolInitializerData.slice(0, 66)), 32n);
  const [pool] = decodeAbiParameters(LONG_POOL_PARAMETERS, params.poolInitializerData);
  assert.equal(pool.fee, 1000);
  assert.equal(pool.tickSpacing, 8);
  assert.equal(pool.farTick, 887256);
  assert.deepEqual(pool.curves, [
    { tickLower: -160000, tickUpper: -49568, numPositions: 1, shares: 991n * 10n ** 15n },
    { tickLower: -49568, tickUpper: 887264, numPositions: 1, shares: 9n * 10n ** 15n },
  ]);
  assert.deepEqual(
    pool.beneficiaries.map((entry) => ({ ...entry, beneficiary: entry.beneficiary.toLowerCase() })),
    [
      { beneficiary: profile().protocolBeneficiary, shares: 5n * 10n ** 16n },
      { beneficiary: input().wallet, shares: 95n * 10n ** 16n },
    ],
  );
  assert.equal(pool.dopplerHook.toLowerCase(), profile().dopplerHook.address);
  assert.equal(pool.graduationDopplerHookCalldata, "0x");
  const hook = decodeAbiParameters(LONG_HOOK_PARAMETERS, pool.onInitializationDopplerHookCalldata);
  assert.deepEqual(
    hook.map((entry) => (typeof entry === "string" ? entry.toLowerCase() : entry)),
    [
      profile().quotes[0].token.address,
      profile().integrator,
      800000n,
      11200n,
      10n,
      0n,
      0n,
      0n,
      714285714285714286n,
      0n,
      285714285714285714n,
      142857142857142857n,
      714285714285714286n,
      0n,
      142857142857142857n,
    ],
  );
  assert.equal(
    hook.slice(7, 11).reduce((sum, value) => sum + value, 0n),
    10n ** 18n,
  );
  assert.equal(
    hook.slice(11).reduce((sum, value) => sum + value, 0n),
    10n ** 18n,
  );
  assert.equal(encodeAbiParameters(LONG_POOL_PARAMETERS, [pool]), params.poolInitializerData);
});

test("CREATE2 is deterministic and bound to the reviewed launch context", () => {
  const plan = buildUnsignedLongLaunch(input(), profile(), publicOrigin);
  assert.deepEqual(buildUnsignedLongLaunch(input(), profile(), publicOrigin), plan);
  const reordered = profile();
  reordered.launcher = {
    codeHash: reordered.launcher.codeHash,
    address: reordered.launcher.address,
  };
  assert.deepEqual(buildUnsignedLongLaunch(input(), reordered, publicOrigin), plan);
  const {
    args: [params],
  } = decodeFunctionData({ abi: LONG_CREATE_ABI, data: plan.transaction.data });
  assert.equal(
    getCreate2Address({
      from: profile().tokenFactory.address,
      salt: params.salt,
      bytecodeHash: profile().tokenFactory.initCodeHash,
    }),
    plan.predictedAsset,
  );
  assert.ok(BigInt(plan.predictedAsset) < BigInt(params.numeraire));
  assert.ok(plan.predictedAsset.toLowerCase().endsWith('1e18'));
  assert.deepEqual(buildUnsignedLongLaunch(input(), profile(), publicOrigin, plan.saltAttempt), plan);
  for (const attempt of [-1, 3_000_000, 1.5, plan.saltAttempt + 1])
    assert.throws(() => buildUnsignedLongLaunch(input(), profile(), publicOrigin, attempt), /invalid_long_salt/);
  for (const change of [
    { wallet: address(1002) },
    { draft: { ...input().draft, ticker: "SUN" } },
    { startingTick: -160008 },
    { metadataUri: input().metadataUri.replace("a".repeat(64), "b".repeat(64)) },
    { intentId: "00000000-0000-4000-8000-000000000002" },
  ])
    assert.notEqual(
      buildUnsignedLongLaunch({ ...input(), ...change }, profile(), publicOrigin).binding,
      plan.binding,
    );
});

test('canonical mining yields to other requests and honors the preparation deadline', async () => {
  const fresh = { ...input(), intentId: '00000000-0000-4000-8000-000000000099' };
  let checks = 0, responsive = false;
  const timer = setTimeout(() => { responsive = true; }, 0);
  await assert.rejects(buildUnsignedLongLaunchAsync(fresh, profile(), publicOrigin, () => {
    if (++checks === 2) throw new Error('deadline reached');
  }), /deadline reached/);
  clearTimeout(timer);
  assert.equal(responsive, true);
  const plan = await buildUnsignedLongLaunchAsync(fresh, profile(), publicOrigin);
  assert.ok(plan.predictedAsset.toLowerCase().endsWith('1e18'));
  assert.deepEqual(buildUnsignedLongLaunch(fresh, profile(), publicOrigin, plan.saltAttempt), plan);
  const impossible = profile(); impossible.quotes[0].token.address = address(1);
  await assert.rejects(buildUnsignedLongLaunchAsync(fresh, impossible, publicOrigin), /long_salt_unavailable/);
});

test("unreviewed chains, pairs, module profiles, mutable options and invalid curves fail closed", () => {
  for (const change of [
    { chainId: 8453 },
    { wallet: zeroAddress },
    { wallet: profile().protocolBeneficiary },
    { pairId: "long-UNKNOWN" },
    { startingTick: -160001 },
    { startingTick: -887280 },
    { startingTick: 776832 },
    { startingTick: NaN },
    { intentId: "repeat" },
    { metadataUri: "https://other.example.com/metadata.json" },
    { editableMetadata: true },
    { creatorAllocation: "1" },
    { privateKey: "EXAMPLE" },
  ])
    assert.throws(() =>
      buildUnsignedLongLaunch({ ...input(), ...change }, profile(), publicOrigin),
    );
  for (const change of [
    { chainId: 8453 },
    { launcher: { ...contract(1), codeHash: hash(0) } },
    { tokenFactory: contract(3) },
    { airlock: contract(1) },
    { quotes: [] },
    { quotes: [...profile().quotes, ...profile().quotes] },
    { quotes: [{ ...profile().quotes[0], decimals: 8 }] },
  ])
    assert.throws(() => readLongLaunchProfile({ ...profile(), ...change }));
});

test("transaction validation rejects destination, wallet, value, chain, calldata and extra-field changes", () => {
  const draft = input();
  const config = profile();
  const plan = buildUnsignedLongLaunch(draft, config, publicOrigin);
  assert.equal(assertUnsignedLongTransaction(plan.transaction, draft, config, publicOrigin), true);
  for (const change of [
    { to: address(900) },
    { from: address(901) },
    { value: "1" },
    { chainId: 8453 },
    { data: `${plan.transaction.data}00` },
    { nonce: "1" },
    { authorizationList: [] },
  ])
    assert.throws(
      () =>
        assertUnsignedLongTransaction(
          { ...plan.transaction, ...change },
          draft,
          config,
          publicOrigin,
        ),
      { code: "long_transaction_changed" },
    );
  const {
    args: [params],
  } = decodeFunctionData({ abi: LONG_CREATE_ABI, data: plan.transaction.data });
  const altered = encodeFunctionData({
    abi: LONG_CREATE_ABI,
    functionName: "create",
    args: [{ ...params, numTokensToSell: params.initialSupply - 1n }],
  });
  assert.throws(() =>
    assertUnsignedLongTransaction(
      { ...plan.transaction, data: altered },
      draft,
      config,
      publicOrigin,
    ),
  );
});

test("recipient ordering is numeric and salt exhaustion never produces a fallback transaction", () => {
  const config = profile();
  config.protocolBeneficiary = address(2000);
  const plan = buildUnsignedLongLaunch(input(), config, publicOrigin);
  const {
    args: [params],
  } = decodeFunctionData({ abi: LONG_CREATE_ABI, data: plan.transaction.data });
  const [pool] = decodeAbiParameters(LONG_POOL_PARAMETERS, params.poolInitializerData);
  assert.equal(pool.beneficiaries[0].beneficiary.toLowerCase(), input().wallet);
  assert.equal(pool.beneficiaries[0].shares, 95n * 10n ** 16n);
  const impossible = profile();
  impossible.quotes[0].token.address = address(1);
  assert.throws(() => buildUnsignedLongLaunch(input(), impossible, publicOrigin), {
    code: "long_salt_unavailable",
  });
});
