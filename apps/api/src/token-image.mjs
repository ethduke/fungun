import { parseAbi, encodeFunctionData, decodeFunctionResult } from "viem";
import { CID } from "multiformats/cid";
import { ServiceError } from "./errors.mjs";
import { validAddress } from "./fee-contracts.mjs";
import { FeeRpc } from "./fee-rpc.mjs";
import { IMAGE_BYTE_LIMIT, LaunchImageProcessor, rasterFormat } from "./launch-image.mjs";
import { O1TokenImages } from "./o1-token-image.mjs";
import { ReadCache, withinReadDeadline } from "./upstream.mjs";

const unavailable = () => { throw new ServiceError("image_unavailable", 404); };
const noMetadata = () => { throw new ServiceError("image_metadata_missing", 404); };
const metadataLimit = 128 * 1024;
const ponsTokenAbi = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, Socials tokenSocials)",
]);
const tokenAbi = [{ type: "function", name: "tokenURI", stateMutability: "view", inputs: [],
  outputs: [{ type: "string" }] }];

export function validateCopiedTokenImageInput(input) {
  const address = typeof input?.address === "string" ? input.address.toLowerCase() : "";
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== 3 || !validAddress(address)
    || ![4663, 8453].includes(input.chainId)
    || !["o1", "doppler", "pons-v2"].includes(input.provider)
    || (input.provider !== "doppler" && input.chainId !== 4663))
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
  provider = "doppler";
  constructor(config, upstream, fetcher = fetch, now = Date.now) {
    Object.assign(this, { config, upstream, fetcher });
    this.rpc = new FeeRpc(config, upstream);
    this.processor = new LaunchImageProcessor();
    this.tokens = new ReadCache(now, 8);
    this.content = new ReadCache(now, 8);
    this.chains = new ReadCache(now, 2);
  }

  fetchContent(cid, signal) {
    return this.fetchUrls(gatewayUrls(cid), signal);
  }

  async fetchUrls(urls, signal) {
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
            // Only an explicitly supplied canonical URL is allowed. Gateway lists
            // contain the same CID; a Pons HTTPS logo supplies just its exact URL.
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
        return this.decode(bytes, signal);
      }
      if (!metadataAllowed || bytes.length > metadataLimit) unavailable();
      let metadata;
      try { metadata = JSON.parse(bytes.toString("utf8")); } catch { unavailable(); }
      if (metadata && typeof metadata === "object" && !Array.isArray(metadata)
        && [metadata.image, metadata.image_hash].every(value => value == null || value === "")) noMetadata();
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

  async decode(bytes, signal) {
    signal.throwIfAborted();
    const image = await this.processor.process(bytes);
    signal.throwIfAborted();
    return { mime: image.mime, size: image.bytes.length, base64: image.bytes.toString("base64") };
  }

  async metadataUri(input, functionName) {
    const abi = [{ ...tokenAbi[0], name: functionName }];
    let result;
    try {
      [result] = await this.rpc.batch(input.chainId, [{ method: "eth_call", params: [
        { to: input.address, data: encodeFunctionData({ abi, functionName }) }, "latest",
      ] }]);
    } catch (error) {
      // A revert can mean the optional metadata function is absent. Do not
      // misreport timeouts, rate limits or malformed RPC replies as no metadata.
      if (error?.code === "reverted") return null;
      throw error;
    }
    if (result === "0x") return null;
    try { return decodeFunctionResult({ abi, functionName, data: result }) || null; }
    catch { throw new ServiceError("invalid_response"); }
  }

  async loadImage(input, signal) {
    const uri = await this.metadataUri(input, "tokenURI")
      || await this.metadataUri(input, "contractURI");
    if (!uri) noMetadata();
    return this.resolve(imageCid(uri), true, signal);
  }

  get(raw) {
    const input = validateCopiedTokenImageInput({ ...raw, provider: this.provider });
    if (!this.config.readsEnabled) throw new ServiceError("not_configured");
    // tokenURI can change; only immutable IPFS content gets the longer TTL.
    return this.tokens.get(`${input.chainId}:${input.address}`, 60_000, () => withinReadDeadline(async () => {
      const signal = AbortSignal.timeout(18_000);
      await this.chains.get(String(input.chainId), 300_000, async () => {
        const [chain] = await this.rpc.batch(input.chainId, [{ method: "eth_chainId", params: [] }]);
        if (chain !== `0x${input.chainId.toString(16)}`) throw new ServiceError("wrong_chain");
        return true;
      });
      const image = await this.loadImage(input, signal);
      signal.throwIfAborted();
      return { chainId: input.chainId, address: input.address, ...image };
    }, 18_000));
  }
}

// Pons stores an image URI directly in getTokenInfo().tokenLogo. These static
// CDN paths were verified on live v2 tokens; no arbitrary HTTP proxy is exposed.
export function ponsLogoUrl(value) {
  if (typeof value !== "string" || value.length > 512) unavailable();
  let url;
  try { url = new URL(value); } catch { unavailable(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || url.search || url.hash || url.href !== value) unavailable();
  const axiom = url.hostname === "axiomtrading-v2.axiom-cdn.io"
    && /^\/[a-zA-Z0-9_-]{16,128}\.(?:webp|png|jpe?g)$/.test(url.pathname);
  const twitter = url.hostname === "pbs.twimg.com"
    && /^\/profile_images\/\d{1,24}\/[a-zA-Z0-9_-]{1,128}\.(?:webp|png|jpe?g)$/.test(url.pathname);
  if (!axiom && !twitter) unavailable();
  return url.href;
}

export class PonsTokenImages extends DopplerTokenImages {
  provider = "pons-v2";

  async loadImage(input, signal) {
    const [info] = await this.rpc.calls(input.chainId, [{ address: input.address,
      abi: ponsTokenAbi, functionName: "getTokenInfo" }]);
    const logo = info?.[1];
    if (logo === "") noMetadata();
    if (typeof logo === "string" && logo.startsWith("ipfs://"))
      return this.resolve(imageCid(logo), false, signal);
    const url = ponsLogoUrl(logo);
    // HTTPS resources can change independently of the token's metadata.
    return this.content.get(`https:${url}`, 60_000, async () =>
      this.decode(await this.fetchUrls([url], signal), signal));
  }
}

export class TokenImages {
  constructor(config, upstream, fetcher = fetch, now = Date.now) {
    this.o1 = new O1TokenImages(config, upstream, fetcher, now);
    this.doppler = new DopplerTokenImages(config, upstream, fetcher, now);
    this.pons = new PonsTokenImages(config, upstream, fetcher, now);
  }

  get(raw) {
    // Preserve the original endpoint for clients still running the O1 release.
    if (!Object.hasOwn(raw, "provider")) return this.o1.get(raw);
    const { provider, ...input } = validateCopiedTokenImageInput(raw);
    return provider === "o1" ? this.o1.get(input)
      : provider === "pons-v2" ? this.pons.get(input) : this.doppler.get(input);
  }
}
