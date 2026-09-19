// SDK errors may contain RPC URLs, headers or bare credentials. A character
// class is not a safe allowlist: retain only application/protocol constants.
const reasons = new Set([
  "asset_not_deployed_contract", "invalid_exact_evm_scheme",
  "invalid_exact_evm_network_mismatch", "invalid_exact_evm_missing_eip712_domain",
  "invalid_exact_evm_recipient_mismatch", "invalid_exact_evm_signature",
  "invalid_exact_evm_payload_authorization_valid_before",
  "invalid_exact_evm_payload_authorization_valid_after",
  "invalid_exact_evm_authorization_value",
  "invalid_exact_evm_payload_authorization_value_mismatch",
  "invalid_exact_evm_transaction_failed", "invalid_exact_evm_transfer_event_mismatch",
  "invalid_exact_evm_token_name_mismatch", "invalid_exact_evm_token_version_mismatch",
  "invalid_exact_evm_eip3009_not_supported", "invalid_exact_evm_nonce_already_used",
  "invalid_exact_evm_insufficient_balance", "invalid_exact_evm_transaction_simulation_failed",
  "unsupported_payload_type", "invalid_transaction_state", "eip6492_factory_not_allowed",
  "smart_wallet_deployment_failed", "settlement_pending", "settlement_call_not_allowed",
  "settlement_gas_limit_exceeded", "settlement_fee_cap_exceeded", "raw_transaction_disabled",
  "robinhood_usdg_configuration_mismatch",
]);
const startupReasons = new Set([
  "relayer_must_not_receive_payments", "robinhood_usdg_configuration_mismatch",
  ...[
    "x402_facilitator_private_key", "x402_facilitator_bearer_token", "robinhood_rpc",
    "image_max_price_usdg_base_units", "image_payment_recipient", "image_usdg_address",
  ].flatMap(key => [`missing_${key}`, `invalid_${key}`]),
]);

export const safeReason = (value, fallback = "unexpected_error") =>
  reasons.has(value) ? value : fallback;
export const safeStartupReason = value =>
  startupReasons.has(value) ? value : "startup_validation_failed";
