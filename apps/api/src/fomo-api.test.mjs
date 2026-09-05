import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHandler } from "./service.mjs";
import { apiEnvironment } from "./runtime-env.mjs";

test("FOMO API is a cached read with existing origin and exact-input protection", async (t) => {
  let snapshots = 0;
  const origin = "http://127.0.0.1:3000";
  const server = createServer(
    createHandler({ origin }, { request() {} }, null, null, null, null, {
      snapshot() {
        snapshots++;
        return { stream_highlights: [], connected: false, history_complete: false };
      },
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/v1/fomo`;
  const post = (body, extra = {}) =>
    fetch(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { origin, "content-type": "application/json", "x-fungun-intent": "fomo", ...extra },
    });
  assert.equal((await post({}, { origin: "https://other.invalid" })).status, 403);
  assert.equal((await post({ token: "arbitrary" })).status, 400);
  const response = await post({});
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).stream_highlights, []);
  assert.equal(snapshots, 1);
});

test("FOMO key and watchlist configuration are forwarded only through API runtime allowlist", () => {
  const result = apiEnvironment(
    {},
    { FOMO_API_KEY: "EXAMPLE", FOMO_ENABLED: "1", FOMO_USERS_PATH: "/data/users.json" },
  );
  assert.equal(result.FOMO_API_KEY, "EXAMPLE");
  assert.equal(result.FOMO_ENABLED, "1");
  assert.equal(result.FOMO_USERS_PATH, "/data/users.json");
});
