import { createHash } from "node:crypto";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { balanced } from "ipfs-unixfs-importer/layout";
import { IMAGE_BYTE_LIMIT, rasterFormat } from "./launch-image.mjs";
import { METADATA_BYTE_LIMIT, normalizeLaunchDetails, validatePublishedUri } from "./launch-metadata.mjs";
import { ServiceError } from "./errors.mjs";

export const IPFS_IMPORT_PROFILE = "pinata-v1-256k";
export const LONG_IPFS_SCHEMA = "long-ipfs-v1";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function ipfsContentId(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > IMAGE_BYTE_LIMIT)
    throw new ServiceError("invalid_ipfs_asset", 400);
  // Discard blocks: calculate the CID without writing files or contacting a node.
  const blocks = { put: async (cid) => cid };
  const input = Buffer.from(bytes);
  for await (const entry of importer([{ content: input }], blocks, {
    cidVersion: 1,
    rawLeaves: true,
    reduceSingleLeafToSelf: true,
    wrapWithDirectory: false,
    fieldOrder: "links-first",
    chunker: fixedSize({ chunkSize: 262144 }),
    layout: balanced({ maxChildrenPerNode: 174 }),
    fileImportConcurrency: 1,
    blockWriteConcurrency: 1,
  })) return entry.cid.toString();
  throw new ServiceError("invalid_ipfs_asset", 400);
}

export function ipfsUri(cid) {
  if (typeof cid !== "string" || !/^b[a-z2-7]{58}$/.test(cid))
    throw new ServiceError("invalid_ipfs_asset", 400);
  return validatePublishedUri(`ipfs://${cid}`, "image");
}

export async function prepareLongIpfsAssets(processedImage, input) {
  const draft = normalizeLaunchDetails(input);
  if (!Buffer.isBuffer(processedImage) || processedImage.length > IMAGE_BYTE_LIMIT
    || rasterFormat(processedImage) !== "webp")
    throw new ServiceError("invalid_ipfs_asset", 400);
  const imageBytes = Buffer.from(processedImage);
  const imageCid = await ipfsContentId(imageBytes);
  const imageUri = ipfsUri(imageCid);
  const metadataBytes = Buffer.from(JSON.stringify({
    name: draft.name, symbol: draft.ticker, description: draft.description,
    image: imageUri, image_hash: imageUri,
  }));
  if (metadataBytes.length > METADATA_BYTE_LIMIT) throw new ServiceError("metadata_size", 400);
  const metadataCid = await ipfsContentId(metadataBytes);
  return {
    profile: IPFS_IMPORT_PROFILE, schema: LONG_IPFS_SCHEMA, draft,
    image: { bytes: imageBytes, cid: imageCid, uri: imageUri, mime: "image/webp", sha256: digest(imageBytes) },
    metadata: { bytes: metadataBytes, cid: metadataCid, uri: ipfsUri(metadataCid),
      mime: "application/json", sha256: digest(metadataBytes) },
    totalBytes: imageBytes.length + metadataBytes.length,
    launchReady: false,
  };
}
