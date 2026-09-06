import { LaunchError, launchRequest, type LaunchRecovery } from './long-wallet.ts';
import { isCanonicalLongAsset } from './long-encoding/long-salt.mjs';
import type { LaunchpadId } from './launch-model.ts';

export type LaunchReceipt = {
  id: string; status: string; hash?: string; asset?: string; paidGasWei?: string;
};
export function confirmedLongTokenUrl(receipt: LaunchReceipt | null) {
  return receipt?.status === 'confirmed' && isCanonicalLongAsset(receipt.asset)
    ? `https://app.long.xyz/tokens/${receipt.asset!.toLowerCase()}`
    : null;
}
export function confirmedLaunchTokenUrl(pad: LaunchpadId, receipt: LaunchReceipt | null) {
  if (pad === 'long') return confirmedLongTokenUrl(receipt);
  if (receipt?.status !== 'confirmed' || !/^0x[a-f0-9]{40}$/i.test(receipt.asset ?? '')) return null;
  const asset = receipt.asset!.toLowerCase();
  return pad === 'longbow' ? `https://longbow.gg/c/${asset}`
    : `https://launch.o1.exchange/token/${asset}?chain=4663`;
}
export function validateLaunchStatus(value: LaunchReceipt, recovery: LaunchRecovery) {
  if (!value || value.id !== recovery.id || !['retryable', 'locating', 'uncertain', 'prepared', 'submitted', 'confirming', 'confirmed', 'failed'].includes(value.status)
    || (value.hash !== undefined && !/^0x[a-f0-9]{64}$/i.test(value.hash))
    || (recovery.hash && value.hash && recovery.hash.toLowerCase() !== value.hash.toLowerCase()))
    throw new LaunchError('launch_receipt_unverified');
  if (['confirmed', 'failed'].includes(value.status) && (!value.hash || !/^\d+$/.test(value.paidGasWei ?? '')
    || (value.status === 'confirmed' && !/^0x[a-f0-9]{40}$/i.test(value.asset ?? ''))))
    throw new LaunchError('launch_receipt_unverified');
  return value;
}

// Only reads. Wallet dispatch always requires a separate user click/approval.
export function watchLaunch(recovery: LaunchRecovery, onStatus: (result: LaunchReceipt) => void,
  onError: (error: unknown) => void, request = launchRequest,
  schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout) {
  let stopped = false, attempts = 0, timer: ReturnType<typeof setTimeout>;
  async function poll() {
    let delay = attempts++ < 3 ? 5000 : attempts < 20 ? 15000 : 60000;
    try {
      const result = validateLaunchStatus(await request('launch-status', { id: recovery.id, hash: recovery.hash }), recovery);
      if (stopped) return;
      onStatus(result);
      if (['confirmed', 'failed', 'retryable'].includes(result.status)) return;
    } catch (error) {
      if (stopped) return;
      onError(error);
      delay = Math.max(delay, error instanceof LaunchError ? error.retryAfter * 1000 : 15000);
    }
    if (!stopped) timer = schedule(() => { void poll(); }, delay);
  }
  void poll();
  return () => { stopped = true; clearTimeout(timer); };
}
