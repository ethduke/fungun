'use client';

import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useConnectedAccount } from '@/lib/account-context';
import { useDraftCache } from '@/lib/launch-draft';
import { formatEth, formatUsd, type LaunchCostQuote, type UsdRate } from '@/lib/launch-cost';
import { launchMessage, launchRequest, LaunchError, readLaunchRecovery, saveLaunchRecovery,
  validateLongPlan, type LaunchInput, type LaunchRecovery, type LongPlan } from '@/lib/long-wallet';

const wei = (value: string) => BigInt(value);
export type LongCosts = { quote: LaunchCostQuote; usd: UsdRate } | null;
export function LongLaunch({ enabled, ready, pairId, name, ticker, description, contextKey, onCosts }: {
  enabled: boolean; ready: boolean; pairId?: string; name: string; ticker: string; description: string;
  contextKey: string; onCosts: (costs: LongCosts) => void;
}) {
  const account = useConnectedAccount();
  const { published } = useDraftCache();
  const [plan, setPlan] = useState<LongPlan | null>(null);
  const [planContext, setPlanContext] = useState('');
  const [recovery, setRecovery] = useState<LaunchRecovery | null>(null);
  const [blocked, setBlocked] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<{ status: string; hash?: string; asset?: string; paidGasWei?: string } | null>(null);
  const [recoveryHash, setRecoveryHash] = useState('');
  const [expired, setExpired] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const flight = useRef(false);
  const current = useRef(contextKey);
  useEffect(() => { current.current = contextKey; }, [contextKey]);
  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (!mounted) return;
      try { setRecovery(readLaunchRecovery()); setBlocked(false); }
      catch (e) { setError(launchMessage(e)); }
    });
    const sync = () => { try { setRecovery(readLaunchRecovery()); } catch { setBlocked(true); } };
    window.addEventListener('storage', sync);
    return () => { mounted = false; window.removeEventListener('storage', sync); };
  }, []);
  useEffect(() => {
    if (!plan) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, plan.deadline - performance.now()));
    return () => clearTimeout(timer);
  }, [plan]);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(false), 60000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  const isReady = ready && !!account.address && account.chainId === 4663 && !!account.sendLong
    && !!published?.ipfs && !!pairId && !blocked && !recovery;
  const validPlan = plan && planContext === contextKey && !expired ? plan : null;
  async function prepare() {
    if (flight.current || !isReady || !published || !pairId || !account.address) return;
    flight.current = true; setBusy('Simulating launch and estimating gas…'); setError(''); setNotice('');
    const context = contextKey;
    try {
      const input: LaunchInput = { chainId: 4663, wallet: account.address, draft: { name, ticker, description }, pairId,
        publication: { id: published.id, imageHash: published.imageHash, metadataHash: published.metadataHash } };
      const started = performance.now();
      const raw = await launchRequest('launch-prepare', input);
      const checked = validateLongPlan(raw, input, published, started);
      if (current.current !== context) return;
      setPlan(checked); setPlanContext(context); setExpired(false);
      const observed = performance.now();
      onCosts({ quote: { contextKey: context, chainId: 4663, quotedAt: observed, expiresAt: checked.deadline, nativeOnly: true,
        pads: [{ id: 'long', steps: [{ kind: 'launch', valueWei: 0n, launchpadFeeWei: 0n,
          network: { chainId: 4663, gasUnits: wei(checked.estimatedGas), gasPriceWei: wei(checked.transaction.gasPrice) } }] }] },
        usd: { microUsdPerEth: wei(checked.usd.microUsdPerEth), sourceLabel: checked.usd.sourceLabel,
          quotedAt: observed, expiresAt: Math.min(checked.deadline, observed + 60000 - (raw.serverTime - checked.usd.quotedAt)) } });
    } catch (e) { setError(launchMessage(e)); setCooldown(true); }
    finally { flight.current = false; setBusy(''); }
  }
  async function launch() {
    if (flight.current || !validPlan || !isReady || !account.sendLong) return;
    flight.current = true; setBusy('Review and approve in your wallet…'); setError('');
    const context = contextKey;
    let saved: LaunchRecovery | undefined;
    try {
      const hash = await account.sendLong(validPlan, () => current.current === context, async () => {
        if (readLaunchRecovery()) throw new LaunchError('launch_pending');
        saved = { id: validPlan.id, binding: validPlan.binding, hash: null };
        saveLaunchRecovery(saved); setRecovery(saved);
        await launchRequest('launch-reserve', { id: validPlan.id, binding: validPlan.binding });
      });
      if (!saved) throw new LaunchError('launch_unknown');
      saved = { ...saved, hash };
      setRecovery(saved); saveLaunchRecovery(saved);
      setNotice('Transaction submitted. Check confirmation below.');
    } catch (e) {
      setError(launchMessage(e));
      if (saved) setNotice('This launch stays locked after wallet approval opens, including cancellation or a lost response. Check wallet history; do not launch again.');
    } finally { flight.current = false; setBusy(''); }
  }
  async function check() {
    if (flight.current || !recovery) return;
    flight.current = true; setBusy('Checking transaction…'); setError('');
    try {
      const hash = recovery.hash ?? (recoveryHash.trim() || null);
      if (hash && !/^0x[a-f0-9]{64}$/i.test(hash)) throw new LaunchError('launch_unknown');
      const result = await launchRequest('launch-status', { id: recovery.id, hash });
      if (result.id !== recovery.id || !['prepared','uncertain','submitted','confirming','confirmed','failed'].includes(result.status)) throw new LaunchError('launch_receipt_unverified');
      if (['confirmed','failed'].includes(result.status)) {
        if (!/^0x[a-f0-9]{64}$/i.test(result.hash) || !/^\d+$/.test(result.paidGasWei)
          || (result.status === 'confirmed' && !/^0x[a-f0-9]{40}$/i.test(result.asset))) throw new LaunchError('launch_receipt_unverified');
      }
      if (hash && result.hash === hash) {
        const saved = { ...recovery, hash }; saveLaunchRecovery(saved); setRecovery(saved);
      }
      setReceipt(result);
      setNotice(result.status === 'confirmed' ? 'Launch confirmed. Token metadata, supply and ticker reservation verified.'
        : result.status === 'failed' ? 'The transaction failed onchain. Gas was spent; no successful launch was verified.'
        : result.status === 'prepared' ? 'No wallet submission was recorded, but this browser attempt remains locked. Contact support before retrying.'
        : 'Confirmation is still pending. Check your wallet history; do not submit again.');
      setCooldown(true);
    } catch (e) { setError(launchMessage(e)); setCooldown(true); }
    finally { flight.current = false; setBusy(''); }
  }
  if (!enabled && !recovery) return null;
  const usd: UsdRate | undefined = plan ? { microUsdPerEth: wei(plan.usd.microUsdPerEth), sourceLabel: plan.usd.sourceLabel,
    quotedAt: 0, expiresAt: 60000 } : undefined;
  return <div className="long-launch" aria-busy={!!busy}>
    {recovery ? <>
      {!recovery.hash && <label htmlFor="launch-recovery-hash">Transaction hash from wallet history (if submitted)
        <Input id="launch-recovery-hash" value={recoveryHash} onChange={(e) => setRecoveryHash(e.target.value)} maxLength={66} autoComplete="off" spellCheck={false} />
      </label>}
      {!receipt || !['confirmed','failed'].includes(receipt.status) ? <Button type="button" variant="outline" disabled={!!busy || cooldown} onClick={check}>Check launch</Button> : null}
      {receipt?.hash && <a href={`https://robinhoodchain.blockscout.com/tx/${receipt.hash}`} target="_blank" rel="noopener noreferrer">View transaction</a>}
      {receipt?.asset && <a href={`https://robinhoodchain.blockscout.com/address/${receipt.asset}`} target="_blank" rel="noopener noreferrer">View token on explorer</a>}
      {receipt?.paidGasWei && <p>Gas paid: {formatEth(wei(receipt.paidGasWei))}</p>}
    </> : <>
      {validPlan && <details>
        <summary>Review launch · Long on Robinhood</summary>
        <p>{name} · ${ticker} · 1 billion tokens · no creator allocation · fixed metadata</p>
        <p>Maximum gas budget: {formatEth(wei(validPlan.maximumGasWei))} ({formatUsd(wei(validPlan.maximumGasWei), usd, 0)}). Includes a 20% gas-unit buffer. Unused gas is not charged.</p>
        <p>Wallet: {validPlan.transaction.from.slice(0,6)}…{validPlan.transaction.from.slice(-4)} · value: 0 ETH · chain: 4663</p>
        <a href={`https://robinhoodchain.blockscout.com/address/${validPlan.transaction.to}?tab=contract`} target="_blank" rel="noopener noreferrer">Verified launch contract</a>
        <p>Your wallet displays the full transaction. Gas and availability can change before it is mined.</p>
      </details>}
      <Button type="button" disabled={!isReady || !!busy || cooldown} onClick={validPlan ? launch : prepare}>
        {validPlan ? 'Launch coin' : plan ? 'Refresh launch estimate' : 'Review launch'}
      </Button>
      {!published && <p>Publish artwork above to prepare your launch.</p>}
      {published && !ready && <p>Select only Long and complete your coin details to launch.</p>}
    </>}
    {busy && <output>{busy}</output>}
    {notice && <output>{notice}</output>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
