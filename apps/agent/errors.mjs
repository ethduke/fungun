export const retries = new Set([
  "rate_limited",
  "busy",
  "upstream_unavailable",
  "read_service_unavailable",
  "unavailable",
  "timeout",
  "fetch failed",
  "long_address_pending",
  "quote_expired",
  "asset_busy",
  "asset_publication_uncertain",
  "image_job_pending",
  "image_retry_later",
  "image_request_uncertain",
  "image_recovery_unavailable",
  "image_quote_refreshed",
  "image_quote_unavailable",
  "image_payment_uncertain",
  "daily_launch_limit",
  "daily_spend_limit",
  "image_daily_budget",
]);
const visible = new Set([
  "asset_approval_expired", "ticker_reserved", "https_required", "image_required",
  "publication_changed", "wrong_signer", "broadcast_uncertain", "invalid_theme_limit",
  "launch_transaction_changed", "nonce_limit", "launch_simulation_failed",
  "journal_permissions", "journal_symlink", "journal_size", "journal_version",
  "journal_size_or_permissions", "journal_identity_missing",

  ...retries,
  "agent_configuration",
  "unsupported_launchpad",
  "journal_locked",
  "daily_reservation_expired",
  "unresolved_intent",
  "contract_unverified",
  "nonce_changed",
  "insufficient_funds",
  "intent_input_changed",
  "spend_limit",
  "wrong_chain",
  "image_generator_required",
  "response_size",
  "journal_identity_changed",
  "image_job_terminal",
  "image_payment_not_allowed",
  "image_config_invalid",
  "image_journal_permissions",
  "image_signing_failed",
  "invalid_limits",
  "invalid_launch_details",
  "invalid_image_mode",
  "unauthorized",
  "forbidden",
  "invalid_theme",
  "theme_cursor_expired",
  "image_journal_full",
  "launch_unknown",
  "launch_outcome_pending",
  "launch_failed",
  "invalid_runtime",
  "invalid_input",
  "invalid_wait_settings",
  "aborted",
  "image_signer_mismatch",
]);
export const safeAgentError = (error) =>
  visible.has(error?.message) ? error.message : "agent_failed";

// A new Error deliberately drops transport details, request headers, signed bytes and causes.
export function safeSdkError(error) {
  const safe = new Error(safeAgentError(error));
  if (error?.retryable === true || ["TypeError", "TimeoutError", "AbortError"].includes(error?.name))
    safe.retryable = true;
  if (typeof error?.retryAfter === "number" && Number.isFinite(error.retryAfter))
    safe.retryAfter = Math.min(86400, Math.max(1, error.retryAfter));
  return safe;
}

// CLI output is a public progress summary, never a dump of upstream response objects.
export function safeAgentResult(value) {
  if (Array.isArray(value)) return value.map(safeAgentResult);
  const out = {};
  const statuses = new Set([
    "confirmed", "failed", "skipped", "pending", "submitted", "confirming", "uncertain",
    "retryable", "wallet", "unknown", "artwork_retry", "artwork_pending", "checked", "stale",
  ]);
  out.status = statuses.has(value?.status) ? value.status : "pending";
  for (const key of ["id", "hash", "asset", "paidGasWei"]) {
    const pattern = {
      id: /^[a-f0-9]{48,64}$/,
      hash: /^0x[a-fA-F0-9]{64}$/,
      asset: /^0x[a-fA-F0-9]{40}$/,
      paidGasWei: /^[0-9]{1,78}$/,
    }[key];
    if (typeof value?.[key] === "string" && pattern.test(value[key])) out[key] = value[key];
  }
  if (value?.reason && visible.has(value.reason)) out.reason = value.reason;
  return out;
}
