import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Budget } from "./budget.mjs";
import { createAgentHandler, readAgentConfig } from "./agent-api.mjs";
const wallet = "0x" + "1".repeat(40),
  artwork = "a".repeat(48),
  launch = "b".repeat(64),
  hash = "c".repeat(64);
const token = "EXAMPLE_AGENT_TEST_CREDENTIAL";
const bearer = (value = token) => ["Bearer", value].join(" ");
const client = {
  id: "test",
  wallet,
  tokenHash: createHash("sha256").update(token).digest("hex"),
  scopes: ["long:deploy", "themes:read"],
};
const agent = {
  enabled: true,
  publicAssetOrigin: "https://assets.example",
  clients: [
    client,
    {
      ...client,
      id: "other",
      tokenHash: createHash("sha256")
        .update(token + "2")
        .digest("hex"),
    },
  ],
};
const draft = { name: "Coin", ticker: "COIN", description: "" };
const config = {
  origin: "https://app.example",
  longLaunch: {
    assetOrigin: "https://assets.example",
    profile: { quotes: [{ id: "long-NVDA", token: { symbol: "NVDA" } }] },
  },
};
async function fixture(t, options = {}) {
  const budget = new Budget(":memory:");
  let calls = [];
  const dependencies = {
    config,
    budget,
    agent,
    adapters: { ticker: async (...args) => ({ args }) },
    launches: {
      run: async (kind, input) => {
        calls.push([kind, input]);
        return { id: launch, status: "prepared" };
      },
    },
    fetcher: async (url, opts) => {
      calls.push([url, JSON.parse(opts.body), opts]);
      return Response.json({
        id: artwork,
        status: "prepared",
        imageUrl: "https://assets.example/ipfs/example-image",
        metadataUrl: "https://assets.example/ipfs/example-metadata",
      });
    },
    ...options,
  };
  const server = createServer(
    createAgentHandler(dependencies, (_, res) => {
      res.statusCode = 404;
      res.end();
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    budget.close();
  });
  const request = async (path, body, headers = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}/v1/agent/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: bearer(), "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { request, budget, calls, dependencies };
}
test("disabled by default and strict hashed credential configuration", () => {
  assert.equal(readAgentConfig({}).enabled, false);
  assert.deepEqual(
    readAgentConfig({
      AGENT_API_ENABLED: "true",
      AGENT_API_CLIENTS_JSON: JSON.stringify([client]),
    }),
    { enabled: true, clients: [client] },
  );
  for (const change of [
    { tokenHash: token },
    { wallet: "bad" },
    { scopes: ["admin"] },
    { token: "secret" },
  ])
    assert.throws(() =>
      readAgentConfig({
        AGENT_API_ENABLED: "true",
        AGENT_API_CLIENTS_JSON: JSON.stringify([{ ...client, ...change }]),
      }),
    );
});
test("HTTP bearer auth, scopes, exact payload and fixed chain", async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request("launchpads", undefined, { authorization: "" })).status, 401);
  assert.equal(
    (await request("launchpads", undefined, { authorization: bearer(token + "wrong") })).status,
    401,
  );
  assert.equal(
    (await request("long/ticker", { ticker: "COIN", privateKey: "EXAMPLE" })).status,
    400,
  );
  assert.deepEqual((await (await request("long/ticker", { ticker: "COIN" })).json()).args, [
    4663,
    "COIN",
    ["long"],
  ]);
  assert.equal(
    (
      await request("long/artwork-prepare", {
        chainId: 4663,
        wallet: "0x" + "2".repeat(40),
        draft,
        imageBase64: "aGk=",
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("long/artwork-prepare", { chainId: 8453, wallet, draft, imageBase64: "aGk=" }))
      .status,
    400,
  );
});
test("artwork proxy pins origin and intents, persists ownership and permits retry", async (t) => {
  const { request, calls, budget } = await fixture(t);
  const input = { chainId: 4663, wallet, draft, imageBase64: "aGk=" };
  assert.equal((await request("long/artwork-prepare", input)).status, 200);
  assert.equal(calls[0][0], "https://assets.example/v1/asset-launch-prepare");
  assert.equal(calls[0][2].headers["x-fungun-intent"], "asset-launch-prepare");
  assert.equal(calls[0][2].headers.authorization, undefined);
  const prepare = {
    chainId: 4663,
    wallet,
    draft,
    pairId: "long-NVDA",
    publication: { id: artwork, imageHash: hash, metadataHash: hash },
  };
  assert.equal((await request("long/prepare", prepare)).status, 200);
  assert.equal((await request("long/prepare", prepare)).status, 200);
  assert.equal(
    budget.db.prepare("SELECT client FROM agent_resources WHERE id=?").get(launch).client,
    "test",
  );
  assert.equal((await request("long/reserve", { id: launch, binding: hash })).status, 200);
  assert.equal(
    (
      await request(
        "long/status",
        { id: launch, hash: null },
        { authorization: bearer(token + "2") },
      )
    ).status,
    404,
  );
  assert.equal(
    (await request("long/prepare", prepare, { authorization: bearer(token + "2") })).status,
    404,
  );
  assert.equal(
    (
      await request(
        "long/artwork-status",
        { chainId: 4663, wallet, id: artwork, imageHash: hash, metadataHash: hash },
        { authorization: bearer(token + "2") },
      )
    ).status,
    404,
  );
});
test("durable client rate limit and safe upstream errors", async (t) => {
  const { request, budget } = await fixture(t);
  budget.debit([[`agent:test:requests`, 60, 60000]], 30);
  budget.debit([[`agent:test:requests`, 60, 60000]], 30);
  const limited = await request("launchpads");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});
