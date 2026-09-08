import test from "node:test";
import assert from "node:assert/strict";
import { deployAndWait, watchThemes, retryDelay, safeAgentError } from "./run.mjs";

test("one deploy invocation retains intent through preparation, payment and confirmation", async () => {
  let time = 0,
    attempts = 0;
  const keys = [];
  const agent = {
    deploy: async (_, options) => {
      keys.push(options.intentKey);
      attempts++;
      if (attempts === 1) throw new Error("image_job_pending");
      if (attempts === 2) throw new Error("long_address_pending");
      return attempts === 3
        ? { status: "submitted" }
        : { status: "confirmed", asset: "synthetic-result" };
    },
  };
  const result = await deployAndWait(
    agent,
    { name: "Quorvix Lantern", ticker: "QVXL" },
    {
      now: () => time,
      pause: async (ms) => {
        time += ms;
      },
      timeoutMs: 30000,
    },
  );
  assert.equal(result.status, "confirmed");
  assert.equal(new Set(keys).size, 1);
  assert.equal(attempts, 4);
});
test("pending deadline returns recoverable intent and never creates another", async () => {
  let time = 0;
  const keys = [];
  const result = await deployAndWait(
    {
      deploy: async (_, options) => {
        keys.push(options.intentKey);
        return { status: "uncertain", id: "returned-intent" };
      },
    },
    { name: "Quorvix Lantern", ticker: "QVXL" },
    {
      now: () => time,
      pause: async (ms) => {
        time += ms;
      },
      timeoutMs: 11000,
    },
  );
  assert.equal(result.status, "pending");
  assert.equal(result.id, "returned-intent");
  assert.equal(result.intentKey, keys[0]);
  assert.equal(new Set(keys).size, 1);
});
test("watch honors provider retry and continues until signaled", async () => {
  const controller = new AbortController();
  let count = 0;
  const waits = [];
  await watchThemes(
    {
      tick: async () => {
        if (++count === 1) {
          const e = new Error("rate_limited");
          e.retryAfter = 90;
          throw e;
        }
        return { status: "checked" };
      },
    },
    { pollSeconds: 5 },
    {
      signal: controller.signal,
      pause: async (ms) => {
        waits.push(ms);
      },
      onResult: () => controller.abort(),
    },
  );
  assert.deepEqual(waits, [90000]);
  assert.equal(count, 2);
});
test("permanent failures stop without leaking arbitrary provider exception text", async () => {
  const codes = [];
  await assert.rejects(
    watchThemes(
      {
        tick: async () => {
          throw new Error("a-provider-credential-containing-arbitrary-text");
        },
      },
      {},
      { onError: (code) => codes.push(code) },
    ),
  );
  assert.deepEqual(codes, ["agent_failed"]);
  assert.equal(safeAgentError(new Error("private detail")), "agent_failed");
});
test("daily budgets wait until next UTC day and 409 progress is retryable", () => {
  assert.equal(retryDelay(new Error("daily_launch_limit"), Date.UTC(2026, 8, 8, 23, 59)), 60000);
  assert.equal(retryDelay(new Error("image_quote_refreshed")), 5000);
  assert.equal(retryDelay(new Error("contract_unverified")), null);
});
