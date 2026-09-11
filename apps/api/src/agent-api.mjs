import { createHash, timingSafeEqual } from "node:crypto";
import { isAddress, zeroAddress } from "viem";
import { ServiceError, safeError, serviceErrorBody } from "./errors.mjs";
import { validateLongInput } from "./long-live.mjs";
import { validateAssetInput } from "./asset-service.mjs";
import { IMAGE_BYTE_LIMIT } from "./launch-image.mjs";

// Route names bind resources to one launchpad and chain, including O1's two networks.
const targets = {
  long: { chainId: 4663, config: "longLaunch", scope: "long:deploy", registry: true, pair: id => id.startsWith("long-") },
  stonx: { chainId: 8453, config: "stonxLaunch", scope: "stonx:deploy", pair: id => /^stonx-[a-f0-9]{24}$/.test(id) },
  o1: { chainId: 4663, config: "o1Launch", scope: "o1:deploy", pair: id => /^(native|rwa-[a-f0-9]{24}|crypto-USDG)$/.test(id) },
  "o1-base": { chainId: 8453, config: "o1BaseLaunch", scope: "o1:deploy", pair: id => /^(native|rwa-[a-f0-9]{24})$/.test(id) },
};
const deployScopes = [...new Set(Object.values(targets).map(t => t.scope))];
const targetPairs = (target, live) => live?.profile.quotes?.filter(q => target.pair(q.id)) ?? [];

// Only contractually public asset error codes may cross the service boundary.
const assetErrors = new Set([
  "unavailable",
  "not_found",
  "invalid_request",
  "request_too_large",
  "origin_denied",
  "rate_limited",
  "image_size",
  "invalid_wallet",
  "invalid_asset_image",
  "invalid_launch_details",
  "invalid_asset_uri",
  "metadata_size",
  "invalid_asset_approval",
  "asset_approval_changed",
  "asset_approval_expired",
  "asset_busy",
  "asset_publication_uncertain",
  "ipfs_approval_pending",
  "asset_history_full",
  "asset_storage_full",
  "asset_integrity_failed",
  "asset_storage_unavailable",
  "asset_clock_unavailable",
  "asset_uploads_disabled",
  "ipfs_publication_disabled",
  "artwork_daily_limit",
  "artwork_service_limit",
]);

const fail = (code, status = 400) => {
  throw new ServiceError(code, status);
};
const exact = (v, keys) =>
  v &&
  !Array.isArray(v) &&
  typeof v === "object" &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
