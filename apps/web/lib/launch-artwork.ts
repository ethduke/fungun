import { assetDraft, assetHash, assetWallet, AssetError, type AssetDraft, type PublishedAsset } from './asset-protocol.ts';
import { prepareAsset, publishLaunchAsset, recoveryFor, readAssetRecovery, checkAssetStatus, clearAssetRecovery, type AssetRecovery, type AssetStorage } from './asset-client.ts';
import { artworkHistory, rememberArtwork, forgetArtwork } from './artwork-cache.ts';

const bindingKey = 'fungun.launch-artwork.v1';
const recoveryKey = 'fungun.asset-publication.v1';

function walletArtworkStorage(storage: AssetStorage, origin: string, walletHash: string): AssetStorage {
  const scoped: AssetStorage = {
    getItem: key => storage.getItem(`${key}:${walletHash}`),
    setItem: (key, value) => storage.setItem(`${key}:${walletHash}`, value),
    removeItem: key => storage.removeItem(`${key}:${walletHash}`),
  };
  const existing = readAssetRecovery(scoped, origin);
  if (existing) {
    if (existing.walletHash !== walletHash) throw new AssetError('asset_recovery_wallet');
    return scoped;
  }
  const legacy = readAssetRecovery(storage, origin);
  if (legacy?.walletHash === walletHash) {
    // Copy the owner's old recovery before any new request. Retain the original
    // for older tabs, and never adopt or erase another wallet's publication.
    const binding = storage.getItem(bindingKey);
    if (binding) {
      scoped.setItem(bindingKey, binding);
      if (scoped.getItem(bindingKey) !== binding) throw new AssetError('asset_recovery_unavailable');
    }
    const saved = JSON.stringify(legacy);
    scoped.setItem(recoveryKey, saved);
    if (scoped.getItem(recoveryKey) !== saved) throw new AssetError('asset_recovery_unavailable');
  }
  return scoped;
}

