import { readStonksConfig } from './stonks-live.mjs';
import { readO1LiveConfig, readO1BaseLiveConfig } from "./o1-live.mjs";
import { readPonsFeeProfile } from "./pons-fees.mjs";
import { readPonsLiveConfig } from "./pons-live.mjs";
import { readLongLiveConfig } from "./long-live.mjs";
import { resolve } from "node:path";
import { isAddress, isHex, size } from "viem";
import { ServiceError } from "./errors.mjs";
import { readRuntimeFeeContracts } from "./o1-fee-profiles.mjs";

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
      : url.protocol !== "http:" ||
        !["127.0.0.1", "localhost"].includes(url.hostname) ||
        !/^\d+$/.test(url.port) || Number(url.port) < 1024)
  )
    throw new ServiceError("invalid_origin_configuration");
  const port = Number(env.READ_SERVICE_PORT || 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || (production && port !== 8787))
    throw new ServiceError("invalid_port_configuration");
  const databasePath = resolve(env.BUDGET_DB_PATH || "local/read-budget.sqlite");
  if (
    production &&
    (databasePath !== "/data/read-budget.sqlite" ||
      !env.READS_MACHINE_ID ||
      env.READS_MACHINE_ID !== env.FLY_MACHINE_ID)
  )
    throw new ServiceError("single_machine_required");

  const rpcUrl = env.ROBINHOOD_RPC || env.ROBINHOOD_RPC_URL || "";
  if (rpcUrl && new URL(rpcUrl).protocol !== "https:")
    throw new ServiceError("invalid_rpc_configuration");
  const baseRpcUrl = env.BASE_RPC_URL || "";
  if (baseRpcUrl && new URL(baseRpcUrl).protocol !== "https:")
    throw new ServiceError("invalid_rpc_configuration");
  const rpcBatchRequests = env.RPC_BATCH_REQUESTS ?? "";
  if (!["", "true", "false"].includes(rpcBatchRequests))
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
    longQuotes.length > 512 ||
    longQuotes.some((value) => !isAddress(value))
  )
    throw new ServiceError("invalid_long_configuration");
  const longLaunch = readLongLiveConfig(env);
  return {
    stonksLaunch: readStonksConfig(env),
    longLaunch,
    ponsLaunch: readPonsLiveConfig(env),
    ponsFees: readPonsFeeProfile(env.PONS_FEE_PROFILE_JSON),
    longbowLaunch: readLongLiveConfig(env, "longbow"),
    o1Launch: readO1LiveConfig(env, longLaunch),
    o1BaseLaunch: readO1BaseLiveConfig(env),
    production,
    origin,
    databasePath,
    host: production ? "0.0.0.0" : "127.0.0.1",
    port,
    readsEnabled: env.READ_UPSTREAMS === "true",
    o1Key,
    rpcUrl,
    baseRpcUrl,
    rpcBatchRequests: rpcBatchRequests !== "false",
    feesEnabled: env.READ_FEES === "true",
    claimsEnabled: env.WALLET_CLAIMS === "true",
    feeContracts: readRuntimeFeeContracts(env.FEE_CONTRACTS_JSON || undefined),
    registry,
    codeHash,
    longQuotes: new Set(longLaunch ? longLaunch.profile.quotes.map(q => q.token.address) : longQuotes.map((value) => value.toLowerCase())),
  };
}
