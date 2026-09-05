'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { BulletProgress, LaunchGun } from '@/components/launch-motion';
import { runLaunchFlow } from '@/lib/launch-flow';
import { watchLaunch, type LaunchReceipt } from '@/lib/long-recovery';
import { launchActivity } from '@/lib/launch-progress';
import { useConnectedAccount } from '@/lib/account-context';
import { useDraftCache } from '@/lib/launch-draft';
import { LONG_PAIRS } from '@/lib/launch-model';
import {
  formatEth,
  formatUsd,
  longWalletCostStep,
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
import {
  draftImageBlob,
  launchRecoveryScope,
  type DraftImage,
} from '@/lib/launch-draft-cache';

const wei = (value: string) => BigInt(value);
export type LongCosts = { quote: LaunchCostQuote; usd: UsdRate } | null;
type LongLaunchProps = {
  enabled: boolean;
  ready: boolean;
  pairId?: string;
  name: string;
  ticker: string;
  description: string;
  image: DraftImage | null;
  contextKey: string;
  onCosts: (costs: LongCosts) => void;
};
export function LongLaunch(props: LongLaunchProps) {
  const { address } = useConnectedAccount();
  const { hydrated } = useDraftCache();
  const { name, ticker, description, image, pairId } = props;
  const identity = JSON.stringify([
    address?.toLowerCase(),
    name,
    ticker,
    description,
    image?.url,
    pairId,
  ]);
  const [resolved, setResolved] = useState<{
    identity: string;
    scope: string;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!hydrated || !address || !image || !pairId) return;
    let active = true;
    void draftImageBlob(image)
      .then((blob) =>
        launchRecoveryScope(
          address,
          pairId,
          { name, ticker, description },
          blob,
        ),
      )
      .then((scope) => {
        if (active) setResolved({ identity, scope });
      })
      .catch((error) => {
        if (active)
          setResolved({ identity, scope: '', error: launchMessage(error) });
      });
    return () => {
      active = false;
    };
  }, [hydrated, address, name, ticker, description, image, pairId, identity]);
  if (!props.enabled) return null;
  if (!address || !image || !pairId || !hydrated)
    return <ScopedLongLaunch key={identity} {...props} recoveryScope="" />;
  if (resolved?.identity !== identity || resolved.error)
    return (
      <div className="long-launch">
        <Button className="launch-button" disabled>
          Launch coin
          <LaunchGun />
        </Button>
        {resolved?.identity === identity && resolved.error && (
          <p role="alert" className="launch-feedback">
            {resolved.error}
          </p>
        )}
      </div>
    );
  return (
    <ScopedLongLaunch
      key={resolved.scope}
      {...props}
      recoveryScope={resolved.scope}
    />
  );
}
function ScopedLongLaunch({
  enabled,
  ready,
  pairId,
  name,
  ticker,
  description,
  image,
  contextKey,
  onCosts,
  recoveryScope,
}: LongLaunchProps & { recoveryScope: string }) {
  const account = useConnectedAccount();
  const { published, cachePublication, hydrated } = useDraftCache();
  const [plan, setPlan] = useState<LongPlan | null>(null);
  const [planContext, setPlanContext] = useState('');
  const [recovery, setRecovery] = useState<LaunchRecovery | null>(null);
  const [blocked, setBlocked] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<LaunchReceipt | null>(null);
  const [expired, setExpired] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const flight = useRef(false);
  const current = useRef(contextKey);
  // The intended network switch is allowed; edited drafts, accounts or destinations cancel the flow.
  const intentKey = JSON.stringify([
    name,
    ticker,
    description,
    image?.url,
    account.address?.toLowerCase(),
    pairId,
    ready,
    enabled,
  ]);
  const currentIntent = useRef(intentKey);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    current.current = contextKey;
    currentIntent.current = intentKey;
  }, [contextKey, intentKey]);
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
        setRecovery(recoveryScope ? readLaunchRecovery(recoveryScope) : null);
        setBlocked(false);
      } catch (e) {
        setError(launchMessage(e));
      }
    });
    const sync = () => {
      try {
        setRecovery(recoveryScope ? readLaunchRecovery(recoveryScope) : null);
      } catch {
        setBlocked(true);
      }
    };
    window.addEventListener('storage', sync);
    return () => {
      mounted = false;
      window.removeEventListener('storage', sync);
    };
  }, [recoveryScope]);
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
  useEffect(() => {
    if (!recovery || busy || cooldown) return;
    return watchLaunch(
      recovery,
      (result) => {
        setReceipt(result);
        setError('');
        setNotice(
          result.status === 'failed'
            ? 'The transaction failed. Network gas was charged.'
            : '',
        );
        if (result.hash && result.hash !== recovery.hash) {
          const saved = { ...recovery, hash: result.hash };
          saveLaunchRecovery(saved, recoveryScope);
          setRecovery(saved);
        }
      },
      (e) => setError(launchMessage(e)),
    );
  }, [recovery, busy, cooldown, recoveryScope]);
  const retryable =
    receipt?.id === recovery?.id && receipt?.status === 'retryable';
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
    (!recovery || retryable);
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
      !recoveryScope ||
      !image ||
      !pairId ||
      blocked ||
      (recovery && !retryable) ||
      !hydrated
    )
      return;
    if (!eligiblePair) {
      setError('Choose a Long pairing to launch.');
      return;
    }
    const walletAddress = account.address;
    flight.current = true;
    setBusy('Preparing launch…');
    setError('');
    setNotice('');
    const intent = intentKey;
    const isCurrent = () => mounted.current && currentIntent.current === intent;
    try {
      if (account.chainId !== 4663) {
        if (!account.ensureChain) throw new LaunchError('wrong_chain');
        setBusy('Switch network in wallet…');
        await account.ensureChain(account.address, 4663, isCurrent);
        if (!isCurrent()) return;
      }
      const blob = await draftImageBlob(image);
      const imageBytes = new Uint8Array(await blob.arrayBuffer());
      await runLaunchFlow({
        isCurrent,
        onProgress: setBusy,
        artwork: () =>
          ensureLaunchArtwork({
            bytes: imageBytes,
            wallet: walletAddress,
            draft: { name, ticker, description },
            origin: location.origin,
            storage: localStorage,
            cached: published,
            isCurrent,
            onProgress: (message) => {
              if (mounted.current) setBusy(message);
            },
          }),
        quote: async (artwork) => {
          await cachePublication(artwork);
          setBusy('Estimating launch fees…');
          const input: LaunchInput = {
            chainId: 4663,
            wallet: walletAddress,
            draft: { name, ticker, description },
            pairId,
            publication: {
              id: artwork.id,
              imageHash: artwork.imageHash,
              metadataHash: artwork.metadataHash,
            },
          };
          const prepared = await prepareLongWallet(input, artwork);
          if (prepared.recovery) return { recovery: prepared.recovery };
          const { plan: checked, observedAt: observed, usdAge } = prepared;
          if (!isCurrent()) throw new LaunchError('launch_context_locked');
          const context = current.current;
          if (recovery && checked.id !== recovery.id)
            throw new LaunchError('launch_context_locked');
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
                  launchFeeSource: checked.launchFeeSource,
                  steps: [longWalletCostStep(checked)],
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
          return { checked, context };
        },
        wallet: async (prepared) => {
          if (prepared.recovery) {
            saveLaunchRecovery(prepared.recovery, recoveryScope);
            setRecovery(prepared.recovery);
            setReceipt(null);
          } else await launch(prepared.checked, prepared.context, intent);
        },
      });
    } catch (e) {
      setError(e instanceof AssetError ? assetErrorText(e) : launchMessage(e));
      setCooldown(
        e instanceof AssetError
          ? e.retryAfter * 1000
          : e instanceof LaunchError &&
              ['busy', 'rate_limited'].includes(e.message)
            ? e.retryAfter * 1000
            : 0,
      );
    } finally {
      flight.current = false;
      setBusy('');
    }
  }
  async function launch(launchPlan: LongPlan, context: string, intent: string) {
    if (!account.sendLong) throw new LaunchError('wrong_account');
    setBusy('Approve launch in wallet…');
    setError('');
    let saved: LaunchRecovery | undefined;
    const hash = await account.sendLong(
      launchPlan,
      () => mounted.current && current.current === context && currentIntent.current === intent,
      async () => {
        const prior = recoveryScope ? readLaunchRecovery(recoveryScope) : null;
        if (prior && (prior.id !== launchPlan.id || prior.hash))
          throw new LaunchError('launch_pending');
        saved = {
          id: launchPlan.id,
          binding: launchPlan.binding,
          hash: null,
        };
        saveLaunchRecovery(saved, recoveryScope);
        setRecovery(saved);
        setReceipt(null);
        await launchRequest('launch-reserve', {
          id: launchPlan.id,
          binding: launchPlan.binding,
        });
      },
    );
    if (!saved) throw new LaunchError('launch_unknown');
    saved = { ...saved, hash };
    setRecovery(saved);
    saveLaunchRecovery(saved, recoveryScope);
    setNotice('');
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
          ? 'Review your coin details above.'
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
          {!terminal && (
            <Button
              type="button"
              className="launch-button"
              disabled={
                !!busy ||
                !!cooldown ||
                !retryable ||
                !ready ||
                !image ||
                !eligiblePair
              }
              onClick={startLaunch}
            >
              <span>
                {busy
                  ? 'Launching coin…'
                  : retryable
                    ? 'Launch coin'
                    : 'Confirming launch…'}
              </span>
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
          {error && <p role="alert" className="launch-feedback">{error}</p>}
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
      {error && recovery && (
        <p role="alert" className="launch-feedback">
          {error}
        </p>
      )}
    </div>
  );
}
