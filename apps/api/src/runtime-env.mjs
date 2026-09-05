export const LONG_WALLET_LAUNCH_RUNTIME_NAMES = Object.freeze([
  "LONG_WALLET_LAUNCH",
  "LONG_LAUNCH_PROFILE_JSON",
  "LONG_LAUNCH_GUARDS_JSON",
  "LAUNCH_ASSET_SERVICE_ORIGIN",
]);

export const API_RUNTIME_NAMES = Object.freeze([
  "NODE_ENV",
  "FOMO_API_KEY",
  "FOMO_ENABLED",
  "FOMO_USERS_PATH",
  "APP_ORIGIN",
  "READ_SERVICE_PORT",
  "BUDGET_DB_PATH",
  "READS_MACHINE_ID",
  "FLY_MACHINE_ID",
  "READ_UPSTREAMS",
  "READ_FEES",
  "WALLET_CLAIMS",
  "O1_API_KEY",
  "ROBINHOOD_RPC",
  "ROBINHOOD_RPC_URL",
  "BASE_RPC_URL",
  "RPC_BATCH_REQUESTS",
  ...LONG_WALLET_LAUNCH_RUNTIME_NAMES,
  "LONG_TICKER_REGISTRY_ADDRESS",
  "LONG_TICKER_REGISTRY_CODE_HASH",
  "LONG_RWA_ALLOWLIST",
  "FEE_CONTRACTS_JSON",
]);

const SYSTEM_NAMES = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"];

export function apiEnvironment(inherited = {}, local = {}) {
  const selected = {};
  for (const name of SYSTEM_NAMES)
    if (Object.hasOwn(inherited, name) && typeof inherited[name] === "string")
      selected[name] = inherited[name];
  for (const name of API_RUNTIME_NAMES) {
    const source = Object.hasOwn(inherited, name) ? inherited : local;
    if (typeof source[name] === "string") selected[name] = source[name];
  }
  return selected;
}
