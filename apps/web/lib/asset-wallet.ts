import {
  createWalletClient,
  custom,
  recoverMessageAddress,
  type EIP1193Provider,
} from 'viem';
import {
  AssetError,
  assetMessage,
  assetWallet,
  type AssetApproval,
} from './asset-protocol.ts';

let signing = false;
export async function signWalletAsset(
  provider: EIP1193Provider,
  approval: AssetApproval,
  isCurrent: () => boolean,
) {
  if (signing) throw new AssetError('asset_busy');
  signing = true;
  const identity = async () => {
    if (!isCurrent()) throw new AssetError('asset_context_changed');
    if (performance.now() >= approval.deadline)
      throw new AssetError('asset_approval_expired');
    const accounts = await provider.request({ method: 'eth_accounts' });
    const chain = await provider.request({ method: 'eth_chainId' });
    if (
      !isCurrent() ||
      accounts[0]?.toLowerCase() !== approval.wallet ||
      BigInt(chain) !== 4663n
    )
      throw new AssetError('asset_context_changed');
    if (performance.now() >= approval.deadline)
      throw new AssetError('asset_approval_expired');
  };
  try {
    if (
      assetWallet(approval.wallet) !== approval.wallet ||
      approval.message !== assetMessage(approval)
    )
      throw new AssetError('invalid_asset_approval');
    await identity();
    const client = createWalletClient({
      transport: custom(provider, { retryCount: 0 }),
    });
    const signature = await client.signMessage({
      account: approval.wallet as `0x${string}`,
      message: approval.message,
    });
    await identity();
    if (
      (
        await recoverMessageAddress({ message: approval.message, signature })
      ).toLowerCase() !== approval.wallet
    )
      throw new AssetError('invalid_asset_approval');
    if (!isCurrent()) throw new AssetError('asset_context_changed');
    return signature;
  } catch (error) {
    let current: unknown = error;
    for (
      let index = 0;
      index < 8 && current && typeof current === 'object';
      index++
    ) {
      if (
        ('code' in current && current.code === 4001) ||
        ('name' in current && current.name === 'UserRejectedRequestError')
      )
        throw new AssetError('asset_rejected');
      current = 'cause' in current ? current.cause : null;
    }
    throw error instanceof AssetError
      ? error
      : new AssetError('invalid_asset_approval');
  } finally {
    signing = false;
  }
}