export async function ensureLaunchArtwork({ bytes, wallet, draft, origin, storage, cached, isCurrent, onProgress,
  fetcher = fetch, pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)), now = Date.now,
}: { bytes: Uint8Array; wallet: string; draft: AssetDraft; origin: string; storage: AssetStorage;
  cached?: PublishedAsset | null; isCurrent: () => boolean; onProgress: (message: string) => void;
  fetcher?: typeof fetch; pause?: (ms: number) => Promise<void>; now?: () => number;
}): Promise<PublishedAsset> {
  const account = assetWallet(wallet), details = assetDraft(draft);
  const sourceKey = await assetHash(new TextEncoder().encode(JSON.stringify([account, details, await assetHash(bytes)])));
  const guard = () => { if (!isCurrent()) throw new AssetError('asset_context_changed'); };
  const walletHash = await assetHash(new TextEncoder().encode(account));
  guard();
  storage = walletArtworkStorage(storage, origin, walletHash);
  const ticketFor = (asset: PublishedAsset): AssetRecovery => ({ id: asset.id, imageHash: asset.imageHash,
    metadataHash: asset.metadataHash, imageUrl: asset.imageUrl, metadataUrl: asset.metadataUrl,
    appOrigin: origin, assetOrigin: new URL(asset.imageUrl).origin, walletHash,
    ...(asset.ipfs ? { version: 2, ipfs: asset.ipfs } : {}) });
  const completed = (asset: PublishedAsset) => {
    if (asset.ipfs) rememberArtwork(storage, sourceKey, ticketFor(asset), now());
    return asset;
  };
  const saved = artworkHistory(storage, origin, walletHash, now()).find(entry => entry.sourceKey === sourceKey);
  if (saved) {
    onProgress('Using saved artwork…');
    try {
      const result = await checkAssetStatus(saved.ticket, account, storage, fetcher);
      guard();
      if (result?.status === 'published') return result;
    } catch (error) {
      if (!(error instanceof AssetError) || error.code !== 'asset_approval_changed') throw error;
    }
    forgetArtwork(storage, sourceKey, origin, walletHash, now());
  }
  const savedBinding = storage.getItem(bindingKey);
  let binding: { id: string; sourceKey: string } | null = null;
  if (savedBinding) {
    try {
      const value = JSON.parse(savedBinding);
      if (savedBinding.length > 256 || Object.keys(value).sort().join(',') !== 'id,sourceKey'
        || !/^[a-f0-9]{48}$/.test(value.id) || !/^[a-f0-9]{64}$/.test(value.sourceKey)) throw new Error();
      binding = value;
    } catch { throw new AssetError('asset_recovery_unavailable'); }
  }
  const wait = async (ticket: AssetRecovery) => {
    // Poll local status only. Provider retries remain durably scheduled by the
    // worker; a delayed verification must never cause a second upload.
    for (let attempt = 0; attempt < 27; attempt++) {
      guard();
      const result = await checkAssetStatus(ticket, account, storage, fetcher);
      guard();
      if (result?.status === 'published' || result?.status === 'expired' || result?.status === 'pending') return result;
      if (result?.issue === 'gateway_access_denied') throw new AssetError('asset_gateway_unavailable');
      onProgress(result?.progress.image === 'verified' ? 'Finishing artwork…' : 'Uploading artwork…');
      if (attempt < 26) await pause(attempt < 5 ? 3000 : 5000);
    }
    throw new AssetError('asset_publication_uncertain');
  };
  guard();
  const recovery = readAssetRecovery(storage, origin);
  let pendingId: string | undefined;
  if (recovery) {
    onProgress('Checking artwork…');
    const result = await wait(recovery);
    if (result.status === 'pending') pendingId = result.id;
    if (result.status === 'published' && binding?.id === recovery.id) {
      rememberArtwork(storage, binding.sourceKey, ticketFor(result), now());
      if (binding.sourceKey === sourceKey) return completed(result);
    }
    // A completed older publication stays public. It must not be attached to
    // changed artwork, or to a legacy recovery without a source-byte binding.
    if (result.status !== 'pending') {
      clearAssetRecovery(storage, recovery);
      storage.removeItem(bindingKey);
    }
    // Pending means the server has not reserved or uploaded anything. Prepare
    // the current bytes again to obtain the same content-bound capability and
    // resume acceptance; reserved/uncertain uploads above remain read-only.
  } else if (cached?.ipfs) {
    const ticket: AssetRecovery = { id: cached.id, imageHash: cached.imageHash, metadataHash: cached.metadataHash,
      imageUrl: cached.imageUrl, metadataUrl: cached.metadataUrl, appOrigin: origin,
      assetOrigin: new URL(cached.imageUrl).origin, walletHash,
      version: 2, ipfs: cached.ipfs };
    try {
      const result = await wait(ticket);
      if (result.status === 'published') return completed(result);
    } catch (error) {
      if (!(error instanceof AssetError) || error.code !== 'asset_approval_changed') throw error;
    }
  }
  guard(); onProgress('Preparing artwork…');
  const approval = await prepareAsset(bytes, account, details, origin, fetcher, true);
  guard();
  const ticket = await recoveryFor(approval);
  storage.setItem(bindingKey, JSON.stringify({ id: ticket.id, sourceKey }));
  if (storage.getItem(bindingKey) !== JSON.stringify({ id: ticket.id, sourceKey })) throw new AssetError('asset_recovery_unavailable');
  onProgress('Uploading artwork…');
  let accepted;
  let publicationError: AssetError | undefined;
  try { accepted = await publishLaunchAsset(approval, ticket, storage, isCurrent, fetcher, pendingId === ticket.id); }
  catch (error) {
    if (!(error instanceof AssetError) || error.code !== 'asset_publication_uncertain') throw error;
    publicationError = error;
    // The recovery record was saved before the request. Resolve a missing
    // acknowledgment through status, never by repeating the publication write.
  }
  guard();
  if (accepted?.status === 'published') return completed(accepted);
  const result = await wait(ticket);
  if (result.status === 'pending') {
    // A refused request must not become minutes of polling an unstarted upload.
    // Retain recovery: the next automatic preparation can resume this same id.
    throw new AssetError(publicationError?.publicationCause || 'asset_publication_uncertain', publicationError?.retryAfter ?? 0);
  }
  if (result.status !== 'published') throw new AssetError('asset_approval_expired');
  return completed(result);
}
