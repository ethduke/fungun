import { isAddress, zeroAddress } from 'viem';

export const ASSET_IMAGE_LIMIT = 2 * 1024 * 1024;
export const ASSET_BODY_LIMIT = Math.ceil(ASSET_IMAGE_LIMIT / 3) * 4 + 16384;
export type AssetDraft = { name: string; ticker: string; description: string };
export type AssetIpfs = {
  profile: 'pinata-v1-256k';
  schema: 'long-ipfs-v1';
  imageCid: string;
  metadataCid: string;
};
export type AssetApproval = {
  uploadToken?: string;
  id: string;
  wallet: string;
  appOrigin: string;
  assetOrigin: string;
  draft: AssetDraft;
  imageHash: string;
  metadataHash: string;
  imageUrl: string;
  metadataUrl: string;
  imageBase64: string;
  width: number;
  height: number;
  issuedAt: number;
  expiresAt: number;
  deadline: number;
  totalBytes: number;
  message: string;
  ipfs?: AssetIpfs;
};
export type PublishedAsset = Pick<
  AssetApproval,
  'id' | 'imageHash' | 'metadataHash' | 'imageUrl' | 'metadataUrl'
> & { status: 'published'; launchReady: false; ipfs?: AssetIpfs };
export type ProcessingAsset = Pick<
  AssetApproval,
  'id' | 'imageHash' | 'metadataHash' | 'imageUrl' | 'metadataUrl'
> & {
  status: 'processing';
  launchReady: false;
  ipfs: AssetIpfs;
  progress: { image: 'staging' | 'ready' | 'sending' | 'pinned' | 'verified'; metadata: 'staging' | 'ready' | 'sending' | 'pinned' | 'verified' };
  issue?: 'verification_delayed';
  retryAt?: number;
};
export type ExpiredAsset = Pick<
  AssetApproval,
  'id' | 'imageHash' | 'metadataHash'
> & { status: 'expired' };

export function validateExpiredAsset(
  value: unknown,
  expected: Pick<AssetApproval, 'id' | 'imageHash' | 'metadataHash'>,
): ExpiredAsset {
  if (
    !objectFields(value, ['id', 'status', 'imageHash', 'metadataHash']) ||
    value.status !== 'expired' ||
    value.id !== expected.id ||
    value.imageHash !== expected.imageHash ||
    value.metadataHash !== expected.metadataHash
  )
    throw new AssetError('invalid_asset_response');
  return value as ExpiredAsset;
}

