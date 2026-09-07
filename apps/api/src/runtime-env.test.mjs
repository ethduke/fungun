import assert from "node:assert/strict";
import test from "node:test";
import {
  apiEnvironment,
  API_RUNTIME_NAMES,
  LONG_WALLET_LAUNCH_RUNTIME_NAMES,
  O1_WALLET_LAUNCH_RUNTIME_NAMES,
} from "./runtime-env.mjs";

test("API receives only its explicit runtime configuration", () => {
  const local = Object.fromEntries(API_RUNTIME_NAMES.map((name) => [name, "EXAMPLE"]));
  local.PRIVATE_KEY = "EXAMPLE";
  local.MNEMONIC = "EXAMPLE";
  local.XAI_API_KEY = "EXAMPLE";
  local.TELEGRAM_BOT_TOKEN = "EXAMPLE";
  local.NEXT_PUBLIC_O1_API_KEY = "EXAMPLE";
  local.VITE_PRIVATE_KEY = "EXAMPLE";
  local.UNRELATED = "EXAMPLE";
  const selected = apiEnvironment({}, local);
  assert.deepEqual(Object.keys(selected).sort(), [...API_RUNTIME_NAMES].sort());
  assert.equal(selected.O1_API_KEY, "EXAMPLE");
  assert.ok(!("PRIVATE_KEY" in selected));
  assert.ok(!("MNEMONIC" in selected));
});

test("inherited secrets and Node injection settings are not passed to the service", () => {
  const inherited = {
    PRIVATE_KEY: "EXAMPLE",
    SEED_PHRASE: "EXAMPLE",
    NODE_OPTIONS: "--require example",
    NODE_EXTRA_CA_CERTS: "example",
    O1_API_KEY: "EXAMPLE",
    PATH: "/usr/bin",
    HOME: "/example",
    TZ: "UTC",
  };
  assert.deepEqual(apiEnvironment(inherited), {
    PATH: "/usr/bin",
    HOME: "/example",
    TZ: "UTC",
    O1_API_KEY: "EXAMPLE",
  });
});

test("shell configuration wins and local files cannot override system settings", () => {
  const inherited = { READ_FEES: "false", APP_ORIGIN: "", PATH: "/usr/bin" };
  const local = { READ_FEES: "true", APP_ORIGIN: "EXAMPLE", PATH: "/example", HOME: "/example" };
  assert.deepEqual(apiEnvironment(inherited, local), inherited);
  assert.equal(local.READ_FEES, "true");
  assert.equal(inherited.READ_FEES, "false");
});

test("missing, inherited-prototype and non-string entries cannot become configuration", () => {
  const inherited = Object.create({ O1_API_KEY: "EXAMPLE" });
  assert.deepEqual(apiEnvironment(inherited, { READ_UPSTREAMS: true }), {});
  assert.deepEqual(apiEnvironment(), {});
});

test("RPC batch compatibility is forwarded only as server runtime configuration", () => {
  assert.deepEqual(apiEnvironment({}, { RPC_BATCH_REQUESTS: "false" }), {
    RPC_BATCH_REQUESTS: "false",
  });
  assert.deepEqual(
    apiEnvironment({ RPC_BATCH_REQUESTS: "true" }, { RPC_BATCH_REQUESTS: "false" }),
    {
      RPC_BATCH_REQUESTS: "true",
    },
  );
  assert.deepEqual(apiEnvironment({}, { NEXT_PUBLIC_RPC_BATCH_REQUESTS: "false" }), {});
});

test("all four Long wallet launch settings stay API-only and are forwarded together", () => {
  assert.deepEqual(LONG_WALLET_LAUNCH_RUNTIME_NAMES, [
    "LONG_WALLET_LAUNCH",
    "LONG_LAUNCH_PROFILE_JSON",
    "LONG_LAUNCH_GUARDS_JSON",
    "LAUNCH_ASSET_SERVICE_ORIGIN",
  ]);
  const local = Object.fromEntries(
    LONG_WALLET_LAUNCH_RUNTIME_NAMES.map((name) => [name, `${name}-VALUE`]),
  );
  for (const name of LONG_WALLET_LAUNCH_RUNTIME_NAMES)
    local[`NEXT_PUBLIC_${name}`] = "LEAK";
  assert.deepEqual(
    apiEnvironment({}, local),
    Object.fromEntries(
      LONG_WALLET_LAUNCH_RUNTIME_NAMES.map((name) => [name, `${name}-VALUE`]),
    ),
  );
});


test("O1 launch settings for both chains remain API-only", () => {
  const expected = ["O1_WALLET_LAUNCH", "O1_LAUNCH_PROFILE_JSON", "O1_LAUNCH_TOKENS_JSON", "O1_BASE_WALLET_LAUNCH", "O1_BASE_LAUNCH_PROFILE_JSON"];
  assert.deepEqual(O1_WALLET_LAUNCH_RUNTIME_NAMES, expected);
  const local = Object.fromEntries(expected.map(name => [name, "EXAMPLE"]));
  assert.deepEqual(apiEnvironment({}, { ...local, NEXT_PUBLIC_O1_BASE_LAUNCH_PROFILE_JSON: "LEAK" }), local);
});
