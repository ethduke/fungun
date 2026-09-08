import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { FungunAgent } from "./index.mjs";
import { safeSdkError, safeAgentError, safeAgentResult } from "./errors.mjs";

const marker = () => randomBytes(24).toString("base64url");
const unsafe = (canary) => Object.assign(new Error(`Transport failed: ${canary}`), {
  cause: { headers: { authorization: canary }, url: `https://example.invalid/${canary}` },
  details: canary,
});
function fixture(fetcher) {
  const agent = Object.create(FungunAgent.prototype);
  agent.url = new URL("https://example.invalid");
  agent.token = marker();
  agent.fetcher = fetcher;
  return agent;
}
async function redacted(operation, canary) {
  await assert.rejects(operation, (error) => {
    assert.equal(inspect(error).includes(canary), false);
    assert.equal(error.cause, undefined);
    assert.equal(error.details, undefined);
    return true;
  });
}
test("SDK drops fetch exception credentials and arbitrary API error bodies", async () => {
  const canary = marker();
  await redacted(() => fixture(async () => { throw unsafe(canary); }).searchLaunchpads(), canary);
  await redacted(() => fixture(async () => new Response(JSON.stringify({ error: canary }), {
    status: 503,
  })).request("launchpads"), canary);
});
test("deploy, resume and watch boundaries drop signer, RPC and filesystem exception details", async () => {
  const canary = marker();
  for (const method of ["deploy", "resume", "tick"]) {
    const agent = fixture();
    agent.journal = { lock: async () => { throw unsafe(canary); } };
    const config = { searchLaunchpads: ["long"], deployLaunchpads: ["long"] };
    await redacted(() => agent[method](config), canary);
  }
});
test("fixed retry codes and bounded retry metadata survive redaction", () => {
  const source = Object.assign(unsafe(marker()), { message: "quote_expired", retryable: true, retryAfter: 100000 });
  const safe = safeSdkError(source);
  assert.equal(safe.message, "quote_expired");
  assert.equal(safe.retryable, true);
  assert.equal(safe.retryAfter, 86400);
  assert.equal(safe.cause, undefined);
  assert.equal(safeAgentError(unsafe(marker())), "agent_failed");
});
test("CLI summaries exclude upstream recovery capabilities, signatures and unexpected fields", () => {
  const canary = marker();
  const result = safeAgentResult([{ status: "confirmed", uploadToken: canary,
    recovery: { capability: canary }, signature: canary, debug: canary }]);
  assert.deepEqual(result, [{ status: "confirmed" }]);
  assert.equal(JSON.stringify(result).includes(canary), false);
});

test("SDK removes malformed JSON echoes and body cleanup errors", async () => {
  const canary = marker();
  await redacted(() => fixture(async () => new Response(`invalid ${canary}`, { status: 200 })).request("launchpads"), canary);
  await redacted(() => fixture(async () => ({ body: { getReader: () => ({
    read: async () => ({ done: true }), cancel: async () => { throw unsafe(canary); },
  }) } })).request("launchpads"), canary);
});
test("SDK normalizes errors thrown inside a recovered intent, not only journal opening", async () => {
  const canary = marker();
  const agent = fixture();
  agent.journal = { lock: async (fn) => fn({ data: { intents: { one: { state: "signing" } } } }) };
  agent.advanceIntent = async () => { throw unsafe(canary); };
  await redacted(() => agent.resume(), canary);
});