export class AssetError extends Error {
  code: string;
  retryAfter: number;
  publicationCause: string;
  constructor(code: string, retryAfter = 0, publicationCause = '') {
    super(code);
    this.code = code;
    this.retryAfter = retryAfter;
    this.publicationCause = publicationCause;
  }
}
const messages: Record<string, string> = {
  asset_uploads_disabled:
    'Publication is not enabled yet. Your image has not been published.',
  disconnected: 'Connect your wallet first.',
  wrong_chain:
    'Your wallet stayed on another network. Switch to Robinhood Chain and try again.',
  asset_chain_rejected:
    'You declined the Robinhood Chain switch. Nothing was published.',
  asset_chain_unsupported:
    'This wallet could not switch to Robinhood Chain. Add it manually or use Rabby or MetaMask.',
  asset_wallet_pending:
    'Finish the open wallet request, then try again. Nothing was published.',
  asset_context_changed:
    'Coin details or wallet changed. Click Launch coin again.',
  asset_approval_expired:
    'Artwork preparation expired. Click Launch coin again.',
  invalid_asset_approval:
    'Artwork could not be verified. Please try again.',
  asset_rejected: 'You declined the wallet approval. Nothing was published.',
  asset_busy: 'An image request is already running. Please wait.',
  rate_limited: 'Too many requests. Please wait before trying again.',
  invalid_launch_details:
    'Enter a coin name, a ticker of 1–11 English letters, and a description under 2,000 bytes.',
  image_size: 'Choose an image no larger than 2 MiB.',
  image_dimensions: 'Use an image no larger than 4096 × 4096 pixels.',
  image_animated: 'Choose a still image; animations are not supported yet.',
  image_timeout: 'Image processing took too long. Try a smaller image.',
  image_format: 'Choose a valid PNG, JPEG, WebP or GIF image.',
  image_decode: 'This image could not be decoded safely. Choose another file.',
  image_output_size:
    'The processed image is too large. Choose a smaller or simpler image.',
  asset_storage_full:
    'Image storage is temporarily full. Please try again later.',
  asset_history_full:
    'Publication is paused while storage history is reviewed. Please try again later.',
  asset_integrity_failed:
    'Stored files could not be verified. Contact support before publishing again.',
  asset_publication_uncertain:
    'Artwork is still being checked. Click Launch coin again in a minute.',
  ipfs_approval_pending:
    'Previous artwork is pending. Wait a few minutes and try again.',
  ipfs_publication_disabled:
    'IPFS publication is not available yet. Your image has not been uploaded.',
  ipfs_configuration:
    'IPFS publication is not configured. Your image has not been uploaded.',
  ipfs_verification_unavailable:
    'The IPFS files are still being verified. Keep this launch pending and check again later.',
  asset_recovery_wallet:
    'Connect the wallet used for this publication to check its status.',
  asset_recovery_unavailable:
    'Your browser could not save recovery information. Enable session storage before publishing.',
  invalid_asset_response:
    'The service response could not be verified. No new wallet approval was requested.',
};
export function assetErrorText(error: unknown) {
  if (
    error instanceof AssetError &&
    error.code === 'asset_publication_uncertain'
  ) {
    const causes: Record<string, string> = {
      rate_limited: 'The publication service is rate-limited.',
      asset_busy: 'The publication service is busy.',
      asset_storage_full: 'Publication storage is full.',
      asset_uploads_disabled: 'Publication is currently disabled.',
      asset_approval_expired: 'The approval has expired.',
    };
    const cause = causes[error.publicationCause];
    return `${cause ? `${cause} ` : ''}${messages.asset_publication_uncertain}`;
  }
  return error instanceof AssetError && messages[error.code]
    ? messages[error.code]
    : 'Image publication is temporarily unavailable. Please try again later.';
}
export function objectFields(
  value: unknown,
  fields: string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}
