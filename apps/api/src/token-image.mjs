import { CID } from "multiformats/cid";
import { ServiceError } from "./errors.mjs";
import { validAddress } from "./fee-contracts.mjs";
import { FeeRpc } from "./fee-rpc.mjs";
import { IMAGE_BYTE_LIMIT, LaunchImageProcessor, rasterFormat } from "./launch-image.mjs";
import { O1TokenImages } from "./o1-token-image.mjs";
import { ReadCache, withinReadDeadline } from "./upstream.mjs";

const unavailable = () => { throw new ServiceError("image_unavailable", 404); };
const metadataLimit = 128 * 1024;
const tokenAbi = [{ type: "function", name: "tokenURI", stateMutability: "view", inputs: [],
  outputs: [{ type: "string" }] }];

export function validateCopiedTokenImageInput(input) {
  const address = typeof input?.address === "string" ? input.address.toLowerCase() : "";
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== 3 || !validAddress(address)
    || ![4663, 8453].includes(input.chainId)
    || !["o1", "doppler"].includes(input.provider)
    || (input.provider === "o1" && input.chainId !== 4663))
    throw new ServiceError("invalid_request", 400);
  return { chainId: input.chainId, address, provider: input.provider };
}

// Accept only content-addressed roots, never caller-supplied hosts, paths or IPNS.
export function imageCid(uri) {
  if (typeof uri !== "string" || !/^ipfs:\/\/(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/.test(uri))
    unavailable();
  try {
    const cid = CID.parse(uri.slice(7));
    if (![0x55, 0x70].includes(cid.code) || cid.multihash.code !== 0x12 || cid.multihash.size !== 32)
      unavailable();
    return cid.toV1().toString();
  } catch { unavailable(); }
}

function gatewayUrls(cid) {
  return [
    `https://ipfs.io/ipfs/${cid}`,
    `https://gateway.pinata.cloud/ipfs/${cid}`,
    `https://${cid}.ipfs.dweb.link/`,
  ];
}

async function readContent(response) {
  if (!response.ok || response.redirected || !response.body
    || Number(response.headers.get("content-length")) > IMAGE_BYTE_LIMIT) {
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
      // Non-raster responses have the smaller metadata limit, even without a
      // Content-Length header or with a misleading Content-Type header.
      if (size > metadataLimit && !rasterFormat(Buffer.concat(chunks, 12))) unavailable();
    }
  } finally { await reader.cancel(); }
  if (!size) unavailable();
  return Buffer.concat(chunks);
}

export class DopplerTokenImages {
  constructor(config, upstream, fetcher = fetch, now = Date.now) {
    Object.assign(this, { config, upstream, fetcher });
    this.rpc = new FeeRpc(config, upstream);
    this.processor = new LaunchImageProcessor();
    this.tokens = new ReadCache(now, 8);
    this.content = new ReadCache(now, 8);
    this.chains = new ReadCache(now, 2);
  }

  async fetchContent(cid, signal) {
    const urls = gatewayUrls(cid);
    const visited = new Set();
    for (const initial of urls) {
      let url = initial;
      while (!visited.has(url)) {
        signal.throwIfAborted();
        visited.add(url);
        const release = await this.upstream.acquire("token-image", false);
        try {
          this.upstream.budget.upstream("token-image");
          const response = await this.fetcher(url, {
            redirect: "manual", credentials: "omit",
            signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
            headers: { accept: "application/json,image/png,image/jpeg,image/webp,image/gif,application/octet-stream" },
          });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("location");
            await response.body?.cancel();
            // Only another canonical gateway URL for this exact CID is allowed.
            if (!urls.includes(location)) unavailable();
            url = location;
            continue;
          }
          return await readContent(response);
        } catch (error) {
          if (error?.status === 429) throw error;
          signal.throwIfAborted();
          break;
        } finally { release(); }
      }
    }
    unavailable();
  }

  resolve(cid, metadataAllowed, signal) {
    return this.content.get(`${metadataAllowed ? "document" : "image"}:${cid}`, 3_600_000, async () => {
      const bytes = await this.fetchContent(cid, signal);
      if (rasterFormat(bytes)) {
        signal.throwIfAborted();
        const image = await this.processor.process(bytes);
        signal.throwIfAborted();
        return { mime: image.mime, size: image.bytes.length, base64: image.bytes.toString("base64") };
      }
      if (!metadataAllowed || bytes.length > metadataLimit) unavailable();
      let metadata;
      try { metadata = JSON.parse(bytes.toString("utf8")); } catch { unavailable(); }
      const candidates = new Set();
      for (const field of [metadata?.image, metadata?.image_hash]) {
        try { candidates.add(imageCid(field)); } catch { /* Try the other supported field. */ }
      }
      for (const candidate of candidates) {
        signal.throwIfAborted();
        try { return await this.resolve(candidate, false, signal); }
        catch (error) { if (error?.status === 429) throw error; }
      }
      unavailable();
    });
  }

  get(raw) {
    const input = validateCopiedTokenImageInput({ ...raw, provider: "doppler" });
    if (!this.config.readsEnabled) throw new ServiceError("not_configured");
    // tokenURI can change; only immutable IPFS content gets the longer TTL.
    return this.tokens.get(`${input.chainId}:${input.address}`, 60_000, () => withinReadDeadline(async () => {
      const signal = AbortSignal.timeout(18_000);
      await this.chains.get(String(input.chainId), 300_000, async () => {
        const [chain] = await this.rpc.batch(input.chainId, [{ method: "eth_chainId", params: [] }]);
        if (chain !== `0x${input.chainId.toString(16)}`) throw new ServiceError("wrong_chain");
        return true;
      });
      const [uri] = await this.rpc.calls(input.chainId, [{ address: input.address,
        abi: tokenAbi, functionName: "tokenURI" }]);
      const image = await this.resolve(imageCid(uri), true, signal);
      signal.throwIfAborted();
      return { chainId: input.chainId, address: input.address, ...image };
    }, 18_000));
  }
}

export class TokenImages {
  constructor(config, upstream, fetcher = fetch, now = Date.now) {
    this.o1 = new O1TokenImages(config, upstream, fetcher, now);
    this.doppler = new DopplerTokenImages(config, upstream, fetcher, now);
  }

  get(raw) {
    // Preserve the original endpoint for clients still running the O1 release.
    if (!Object.hasOwn(raw, "provider")) return this.o1.get(raw);
    const { provider, ...input } = validateCopiedTokenImageInput(raw);
    return provider === "o1" ? this.o1.get(input) : this.doppler.get(input);
  }
}
