import test from "node:test";
import assert from "node:assert/strict";
import { createFomoRelayHandler } from "./fomo-relay.mjs";

const token = "synthetic-relay-token-32-characters-minimum";
const bearer = ["Bearer", token].join(" ");
function request(handler, url, headers = {}, method = "GET") {
  let body, status;
  const resultHeaders = {};
  handler({ url, headers, method }, {
    setHeader(name, value) { resultHeaders[name] = value; },
    writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); },
  });
  return { status, body, headers: resultHeaders };
}

test("relay authenticates independently, limits input and passes public routes through", () => {
  let calls = 0, fallback = 0;
  const handler = createFomoRelayHandler({ journal(after) { calls++; return { next_cursor: after }; } }, token,
    () => { fallback++; });
  assert.equal(request(handler, "/internal/fomo/events").status, 401);
  assert.equal(request(handler, "/internal/fomo/events", { authorization: "Bearer EXAMPLE" }).status, 401);
  const headers = { authorization: bearer };
  assert.equal(request(handler, "/internal/fomo/events", headers, "POST").status, 405);
  for (const query of ["after=-1", "after=1.5", "after=01", "after=9007199254740992", "after=1&after=2", "token=x"])
    assert.equal(request(handler, `/internal/fomo/events?${query}`, headers).status, 400);
  assert.equal(calls, 0);
  const result = request(handler, "/internal/fomo/events?after=42", headers);
  assert.equal(result.status, 200);
  assert.equal(result.body.next_cursor, 42);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(calls, 1);
  request(handler, "/health");
  assert.equal(fallback, 1);
  assert.equal(request(createFomoRelayHandler({}, "", () => {}), "/internal/fomo/events", headers).status, 404);
});

test("storage errors do not expose exception text", () => {
  const handler = createFomoRelayHandler({ journal() { throw new Error(token); } }, token, () => {});
  const result = request(handler, "/internal/fomo/events", { authorization: bearer });
  assert.equal(result.status, 503);
  assert.doesNotMatch(JSON.stringify(result), /synthetic/);
});