export function assetDraft(value: unknown): AssetDraft {
  if (!objectFields(value, ['name', 'ticker', 'description']))
    throw new AssetError('invalid_launch_details');
  const { name, ticker, description } = value;
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    Array.from(name).length > 50 ||
    /[\p{Cc}\p{Cf}]/u.test(name) ||
    typeof ticker !== 'string' ||
    !/^[A-Z]{1,11}$/.test(ticker) ||
    typeof description !== 'string' ||
    new TextEncoder().encode(description).length > 2000 ||
    /[\p{Cc}\p{Cf}]/u.test(description.replace(/\n/g, ''))
  )
    throw new AssetError('invalid_launch_details');
  return { name: name.trim(), ticker, description: description.trim() };
}
export function assetWallet(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !isAddress(value) ||
    value.toLowerCase() === zeroAddress
  )
    throw new AssetError('disconnected');
  return value.toLowerCase();
}
export function assetOrigin(value: unknown, local = false): string {
  if (typeof value !== 'string') throw new AssetError('invalid_asset_response');
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(
        local &&
        ['http://127.0.0.1:3000', 'http://localhost:3000'].includes(value)
      ))
  )
    throw new AssetError('invalid_asset_response');
  return value;
}
export function imageBase64(bytes: Uint8Array): string {
  if (!bytes.length || bytes.length > ASSET_IMAGE_LIMIT)
    throw new AssetError('image_size');
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}
export function imageBytes(value: unknown): Uint8Array {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > Math.ceil(ASSET_IMAGE_LIMIT / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw new AssetError('image_size');
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    throw new AssetError('image_size');
  }
  if (imageBase64(bytes) !== value) throw new AssetError('image_size');
  return bytes;
}
export async function assetHash(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
export function assetMessage(
  value: Pick<
    AssetApproval,
    | 'appOrigin'
    | 'assetOrigin'
    | 'wallet'
    | 'imageHash'
    | 'metadataHash'
    | 'totalBytes'
    | 'id'
    | 'issuedAt'
    | 'expiresAt'
    | 'ipfs'
    | 'uploadToken'
  >,
) {
  if ('ipfs' in value && value.ipfs) {
    return [
      value.uploadToken ? 'Launch assets — no wallet signature.' : 'Publish memecoin assets — no transaction or token approval.',
      value.uploadToken ? 'Intent version: 3' : 'Intent version: 2',
      `Website: ${value.appOrigin}`,
      `Public asset origin: ${value.assetOrigin}`,
      `Wallet: ${value.wallet.toLowerCase()}`,
      'Chain ID: 4663',
      'Launchpad: Long',
      'Storage: public IPFS',
      `Importer: ${value.ipfs.profile}`,
      `Metadata schema: ${value.ipfs.schema}`,
      `Image URI: ipfs://${value.ipfs.imageCid}`,
      `Metadata URI: ipfs://${value.ipfs.metadataCid}`,
      `Image SHA-256: ${value.imageHash}`,
      `Metadata SHA-256: ${value.metadataHash}`,
      `Total published bytes: ${value.totalBytes}`,
      'I approve publishing these exact images and metadata publicly. Copies may remain permanently.',
      `Nonce: ${value.id}`,
      `Issued at: ${value.issuedAt}`,
      `Expires at: ${value.expiresAt}`,
    ].join('\n');
  }
  return [
    'Publish memecoin assets — no transaction or token approval.',
    'Intent version: 1',
    `Website: ${value.appOrigin}`,
    `Public asset origin: ${value.assetOrigin}`,
    `Wallet: ${value.wallet.toLowerCase()}`,
    'Chain ID: 4663',
    'Launchpad: Long',
    `Image SHA-256: ${value.imageHash}`,
    `Metadata SHA-256: ${value.metadataHash}`,
    `Total published bytes: ${value.totalBytes}`,
    'I approve publishing these exact images and metadata publicly. Copies may remain permanently.',
    `Nonce: ${value.id}`,
    `Issued at: ${value.issuedAt}`,
    `Expires at: ${value.expiresAt}`,
  ].join('\n');
}
export async function validateAssetPreview(
  raw: unknown,
  expected: {
    wallet: string;
    draft: AssetDraft;
    appOrigin: string;
    startedAt: number;
    launch?: boolean;
  },
  now = performance.now(),
): Promise<AssetApproval> {
  const baseFields = [
    'id',
    'message',
    'issuedAt',
    'totalBytes',
    'expiresAt',
    'imageHash',
    'metadataHash',
    'imageUrl',
    'metadataUrl',
    'draft',
    'imageBase64',
    'width',
    'height',
    'serverTime',
    'assetOrigin',
  ];
  const fields = raw && typeof raw === 'object' && 'ipfs' in raw ? [...baseFields, 'ipfs'] : baseFields;
  if (!objectFields(raw, expected.launch ? [...fields, 'uploadToken'] : fields)
    || (expected.launch && (typeof raw.uploadToken !== 'string' || !/^[a-f0-9]{64}$/.test(raw.uploadToken) || !('ipfs' in raw))))
    throw new AssetError('invalid_asset_response');
  const origin = assetOrigin(raw.assetOrigin);
  const draft = assetDraft(raw.draft);
  const supplied = assetDraft(expected.draft);
  const bytes = imageBytes(raw.imageBase64);
  const integer = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value);
  if (
    JSON.stringify(draft) !== JSON.stringify(supplied) ||
    typeof raw.id !== 'string' ||
    !/^[a-f0-9]{48}$/.test(raw.id) ||
    !integer(raw.issuedAt) ||
    !integer(raw.expiresAt) ||
    !integer(raw.serverTime) ||
    raw.issuedAt < 0 ||
    raw.expiresAt - raw.issuedAt !== 300000 ||
    raw.serverTime < raw.issuedAt ||
    raw.serverTime >= raw.expiresAt ||
    [raw.width, raw.height].some(
      (side) => !integer(side) || side < 1 || side > 4096,
    ) ||
    new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RIFF' ||
    new TextDecoder().decode(bytes.subarray(8, 12)) !== 'WEBP'
  )
    throw new AssetError('invalid_asset_response');
  const imageHash = await assetHash(bytes);
  let imageUrl = `${origin}/launch-assets/${imageHash}.webp`;
  let metadata = new TextEncoder().encode(JSON.stringify({ name: draft.name, symbol: draft.ticker,
    description: draft.description, image: imageUrl }));
  let ipfs: AssetIpfs | undefined;
  if (Object.hasOwn(raw, 'ipfs')) {
    const { IPFS_PROFILE, IPFS_SCHEMA, ipfsContentId, ipfsMetadata } = await import('./ipfs-content.ts');
    const suppliedIpfs = raw.ipfs;
    if (!objectFields(suppliedIpfs, ['profile', 'schema', 'imageCid', 'metadataCid'])
      || suppliedIpfs.profile !== IPFS_PROFILE || suppliedIpfs.schema !== IPFS_SCHEMA)
      throw new AssetError('invalid_asset_response');
    const imageCid = await ipfsContentId(bytes);
    metadata = ipfsMetadata(draft, imageCid);
    const metadataCid = await ipfsContentId(metadata);
    if (suppliedIpfs.imageCid !== imageCid || suppliedIpfs.metadataCid !== metadataCid)
      throw new AssetError('invalid_asset_response');
    ipfs = suppliedIpfs as AssetIpfs;
    imageUrl = `${origin}/ipfs/${imageCid}`;
  }
  const metadataHash = await assetHash(metadata);
  if (
    raw.imageHash !== imageHash ||
    raw.imageUrl !== imageUrl ||
    raw.metadataHash !== metadataHash ||
    raw.metadataUrl !== (ipfs ? `${origin}/ipfs/${ipfs.metadataCid}` : `${origin}/launch-assets/${metadataHash}.json`) ||
    raw.totalBytes !== bytes.length + metadata.length
  )
    throw new AssetError('invalid_asset_response');
  const result = {
    ...raw,
    draft,
    wallet: assetWallet(expected.wallet),
    appOrigin: assetOrigin(expected.appOrigin, true),
    deadline: expected.startedAt + raw.expiresAt - raw.serverTime,
  } as AssetApproval;
  if (result.message !== assetMessage(result) || result.deadline <= now)
    throw new AssetError('invalid_asset_response');
  Object.freeze(result.draft);
  return Object.freeze(result);
}
export function validatePublishedAsset(
  raw: unknown,
  expected: Pick<
    AssetApproval,
    'id' | 'imageHash' | 'metadataHash' | 'imageUrl' | 'metadataUrl' | 'ipfs'
  >,
): PublishedAsset {
  if (
    !objectFields(raw, [
      'id',
      'status',
      'imageUrl',
      'metadataUrl',
      'imageHash',
      'metadataHash',
      'launchReady',
      ...(expected.ipfs ? ['ipfs'] : []),
    ]) ||
    raw.status !== 'published' ||
    raw.launchReady !== false ||
    ['id', 'imageUrl', 'metadataUrl', 'imageHash', 'metadataHash'].some(
      (field) => raw[field] !== expected[field as keyof typeof expected],
    ) || JSON.stringify(raw.ipfs) !== JSON.stringify(expected.ipfs)
  )
    throw new AssetError('invalid_asset_response');
  return raw as PublishedAsset;
}

