import type { ConnectedAccount } from './account-context.tsx';
import { AssetError } from './asset-protocol.ts';
import { AppError } from './user-error.ts';

export const ASSET_CHAIN_ID = 4663;

export function assetAccountReady(account: ConnectedAccount) {
  return !!account.address && !!account.ensureChain && !!account.signAsset;
}

function chainError(value: unknown) {
  const seen = new Set<unknown>();
  let current = value;
  for (
    let depth = 0;
    depth < 8 && current && typeof current === 'object' && !seen.has(current);
    depth++
  ) {
    seen.add(current);
    if (current instanceof AppError) {
      if (['cancelled', 'wrong_account'].includes(current.code))
        return new AssetError('asset_context_changed');
      if (current.code === 'disconnected') return new AssetError('disconnected');
      if (current.code === 'wrong_chain') return new AssetError('wrong_chain');
    }
    const entry = current as {
      code?: unknown;
      name?: unknown;
      cause?: unknown;
    };
    if (entry.code === 4001 || entry.name === 'UserRejectedRequestError')
      return new AssetError('asset_chain_rejected');
    if (entry.code === -32002) return new AssetError('asset_wallet_pending');
    if ([4100, 4900].includes(Number(entry.code)))
      return new AssetError('disconnected');
    if (entry.code === 4200) return new AssetError('asset_chain_unsupported');
    current = entry.cause;
  }
  return new AssetError('wrong_chain');
}

export async function ensureAssetChain(
  account: ConnectedAccount,
  isCurrent: () => boolean,
) {
  if (!account.address || !account.ensureChain)
    throw new AssetError('disconnected');
  if (!isCurrent()) throw new AssetError('asset_context_changed');
  if (account.chainId === ASSET_CHAIN_ID) return;
  try {
    await account.ensureChain(account.address, ASSET_CHAIN_ID, isCurrent);
  } catch (value) {
    throw chainError(value);
  }
  if (!isCurrent()) throw new AssetError('asset_context_changed');
}
