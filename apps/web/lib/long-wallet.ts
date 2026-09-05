import { keccak256, type EIP1193Provider } from 'viem';
import { buildUnsignedLongLaunch, readLongLaunchProfile } from './long-encoding/long-launch.mjs';
import { assetDraft, assetWallet, type AssetDraft, type PublishedAsset } from './asset-protocol.ts';

export type LaunchInput = { chainId: 4663; wallet: string; draft: AssetDraft; pairId: string;
  publication: { id: string; imageHash: string; metadataHash: string } };
export type LongPlan = {
  id: string; binding: string; chainId: 4663; quotedAt: number; expiresAt: number; deadline: number;
  transaction: { chainId: '0x1237'; from: string; to: string; data: `0x${string}`; value: '0x0'; nonce: `0x${string}`; gas: `0x${string}`; gasPrice: `0x${string}` };
  profile: ReturnType<typeof readLongLaunchProfile> & { launcher: { address: string; codeHash: string } }; startingTick: number; intentId: string;
  predictedAsset: string; predictedPool: string; review: ReturnType<typeof buildUnsignedLongLaunch>['review'];
  estimatedGas: string; maximumGasWei: string; launchpadFeeWei: '0';
  usd: { microUsdPerEth: string; sourceLabel: string; quotedAt: number };
};
export class LaunchError extends Error {
  retryAfter: number;
  constructor(message: string, retryAfter = 0) { super(message); this.retryAfter = retryAfter; }
}
export class LaunchPreflightError extends Error {
  override cause: unknown;
  constructor(cause: unknown) { super('launch_preflight'); this.cause = cause; }
}
export function launchMessage(error: unknown) {
  if (error instanceof LaunchPreflightError) return launchMessage(error.cause);
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
    const entry = cause as { code?: number; cause?: unknown };
    if (entry.code === 4001) return 'Wallet request cancelled. You can try Launch coin again.';
    cause = entry.cause;
  }
  const code = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = {
    long_launch_disabled: 'Long launches are not enabled on this server yet.',
    unsupported_pair: 'This pairing has not been verified for wallet launches yet. Choose NVDA.',
    launch_assets_unverified: 'Artwork publication is not verified yet. Check its status before launching.',
    oracle_stale: 'The stock price is paused or out of date. Wait for a fresh market price before launching.',
    contract_unverified: 'A launch contract or price feed changed. Launching is paused for review.',
    ticker_reserved: 'This ticker is reserved. Choose another ticker.',
    insufficient_funds: 'Your wallet needs more ETH on Robinhood Chain for gas.',
    launch_gas_limit: 'Gas is above the launch limit. Wait for fees to fall and refresh the estimate.',
    launch_pending: 'Your launch is being checked automatically.',
    launch_context_locked: 'Coin details changed while preparing. Launch again with the current details.',
    quote_expired: 'The gas estimate expired. Refresh it before opening your wallet.',
    wrong_account: 'The connected account changed. Restore the account used for this launch.',
    wrong_chain: 'Switch your wallet to Robinhood Chain before continuing.',
    launch_eoa_required: 'This launch currently supports ordinary wallet accounts only.',
    rate_limited: 'The service is busy. Your draft is saved; please try again shortly.',
    busy: 'Another launch check is running. Try again shortly.',
    reverted: 'The launch simulation failed. No transaction was sent. Refresh the ticker and estimate.',
    launch_transaction_changed: 'The wallet changed this transaction. No matching launch was verified.',
    launch_receipt_unverified: 'Verifying your launch on the network…',
    recovery_unavailable: 'Browser recovery storage is unavailable. Enable it before launching.',
    launch_unknown: 'Reconnecting to your launch…',
  };
  return messages[code] ?? 'Could not complete the launch request. Reconnecting…';
}
const hex = (s: unknown) => typeof s === 'string' && /^0x(?:0|[1-9a-f][a-f0-9]*)$/i.test(s);
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const assert = (ok: unknown) => { if (!ok) throw new LaunchError('launch_transaction_changed'); };
export function validateLongPlan(raw: unknown, input: LaunchInput, published: PublishedAsset, started: number, now = performance.now()): LongPlan {
  const p = raw as LongPlan & { serverTime: number };
  assert(p && p.chainId === 4663 && /^[a-f0-9]{64}$/.test(p.id) && /^[a-f0-9]{64}$/.test(p.binding));
  assert([p.quotedAt, p.expiresAt, p.serverTime].every(Number.isSafeInteger) && p.expiresAt - p.quotedAt === 30000
    && p.serverTime >= p.quotedAt && p.serverTime < p.expiresAt && published.ipfs);
  const deadline = started + p.expiresAt - p.serverTime;
  assert(deadline > now);
  const inputDraft = assetDraft(input.draft);
  const rebuilt = buildUnsignedLongLaunch({ chainId: 4663, wallet: assetWallet(input.wallet), draft: inputDraft,
    pairId: input.pairId, metadataUri: `ipfs://${published.ipfs!.metadataCid}`, startingTick: p.startingTick, intentId: p.intentId }, p.profile);
  assert(rebuilt.binding === p.binding && same(rebuilt.predictedAsset, p.predictedAsset)
    && JSON.stringify(rebuilt.review) === JSON.stringify(p.review));
  const tx = p.transaction;
  assert(tx && Object.keys(tx).sort().join(',') === 'chainId,data,from,gas,gasPrice,nonce,to,value'
    && tx.chainId === '0x1237' && tx.value === '0x0' && same(tx.from, input.wallet)
    && same(tx.to, rebuilt.transaction.to) && tx.data === rebuilt.transaction.data
    && [tx.gas, tx.gasPrice, tx.nonce].every(hex));
  const estimate = BigInt(p.estimatedGas), gas = BigInt(tx.gas), price = BigInt(tx.gasPrice);
  assert(estimate >= 21000n && gas === (estimate * 120n + 99n) / 100n && gas <= 3000000n && price > 0n
    && price <= 10n ** 12n && gas * price <= 5n * 10n ** 16n && p.maximumGasWei === String(gas * price) && p.launchpadFeeWei === '0');
  assert(p.usd?.sourceLabel === 'Coinbase ETH/USD spot' && /^\d{1,12}$/.test(p.usd.microUsdPerEth)
    && BigInt(p.usd.microUsdPerEth) > 0n && Number.isSafeInteger(p.usd.quotedAt)
    && p.usd.quotedAt <= p.serverTime && p.serverTime - p.usd.quotedAt < 60000);
  return Object.freeze({ ...p, deadline, transaction: Object.freeze({ ...tx }) });
}

