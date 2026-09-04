import { createHash } from "node:crypto";
import { ipfsContentId, ipfsUri } from "./ipfs-content.mjs";
import { IMAGE_BYTE_LIMIT, rasterFormat } from "./launch-image.mjs";
import { METADATA_BYTE_LIMIT } from "./launch-metadata.mjs";
import { ServiceError } from "./errors.mjs";

const uploadUrl = "https://uploads.pinata.cloud/v3/files";
const fileUrl = "https://api.pinata.cloud/v3/files/public/";
const fileId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const gatewayHost = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.mypinata\.cloud$/;
const messages = Object.freeze({
  ipfs_publication_disabled: "IPFS publication is not available yet. Your image has not been uploaded.",
  ipfs_configuration: "IPFS storage is not configured. Please try again after setup is complete.",
  invalid_ipfs_asset: "The prepared image or metadata changed. Prepare a new preview before publishing.",
  ipfs_busy: "Another IPFS request is in progress. Please wait a moment.",
  ipfs_publication_uncertain: "The IPFS upload could not be confirmed. Do not upload again; check its publication status first.",
  ipfs_verification_unavailable: "The IPFS files could not be verified yet. Keep this launch pending and try the status check later.",
});

export function ipfsMessage(code) {
  return Object.hasOwn(messages, code) ? messages[code]
    : "IPFS publication could not be completed. Please check its status before trying again.";
}

export function pinataGatewayUrl(gateway, cid) {
  if (typeof gateway !== "string" || !gatewayHost.test(gateway))
    throw new ServiceError("ipfs_configuration");
  ipfsUri(cid);
  return `https://${gateway}/ipfs/${cid}`;
}

function cancel(body) {
  if (body && !body.locked) void body.cancel().catch(() => {});
}

async function readBytes(response, limit, mime, signal) {
  if (signal.aborted || response.status !== 200 || response.redirected
    || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== mime
    || Number(response.headers.get("content-length")) > limit || !response.body) {
    cancel(response.body);
    throw new Error("Invalid provider response");
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error("Provider deadline");
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Provider response too large");
      chunks.push(value);
    }
    if (signal.aborted) throw new Error("Provider deadline");
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}

async function snapshotObject(input) {
  if (!input || !Buffer.isBuffer(input.bytes)
    || !["image/webp", "application/json"].includes(input.mime)
    || !input.bytes.length
    || input.bytes.length > (input.mime === "image/webp" ? IMAGE_BYTE_LIMIT : METADATA_BYTE_LIMIT))
    throw new ServiceError("invalid_ipfs_asset", 400);
  const object = { bytes: Buffer.from(input.bytes), mime: input.mime, cid: input.cid };
  ipfsUri(object.cid);
  if (object.mime === "image/webp" && rasterFormat(object.bytes) !== "webp")
    throw new ServiceError("invalid_ipfs_asset", 400);
  if (await ipfsContentId(object.bytes) !== object.cid)
    throw new ServiceError("invalid_ipfs_asset", 400);
  return object;
}

function pinReceipt(data, object, id) {
  if (!data || typeof data !== "object" || Array.isArray(data)
    || typeof data.id !== "string" || !fileId.test(data.id) || (id && data.id !== id)
    || data.cid !== object.cid || data.size !== object.bytes.length
    || data.number_of_files !== 1 || data.mime_type !== object.mime)
    throw new Error("Invalid pin record");
  return { id: data.id, cid: object.cid, size: object.bytes.length, mime: object.mime };
}

// Transport only: callers must durably reserve an approved upload before pinObject.
export class PinataPublisher {
  #jwt;
  #gateway;
  #enabled;
  #fetcher;
  #timeout;
  #busy = false;

  constructor({ jwt, gateway, enabled = false, fetcher = fetch, timeoutMs = 10000 } = {}) {
    if (typeof enabled !== "boolean" || typeof fetcher !== "function"
      || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 15000
      || (enabled && (typeof jwt !== "string" || jwt.length < 20 || jwt.length > 8192
        || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)
        || typeof gateway !== "string" || !gatewayHost.test(gateway))))
      throw new ServiceError("ipfs_configuration");
    this.#jwt = jwt;
    this.#gateway = gateway;
    this.#enabled = enabled;
    this.#fetcher = fetcher;
    this.#timeout = timeoutMs;
  }

  async #run(work) {
    if (!this.#enabled) throw new ServiceError("ipfs_publication_disabled");
    if (this.#busy) throw new ServiceError("ipfs_busy", 429, 2);
    this.#busy = true;
    try { return await work(); }
    finally { this.#busy = false; }
  }

  #providerHeaders() {
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${this.#jwt}`);
    return headers;
  }

  async #request(url, options, consume, failure) {
    const controller = new AbortController();
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ServiceError(failure, failure === "ipfs_publication_uncertain" ? 409 : 503));
      }, this.#timeout);
    });
    try {
      return await Promise.race([expired, (async () => {
        const response = await this.#fetcher(url, { ...options, redirect: "error",
          credentials: "omit", cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) { cancel(response.body); throw new Error("Provider deadline"); }
        return consume(response, controller.signal);
      })()]);
    } catch {
      throw new ServiceError(failure, failure === "ipfs_publication_uncertain" ? 409 : 503);
    } finally { clearTimeout(timer); }
  }

  async pinObject(input) {
    return this.#run(async () => {
      const object = await snapshotObject(input);
      const hash = createHash("sha256").update(object.bytes).digest("hex");
      const form = new FormData();
      form.set("file", new Blob([object.bytes], { type: object.mime }),
        `${hash}.${object.mime === "image/webp" ? "webp" : "json"}`);
      form.set("network", "public");
      form.set("cid_version", "v1");
      return this.#request(uploadUrl, { method: "POST", headers: this.#providerHeaders(), body: form },
        async (response, signal) => pinReceipt(JSON.parse(await readBytes(response, 8192, "application/json", signal)).data, object),
        "ipfs_publication_uncertain");
    });
  }

  async inspectPin(id, input) {
    return this.#run(async () => {
      if (typeof id !== "string" || !fileId.test(id)) throw new ServiceError("invalid_ipfs_asset", 400);
      const object = await snapshotObject(input);
      return this.#request(`${fileUrl}${id}`, { method: "GET", headers: this.#providerHeaders() },
        async (response, signal) => pinReceipt(JSON.parse(await readBytes(response, 8192, "application/json", signal)).data, object, id),
        "ipfs_verification_unavailable");
    });
  }

  async verifyObject(input) {
    return this.#run(async () => {
      const object = await snapshotObject(input);
      const url = pinataGatewayUrl(this.#gateway, object.cid);
      return this.#request(url, { method: "GET", headers: { Accept: object.mime } }, async (response, signal) => {
        const bytes = await readBytes(response, object.bytes.length, object.mime, signal);
        if (!bytes.equals(object.bytes)) throw new Error("Content mismatch");
        return { cid: object.cid, size: bytes.length, contentVerified: true, launchReady: false };
      }, "ipfs_verification_unavailable");
    });
  }
}
