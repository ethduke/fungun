import assert from "node:assert/strict";
import test from "node:test";
import { runtimeStatus } from "./runtime-status.mjs";

const feature = (env, id) => runtimeStatus(env).features.find((entry) => entry.id === id);

test("runtime status distinguishes absent settings, disabled features and unverified configuration", () => {
  assert.equal(runtimeStatus({}).configuration, "valid");
  assert.deepEqual(feature({}, "o1_catalog"), {
    id: "o1_catalog",
    missing: ["O1_API_KEY"],
    disabled: ["READ_UPSTREAMS"],
    status: "missing_configuration",
  });
  assert.equal(feature({ O1_API_KEY: "EXAMPLE" }, "o1_catalog").status, "disabled");
  assert.equal(
    feature({ O1_API_KEY: "EXAMPLE", READ_UPSTREAMS: "true" }, "o1_catalog").status,
    "needs_live_verification",
  );
  assert.equal(
    feature({ O1_API_KEY: "EXAMPLE", READ_UPSTREAMS: "true" }, "long_catalog_subset").status,
    "missing_configuration",
  );
});

test("runtime status never emits provider values or derived contract configuration", () => {
  const endpoint = new URL("/rpc", "https://example.invalid").href;
  const target = `0x${"1".repeat(40)}`;
  const pin = `0x${"2".repeat(64)}`;
  const report = runtimeStatus({
    O1_API_KEY: "EXAMPLE",
    ROBINHOOD_RPC_URL: endpoint,
    LONG_TICKER_REGISTRY_ADDRESS: target,
    LONG_TICKER_REGISTRY_CODE_HASH: pin,
    READ_UPSTREAMS: "true",
  });
  const serialized = JSON.stringify(report);
  for (const value of [endpoint, target, pin, "EXAMPLE"]) assert.ok(!serialized.includes(value));
  assert.equal(
    report.features.find((entry) => entry.id === "long_ticker").status,
    "needs_live_verification",
  );
});

test("invalid configuration returns a fixed safe message without exception details", () => {
  const report = runtimeStatus({ BASE_RPC_URL: "EXAMPLE" });
  assert.equal(report.configuration, "invalid");
  assert.deepEqual(report.features, []);
  assert.ok(!report.message.includes("EXAMPLE"));
  assert.ok(!report.message.includes("stack"));
});

test("blank optional fee configuration remains valid and cannot enable claims", () => {
  const report = runtimeStatus({ FEE_CONTRACTS_JSON: "" });
  assert.equal(report.configuration, "valid");
  assert.equal(
    report.features.find((entry) => entry.id === "long_locked_pool_claims").status,
    "missing_configuration",
  );
  for (const id of ["launch_execution", "image_storage", "paid_image_generation"])
    assert.equal(
      feature({ READ_UPSTREAMS: "true", READ_FEES: "true", WALLET_CLAIMS: "true" }, id).status,
      "not_implemented",
    );
});

test("fee readiness requires chain-specific escrow configuration", () => {
  const escrow = `0x${"1".repeat(40)}`;
  const codeHash = `0x${"2".repeat(64)}`;
  const env = {
    O1_API_KEY: "EXAMPLE",
    ROBINHOOD_RPC: new URL("/rpc", "https://example.invalid").href,
    READ_FEES: "true",
    WALLET_CLAIMS: "true",
    FEE_CONTRACTS_JSON: JSON.stringify({ o1: [{ chainId: 4663, escrow, codeHash }] }),
  };
  assert.equal(feature(env, "o1_robinhood_claims").status, "needs_live_verification");
  assert.equal(feature(env, "o1_base_live_fees_and_claims").status, "missing_configuration");
  assert.equal(
    feature({ ...env, FEE_CONTRACTS_JSON: "{}" }, "o1_robinhood_claims").status,
    "missing_configuration",
  );
});

test("Longbow readiness requires its own profile without enabling Long", () => {
  const address = (digit) => `0x${digit.repeat(40)}`;
  const codeHash = `0x${"2".repeat(64)}`;
  const env = {
    ROBINHOOD_RPC: new URL("/rpc", "https://example.invalid").href,
    READ_FEES: "true",
    WALLET_CLAIMS: "true",
    FEE_CONTRACTS_JSON: JSON.stringify({
      longbow: {
        manager: address("1"),
        managerCodeHash: codeHash,
        hook: address("2"),
        hookCodeHash: codeHash,
        pools: [
          {
            asset: address("3"),
            currency0: { address: address("3"), symbol: "TEST", decimals: 18 },
            currency1: { address: address("4"), symbol: "PAIR", decimals: 6 },
            fee: 3000,
            tickSpacing: 60,
          },
        ],
      },
    }),
  };
  assert.equal(feature(env, "longbow_locked_pool_fees").status, "needs_live_verification");
  assert.equal(feature(env, "longbow_locked_pool_claims").status, "needs_live_verification");
  assert.equal(feature(env, "long_locked_pool_claims").status, "missing_configuration");
  assert.deepEqual(
    feature({ ...env, FEE_CONTRACTS_JSON: "{}" }, "longbow_locked_pool_fees").missing,
    ["FEE_CONTRACTS_JSON.longbow"],
  );
  assert.equal(
    feature({ ...env, WALLET_CLAIMS: "false" }, "longbow_locked_pool_claims").status,
    "disabled",
  );
});
