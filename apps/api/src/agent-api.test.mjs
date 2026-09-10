import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Budget } from "./budget.mjs";
import { ServiceError } from "./errors.mjs";
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

test("opaque lowercase upstream error values are not reflected", async (t) => {
  const { request } = await fixture(t, {
    fetcher: async () => Response.json({ error: "synthetic_opaque_credential" }, { status: 503 }),
  });
  const response = await request("long/artwork-prepare", {
    chainId: 4663,
    wallet,
    draft,
    imageBase64: "aGk=",
  });
  assert.deepEqual(await response.json(), { error: "unavailable" });
});

test("ordered ticker options stop at the first proven available candidate", async (t) => {
  const seen = [];
  const { request } = await fixture(t, {
    adapters: {
      ticker: async (chainId, ticker, pads) => {
        assert.equal(chainId, 4663);
        assert.deepEqual(pads, ["long"]);
        seen.push(ticker);
        return { results: { long: { status: ticker === "SECOND" ? "unreserved" : "reserved" } } };
      },
    },
  });
  const result = await request("long/ticker", { tickers: ["FIRST", "SECOND", "THIRD"] });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    selectedTicker: "SECOND",
    checked: [
      { ticker: "FIRST", status: "reserved" },
      { ticker: "SECOND", status: "unreserved" },
    ],
  });
  assert.deepEqual(seen, ["FIRST", "SECOND"]);
});

test("ordered ticker options return conflict only when every candidate is reserved", async (t) => {
  const seen = [];
  const { request } = await fixture(t, {
    adapters: {
      ticker: async (_, ticker) => {
        seen.push(ticker);
        return { results: { long: { status: "reserved" } } };
      },
    },
  });
  const response = await request("long/ticker", { tickers: ["FIRST", "SECOND"] });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "tickers_unavailable" });
  assert.deepEqual(seen, ["FIRST", "SECOND"]);
});

test("ordered ticker options fail closed on unknown availability and provider exceptions", async (t) => {
  for (const result of [
    undefined,
    {},
    { results: { long: { status: "unverified" } } },
    { results: { long: { status: "available" } } },
    new Error("synthetic provider failure"),
  ]) {
    const seen = [];
    const { request } = await fixture(t, {
      adapters: {
        ticker: async (_, ticker) => {
          seen.push(ticker);
          if (result instanceof Error) throw result;
          return result;
        },
      },
    });
    const response = await request("long/ticker", { tickers: ["FIRST", "SECOND"] });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "unavailable" });
    assert.deepEqual(seen, ["FIRST"]);
  }
});

test("ordered ticker inputs are fully validated and authenticated before any reads", async (t) => {
  let reads = 0;
  const { request } = await fixture(t, {
    adapters: {
      ticker: async () => {
        reads++;
        return {};
      },
    },
  });
  for (const input of [
    { tickers: [] },
    { tickers: "FIRST" },
    { tickers: ["FIRST", "FIRST"] },
    { tickers: ["FIRST", "lowercase"] },
    { tickers: ["FIRST", null] },
    { tickers: ["FIRST", "TOOLONGTICKER"] },
    { tickers: ["FIRST", "WITH SPACE"] },
    { tickers: ["FIRST", "A1"] },
    { tickers: ["FIRST", ""] },
    { tickers: Array.from({ length: 11 }, (_, n) => String.fromCharCode(65 + n)) },
    { ticker: "FIRST", tickers: ["SECOND"] },
    { tickers: ["FIRST"], extra: true },
  ]) {
    assert.equal((await request("long/ticker", input)).status, 400);
  }
  assert.equal(
    (await request("long/ticker", { tickers: ["FIRST"] }, { authorization: "" })).status,
    401,
  );
  assert.equal(reads, 0);
});

