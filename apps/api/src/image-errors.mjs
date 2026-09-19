// Error text and code-shaped strings can both contain credentials. Only these
// application-owned values may cross the image journal or response boundary.
const codes = new Set([
  "image_outcome_unknown", "image_price_changed", "image_not_square",
  "image_provider_response_invalid", "image_filtered", "image_pricing_unavailable",
  "image_service_not_configured", "image_provider_unavailable", "decoder_unavailable",
  "image_size", "image_format", "image_dimensions", "image_animated", "image_decode",
  "image_output_size", "image_timeout", "image_busy", "image_quote_expired",
  "image_daily_limit", "image_payment_expired", "image_settlement_failed",
  "image_settlement_pending", "image_settlement_review_required",
]);

export const safeImageErrorCode = (value) => codes.has(value) ? value : "image_outcome_unknown";
