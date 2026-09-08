import { sha256 } from "viem";
import { ServiceError } from "./errors.mjs";

export const METADATA_BYTE_LIMIT = 16 * 1024;

function validContentId(cid) {
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let value = 0n;
    for (const char of cid) value = value * 58n + BigInt(alphabet.indexOf(char));
    const hex = value.toString(16);
    const bytes = Uint8Array.from((hex.length % 2 ? `0${hex}` : hex).match(/../g), (pair) => parseInt(pair, 16));
    return bytes.length === 34 && bytes[0] === 18 && bytes[1] === 32;
  }
  if (!/^b[a-z2-7]{58}$/.test(cid)) return false;
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = [];
  let pending = 0;
  let bits = 0;
  for (const char of cid.slice(1)) {
    pending = (pending << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push(pending >> bits);
      pending &= (1 << bits) - 1;
    }
  }
  return (
    pending === 0 &&
    bytes.length === 36 &&
    bytes[0] === 1 &&
    [85, 112].includes(bytes[1]) &&
    bytes[2] === 18 &&
    bytes[3] === 32
  );
}

export function normalizeLaunchDetails(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !["name", "ticker", "description", "launchpad", "website", "twitter"].includes(key))
  )
    throw new ServiceError("invalid_launch_details", 400);
  const { name, ticker, description = "" } = input;
  const links = {};
  for (const key of ['website', 'twitter']) {
    if (input[key] === undefined) continue;
    try {
      const value = input[key];
      const url = new URL(value);
      if (typeof value !== 'string' || value.length > 512 || /[\s\p{Cc}\p{Cf}]/u.test(value) || url.protocol !== 'https:' || url.username || url.password) throw Error();
      links[key] = value;
    } catch { throw new ServiceError('invalid_launch_details', 400); }
  }
  if (
    (input.launchpad !== undefined && input.launchpad !== "longbow") ||
    typeof name !== "string" ||
    !name.trim() ||
    Array.from(name).length > 50 ||
    /[\p{Cc}\p{Cf}]/u.test(name) ||
    typeof ticker !== "string" ||
    !/^[A-Z]{1,11}$/.test(ticker) ||
    typeof description !== "string" ||
    new TextEncoder().encode(description).length > 2000 ||
    /[\p{Cc}\p{Cf}]/u.test(description.replace(/\n/g, ""))
  )
    throw new ServiceError("invalid_launch_details", 400);
  return Object.freeze({ name: name.trim(), ticker, description: description.trim(), ...links, ...(input.launchpad ? { launchpad: input.launchpad } : {}) });
}

export function validatePublishedUri(uri, kind, publicOrigin) {
  if (typeof uri !== "string" || uri.length > 256 || !["image", "metadata"].includes(kind))
    throw new ServiceError("invalid_asset_uri", 400);
  if (uri.startsWith("ipfs://") && validContentId(uri.slice(7))) return uri;
  let origin;
  let url;
  try {
    origin = new URL(publicOrigin);
    url = new URL(uri);
  } catch {
    throw new ServiceError("invalid_asset_uri", 400);
  }
  const suffix = kind === "image" ? "webp" : "json";
  if (
    origin.protocol !== "https:" ||
    origin.origin !== publicOrigin ||
    origin.username ||
    origin.password ||
    url.origin !== publicOrigin ||
    url.href !== uri ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !new RegExp(`^/launch-assets/[a-f0-9]{64}\\.${suffix}$`).test(url.pathname)
  )
    throw new ServiceError("invalid_asset_uri", 400);
  return uri;
}

export function buildLongMetadata(input, publishedImageUri, publicOrigin) {
  const { name, ticker, description, website, twitter } = normalizeLaunchDetails(input);
  const image = validatePublishedUri(publishedImageUri, "image", publicOrigin);
  const bytes = Buffer.from(JSON.stringify({ name, symbol: ticker, description, image, ...(website !== undefined ? { website } : {}), ...(twitter !== undefined ? { twitter } : {}) }), "utf8");
  if (bytes.length > METADATA_BYTE_LIMIT) throw new ServiceError("metadata_size", 400);
  return Object.freeze({
    bytes,
    mime: "application/json",
    sha256: sha256(bytes).slice(2),
  });
}