test("ordered ticker options accept one or ten candidates and retain the legacy response", async (t) => {
  const calls = [];
  const legacy = {
    chainId: 4663,
    ticker: "LEGACY",
    results: { long: { status: "unreserved", checkedAt: 1 } },
  };
  const { request } = await fixture(t, {
    adapters: {
      ticker: async (_, ticker) => {
        calls.push(ticker);
        return ticker === "LEGACY" ? legacy : { results: { long: { status: "unreserved" } } };
      },
    },
  });
  assert.deepEqual(await (await request("long/ticker", { ticker: "LEGACY" })).json(), legacy);
  assert.equal(
    (await (await request("long/ticker", { tickers: ["SINGLE"] })).json()).selectedTicker,
    "SINGLE",
  );
  assert.equal(
    (
      await (
        await request("long/ticker", {
          tickers: Array.from({ length: 10 }, (_, n) => String.fromCharCode(65 + n)),
        })
      ).json()
    ).selectedTicker,
    "A",
  );
  assert.deepEqual(calls, ["LEGACY", "SINGLE", "A"]);
});

test("ordered ticker lookup stops after the deadline without reading subsequent options", async (t) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const seen = [];
  const { request } = await fixture(t, {
    timeoutMs: 25,
    adapters: {
      ticker: async (_, ticker) => {
        seen.push(ticker);
        await pending;
        return { results: { long: { status: "reserved" } } };
      },
    },
  });
  const response = await request("long/ticker", { tickers: ["FIRST", "SECOND"] });
  assert.equal(response.status, 504);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["FIRST"]);
});

test("ordered ticker options preserve underlying budget backoff without skipping candidates", async (t) => {
  const seen = [];
  const { request } = await fixture(t, {
    adapters: {
      ticker: async (_, ticker) => {
        seen.push(ticker);
        throw new ServiceError("rate_limited", 429, 7);
      },
    },
  });
  const response = await request("long/ticker", { tickers: ["FIRST", "SECOND"] });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.deepEqual(seen, ["FIRST"]);
});

const stonxPair = `stonx-${"d".repeat(24)}`;
const stonxConfig = {
  ...config,
  stonxLaunch: {
    assetOrigin: "https://stonx-assets.example",
    profile: { chainId: 8453, quotes: [{ id: stonxPair, token: { symbol: "NVDA" } }] },
  },
};
const stonxAgent = {
  ...agent,
  clients: agent.clients.map((entry) => ({ ...entry, scopes: [...entry.scopes, "stonx:deploy"] })),
};
const stonxArtwork = { chainId: 8453, wallet, draft, imageBase64: "aGk=" };
const stonxPrepare = {
  chainId: 8453,
  wallet,
  draft,
  pairId: stonxPair,
  publication: { id: artwork, imageHash: hash, metadataHash: hash },
};
const stonxFixture = (t, options = {}) =>
  fixture(t, { config: stonxConfig, agent: stonxAgent, ...options });

test("Stonx scope configuration and discovery expose only permitted launchpads", async (t) => {
  const stonxClient = { ...client, scopes: ["stonx:deploy"] };
  assert.deepEqual(
    readAgentConfig({
      AGENT_API_ENABLED: "true",
      AGENT_API_CLIENTS_JSON: JSON.stringify([stonxClient]),
    }).clients,
    [stonxClient],
  );
  const { request } = await stonxFixture(t, { agent: { ...agent, clients: [stonxClient] } });
  const discovery = await (await request("launchpads")).json();
  assert.equal(discovery.chainId, 4663);
  assert.deepEqual(discovery.launchpads, [
    { id: "stonx", chainId: 8453, pairs: [{ id: stonxPair, token: { symbol: "NVDA" } }] },
  ]);
  assert.equal((await request("long/ticker", { ticker: "COIN" })).status, 403);
  assert.equal(
    (await request("stonx/ticker", { ticker: "COIN" }, { authorization: "" })).status,
    401,
  );
  const longOnly = await stonxFixture(t, { agent });
  assert.equal((await longOnly.request("stonx/ticker", { ticker: "COIN" })).status, 403);
  assert.deepEqual(
    (await (await longOnly.request("launchpads")).json()).launchpads.map((pad) => [
      pad.id,
      pad.chainId,
    ]),
    [["long", 4663]],
  );
});

