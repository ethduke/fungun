import assert from "node:assert/strict";
import test from "node:test";
import { apiEnvironment, API_RUNTIME_NAMES } from "./runtime-env.mjs";

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
