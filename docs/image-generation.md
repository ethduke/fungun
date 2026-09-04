# Memecoin image prompt scaffold

`apps/api/src/image-prompt.mjs` owns the fixed art instructions and the pure
`buildGrokImageRequest({ name, ticker, prompt })` builder. It does not send requests,
read credentials, log inputs, store images or charge payments. The webview remains
preview-only; no generation endpoint is connected yet.

The instructions use the ticker/name as context, request a square memecoin avatar,
keep the focal subject inside a circular-crop safe area, and favor readable
silhouettes at thumbnail size. User style is preserved. Lettering is opt-in;
watermarks, addresses, QR codes and invented financial claims are excluded.

The [xAI image API](https://docs.x.ai/developers/model-capabilities/images/generation)
takes one prompt, not separate system-role messages. The backend prepends its
instructions and appends only the validated name, ticker and creative brief as
JSON. This is best-effort art guidance, not role-level prompt-injection isolation.
Fields cannot override the model, single-image count, square ratio, 1k resolution,
low quality tier or base64 response format. The settings were checked against the
official docs on 4 September 2026; recheck support and pricing before activation.

Future paid integration must bind the validated request and prompt version to a
one-time approved quote, enforce durable spend/concurrency limits, and reconcile
uncertain outcomes before retrying. Do not automatically retry paid generation.
Keep provider keys in runtime secrets, never forward wallet/payment data to the
image model, and never log the request body. Free-text validation is not a secret
detector; remind users not to include private data in their creative brief.

Before attaching output, check moderation, decode the returned raster, verify
square dimensions and apply the app's image size limits. Do not rely on the prompt
to enforce these output requirements. This output validation and payment transport
are not implemented by the scaffold.
