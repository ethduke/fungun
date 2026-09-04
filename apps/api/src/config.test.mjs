import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "./config.mjs";

test("RPC request transport defaults to batches and accepts only explicit boolean settings", () => {
  assert.equal(readConfig({}).rpcBatchRequests, true);
  assert.equal(readConfig({ RPC_BATCH_REQUESTS: "" }).rpcBatchRequests, true);
  assert.equal(readConfig({ RPC_BATCH_REQUESTS: "true" }).rpcBatchRequests, true);
  assert.equal(readConfig({ RPC_BATCH_REQUESTS: "false" }).rpcBatchRequests, false);
  for (const value of ["0", "1", "TRUE", "False", " true", "false ", true, false])
    assert.throws(() => readConfig({ RPC_BATCH_REQUESTS: value }), {
      code: "invalid_rpc_configuration",
    });
});

test("local API ports and exact loopback web origins can be isolated per worktree", () => {
  assert.equal(readConfig({}).port, 8787);
  for (const [origin, port] of [
    ["http://127.0.0.1:3011", "8788"],
    ["http://localhost:1024", "1024"],
    ["http://127.0.0.1:65535", "65535"],
  ]) {
    const config = readConfig({ APP_ORIGIN: origin, READ_SERVICE_PORT: port });
    assert.equal(config.origin, origin);
    assert.equal(config.port, Number(port));
    assert.equal(config.host, "127.0.0.1");
  }
});

test("custom local configuration still rejects non-loopback origins and invalid ports", () => {
  for (const port of ["0", "1023", "65536", "-8788", "8788.5", "NaN", "Infinity"])
    assert.throws(() => readConfig({ READ_SERVICE_PORT: port }), {
      code: "invalid_port_configuration",
    });
  for (const origin of [
    "http://127.0.0.1",
    "http://127.0.0.1:1023",
    "http://192.0.2.1:3011",
    "http://example.invalid:3011",
    "https://127.0.0.1:3011",
    "http://127.0.0.1:3011/fees",
    "http://user@127.0.0.1:3011",
  ])
    assert.throws(() => readConfig({ APP_ORIGIN: origin, READ_SERVICE_PORT: "8788" }), {
      code: "invalid_origin_configuration",
    });
});

test("production keeps HTTPS and the fixed API port with its single-machine storage boundary", () => {
  const env = {
    NODE_ENV: "production",
    APP_ORIGIN: "https://app.example.invalid",
    BUDGET_DB_PATH: "/data/read-budget.sqlite",
    READS_MACHINE_ID: "EXAMPLE",
    FLY_MACHINE_ID: "EXAMPLE",
  };
  assert.equal(readConfig(env).port, 8787);
  assert.equal(readConfig(env).host, "0.0.0.0");
  assert.equal(readConfig({ ...env, READ_SERVICE_PORT: "8787" }).port, 8787);
  assert.throws(() => readConfig({ ...env, READ_SERVICE_PORT: "8788" }), {
    code: "invalid_port_configuration",
  });
  assert.throws(() => readConfig({ ...env, APP_ORIGIN: "http://app.example.invalid" }), {
    code: "invalid_origin_configuration",
  });
  assert.throws(() => readConfig({ ...env, BUDGET_DB_PATH: "/tmp/read-budget.sqlite" }), {
    code: "single_machine_required",
  });
});