test("raw exceptions never returned and upstream retry hints preserved", async (t) => {
  const { request } = await fixture(t, {
    fetcher: async () =>
      Response.json(
        { error: "asset_busy", secret: "EXAMPLE" },
        { status: 429, headers: { "retry-after": "2" } },
      ),
  });
  const response = await request("long/artwork-prepare", {
    chainId: 4663,
    wallet,
    draft,
    imageBase64: "aGk=",
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "2");
  assert.deepEqual(await response.json(), { error: "asset_busy" });
});
test("themes shares auth, rates and strict query parsing", async (t) => {
  const { request } = await fixture(t, { themes: { poll: async (options) => ({ options }) } });
  assert.deepEqual(await (await request("themes?minimumTokens=3&windowSeconds=60")).json(), {
    options: { minimumTokens: 3, windowSeconds: 60 },
  });
  assert.equal((await request("themes?privateKey=secret")).status, 400);
});
test("scopes deny deploy and unexpected exceptions are sanitized", async (t) => {
  const { request } = await fixture(t, {
    agent: { enabled: true, clients: [{ ...client, scopes: ["themes:read"] }] },
  });
  assert.equal((await request("launchpads")).status, 403);
});
test("oversized requests are rejected before body processing", async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request("long/ticker", { ticker: "A".repeat(17000) })).status, 413);
});
test("unexpected provider failure is redacted", async (t) => {
  const { request } = await fixture(t, {
    fetcher: async () => {
      throw new Error("sensitive provider details");
    },
  });
  const response = await request("long/artwork-prepare", {
    chainId: 4663,
    wallet,
    draft,
    imageBase64: "aGk=",
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "unavailable" });
});
test("deadline terminates stalled upstream work", async (t) => {
  const { request } = await fixture(t, {
    timeoutMs: 25,
    fetcher: async (_, options) =>
      new Promise((_, reject) =>
        options.signal.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
  });
  const response = await request("long/artwork-prepare", {
    chainId: 4663,
    wallet,
    draft,
    imageBase64: "aGk=",
  });
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "request_timeout" });
});
test("prepare resumes a submitted launch recovery envelope", async (t) => {
  const { request, budget } = await fixture(t, {
    launches: { run: async () => ({ recovery: { id: launch, binding: hash, hash: "0x" + hash } }) },
  });
  budget.db
    .prepare("INSERT INTO agent_resources VALUES (?,?,?)")
    .run("artwork", artwork, client.id);
  const payload = {
    chainId: 4663,
    wallet,
    draft,
    pairId: "long-NVDA",
    publication: { id: artwork, imageHash: hash, metadataHash: hash },
  };
  for (let retry = 0; retry < 2; retry++) {
    const response = await request("long/prepare", payload);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).recovery.id, launch);
  }
  assert.equal(
    budget.db
      .prepare("SELECT client FROM agent_resources WHERE kind=? AND id=?")
      .get("launch", launch).client,
    client.id,
  );
});

test("public artwork origin is pinned independently of the private service origin", async (t) => {
  const { request } = await fixture(t, {
    fetcher: async () =>
      Response.json({
        id: artwork,
        imageUrl: "https://substituted.example.invalid/image",
        metadataUrl: "https://substituted.example.invalid/metadata",
      }),
  });
  assert.equal(
    (await request("long/artwork-prepare", { chainId: 4663, wallet, draft, imageBase64: "aGk=" }))
      .status,
    503,
  );
  for (const ASSET_PUBLIC_ORIGIN of ["http://example.invalid", "https://example.invalid/path"])
    assert.throws(() =>
      readAgentConfig({
        AGENT_API_ENABLED: "true",
        AGENT_API_CLIENTS_JSON: JSON.stringify([client]),
        ASSET_PUBLIC_ORIGIN,
      }),
    );
});
