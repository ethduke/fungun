import { pathToFileURL } from "node:url";
import { readJson } from "../apps/api/src/upstream.mjs";
import { parseCatalog } from "../apps/web/lib/read-service.ts";

const ORIGIN = "http://127.0.0.1:3000";
const onlyKeys = (value, allowed) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key));

export async function verifyLocalCatalog(chainId, fetcher = fetch) {
  if (![4663, 8453].includes(chainId))
    return { status: "invalid_chain", message: "Choose Robinhood (4663) or Base (8453)." };
  try {
    const response = await fetcher(`${ORIGIN}/api/catalog`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-fungun-intent": "catalog",
      },
      body: JSON.stringify({ chainId }),
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(24_000),
    });
    const value = await readJson(response, 128 * 1024);
    const catalog = parseCatalog(value, chainId);
    if (
      !onlyKeys(value, ["chainId", "pads", "checkedAt", "expiresAt", "serverTime"]) ||
      !Number.isFinite(value.serverTime) ||
      value.expiresAt <= value.serverTime ||
      value.expiresAt - value.serverTime > 300_000 ||
      Object.values(catalog.pads).some(
        (pad) =>
          !onlyKeys(pad, ["status", "pairs"]) ||
          (pad.status === "unavailable" && pad.pairs.length > 0) ||
          pad.pairs.some((pair) => !onlyKeys(pair, ["id", "symbol"])),
      )
    )
      return {
        chainId,
        status: "invalid_response",
        message: "Catalog response failed validation.",
      };
    return {
      chainId,
      status: catalog.pads.o1.status === "ready" ? "verified" : "unavailable",
      pads: Object.fromEntries(
        Object.entries(catalog.pads).map(([id, pad]) => [
          id,
          { status: pad.status, pairCount: pad.pairs.length },
        ]),
      ),
    };
  } catch (error) {
    if (error?.status === 429)
      return {
        chainId,
        status: "rate_limited",
        retryAfter: error.retryAfter,
        message: "Read limit reached. Wait before running another check; no retry was sent.",
      };
    return {
      chainId,
      status: "unavailable",
      message:
        "Catalog verification failed. Check that the local webview and read API are running.",
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["4663", "8453"].includes(args[0])) {
    console.error("Usage: npm run verify:catalog:local -- 4663|8453");
    process.exitCode = 1;
  } else {
    const report = await verifyLocalCatalog(Number(args[0]));
    console.log(JSON.stringify(report));
    if (report.status !== "verified") process.exitCode = 1;
  }
}
