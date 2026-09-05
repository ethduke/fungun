'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { BulletProgress, LaunchGun } from '@/components/launch-motion';
import { launchActivity } from '@/lib/launch-progress';
import { useConnectedAccount } from '@/lib/account-context';
import { useDraftCache } from '@/lib/launch-draft';
import { LONG_PAIRS } from '@/lib/launch-model';
import {
  formatEth,
  formatUsd,
  type LaunchCostQuote,
  type UsdRate,
} from '@/lib/launch-cost';
import {
  launchMessage,
  launchRequest,
  LaunchError,
  readLaunchRecovery,
  saveLaunchRecovery,
  prepareLongWallet,
  type LaunchInput,
  type LaunchRecovery,
  type LongPlan,
} from '@/lib/long-wallet';

import { ensureLaunchArtwork } from '@/lib/launch-artwork';
import { assetErrorText, AssetError } from '@/lib/asset-protocol';
import { draftImageBlob, type DraftImage } from '@/lib/launch-draft-cache';

const wei = (value: string) => BigInt(value);
export type LongCosts = { quote: LaunchCostQuote; usd: UsdRate } | null;
export function LongLaunch({
  enabled,
  ready,
  pairId,
  name,
  ticker,
  description,
  image,
  contextKey,
  onCosts,
}: {
  enabled: boolean;
  ready: boolean;
  pairId?: string;
  name: string;
  ticker: string;
  description: string;
  image: DraftImage | null;
  contextKey: string;
  onCosts: (costs: LongCosts) => void;
}) {
  const account = useConnectedAccount();
  const { published, cachePublication, hydrated } = useDraftCache();
  const [plan, setPlan] = useState<LongPlan | null>(null);
  const [planContext, setPlanContext] = useState('');
  const [recovery, setRecovery] = useState<LaunchRecovery | null>(null);
  const [blocked, setBlocked] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<{
    id: string;
    status: string;
    hash?: string;
    asset?: string;
    paidGasWei?: string;
  } | null>(null);
  const [recoveryHash, setRecoveryHash] = useState('');
  const [expired, setExpired] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const flight = useRef(false);
  const current = useRef(contextKey);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    current.current = contextKey;
  }, [contextKey]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (!mounted) return;
      try {
        setRecovery(readLaunchRecovery());
        setBlocked(false);
      } catch (e) {
        setError(launchMessage(e));
      }
    });
    const sync = () => {
      try {
        setRecovery(readLaunchRecovery());
      } catch {
        setBlocked(true);
      }
    };
    window.addEventListener('storage', sync);
    return () => {
      mounted = false;
      window.removeEventListener('storage', sync);
    };
  }, []);
  useEffect(() => {
    if (!plan) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, plan.deadline - performance.now()),
    );
    return () => clearTimeout(timer);
  }, [plan]);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(0), cooldown);
    return () => clearTimeout(timer);
  }, [cooldown]);
  const eligiblePair = LONG_PAIRS.some((pair) => pair.id === pairId);
  const isReady =
    ready &&
    !!account.address &&
    account.chainId === 4663 &&
    !!account.sendLong &&
    hydrated &&
    !!image &&
    eligiblePair &&
    !blocked &&
    !recovery;
  const validPlan =
    plan && planContext === contextKey && !expired ? plan : null;
  async function startLaunch() {
    if (!account.address) {
      account.openWallet?.();
      return;
    }
    if (
      flight.current ||
      !ready ||
      !image ||
      !pairId ||
      blocked ||
      recovery ||
      !hydrated
    )
      return;
    if (!eligiblePair) {
      setError('Choose a Long pairing to launch.');
      return;
    }
    flight.current = true;
    setBusy('Preparing launch…');
    setError('');
    setNotice('');
    const context = contextKey;
    const isCurrent = () => mounted.current && current.current === context;
    try {
      if (account.chainId !== 4663) {
        if (!account.ensureChain) throw new LaunchError('wrong_chain');
        setBusy('Switch network in wallet…');
        await account.ensureChain(account.address, 4663, isCurrent);
        setNotice('Network switched. Click Launch coin to continue.');
        return;
      }
      const blob = await draftImageBlob(image);
      const artwork = await ensureLaunchArtwork({
        bytes: new Uint8Array(await blob.arrayBuffer()),
        wallet: account.address,
        draft: { name, ticker, description },
        origin: location.origin,
        storage: localStorage,
        cached: published,
        isCurrent,
        onProgress: (message) => {
          if (mounted.current) setBusy(message);
        },
      });
      if (!isCurrent()) return;
      await cachePublication(artwork);
      setBusy('Estimating launch fees…');
      const input: LaunchInput = {
        chainId: 4663,
        wallet: account.address,
        draft: { name, ticker, description },
        pairId,
        publication: {
          id: artwork.id,
          imageHash: artwork.imageHash,
          metadataHash: artwork.metadataHash,
        },
      };
      const {
        plan: checked,
        observedAt: observed,
        usdAge,
      } = await prepareLongWallet(input, artwork);
      if (current.current !== context) return;
      setPlan(checked);
      setPlanContext(context);
      setExpired(false);
      onCosts({
        quote: {
          contextKey: context,
          chainId: 4663,
          quotedAt: observed,
          expiresAt: checked.deadline,
          nativeOnly: true,
          pads: [
            {
              id: 'long',
              steps: [
                {
                  kind: 'launch',
                  valueWei: 0n,
                  launchpadFeeWei: 0n,
                  network: {
                    chainId: 4663,
                    gasUnits: wei(checked.estimatedGas),
                    gasPriceWei: wei(checked.transaction.gasPrice),
                  },
                },
              ],
            },
          ],
        },
        usd: {
          microUsdPerEth: wei(checked.usd.microUsdPerEth),
          sourceLabel: checked.usd.sourceLabel,
          quotedAt: observed,
          expiresAt: Math.min(checked.deadline, observed + 60000 - usdAge),
        },
      });
      await launch(checked, context);
    } catch (e) {
      setError(e instanceof AssetError ? assetErrorText(e) : launchMessage(e));
      setCooldown(
        e instanceof AssetError
          ? e.retryAfter * 1000
          : e instanceof Error && ['busy', 'rate_limited'].includes(e.message)
            ? 60000
            : 0,
      );
    } finally {
      flight.current = false;
      setBusy('');
    }
  }
  async function launch(launchPlan: LongPlan, context: string) {
    if (!account.sendLong) throw new LaunchError('wrong_account');
    setBusy('Approve launch in wallet…');
    setError('');
    let saved: LaunchRecovery | undefined;
    try {
      const hash = await account.sendLong(
        launchPlan,
        () => mounted.current && current.current === context,
        async () => {
          if (readLaunchRecovery()) throw new LaunchError('launch_pending');
          saved = {
            id: launchPlan.id,
            binding: launchPlan.binding,
            hash: null,
          };
          saveLaunchRecovery(saved);
          setRecovery(saved);
          await launchRequest('launch-reserve', {
            id: launchPlan.id,
            binding: launchPlan.binding,
          });
        },
      );
      if (!saved) throw new LaunchError('launch_unknown');
      saved = { ...saved, hash };
      setRecovery(saved);
      saveLaunchRecovery(saved);
      setNotice('');
    } catch (e) {
      setError(launchMessage(e));
      if (saved)
        setNotice(
          'This launch stays locked after wallet approval opens, including cancellation or a lost response. Check wallet history; do not launch again.',
        );
    } finally {
      flight.current = false;
      setBusy('');
    }
  }
  async function check() {
    if (flight.current || !recovery) return;
    flight.current = true;
    setBusy('Checking confirmation…');
    setError('');
    try {
      const hash = recovery.hash ?? (recoveryHash.trim() || null);
      if (hash && !/^0x[a-f0-9]{64}$/i.test(hash))
        throw new LaunchError('launch_unknown');
      const result = await launchRequest('launch-status', {
        id: recovery.id,
        hash,
      });
      if (
        result.id !== recovery.id ||
        ![
          'prepared',
          'uncertain',
          'submitted',
          'confirming',
          'confirmed',
          'failed',
        ].includes(result.status)
      )
        throw new LaunchError('launch_receipt_unverified');
      if (['confirmed', 'failed'].includes(result.status)) {
        if (
          !/^0x[a-f0-9]{64}$/i.test(result.hash) ||
          !/^\d+$/.test(result.paidGasWei) ||
          (result.status === 'confirmed' &&
            !/^0x[a-f0-9]{40}$/i.test(result.asset))
        )
          throw new LaunchError('launch_receipt_unverified');
      }
      if (hash && result.hash === hash) {
        const saved = { ...recovery, hash };
        saveLaunchRecovery(saved);
        setRecovery(saved);
      }
      setReceipt(result);
      setNotice(
        result.status === 'confirmed'
          ? ''
          : result.status === 'failed'
            ? 'The transaction failed onchain. Gas was spent; no successful launch was verified.'
            : result.status === 'prepared'
              ? 'No wallet submission was recorded, but this browser attempt remains locked. Contact support before retrying.'
              : result.status === 'uncertain'
                ? 'Check your wallet history; do not submit again.'
                : '',
      );
      setCooldown(60000);
    } catch (e) {
      setError(launchMessage(e));
      setCooldown(60000);
    } finally {
      flight.current = false;
      setBusy('');
    }
  }
  if (!enabled && !recovery) return null;
  const usd: UsdRate | undefined = plan
    ? {
        microUsdPerEth: wei(plan.usd.microUsdPerEth),
        sourceLabel: plan.usd.sourceLabel,
        quotedAt: 0,
        expiresAt: 60000,
      }
    : undefined;
  const currentReceipt = receipt?.id === recovery?.id ? receipt : null;
  const activity = launchActivity({
    busy,
    error,
    recovery,
    receiptStatus: currentReceipt?.status,
  });
  const terminal =
    currentReceipt && ['confirmed', 'failed'].includes(currentReceipt.status);
  const transactionHash = currentReceipt?.hash || recovery?.hash;
  const guidance = !enabled
    ? 'Choose Long and a pairing to launch.'
    : account.address && !isReady
      ? !eligiblePair
        ? 'Choose a Long pairing to launch.'
        : !ready
          ? 'Select only Long and complete your coin details.'
          : account.chainId !== 4663
            ? 'Your wallet will switch to Robinhood Chain.'
            : ''
      : '';
  return (
    <div className="long-launch" data-phase={activity.phase} aria-busy={!!busy}>
      {recovery ? (
        <div className="launch-recovery">
          {activity.phase === 'confirmed' && (
            <output className="launch-confirmed" key={recovery.id}>
              <strong>Coin is live</strong>
              <LaunchGun confirmed />
            </output>
          )}
          {!recovery.hash && !busy && (
            <label htmlFor="launch-recovery-hash">
              Transaction hash from wallet history (if submitted)
              <Input
                id="launch-recovery-hash"
                value={recoveryHash}
                onChange={(e) => setRecoveryHash(e.target.value)}
                maxLength={66}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}
          {!terminal && (
            <Button
              type="button"
              className="launch-button"
              disabled={!!busy || !!cooldown}
              onClick={check}
            >
              <span>{busy ? 'Launch in progress…' : 'Check launch'}</span>
              <LaunchGun />
            </Button>
          )}
          <div className="launch-recovery-links">
            {transactionHash && (
              <a
                href={`https://robinhoodchain.blockscout.com/tx/${transactionHash}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View transaction
              </a>
            )}
            {currentReceipt?.asset && (
              <a
                href={`https://robinhoodchain.blockscout.com/address/${currentReceipt.asset}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View token
              </a>
            )}
          </div>
          {currentReceipt?.paidGasWei && (
            <p className="launch-feedback">
              Gas paid: {formatEth(wei(currentReceipt.paidGasWei))}
            </p>
          )}
        </div>
      ) : (
        <>
          {validPlan && (
            <details>
              <summary>Launch details</summary>
              <p>
                {name} · ${ticker} · 1 billion tokens · no creator allocation ·
                fixed metadata
              </p>
              <p>
                Maximum gas budget: {formatEth(wei(validPlan.maximumGasWei))} (
                {formatUsd(wei(validPlan.maximumGasWei), usd, 0)}). Includes a
                20% gas-unit buffer. Unused gas is not charged.
              </p>
              <p>
                Wallet: {validPlan.transaction.from.slice(0, 6)}…
                {validPlan.transaction.from.slice(-4)} · value: 0 ETH · chain:
                4663
              </p>
              <a
                href={`https://robinhoodchain.blockscout.com/address/${validPlan.transaction.to}?tab=contract`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Verified launch contract
              </a>
              <p>
                Your wallet displays the full transaction. Gas and availability
                can change before it is mined.
              </p>
            </details>
          )}
          <Button
            type="button"
            className="launch-button"
            disabled={
              !!busy ||
              !!cooldown ||
              blocked ||
              !hydrated ||
              (Boolean(account.address) &&
                (!ready || !image || !eligiblePair))
            }
            onClick={startLaunch}
          >
            <span>
              {busy
                ? 'Launching coin…'
                : account.address
                  ? 'Launch coin'
                  : 'Connect wallet'}
            </span>
            <LaunchGun />
          </Button>
          <p className="launch-disclosure">
            Artwork becomes public. You pay the launch fee and gas.
          </p>
          {guidance && !busy && <p className="launch-feedback">{guidance}</p>}
        </>
      )}
      {activity.label && activity.phase !== 'confirmed' && (
        <BulletProgress label={activity.label} active={activity.animated} />
      )}
      {notice && <output className="launch-feedback">{notice}</output>}
      {error && (
        <p role="alert" className="launch-feedback">
          {error}
        </p>
      )}
    </div>
  );
}