export function validateProcessingAsset(raw: unknown, expected: AssetApproval | (Partial<AssetApproval> & { ipfs?: AssetIpfs })): ProcessingAsset {
  const states = ['staging', 'ready', 'sending', 'pinned', 'verified'];
  const delayed = !!raw && typeof raw === 'object' && 'issue' in raw;
  if (!expected.ipfs || !objectFields(raw, ['id','imageHash','metadataHash','imageUrl','metadataUrl','ipfs','launchReady','status','progress', ...(delayed ? ['issue','retryAt'] : [])])
    || raw.status !== 'processing' || raw.launchReady !== false
    || ['id','imageHash','metadataHash','imageUrl','metadataUrl'].some((field) => raw[field] !== expected[field as keyof typeof expected])
    || JSON.stringify(raw.ipfs) !== JSON.stringify(expected.ipfs)
    || !objectFields(raw.progress, ['image','metadata'])
    || !states.includes(String(raw.progress.image)) || !states.includes(String(raw.progress.metadata))
    || (delayed && (raw.issue !== 'verification_delayed' || !Number.isSafeInteger(raw.retryAt))))
    throw new AssetError('invalid_asset_response');
  return raw as ProcessingAsset;
}
export async function readAssetJson(
  body: ReadableStream<Uint8Array> | null,
  limit = ASSET_BODY_LIMIT,
  timeout = 12000,
): Promise<unknown> {
  const reader = body?.getReader();
  if (!reader) throw new AssetError('invalid_asset_response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel();
  }, timeout);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new AssetError('image_size');
      chunks.push(value);
    }
    if (expired) throw new AssetError('unavailable');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    clearTimeout(timer);
    await reader.cancel();
  }
}
