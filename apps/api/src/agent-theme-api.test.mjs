import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { Budget } from "./budget.mjs";
import { AgentThemes } from "./agent-themes.mjs";
import { createAgentHandler } from "./agent-api.mjs";

test("authenticated themes route serves real threshold events and cursor replay", async (t) => {
  const budget = new Budget(":memory:");
  const token = randomBytes(32).toString("hex");
  let reads = 0;
  const themes = new AgentThemes(budget.db, {
    fetchSnapshot: async () => {
      reads++;
      return {
        pools: [1, 2, 3].map((n) => ({
          chain_id: 4663,
          quote_kind: "eth",
          name: "Quorvix Lantern",
          meme: `0x${n.toString(16).padStart(40, "0")}`,
        })),
      };
    },
  });
  const client = {
    id: "themes-example",
    tokenHash: createHash("sha256").update(token).digest("hex"),
    wallet: `0x${"01".repeat(20)}`,
    scopes: ["themes:read"],
  };
  const server = createServer(
    createAgentHandler(
      { config: {}, budget, themes, agent: { enabled: true, clients: [client] } },
      (_, res) => {
        res.statusCode = 404;
        res.end();
      },
    ),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    budget.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const path = "/v1/agent/themes?minimumTokens=3&windowSeconds=3600";
  assert.equal((await fetch(origin + path)).status, 401);
  assert.equal(reads, 0);
  const headers = { ["authorization"]: ["Bearer", token].join(" ") };
  const response = await fetch(origin + path, { headers });
  assert.equal(response.status, 200);
  const first = await response.json();
  assert.equal(first.freshness.status, "fresh");
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].theme.count, 3);
  assert.equal(first.events[0].theme.name, "Quorvix Lantern");
  const next = await (
    await fetch(`${origin}${path}&cursor=${encodeURIComponent(first.nextCursor)}`, { headers })
  ).json();
  assert.equal(next.events.length, 0);
  assert.equal(next.themes.length, 1);
  assert.equal(reads, 1);
  assert.equal((await fetch(`${origin}/v1/agent/launchpads`, { headers })).status, 403);
});