test("Stonx ticker policy accepts duplicates on chain without registry reads", async (t) => {
  const { request } = await stonxFixture(t, {
    adapters: {
      ticker: async () => {
        throw Error("unexpected registry read");
      },
    },
  });
  assert.deepEqual(await (await request("stonx/ticker", { ticker: "COIN" })).json(), {
    chainId: 8453,
    ticker: "COIN",
    results: { stonx: { status: "unreserved" } },
    tickerPolicy: "duplicates_allowed",
  });
  for (const tickers of [
    ["FIRST"],
    ["FIRST", "SECOND"],
    Array.from({ length: 10 }, (_, n) => String.fromCharCode(65 + n)),
  ]) {
    assert.deepEqual(await (await request("stonx/ticker", { tickers })).json(), {
      selectedTicker: tickers[0],
      checked: [{ ticker: tickers[0], status: "unreserved" }],
      tickerPolicy: "duplicates_allowed",
    });
  }
  for (const input of [
    { tickers: [] },
    { tickers: "FIRST" },
    { tickers: ["FIRST", "FIRST"] },
    { tickers: ["FIRST", "lowercase"] },
    { tickers: ["FIRST", null] },
    { tickers: ["FIRST", "TOOLONGTICKER"] },
    { tickers: ["FIRST", "WITH SPACE"] },
    { tickers: ["FIRST", "A1"] },
    { tickers: ["FIRST", ""] },
    { tickers: Array.from({ length: 11 }, (_, n) => String.fromCharCode(65 + n)) },
    { ticker: "FIRST", tickers: ["SECOND"] },
    { tickers: ["FIRST"], chainId: 8453 },
  ])
    assert.equal((await request("stonx/ticker", input)).status, 400);
});

test("Stonx artwork translates the shared protocol and preserves capability payload and optional metadata", async (t) => {
  const { request, calls } = await stonxFixture(t);
  const enriched = {
    ...stonxArtwork,
    draft: { ...draft, website: "https://coin.example", twitter: "https://x.com/coin" },
  };
  assert.equal((await request("stonx/artwork-prepare", enriched)).status, 200);
  assert.equal(calls[0][0], "https://stonx-assets.example/v1/asset-launch-prepare");
  assert.deepEqual(calls[0][1], { ...enriched, chainId: 4663 });
  assert.equal(calls[0][2].headers["x-fungun-intent"], "asset-launch-prepare");
  assert.equal(calls[0][2].headers.authorization, undefined);
  const publish = { ...enriched, id: artwork, uploadToken: "EXAMPLE_UPLOAD_CAPABILITY" };
  assert.equal((await request("stonx/artwork-publish", publish)).status, 200);
  assert.deepEqual(calls[1][1], { ...publish, chainId: 4663 });
  assert.equal(
    (await request("stonx/prepare", { ...stonxPrepare, draft: enriched.draft })).status,
    200,
  );
  assert.deepEqual(calls[2], ["launch-prepare", { ...stonxPrepare, draft: enriched.draft }]);
  assert.equal((await request("stonx/reserve", { id: launch, binding: hash })).status, 200);
  assert.equal((await request("stonx/status", { id: launch, hash: null })).status, 200);
});

