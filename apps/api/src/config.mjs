import { resolve } from "node:path";
import { isAddress, isHex, size } from "viem";
import { ServiceError } from "./errors.mjs";

export function readConfig(env = process.env) {
  const { O1_API_KEY: o1Key = "" } = env;
  const production = env.NODE_ENV === "production";
  const origin = env.APP_ORIGIN || "http://127.0.0.1:3000";
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    (production
      ? url.protocol !== "https:"
      : !["http://127.0.0.1:3000", "http://localhost:3000"].includes(origin))
  )
    throw new ServiceError("invalid_origin_configuration");
  const databasePath = resolve(env.BUDGET_DB_PATH || "local/read-budget.sqlite");
  if (
    production &&
    (databasePath !== "/data/read-budget.sqlite" ||
      !env.READS_MACHINE_ID ||
      env.READS_MACHINE_ID !== env.FLY_MACHINE_ID)
  )
    throw new ServiceError("single_machine_required");

  const rpcUrl = env.ROBINHOOD_RPC_URL || "";
  if (rpcUrl && new URL(rpcUrl).protocol !== "https:")
    throw new ServiceError("invalid_rpc_configuration");
  const registry = env.LONG_TICKER_REGISTRY_ADDRESS || "";
  const codeHash = env.LONG_TICKER_REGISTRY_CODE_HASH || "";
  const longQuotes = (env.LONG_RWA_ALLOWLIST || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (
    (registry && !isAddress(registry)) ||
    (codeHash && (!isHex(codeHash) || size(codeHash) !== 32)) ||
    longQuotes.length > 100 ||
    longQuotes.some((value) => !isAddress(value))
  )
    throw new ServiceError("invalid_long_configuration");
  return {
    production,
    origin,
    databasePath,
    host: production ? "0.0.0.0" : "127.0.0.1",
    port: 8787,
    readsEnabled: env.READ_UPSTREAMS === "true",
    o1Key,
    rpcUrl,
    registry,
    codeHash,
    longQuotes: new Set(longQuotes.map((value) => value.toLowerCase())),
  };
}
