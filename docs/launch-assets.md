# Launch image and metadata boundary

The internal asset pipeline is implemented and tested; it is not an upload API.
Picking a file still keeps it in the browser. No image is published, persisted,
sent to a model or included in Git by these modules.

## Image processing

`LaunchImageProcessor` accepts bytes only, not filenames, URLs or decoder options.
PNG, JPEG, WebP and still GIF are identified from their contents. Files must be
nonempty, at most 2 MiB and at most 4096 pixels on each side. The decoder must
finish before output is accepted; plausible headers are insufficient.

Sharp is pinned to 0.35.4. A short-lived child process receives no inherited
environment, credentials or shell. It processes one image with a disabled native
cache, one native worker thread, a three-second processing limit and a six-second
parent-enforced deadline. Only one conversion per processor is admitted; there
is no pending queue. Raw decoder diagnostics are discarded. Use one shared
processor instance when wiring the service.

The output is WebP with orientation applied and embedded metadata removed. It
must remain under 2 MiB. Animated GIF/WebP and APNG are explicitly rejected for
this first publication profile; previews remain unchanged. No silent flattening,
cropping, resizing or AI image generation occurs. The transformed image must be
shown before the user approves its publication.

The child-process boundary and V8 heap limit are not a native-code sandbox or a
hard native-memory limit. Before public admission, validate a memory/CPU-limited,
non-root decoder runtime without provider credentials, writable source or outbound
network access. Test the actual Linux deployment architecture, not only macOS.

## Metadata

`buildLongMetadata` emits canonical UTF-8 JSON containing only `name`, `symbol`,
`description` and the published `image` reference. It rejects extra fields,
control characters, unsupported tickers and overlong text. Descriptions follow
the webview's 2,000-byte UTF-8 limit. The resulting bytes receive a SHA-256 digest.

Image references are restricted to supported SHA-256 IPFS content IDs, or an
exact server-configured HTTPS origin and hash-based `/launch-assets/` path.
URI syntax validation is not proof of successful publication or availability.
The publication adapter must verify the retrieved bytes against the approved
image and metadata before returning a transaction-ready URI. No arbitrary URL
fetcher or mutable user-supplied metadata URL is provided.

Doppler recommends IPFS metadata and images. Its indexer also documents HTTPS
retrieval, but this does not establish Long's current frontend/listing behavior.
Long's own metadata display remains an integration gate. Do not copy Longbow's
allocation or category fields into ordinary Long metadata.

## Publication gates

- Confirm the storage transport. IPFS requires a server-only pinning credential;
  Fly-hosted assets require persistent storage, backup/recovery and public serving.
- Verify a wallet-bound, expiring publication intent and explicit public-content
  approval. Never treat selecting an image as consent to publish it.
- Enforce durable byte/job quotas, bounded concurrency and idempotency before
  consuming paid storage. Fail closed after an uncertain publication result;
  reconcile it before retrying. Keep orphaned published content charged.
- Keep original filenames, images, metadata, wallet/signature data and provider
  responses out of logs, build context and source history.
- Only then connect browser upload, approved-image preview, publication and the
  unsigned launch builder. No public endpoint or new runtime secret is enabled
  by this milestone.

References: [Sharp security](https://sharp.pixelplumbing.com/security/),
[input limits](https://sharp.pixelplumbing.com/api-constructor/),
[output and timeout behavior](https://sharp.pixelplumbing.com/api-output/),
[Doppler metadata](https://docs.doppler.lol/resources/metadata-standards),
[Doppler indexer](https://docs.doppler.lol/indexer/overview).
