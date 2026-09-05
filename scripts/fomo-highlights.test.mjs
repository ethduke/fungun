import test from "node:test";
import assert from "node:assert/strict";
import { fomoHighlightsHTML, fomoStatus } from "../apps/web/lib/fomo-highlights.mjs";
import { createTrackedFeedHandler } from "../apps/web/lib/tracked-feed-handler.mjs";
import { FomoStore, fomoUsers } from "../apps/api/src/fomo-store.mjs";
import { DatabaseSync } from "node:sqlite";
const token = `0x${"ab".repeat(20)}`;

test("purchase strip renders canonical profile, contract link, time and escaped labels", () => {
  const row = {
    handle: "unipcs",
    label: "<theunipcs>",
    token,
    symbol: "<EXAMPLE>",
    last_bought_at: 1_788_599_999,
    buy_alerts: 1,
  };
  const html = fomoHighlightsHTML({ stream_highlights: [row, row] });
  assert.match(html, /https:\/\/fomo.family\/profile\/unipcs/);
  assert.match(html, new RegExp(`https://gmgn.ai/robinhood/token/${token}`));
  assert.match(html, /@&lt;theunipcs&gt;/);
  assert.match(html, /&lt;EXAMPLE&gt;/);
  assert.match(html, /<time datetime=".*">\(.*\)<\/time>/);
  assert.equal(html.split(" bought ").length, 2);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(
    fomoHighlightsHTML({
      stream_highlights: [
        { ...row, buy_alerts: 0 },
        { ...row, token: "javascript:bad" },
      ],
    }),
    /No confirmed buys recorded yet/,
  );
});

test("health keeps disconnections, delay and incomplete history honest", () => {
  assert.match(fomoStatus({ connected: false }), /disconnected.*History incomplete/);
  assert.match(fomoStatus({ connected: true, delay_seconds: 15 }), /15s delay/);
  assert.match(fomoStatus({}, true), /showing saved buys/);
  assert.match(fomoStatus({ state: "not_configured" }), /not configured/);
});

test("backend snapshot hook persists admissions without a browser, before returning success", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const store = new FomoStore(db, fomoUsers({ runn3rrr: "runn3rrr" }));
  const handle = createTrackedFeedHandler({
    fetcher: async () => Response.json({ pools: [{ token, sym: "EXAMPLE", quote_kind: "eth" }] }),
    onSnapshot: (snapshot) =>
      store.register(snapshot.pools.map((row) => ({ ...row, chain_id: 4663 }))),
  });
  assert.equal((await handle(new Request("http://localhost/api/tracked-feed"))).status, 200);
  assert.equal(store.tokenCount(), 1);
  const failing = createTrackedFeedHandler({
    fetcher: async () => Response.json({ pools: [] }),
    onSnapshot() {
      throw new Error("synthetic storage failure");
    },
  });
  assert.equal((await failing(new Request("http://localhost/api/tracked-feed"))).status, 502);
});
