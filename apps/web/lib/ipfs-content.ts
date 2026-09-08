import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { balanced } from 'ipfs-unixfs-importer/layout';
import { AssetError } from './asset-protocol.ts';

export const IPFS_PROFILE = 'pinata-v1-256k' as const;
export const IPFS_SCHEMA = 'long-ipfs-v1' as const;

export async function ipfsContentId(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > 2097152) throw new AssetError('invalid_asset_response');
  const source = new Uint8Array(bytes);
  const blocks: Parameters<typeof importer>[1] = { put: async (cid) => cid };
  for await (const entry of importer([{ content: source }], blocks, {
    cidVersion: 1, rawLeaves: true, reduceSingleLeafToSelf: true, wrapWithDirectory: false,
    fieldOrder: 'links-first', chunker: fixedSize({ chunkSize: 262144 }),
    layout: balanced({ maxChildrenPerNode: 174 }), fileImportConcurrency: 1, blockWriteConcurrency: 1,
  })) return entry.cid.toString();
  throw new AssetError('invalid_asset_response');
}

export function ipfsMetadata(draft: { name: string; ticker: string; description: string; launchpad?: 'longbow'; website?: string; twitter?: string }, imageCid: string) {
  const image = `ipfs://${imageCid}`;
  return new TextEncoder().encode(JSON.stringify({
    name: draft.name, symbol: draft.ticker, description: draft.description, image, image_hash: image,
    ...(draft.launchpad === 'longbow' ? { categories: ['longbow'] } : {}),
    ...(draft.website !== undefined ? { website: draft.website } : {}),
    ...(draft.twitter !== undefined ? { twitter: draft.twitter } : {}),
  }));
}