export function readAgentConfig(env = process.env) {
  if (env.AGENT_API_ENABLED !== "true") return { enabled: false, clients: [] };
  try {
    const clients = JSON.parse(env.AGENT_API_CLIENTS_JSON);
    if (
      !Array.isArray(clients) ||
      !clients.length ||
      clients.length > 100 ||
      clients.some(
        (c) =>
          !exact(c, ["id", "tokenHash", "wallet", "scopes"]) ||
          !/^[a-zA-Z0-9_-]{1,64}$/.test(c.id) ||
          !/^[a-f0-9]{64}$/.test(c.tokenHash) ||
          !isAddress(c.wallet) ||
          c.wallet.toLowerCase() === zeroAddress ||
          !Array.isArray(c.scopes) ||
          !c.scopes.length ||
          c.scopes.some((s) => ![...deployScopes, "themes:read"].includes(s)),
      ) ||
      new Set(clients.map((c) => c.id)).size !== clients.length ||
      new Set(clients.map((c) => c.tokenHash)).size !== clients.length
    )
      throw Error();
    let publicAssetOrigin;
    if (env.ASSET_PUBLIC_ORIGIN) {
      const origin = new URL(env.ASSET_PUBLIC_ORIGIN);
      if (
        origin.protocol !== "https:" ||
        origin.origin !== env.ASSET_PUBLIC_ORIGIN ||
        origin.username ||
        origin.password
      )
        throw Error();
      publicAssetOrigin = origin.origin;
    }
    return {
      enabled: true,
      ...(publicAssetOrigin ? { publicAssetOrigin } : {}),
      clients: clients.map((c) => ({ ...c, wallet: c.wallet.toLowerCase() })),
    };
  } catch {
    throw new ServiceError("agent_configuration");
  }
}
async function json(stream, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) fail("request_too_large", 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("invalid_request");
  }
}
// themes.poll({minimumTokens,windowSeconds,cursor}) returns a JSON value. Authentication,
// scope checks, durable rate limits and the deadline are enforced by this wrapper.
export function createAgentHandler(
  {
    config,
    budget,
    adapters,
    launches,
    themes,
    agent = readAgentConfig(),
    fetcher = fetch,
    timeoutMs = 24000,
  },
  fallback,
) {
  if (agent.enabled)
    budget.db.exec(
      "CREATE TABLE IF NOT EXISTS agent_resources (kind TEXT NOT NULL, id TEXT NOT NULL, client TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE INDEX IF NOT EXISTS agent_resources_client ON agent_resources(client); CREATE TABLE IF NOT EXISTS agent_resource_routes (kind TEXT NOT NULL, id TEXT NOT NULL, launchpad TEXT NOT NULL, chain_id INTEGER NOT NULL, PRIMARY KEY(kind,id))",
    );
  let active = 0;
  const own = (kind, id, client, pad) => {
    // Existing resources predate Stonx and belong to Long on chain 4663.
    const route = budget.db
      .prepare("SELECT launchpad, chain_id FROM agent_resource_routes WHERE kind=? AND id=?")
      .get(kind, id);
    if (
      (route?.launchpad ?? "long") !== pad ||
      (route?.chain_id ?? 4663) !== targets[pad].chainId
    )
      fail("not_found", 404);
    if (
      budget.db.prepare("SELECT client FROM agent_resources WHERE kind=? AND id=?").get(kind, id)
        ?.client !== client.id
    )
      fail("not_found", 404);
  };
  const save = (kind, id, client, pad) => {
    if (
      typeof id !== "string" ||
      !new RegExp(`^[a-f0-9]{${kind === "launch" ? 64 : 48}}$`).test(id)
    )
      fail("unavailable", 503);
    if (
      budget.db.prepare("SELECT client FROM agent_resources WHERE kind=? AND id=?").get(kind, id)
    ) {
      own(kind, id, client, pad);
      return;
    }
    budget.db.exec("BEGIN IMMEDIATE");
    try {
      budget.db.prepare("INSERT INTO agent_resources VALUES (?,?,?)").run(kind, id, client.id);
      budget.db
        .prepare("INSERT INTO agent_resource_routes VALUES (?,?,?,?)")
        .run(kind, id, pad, targets[pad].chainId);
      budget.db.exec("COMMIT");
    } catch (error) {
      budget.db.exec("ROLLBACK");
      throw error;
    }
  };
  return async (request, response) => {
    if (!request.url?.startsWith("/v1/agent/")) return fallback(request, response);
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    const send = (status, value) => {
      if (!response.destroyed && !response.writableEnded) {
        response.statusCode = status;
        response.end(JSON.stringify(value));
      }
    };
    if (!agent.enabled) return send(404, { error: "not_found" });
    if (active >= 8) {
      response.setHeader("retry-after", "2");
      return send(429, { error: "busy" });
    }
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      send(504, { error: "request_timeout" });
      request.destroy();
    }, timeoutMs);
    try {
      const auth = request.headers.authorization;
      if (typeof auth !== "string" || !/^Bearer [\x21-\x7e]{16,512}$/.test(auth))
        fail("unauthorized", 401);
      const hash = createHash("sha256").update(auth.slice(7)).digest();
      let client;
      for (const candidate of agent.clients)
        if (timingSafeEqual(hash, Buffer.from(candidate.tokenHash, "hex"))) client = candidate;
      if (!client) fail("unauthorized", 401);
      const route = new URL(request.url, "http://agent.invalid");
      const themeRoute = route.pathname === "/v1/agent/themes";
      const pad = route.pathname.split("/")[3];
      const target = targets[pad];
      const chainId = target?.chainId;
      const discovery = request.url === "/v1/agent/launchpads" && request.method === "GET";
      if (
        discovery
          ? !client.scopes.some((scope) => deployScopes.includes(scope))
          : !client.scopes.includes(themeRoute ? "themes:read" : target?.scope)
      )
        fail("forbidden", 403);
      budget.debit([
        [`agent:${client.id}:requests`, 60, 60000],
        [`agent:${client.id}:requests`, 2000, 86400000],
      ]);
      budget.request(request.socket.remoteAddress, false);
      if (themeRoute && themes && request.method === "GET") {
        if (
          [...route.searchParams.keys()].some(
            (k) => !["minimumTokens", "windowSeconds", "cursor"].includes(k),
          )
        )
          fail("invalid_request");
        const options = Object.fromEntries(route.searchParams);
        for (const key of ["minimumTokens", "windowSeconds"])
          if (options[key] !== undefined) options[key] = Number(options[key]);
        return send(200, await themes.poll(options));
      }
      const live = target && config[target.config];
      const pairs = target ? targetPairs(target, live) : [];
      if (discovery)
        return send(200, {
          chainId: 4663,
          launchpads: Object.entries(targets).flatMap(([id, entry]) => {
            const quotes = targetPairs(entry, config[entry.config]);
            return client.scopes.includes(entry.scope) && quotes.length
              ? [{ id, chainId: entry.chainId, pairs: quotes.map((q) => ({ id: q.id, token: q.token, ...(q.symbol ? { symbol: q.symbol } : {}) })) }]
              : [];
          }),
        });
      if (
        budget.db
          .prepare("SELECT count(*) AS count FROM agent_resources WHERE client=?")
          .get(client.id).count >= 10000 &&
        /\/(?:artwork-prepare|prepare)$/.test(request.url)
      )
        fail("agent_storage_limit", 429);
      const operation = request.url.replace(`/v1/agent/${pad}/`, "");
      const artwork = operation.startsWith("artwork-");
      const kind = artwork
        ? {
            "artwork-prepare": "launch-prepare",
            "artwork-publish": "launch-publish",
            "artwork-status": "status",
          }[operation]
        : {
            ticker: "ticker",
            prepare: "launch-prepare",
            reserve: "launch-reserve",
            status: "launch-status",
          }[operation];
      if (!request.url.startsWith(`/v1/agent/${pad}/`) || !kind || request.method !== "POST")
        fail("not_found", 404);
      if (
        request.headers["content-type"]?.split(";")[0].trim() !== "application/json" ||
        request.headers["content-encoding"]
      )
        fail("invalid_request", 415);
      const limit =
        artwork && kind !== "status" ? Math.ceil(IMAGE_BYTE_LIMIT / 3) * 4 + 16384 : 16384;
      if (Number(request.headers["content-length"]) > limit) fail("request_too_large", 413);
      const input = await json(request, limit);
      if (controller.signal.aborted) return;
      if (kind === "ticker") {
        const validTicker = (ticker) => typeof ticker === "string" && /^[A-Z]{1,11}$/.test(ticker);
        if (exact(input, ["ticker"]) && validTicker(input.ticker)) {
          if (!target.registry) return send(200, {
            chainId, ticker: input.ticker, results: { [pad]: { status: "unreserved" } },
            tickerPolicy: "duplicates_allowed",
          });
          const result = await adapters.ticker(4663, input.ticker, ["long"]);
          return send(200, pad === "long" ? result : { ...result, results: { [pad]: result.results?.long } });
        }
        if (
          !exact(input, ["tickers"]) ||
          !Array.isArray(input.tickers) ||
          input.tickers.length < 1 ||
          input.tickers.length > 10 ||
          input.tickers.some((ticker) => !validTicker(ticker)) ||
          new Set(input.tickers).size !== input.tickers.length
        )
          fail("invalid_request");
        if (!target.registry)
          return send(200, {
            selectedTicker: input.tickers[0],
            checked: [{ ticker: input.tickers[0], status: "unreserved" }],
            tickerPolicy: "duplicates_allowed",
          });
        const checked = [];
        for (const ticker of input.tickers) {
          if (controller.signal.aborted || response.destroyed) return;
          let value;
          try {
            value = await adapters.ticker(4663, ticker, ["long"]);
          } catch (error) {
            if (controller.signal.aborted || response.destroyed) return;
            if (safeError(error).status === 429) throw error;
            fail("unavailable", 503);
          }
          if (controller.signal.aborted || response.destroyed) return;
          const status = value?.results?.long?.status;
          if (!["reserved", "unreserved"].includes(status)) fail("unavailable", 503);
          checked.push({ ticker, status });
          if (status === "unreserved") return send(200, { selectedTicker: ticker, checked });
        }
        fail("tickers_unavailable", 409);
      }
      if (!live) fail("launch_disabled", 503);
      if (artwork) {
        if (!agent.publicAssetOrigin) fail("agent_asset_configuration", 503);
        if (input?.chainId !== chainId) fail("invalid_request");
        // The shared publication protocol uses 4663 even for Base launches.
        // Keep the public route bound to its chain; translate only this envelope.
        const assetInput = { ...input, chainId: 4663 };
        validateAssetInput(kind, assetInput);
        if (input.wallet.toLowerCase() !== client.wallet || (input.draft && Boolean(input.draft.launchpad)))
          fail("forbidden", 403);
        if (kind !== "launch-prepare") own("artwork", input.id, client, pad);
        else budget.debit([[`agent:${client.id}:artwork`, 30, 86400000]]);
        const upstream = await fetcher(`${live.assetOrigin}/v1/asset-${kind}`, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            origin: config.origin,
            "content-type": "application/json",
            "x-fungun-intent": `asset-${kind}`,
          },
          body: JSON.stringify(assetInput),
        });
        if (upstream.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
          fail("unavailable", 503);
        const value = await json(upstream.body, limit);
        if (!upstream.ok) {
          const retry = Number(upstream.headers.get("retry-after"));
          if (retry > 0 && retry <= 86400) response.setHeader("retry-after", String(retry));
          return send(
            [400, 403, 404, 409, 413, 429, 503].includes(upstream.status) ? upstream.status : 503,
            {
              error: assetErrors.has(value.error) ? value.error : "unavailable",
            },
          );
        }
        if (kind === "launch-prepare") {
          if (
            new URL(value.imageUrl).origin !== agent.publicAssetOrigin ||
            new URL(value.metadataUrl).origin !== agent.publicAssetOrigin
          )
            fail("invalid_asset_response", 503);
          value.assetOrigin = agent.publicAssetOrigin;
          save("artwork", value.id, client, pad);
        }
        return send(upstream.status, value);
      }
      const validated = validateLongInput(kind, input);
      if (kind === "launch-prepare") {
        if (validated.chainId !== chainId || validated.wallet !== client.wallet)
          fail("forbidden", 403);
        if (!pairs.some((q) => q.id === validated.pairId)) fail("unsupported_pair");
        own("artwork", validated.publication.id, client, pad);
        budget.debit([[`agent:${client.id}:prepare`, 30, 86400000]]);
      } else own("launch", validated.id, client, pad);
      const value = await launches.run(kind, validated);
      if (kind === "launch-prepare") save("launch", value.id ?? value.recovery?.id, client, pad);
      send(200, value);
    } catch (error) {
      const safe = safeError(error);
      if (safe.retryAfter) response.setHeader("retry-after", String(safe.retryAfter));
      send(safe.status, serviceErrorBody(safe));
    } finally {
      clearTimeout(timer);
      active--;
    }
  };
}
