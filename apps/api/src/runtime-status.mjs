import { readConfig } from "./config.mjs";

export function runtimeStatus(env) {
  let config;
  try {
    config = readConfig(env);
  } catch {
    return {
      configuration: "invalid",
      message:
        "Runtime settings could not be validated. Check the ignored environment file or Fly secrets.",
      features: [],
    };
  }
  const present = (value) => typeof value === "string" && value.trim().length > 0;
  const o1 = ["O1_API_KEY", present(config.o1Key)];
  const rpc = ["ROBINHOOD_RPC", present(config.rpcUrl)];
  const lockedFees = (padId) => [
    `FEE_CONTRACTS_JSON.${padId}`,
    !!(config.feeContracts[padId]?.pools.length || config.feeContracts[padId]?.discovery),
  ];
  const reads = ["READ_UPSTREAMS"];
  const fees = ["READ_FEES"];
  const claims = ["READ_FEES", "WALLET_CLAIMS"];
  const feature = (id, requirements, switches) => {
    const missing = requirements.filter(([, configured]) => !configured).map(([name]) => name);
    const disabled = switches.filter((name) => env[name] !== "true");
    return {
      id,
      missing,
      disabled,
      status: missing.length
        ? "missing_configuration"
        : disabled.length
          ? "disabled"
          : "needs_live_verification",
    };
  };
  return {
    configuration: "valid",
    message:
      "Configuration presence only; no live verification, requests or writes were performed.",
    features: [
      feature("o1_catalog", [o1], reads),
      feature(
        "long_catalog_subset",
        [o1, ["LONG_RWA_ALLOWLIST", config.longQuotes.size > 0]],
        reads,
      ),
      feature(
        "long_ticker",
        [
          rpc,
          ["LONG_TICKER_REGISTRY_ADDRESS", !!config.registry],
          ["LONG_TICKER_REGISTRY_CODE_HASH", !!config.codeHash],
        ],
        reads,
      ),
      feature("o1_indexed_fees", [o1], fees),
      ...["long", "longbow"].flatMap((padId) => [
        feature(`${padId}_locked_pool_fees`, [rpc, lockedFees(padId)], fees),
        feature(`${padId}_locked_pool_claims`, [rpc, lockedFees(padId)], claims),
      ]),
      feature(
        "o1_base_live_fees_and_claims",
        [
          o1,
          ["BASE_RPC_URL", present(config.baseRpcUrl)],
          [
            "FEE_CONTRACTS_JSON.o1",
            config.feeContracts.o1.some((profile) => profile.chainId === 8453),
          ],
          ["FEE_CONTRACTS_JSON.baseOracle", !!config.feeContracts.baseOracle],
        ],
        claims,
      ),
      feature(
        "o1_robinhood_claims",
        [
          o1,
          rpc,
          [
            "FEE_CONTRACTS_JSON.o1",
            config.feeContracts.o1.some((profile) => profile.chainId === 4663),
          ],
        ],
        claims,
      ),
      ...["launch_execution", "image_storage", "paid_image_generation"].map((id) => ({
        id,
        status: "not_implemented",
        missing: [],
        disabled: [],
      })),
    ],
  };
}
