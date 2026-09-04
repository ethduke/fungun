import { assetDraft, assetHash, assetWallet, AssetError, type AssetDraft, type PublishedAsset } from './asset-protocol.ts';
import { prepareAsset, publishLaunchAsset, recoveryFor, readAssetRecovery, checkAssetStatus, clearAssetRecovery, type AssetRecovery } from './asset-client.ts';

const bindingKey = 'fungun.launch-artwork.v1';
export async function ensureLaunchArtwork({ bytes, wallet, draft, origin, storage, cached, isCurrent, onProgress,
  fetcher = fetch, pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
}: { bytes: Uint8Array; wallet: string; draft: AssetDraft; origin: string; storage: Storage;
  cached?: PublishedAsset | null; isCurrent: () => boolean; onProgress: (message: string) => void;
  fetcher?: typeof fetch; pause?: (ms: number) => Promise<void>;
}): Promise<PublishedAsset> {
  const account = assetWallet(wallet), details = assetDraft(draft);
  const sourceKey = await assetHash(new TextEncoder().encode(JSON.stringify([account, details, await assetHash(bytes)])));
  const guard = () => { if (!isCurrent()) throw new AssetError('asset_context_changed'); };
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
    for (let attempt = 0; attempt < 12; attempt++) {
      guard();
      const result = await checkAssetStatus(ticket, account, storage, fetcher);
      guard();
      if (result?.status === 'published' || result?.status === 'expired') return result;
      if (!result || result.issue) throw new AssetError('asset_publication_uncertain', 60);
      onProgress('Uploading artwork…');
      if (attempt < 11) await pause(5000);
    }
    throw new AssetError('asset_publication_uncertain', 60);
  };
  guard();
  const recovery = readAssetRecovery(storage, origin);
  if (recovery) {
    onProgress('Checking artwork…');
    const result = await wait(recovery);
    if (result.status === 'published' && binding?.id === recovery.id && binding.sourceKey === sourceKey) return result;
    // A completed older publication stays public. It must not be attached to
    // changed artwork, or to a legacy recovery without a source-byte binding.
    clearAssetRecovery(storage, recovery);
    storage.removeItem(bindingKey);
  } else if (cached?.ipfs) {
    const ticket: AssetRecovery = { id: cached.id, imageHash: cached.imageHash, metadataHash: cached.metadataHash,
      imageUrl: cached.imageUrl, metadataUrl: cached.metadataUrl, appOrigin: origin,
      assetOrigin: new URL(cached.imageUrl).origin, walletHash: await assetHash(new TextEncoder().encode(account)),
      version: 2, ipfs: cached.ipfs };
    try {
      const result = await wait(ticket);
      if (result.status === 'published') return result;
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
  const accepted = await publishLaunchAsset(approval, ticket, storage, isCurrent, fetcher);
  guard();
  if (accepted.status === 'published') return accepted;
  const result = await wait(ticket);
  if (result.status !== 'published') throw new AssetError('asset_approval_expired');
  return result;
}