export async function prepareLongWallet(input: LaunchInput, publication: PublishedAsset) {
  const started = performance.now();
  const raw = await launchRequest('launch-prepare', input);
  if (raw.recovery !== undefined) return { recovery: validateLaunchRecovery(raw.recovery) };
  const plan = validateLongPlan(raw, input, publication, started);
  return { plan, observedAt: performance.now(), usdAge: raw.serverTime - plan.usd.quotedAt };
}

export async function sendLongWallet(provider: EIP1193Provider, plan: LongPlan, isCurrent: () => boolean, reserve: () => Promise<void>) {
  const check = async () => {
    if (!isCurrent()) throw new LaunchError('wrong_account');
    const accounts = await provider.request({ method: 'eth_accounts' });
    const chain = await provider.request({ method: 'eth_chainId' });
    if (!same(accounts[0], plan.transaction.from)) throw new LaunchError('wrong_account');
    if (BigInt(chain) !== 4663n) throw new LaunchError('wrong_chain');
    if (!isCurrent() || performance.now() >= plan.deadline) throw new LaunchError('quote_expired');
  };
  const tx = plan.transaction;
  try {
  await check();
  const code = await provider.request({ method: 'eth_getCode', params: [tx.to as `0x${string}`, 'latest'] });
  if (code === '0x' || !same(keccak256(code), plan.profile.launcher.codeHash)) throw new LaunchError('contract_unverified');
  const nonce = await provider.request({ method: 'eth_getTransactionCount', params: [tx.from as `0x${string}`, 'pending'] });
  if (BigInt(nonce) !== BigInt(tx.nonce)) throw new LaunchError('quote_expired');
  await check();
  await reserve();
  await check();
  } catch (error) { throw new LaunchPreflightError(error); }
  // The extension owns signing and submission. One request per user action.
  // Recovery can reopen only the same launch intent with its original nonce.
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [tx as never] });
  if (typeof hash !== 'string' || !/^0x[a-f0-9]{64}$/i.test(hash)) throw new LaunchError('launch_unknown');
  return hash;
}

export async function launchRequest(operation: 'launch-prepare' | 'launch-reserve' | 'launch-status' | 'launch-estimate', input: unknown) {
  const response = await fetch(`/api/${operation}`, { method: 'POST', credentials: 'omit', redirect: 'error',
    signal: AbortSignal.timeout(24000), headers: { 'content-type': 'application/json', 'x-fungun-intent': operation }, body: JSON.stringify(input) });
  const reader = response.body?.getReader();
  if (!reader) throw new LaunchError('unavailable');
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      if (size > 32768) throw new LaunchError('unavailable'); chunks.push(value); }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  const result = JSON.parse(new TextDecoder().decode(bytes));
  if (!response.ok) {
    const retry = Number(response.headers.get('retry-after'));
    throw new LaunchError(typeof result?.error === 'string' ? result.error : 'unavailable',
      Number.isFinite(retry) && retry > 0 ? Math.min(retry, 86400) : 0);
  }
  return result;
}

export type LaunchRecovery = { id: string; binding: string; hash: string | null };
const recoveryKey = 'fungun:long-launch:1';
export function validateLaunchRecovery(r: unknown): LaunchRecovery {
  const value = r as LaunchRecovery;
  if (!value || Object.keys(value).sort().join(',') !== 'binding,hash,id' || !/^[a-f0-9]{64}$/.test(value.id)
    || !/^[a-f0-9]{64}$/.test(value.binding) || (value.hash !== null && !/^0x[a-f0-9]{64}$/i.test(value.hash)))
    throw new LaunchError('recovery_unavailable');
  return value;
}
function scopedRecoveryKey(scope: string) {
  if (!scope) return recoveryKey; // Keep legacy records intact; new drafts never adopt them blindly.
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new LaunchError('recovery_unavailable');
  return `fungun:long-launch:2:${scope}`;
}
export function readLaunchRecovery(scope = ''): LaunchRecovery | null {
  try {
    const text = localStorage.getItem(scopedRecoveryKey(scope));
    return text ? validateLaunchRecovery(JSON.parse(text)) : null;
  } catch { throw new LaunchError('recovery_unavailable'); }
}
export function saveLaunchRecovery(value: LaunchRecovery, scope = '') {
  try { localStorage.setItem(scopedRecoveryKey(scope), JSON.stringify(validateLaunchRecovery(value)));
    if (JSON.stringify(readLaunchRecovery(scope)) !== JSON.stringify(value)) throw new Error(); }
  catch { throw new LaunchError('recovery_unavailable'); }
}
