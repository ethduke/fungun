import {
  AssetError,
  assetHash,
  assetOrigin,
  assetWallet,
  imageBase64,
  objectFields,
  readAssetJson,
  validateAssetPreview,
  validatePublishedAsset,
  validateProcessingAsset,
  validateExpiredAsset,
  type AssetApproval,
  type AssetDraft,
  type PublishedAsset,
  type ProcessingAsset,
  type ExpiredAsset,
} from './asset-protocol.ts';

export type AssetRecovery = Pick<
  AssetApproval,
  | 'id'
  | 'imageHash'
  | 'metadataHash'
  | 'imageUrl'
  | 'metadataUrl'
  | 'appOrigin'
  | 'assetOrigin'
> & { walletHash: string; ipfs?: AssetApproval['ipfs']; version?: 2 };
const storageKey = 'fungun.asset-publication.v1';
const recoveryEvent = 'fungun:asset-recovery';
export function assetRecoverySnapshot() {
  try {
    return localStorage.getItem(storageKey) ?? '';
  } catch {
    return 'unavailable';
  }
}
export function subscribeAssetRecovery(listener: () => void) {
  window.addEventListener(recoveryEvent, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(recoveryEvent, listener);
    window.removeEventListener('storage', listener);
  };
}
function notifyRecovery() {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(recoveryEvent));
}
export function readAssetRecovery(
  storage: Pick<Storage, 'getItem'>,
  origin: string,
): AssetRecovery | null {
  const saved = storage.getItem(storageKey);
  if (!saved) return null;
  if (saved.length > 2048) throw new AssetError('asset_publication_uncertain');
  const value: unknown = JSON.parse(saved);
  const fields = [
      'id',
      'imageHash',
      'metadataHash',
      'imageUrl',
      'metadataUrl',
      'appOrigin',
      'assetOrigin',
      'walletHash',
    ];
  const ipfs = !!value && typeof value === 'object' && 'version' in value;
  if (
    !objectFields(value, ipfs ? [...fields, 'ipfs', 'version'] : fields) ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{48}$/.test(value.id) ||
    value.appOrigin !== origin ||
    [value.imageHash, value.metadataHash, value.walletHash].some(
      (hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash),
    )
  )
    throw new AssetError('asset_publication_uncertain');
  const publicOrigin = assetOrigin(value.assetOrigin);
  if (ipfs && (value.version !== 2 || !objectFields(value.ipfs, ['profile','schema','imageCid','metadataCid'])
    || value.ipfs.profile !== 'pinata-v1-256k' || value.ipfs.schema !== 'long-ipfs-v1'
    || !/^b[a-z2-7]{58}$/.test(String(value.ipfs.imageCid))
    || !/^b[a-z2-7]{58}$/.test(String(value.ipfs.metadataCid))))
    throw new AssetError('asset_publication_uncertain');
  if (ipfs && value.imageUrl === `${publicOrigin}/files/${String((value.ipfs as Record<string, unknown>).imageCid)}`
    && value.metadataUrl === `${publicOrigin}/files/${String((value.ipfs as Record<string, unknown>).metadataCid)}`) {
    // Upgrade only the exact legacy gateway paths; publication identity and
    // wallet binding remain unchanged, so recovery never needs another signature.
    value.imageUrl = `${publicOrigin}/ipfs/${String((value.ipfs as Record<string, unknown>).imageCid)}`;
    value.metadataUrl = `${publicOrigin}/ipfs/${String((value.ipfs as Record<string, unknown>).metadataCid)}`;
  }
  if (
    value.imageUrl !== (ipfs ? `${publicOrigin}/ipfs/${String((value.ipfs as Record<string, unknown>).imageCid)}`
      : `${publicOrigin}/launch-assets/${String(value.imageHash)}.webp`) ||
    value.metadataUrl !== (ipfs ? `${publicOrigin}/ipfs/${String((value.ipfs as Record<string, unknown>).metadataCid)}`
      : `${publicOrigin}/launch-assets/${String(value.metadataHash)}.json`)
  )
    throw new AssetError('asset_publication_uncertain');
  return value as AssetRecovery;
}
export async function recoveryFor(
  approval: AssetApproval,
): Promise<AssetRecovery> {
  const {
    id,
    imageHash,
    metadataHash,
    imageUrl,
    metadataUrl,
    appOrigin,
    assetOrigin,
  } = approval;
  return {
    id,
    imageHash,
    metadataHash,
    imageUrl,
    metadataUrl,
    appOrigin,
    assetOrigin,
    walletHash: await assetHash(new TextEncoder().encode(approval.wallet)),
    ...(approval.ipfs ? { version: 2 as const, ipfs: approval.ipfs } : {}),
  };
}
export function saveAssetRecovery(storage: Storage, value: AssetRecovery) {
  if (storage.getItem(storageKey))
    throw new AssetError('asset_publication_uncertain');
  storage.setItem(storageKey, JSON.stringify(value));
  notifyRecovery();
}
export function clearAssetRecovery(storage: Storage, value: AssetRecovery) {
  const stored = readAssetRecovery(storage, value.appOrigin);
  if (stored?.id === value.id) storage.removeItem(storageKey);
  notifyRecovery();
}
export async function assetRequest(
  operation: 'prepare' | 'publish' | 'status',
  value: unknown,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetcher(`/api/assets/${operation}`, {
    method: 'POST',
    body: JSON.stringify(value),
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(35000),
    headers: {
      'content-type': 'application/json',
      'x-fungun-intent': `asset-${operation}`,
    },
  });
  if (
    response.headers.get('content-type')?.split(';')[0].trim() !==
    'application/json'
  ) {
    await response.body?.cancel();
    throw new AssetError('invalid_asset_response');
  }
  const raw = await readAssetJson(response.body);
  if (!response.ok) {
    const error =
      raw &&
      typeof raw === 'object' &&
      'error' in raw &&
      typeof raw.error === 'string'
        ? raw.error
        : 'unavailable';
    const retry = Number(response.headers.get('retry-after'));
    throw new AssetError(
      error,
      Number.isInteger(retry) && retry > 0 ? Math.min(retry, 86400) : 0,
    );
  }
  return raw;
}
export async function prepareAsset(
  bytes: Uint8Array,
  wallet: string,
  draft: AssetDraft,
  origin: string,
  fetcher: typeof fetch = fetch,
) {
  const startedAt = performance.now();
  const account = assetWallet(wallet);
  const response = await assetRequest(
    'prepare',
    { chainId: 4663, wallet: account, draft, imageBase64: imageBase64(bytes) },
    fetcher,
  );
  return validateAssetPreview(response, {
    wallet: account,
    draft,
    appOrigin: origin,
    startedAt,
  });
}
export async function publishAsset(
  approval: AssetApproval,
  signature: string,
  recovery: AssetRecovery,
  storage: Storage,
  isCurrent: () => boolean,
  fetcher: typeof fetch = fetch,
): Promise<PublishedAsset | ProcessingAsset> {
  if (!isCurrent()) throw new AssetError('asset_context_changed');
  if (performance.now() >= approval.deadline)
    throw new AssetError('asset_approval_expired');
  if (
    !/^0x[a-f0-9]{130}$/i.test(signature) ||
    JSON.stringify(recovery) !== JSON.stringify(await recoveryFor(approval))
  )
    throw new AssetError('invalid_asset_approval');
  if (!isCurrent()) throw new AssetError('asset_context_changed');
  if (performance.now() >= approval.deadline)
    throw new AssetError('asset_approval_expired');
  try {
    saveAssetRecovery(storage, recovery);
  } catch (error) {
    throw error instanceof AssetError
      ? error
      : new AssetError('asset_recovery_unavailable');
  }
  try {
    const raw = await assetRequest(
      'publish',
      {
        chainId: 4663,
        wallet: approval.wallet,
        draft: approval.draft,
        imageBase64: approval.imageBase64,
        id: approval.id,
        signature,
      },
      fetcher,
    );
    const result = raw && typeof raw === 'object' && 'status' in raw && raw.status === 'processing'
      ? validateProcessingAsset(raw, approval) : validatePublishedAsset(raw, approval);
    return result;
  } catch (error) {
    throw new AssetError(
      'asset_publication_uncertain',
      error instanceof AssetError ? error.retryAfter : 0,
      error instanceof AssetError ? error.code : '',
    );
  }
}
export async function checkAssetStatus(
  recovery: AssetRecovery,
  wallet: string,
  storage: Storage,
  fetcher: typeof fetch = fetch,
): Promise<PublishedAsset | ProcessingAsset | ExpiredAsset | null> {
  const account = assetWallet(wallet);
  if (
    (await assetHash(new TextEncoder().encode(account))) !== recovery.walletHash
  )
    throw new AssetError('asset_recovery_wallet');
  const raw = await assetRequest(
    'status',
    {
      chainId: 4663,
      wallet: account,
      id: recovery.id,
      imageHash: recovery.imageHash,
      metadataHash: recovery.metadataHash,
    },
    fetcher,
  );
  if (
    objectFields(raw, ['id', 'status']) &&
    raw.id === recovery.id &&
    ['pending', 'uncertain'].includes(raw.status as string)
  )
    return null;
  const result =
    raw &&
    typeof raw === 'object' &&
    'status' in raw &&
    raw.status === 'expired'
      ? validateExpiredAsset(raw, recovery)
      : raw && typeof raw === 'object' && 'status' in raw && raw.status === 'processing'
        ? validateProcessingAsset(raw, recovery)
        : validatePublishedAsset(raw, recovery);
  if (result.status === 'expired') clearAssetRecovery(storage, recovery);
  return result;
}
