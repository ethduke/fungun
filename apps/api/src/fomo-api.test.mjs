import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHandler } from "./service.mjs";
import { DatabaseSync } from "node:sqlite";
import { createFomoService } from "./fomo-service.mjs";
import { apiEnvironment } from "./runtime-env.mjs";
import { NarrativeStore } from "./narrative-store.mjs";

test("public snapshot includes shared persistent narrative arrivals", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const journal = new NarrativeStore(db);
  journal.observe([1, 2].map((i) => ({
    meme: `0x${i.toString(16).padStart(40, '0')}`, name: 'Dogs', quote_kind: 'eth',
  })));
  const service = createFomoService(db, {});
  assert.deepEqual(service.snapshot().narratives, journal.snapshot());
  assert.equal(service.snapshot().narratives[0].count, 2);
  await service.stop();
});

test("FOMO API is a cached read with existing origin and exact-input protection", async (t) => {
  let snapshots = 0;
  const origin = "http://127.0.0.1:3000";
  const server = createServer(
    createHandler({ origin }, { request() {} }, null, null, null, {
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
    {
      FOMO_API_KEY: "EXAMPLE",
      FOMO_ENABLED: "1",
      FOMO_RELAY_TOKEN: "synthetic-private-token",
      FOMO_USERS_PATH: "/data/users.json",
      FOMO_MAX_CONNECTIONS_5M: "72",
    },
  );
  assert.equal(result.FOMO_API_KEY, "EXAMPLE");
  assert.equal(result.FOMO_RELAY_TOKEN, "synthetic-private-token");
  assert.equal(result.FOMO_ENABLED, "1");
  assert.equal(result.FOMO_MAX_CONNECTIONS_5M, "72");
  assert.equal(result.FOMO_USERS_PATH, "/data/users.json");
});

test("service applies the configured connection limit without opening a socket when disabled", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const service = createFomoService(db, { FOMO_MAX_CONNECTIONS_5M: "72" });
  service.start();
  assert.equal(service.snapshot().max_connections_5m, 72);
  assert.equal(service.snapshot().connections_24h, 0);
  assert.equal(service.snapshot().history_complete, false);
  await service.stop();
});

test("shared journal covers both watchlists while public highlights retain the website filter", async (t) => {
  const { FomoStore, fomoUsers } = await import("./fomo-store.mjs");
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const service = createFomoService(db, {});
  const store = new FomoStore(db, fomoUsers({ runn3rrr: "runn3rrr", aurelius0121: "Aurelius0121" }));
  const token = `0x${"ab".repeat(20)}`;
  store.register([{ token, sym: "TEST", chain_id: 4663, quote_kind: "eth" }]);
  for (const trader of ["runn3rrr", "aurelius0121"]) store.ingest({
    type: "alert", id: trader, trader, tokenAddress: token, chainId: 4663,
    token: "TEST", alertType: "buy", ts: Date.now(),
  });
  assert.equal(service.journal(0).events.length, 2);
  assert.deepEqual(service.snapshot().stream_highlights.map((row) => row.handle), ["runn3rrr"]);
  await service.stop();
});