test("Stonx client and route ownership rejects cross-launchpad launch and artwork capabilities", async (t) => {
  for (const originalPad of ["long", "stonx"]) {
    const { request, calls } = await stonxFixture(t);
    const sourceChain = originalPad === "long" ? 4663 : 8453;
    const otherPad = originalPad === "long" ? "stonx" : "long";
    const otherChain = sourceChain === 4663 ? 8453 : 4663;
    const sourceArtwork = { ...stonxArtwork, chainId: sourceChain };
    const sourcePrepare = {
      ...stonxPrepare,
      chainId: sourceChain,
      pairId: originalPad === "long" ? "long-NVDA" : stonxPair,
    };
    assert.equal((await request(`${originalPad}/artwork-prepare`, sourceArtwork)).status, 200);
    assert.equal((await request(`${originalPad}/prepare`, sourcePrepare)).status, 200);
    const before = calls.length;
    for (const [pad, chainId, headers] of [
      [otherPad, otherChain, {}],
      [originalPad, sourceChain, { authorization: bearer(token + "2") }],
    ]) {
      assert.equal(
        (await request(`${pad}/reserve`, { id: launch, binding: hash }, headers)).status,
        404,
      );
      assert.equal(
        (await request(`${pad}/status`, { id: launch, hash: null }, headers)).status,
        404,
      );
      assert.equal(
        (
          await request(
            `${pad}/artwork-status`,
            { chainId, wallet, id: artwork, imageHash: hash, metadataHash: hash },
            headers,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            `${pad}/artwork-publish`,
            { ...sourceArtwork, chainId, id: artwork, uploadToken: "EXAMPLE_UPLOAD_CAPABILITY" },
            headers,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            `${pad}/prepare`,
            { ...sourcePrepare, chainId, pairId: pad === "long" ? "long-NVDA" : stonxPair },
            headers,
          )
        ).status,
        404,
      );
    }
    assert.equal(calls.length, before);
    // Even a repeated prepare returning the same content id cannot claim it across routes.
    assert.equal(
      (await request(`${otherPad}/artwork-prepare`, { ...sourceArtwork, chainId: otherChain }))
        .status,
      404,
    );
  }
});

test("Stonx rejects wrong chain, wallet, launchpad and unsupported pairs before upstream work", async (t) => {
  const { request, calls } = await stonxFixture(t);
  for (const chainId of [4663, 1, "8453", null]) {
    assert.equal(
      (await request("stonx/artwork-prepare", { ...stonxArtwork, chainId })).status,
      400,
    );
    assert.notEqual((await request("stonx/prepare", { ...stonxPrepare, chainId })).status, 200);
  }
  assert.equal(
    (await request("stonx/artwork-prepare", { ...stonxArtwork, wallet: "0x" + "2".repeat(40) }))
      .status,
    403,
  );
  assert.equal(
    (
      await request("stonx/artwork-prepare", {
        ...stonxArtwork,
        draft: { ...draft, launchpad: "longbow" },
      })
    ).status,
    403,
  );
  for (const pairId of [`stonks-${"d".repeat(24)}`, "native", `stonx-${"e".repeat(24)}`])
    assert.equal((await request("stonx/prepare", { ...stonxPrepare, pairId })).status, 400);
  assert.equal(
    (await request("stonx/prepare", { ...stonxPrepare, editableMetadata: true })).status,
    400,
  );
  assert.equal(calls.length, 0);
});

test("Stonx launch flags, asset configuration, failures and limits fail safely", async (t) => {
  const disabled = await stonxFixture(t, { config });
  assert.deepEqual(await (await disabled.request("stonx/artwork-prepare", stonxArtwork)).json(), {
    error: "launch_disabled",
  });
  const noOrigin = await stonxFixture(t, {
    agent: { ...stonxAgent, publicAssetOrigin: undefined },
  });
  assert.deepEqual(await (await noOrigin.request("stonx/artwork-prepare", stonxArtwork)).json(), {
    error: "agent_asset_configuration",
  });
  const failed = await stonxFixture(t, {
    fetcher: async () => {
      throw new Error("EXAMPLE_PRIVATE_PROVIDER_DETAIL");
    },
  });
  assert.deepEqual(await (await failed.request("stonx/artwork-prepare", stonxArtwork)).json(), {
    error: "unavailable",
  });
  assert.equal(
    failed.budget.db.prepare("SELECT count(*) AS count FROM agent_resources").get().count,
    0,
  );
  const limited = await stonxFixture(t);
  limited.budget.debit([["agent:test:artwork", 30, 86400000]], 30);
  assert.equal((await limited.request("stonx/artwork-prepare", stonxArtwork)).status, 429);
  assert.equal(limited.calls.length, 0);
});
