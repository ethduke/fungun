import { ServiceError } from "./errors.mjs";
import { validAddress } from "./fee-contracts.mjs";
import { IMAGE_BYTE_LIMIT, rasterFormat } from "./launch-image.mjs";
import { ReadCache } from "./upstream.mjs";

// Deliberately limited to O1's verified public gateway for this experiment.
const gateway = "https://sapphire-negative-junglefowl-959.mypinata.cloud";
const mimeTypes = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
const unavailable = () => { throw new ServiceError("image_unavailable", 404); };

export function validateTokenImageInput(input) {
  const address = typeof input?.address === "string" ? input.address.toLowerCase() : "";
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== 2 || input.chainId !== 4663 || !validAddress(address))
    throw new ServiceError("invalid_request", 400);
  return { chainId: 4663, address };
}

export function o1ImageUrl(value) {
  if (typeof value !== "string" || value.length > 256) unavailable();
  let url;
  try { url = new URL(value); } catch { unavailable(); }
  if (url.origin !== gateway || url.username || url.password || url.search || url.hash
    || !/^\/ipfs\/(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/.test(url.pathname)
    || url.href !== value) unavailable();
  return url.href;
}

export class O1TokenImages {
  constructor(config, upstream, fetcher = fetch, now = Date.now) {
    Object.assign(this, { config, upstream, fetcher });
    // Bound retained base64 artwork to eight images, plus existing read admission.
    this.cache = new ReadCache(now, 8);
  }

  async get(raw) {
    const input = validateTokenImageInput(raw);
    if (!this.config.readsEnabled || !this.config.o1Key)
      throw new ServiceError("not_configured");
    return this.cache.get(`${input.chainId}:${input.address}`, 300_000, async () => {
      const metadata = await this.upstream.json("o1",
        `https://api.launch.o1.exchange/v1/tokens/${input.chainId}/${input.address}`, {
          credentials: "omit",
          headers: { "x-api-key": this.config.o1Key, accept: "application/json" },
        }, 128 * 1024);
      const token = metadata?.data?.token;
      if (metadata?.data?.chain_id !== input.chainId
        || token?.address?.toLowerCase() !== input.address) unavailable();
      const url = o1ImageUrl(token.image_url);
      const release = await this.upstream.acquire("o1", false);
      try {
        // Account for the gateway read as well as the metadata read.
        this.upstream.budget.upstream("o1");
        const response = await this.fetcher(url, {
          redirect: "error", credentials: "omit", signal: AbortSignal.timeout(8000),
          headers: { accept: "image/png,image/jpeg,image/webp,image/gif" },
        });
        const mime = response.headers.get("content-type")?.split(";")[0].trim();
        if (!response.ok || response.redirected || !Object.values(mimeTypes).includes(mime)
          || Number(response.headers.get("content-length")) > IMAGE_BYTE_LIMIT || !response.body) {
          await response.body?.cancel();
          unavailable();
        }
        const reader = response.body.getReader(), chunks = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > IMAGE_BYTE_LIMIT) unavailable();
            chunks.push(value);
          }
        } finally { await reader.cancel(); }
        const bytes = Buffer.concat(chunks);
        if (!size || mimeTypes[rasterFormat(bytes)] !== mime) unavailable();
        return { ...input, mime, size, base64: bytes.toString("base64") };
      } finally { release(); }
    });
  }
}
