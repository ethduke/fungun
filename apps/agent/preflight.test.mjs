import test from "node:test";
import assert from "node:assert/strict";
import { toHex, keccak256, encodeAbiParameters, parseAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildUnsignedLongLaunch, LONG_NATIVE_ETH_QUOTE } from "../web/lib/long-encoding/long-launch.mjs";
import { preflight, validateSigned } from "./preflight.mjs";
import { defaultLimits } from "./index.mjs";
const address = (n) => toHex(BigInt(n), { size: 20 }),
  contract = (n) => ({ address: address(n), codeHash: keccak256("0x6001") });
const profile = {
  chainId: 4663,
  launcher: contract(1),
  airlock: contract(2),
  tokenFactory: { ...contract(3), initCodeHash: toHex(103n, { size: 32 }) },
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
const published = {
  ipfs: { metadataCid: "bafkreigh2akiscaildc5c5eqkhg5lgfzjuojautmsnb47nbqtwnhx4qyhi" },
};
const input = {
  chainId: 4663,
  wallet: address(1001),
  publication: { id: "publication", imageHash: "image", metadataHash: "metadata" },
  draft: { name: "Moon", ticker: "MOON", description: "" },
  pairId: "long-EXAMPLE",
};
function fixture(selectedProfile = profile, selectedInput = input) {
  const built = buildUnsignedLongLaunch(
    {
      chainId: input.chainId,
      wallet: input.wallet,
      draft: input.draft,
      pairId: selectedInput.pairId,
      metadataUri: `ipfs://${published.ipfs.metadataCid}`,
      startingTick: -160000,
      intentId: "00000000-0000-4000-8000-000000000001",
    },
    selectedProfile,
  );
  const now = Date.now();
  return {
    ...built,
    predictedPool: address(12),
    id: "a".repeat(64),
    chainId: 4663,
    profile: selectedProfile,
    quotedAt: now,
    expiresAt: now + 30000,
    startingTick: -160000,
    intentId: "00000000-0000-4000-8000-000000000001",
    transaction: {
      ...built.transaction,
      chainId: "0x1237",
      value: "0x0",
      nonce: "0x0",
      gas: "0x7530",
      gasPrice: "0x1",
    },
    estimatedGas: "25000",
    maximumGasWei: "30000",
  };
}
const rpc = {
  request: async ({ method }) =>
    ({
      eth_chainId: "0x1237",
      eth_getCode: "0x6001",
      eth_getTransactionCount: "0x0",
      eth_getBalance: "0xffffffffffffffff",
      eth_call: encodeAbiParameters(parseAbiParameters("address,address,address,address,address"), [
        fixture().predictedAsset,
        address(12),
        address(13),
        address(14),
        address(15),
      ]),
    })[method],
};
test("independent rebuild accepts valid plan with all trusted runtime pins", async () => {
  assert.equal(await preflight(fixture(), input, published, profile, rpc, defaultLimits), 30000n);
});
test("mutations of calldata, chain, profile, gas and value fail before signing", async () => {
  for (const mutate of [
    (p) => (p.transaction.data += "00"),
    (p) => (p.chainId = 1),
    (p) => (p.profile.launcher.codeHash = toHex(1n, { size: 32 })),
    (p) => (p.transaction.gas = "0xffffff"),
    (p) => (p.transaction.value = "0x1"),
  ]) {
    const p = structuredClone(fixture());
    mutate(p);
    await assert.rejects(preflight(p, input, published, profile, rpc, defaultLimits));
  }
});
test("wrong RPC chain, nonce, balance and deployed code fail", async () => {
  for (const [method, value] of [
    ["eth_chainId", "0x1"],
    ["eth_getTransactionCount", "0x1"],
    ["eth_getBalance", "0x0"],
    ["eth_getCode", "0x6002"],
  ])
    await assert.rejects(
      preflight(
        fixture(),
        input,
        published,
        profile,
        { request: (x) => (x.method === method ? value : rpc.request(x)) },
        defaultLimits,
      ),
    );
});
test("signed bytes verified and modifications rejected", async () => {
  const account = privateKeyToAccount("0x" + "11".repeat(32)),
    p = fixture(),
    tx = p.transaction;
  const raw = await account.signTransaction({
    chainId: 4663,
    type: "legacy",
    to: tx.to,
    data: tx.data,
    value: 0n,
    nonce: 0,
    gas: 30000n,
    gasPrice: 1n,
  });
  assert.equal(validateSigned(raw, tx), keccak256(raw));
  assert.throws(() => validateSigned(raw, { ...tx, nonce: "0x1" }));
});
test("simulation must return expected asset and nonzero predicted pool", async () => {
  for (const tuple of [
    [address(99), address(12)],
    [fixture().predictedAsset, address(0)],
    [fixture().predictedAsset, address(99)],
  ]) {
    const data = encodeAbiParameters(
      parseAbiParameters("address,address,address,address,address"),
      [...tuple, address(13), address(14), address(15)],
    );
    await assert.rejects(
      preflight(
        fixture(),
        input,
        published,
        profile,
        { request: (x) => (x.method === "eth_call" ? data : rpc.request(x)) },
        defaultLimits,
      ),
      /launch_simulation_failed/,
    );
  }
});

test("native ETH preflight verifies real contracts without querying currency0 bytecode", async () => {
  const nativeProfile = { ...profile, quotes: [LONG_NATIVE_ETH_QUOTE] };
  const nativeInput = { ...input, pairId: "long-ETH" };
  const plan = fixture(nativeProfile, nativeInput), checked = [];
  const nativeRpc = { request: async (request) => {
    if (request.method === "eth_getCode") {
      checked.push(request.params[0]);
      assert.notEqual(request.params[0], address(0));
    }
    if (request.method === "eth_call") return encodeAbiParameters(
      parseAbiParameters("address,address,address,address,address"),
      [plan.predictedAsset, address(12), address(13), address(14), address(15)],
    );
    return rpc.request(request);
  } };
  assert.equal(await preflight(plan, nativeInput, published, nativeProfile, nativeRpc, defaultLimits), 30000n);
  assert.equal(checked.length, 7);
  const bad = structuredClone(nativeProfile);
  bad.quotes[0].token.codeHash = keccak256("0x6001");
  await assert.rejects(preflight(plan, nativeInput, published, bad, nativeRpc, defaultLimits));
});
