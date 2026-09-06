import assert from "node:assert/strict";
import test from "node:test";
import { toHex } from "viem";
import { readConfig } from "./config.mjs";

const address = (value) => toHex(BigInt(value), { size: 20 });
const hash = (value) => toHex(BigInt(value), { size: 32 });
const contract = (value) => ({ address: address(value), codeHash: hash(value) });

function configuredEnvironment() {
  const longProfile = {
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
        id: "long-NVDA",
        token: contract(10),
        oracle: contract(11),
        decimals: 18,
        oracleDecimals: 8,
      },
    ],
  };
  const guards = {
    "long-NVDA": {
      tokenBeacon: contract(12),
      tokenImplementation: contract(13),
      oracleAggregator: contract(14),
      heartbeatSeconds: 86400,
    },
  };
  const o1Profile = {
    chainId: 4663,
    launchpad: "o1",
    launcher: contract(21),
    tokenDeployer: contract(22),
    hook: contract(23),
    feeEscrow: contract(24),
    announcementRegistry: contract(25),
  };
  const stock = { symbol: "AAPL", address: address(30) };
  const usdg = {
    quote: { symbol: "USDG", token: contract(31), decimals: 6 },
  };
  return {
    O1_API_KEY: "EXAMPLE",
    O1_WALLET_LAUNCH: "true",
    LONG_WALLET_LAUNCH: "false",
    O1_LAUNCH_PROFILE_JSON: JSON.stringify(o1Profile),
    O1_LAUNCH_TOKENS_JSON: JSON.stringify([stock]),
    LONG_EXTRA_QUOTES_JSON: JSON.stringify([usdg]),
    LONG_LAUNCH_PROFILE_JSON: JSON.stringify(longProfile),
    LONG_LAUNCH_GUARDS_JSON: JSON.stringify(guards),
    LAUNCH_ASSET_SERVICE_ORIGIN: "https://assets.example.invalid",
  };
}

test("O1 validates shared Long pins without enabling the Long wallet handler", () => {
  const config = readConfig(configuredEnvironment());
  assert.equal(config.longLaunch, null);
  assert.equal(config.o1Launch.assetOrigin, "https://assets.example.invalid");
  assert.deepEqual(
    config.o1Launch.profile.quotes.map((quote) => quote.id),
    ["native", config.o1Launch.profile.quotes[1].id, "crypto-USDG"],
  );
  assert.match(config.o1Launch.profile.quotes[1].id, /^rwa-[a-f0-9]{24}$/);
  assert.equal(
    config.o1Launch.profile.quotes[1].token.codeHash,
    JSON.parse(configuredEnvironment().LONG_LAUNCH_PROFILE_JSON).quotes[0].token.codeHash,
  );
});

test("O1 stays disabled by default and does not parse dormant launch settings", () => {
  const config = readConfig({
    O1_WALLET_LAUNCH: "false",
    LONG_WALLET_LAUNCH: "false",
    O1_LAUNCH_PROFILE_JSON: "not-json",
    O1_LAUNCH_TOKENS_JSON: "not-json",
    LONG_EXTRA_QUOTES_JSON: "not-json",
    LONG_LAUNCH_PROFILE_JSON: "not-json",
    LONG_LAUNCH_GUARDS_JSON: "not-json",
  });
  assert.equal(config.longLaunch, null);
  assert.equal(config.o1Launch, null);
});

test("enabled O1 fails with a stable configuration error when shared pins are absent or malformed", () => {
  const valid = configuredEnvironment();
  for (const changed of [
    { O1_API_KEY: "" },
    { LONG_LAUNCH_PROFILE_JSON: undefined },
    { LONG_LAUNCH_GUARDS_JSON: "{}" },
    { LAUNCH_ASSET_SERVICE_ORIGIN: "http://untrusted.invalid" },
    { O1_LAUNCH_PROFILE_JSON: "{}" },
    { O1_LAUNCH_TOKENS_JSON: "{}" },
    { LONG_EXTRA_QUOTES_JSON: "{}" },
  ]) {
    const env = { ...valid, ...changed };
    assert.throws(
      () => readConfig(env),
      (error) => error?.code === "o1_configuration" && error.status === 503,
    );
  }
});
