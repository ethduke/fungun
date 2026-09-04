'use client';

import Image from 'next/image';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Button } from '@/components/ui/button';
import { useConnectedAccount } from '@/lib/account-context';
import { useDraftCache } from '@/lib/launch-draft';
import {
  AssetError,
  assetDraft,
  assetErrorText,
  imageBytes,
  type AssetApproval,
  type PublishedAsset,
  type ProcessingAsset,
} from '@/lib/asset-protocol';
import {
  checkAssetStatus,
  prepareAsset,
  publishAsset,
  readAssetRecovery,
  recoveryFor,
  assetRecoverySnapshot,
  subscribeAssetRecovery,
  clearAssetRecovery,
} from '@/lib/asset-client';
import {
  ASSET_CHAIN_ID,
  assetAccountReady,
  ensureAssetChain,
} from '@/lib/asset-chain';
import './asset-publication.css';

export function AssetPublication({
  name,
  ticker,
  description,
  image,
  imagePending,
  enabled,
}: {
  name: string;
  ticker: string;
  description: string;
  image: { url: string; size: number } | null;
  imagePending: boolean;
  enabled: boolean;
}) {
  const account = useConnectedAccount();
  const { hydrated, cacheState, published: cachedPublication, cachePublication } = useDraftCache();
  const context = JSON.stringify([
    name,
    ticker,
    description,
    image?.url,
    imagePending,
    enabled,
    account.address,
  ]);
  const current = useRef(context);
  useLayoutEffect(() => {
    current.current = context;
  }, [context]);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState<{
    approval: AssetApproval;
    context: string;
    url: string;
  } | null>(null);
  const savedRecovery = useSyncExternalStore(
    subscribeAssetRecovery,
    assetRecoverySnapshot,
    () => '',
  );
  const recoveryState = useMemo(() => {
    if (!savedRecovery) return { ticket: null, blocked: false };
    try {
      return {
        ticket: readAssetRecovery(
          { getItem: () => savedRecovery },
          location.origin,
        ),
        blocked: false,
      };
    } catch {
      return { ticket: null, blocked: true };
    }
  }, [savedRecovery]);
  const recovery = recoveryState.ticket;
  const recoveryBlocked = recoveryState.blocked;
  useEffect(() => {
    if (recovery && cachedPublication?.id === recovery.id && cacheState === 'saved')
      clearAssetRecovery(localStorage, recovery);
  }, [recovery, cachedPublication, cacheState]);
  const [published, setPublished] = useState<{
    result: PublishedAsset;
    context?: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const [progress, setProgress] = useState<ProcessingAsset | null>(null);
  const progressLabel = (state: string) => ({
    staging: 'preparing', ready: 'queued', sending: 'uploading', pinned: 'pinned', verified: 'verified',
  })[state] ?? 'pending';
  const [expiredId, setExpiredId] = useState('');
  const expires = preview?.approval.id === expiredId;
  const [cooldown, setCooldown] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(retryTimer.current);
    };
  }, []);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(
      () => setExpiredId(preview.approval.id),
      Math.max(0, preview.approval.deadline - performance.now()),
    );
    return () => clearTimeout(timer);
  }, [preview]);
  function failure(value: unknown) {
    setError(assetErrorText(value));
    if (value instanceof AssetError && value.retryAfter) {
      setCooldown(true);
      clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(
        () => setCooldown(false),
        value.retryAfter * 1000,
      );
    }
  }
  const active = preview?.context === context ? preview : null;
  const ready =
    hydrated &&
    enabled &&
    !!image &&
    !imagePending &&
    assetAccountReady(account);
  async function ensureRobinhood(revision: string) {
    const isCurrent = () =>
      mounted.current && current.current === revision;
    if (account.chainId !== ASSET_CHAIN_ID)
      setBusy('Switching to Robinhood Chain…');
    try {
      await ensureAssetChain(account, isCurrent);
      return true;
    } catch (value) {
      if (mounted.current) failure(value);
      return false;
    }
  }
  async function prepare() {
    if (
      inFlight.current ||
      recovery ||
      recoveryBlocked ||
      cooldown ||
      !ready ||
      !image
    )
      return;
    inFlight.current = true;
    setError('');
    setRecoveryNotice('');
    setPreview(null);
    setPublished(null);
    const revision = context;
    try {
      if (!(await ensureRobinhood(revision))) return;
      setBusy('Checking image…');
      const draft = assetDraft({ name, ticker, description });
      if (
        !image.url.startsWith(`blob:${location.origin}/`) ||
        image.size > 2097152
      )
        throw new AssetError('image_size');
      const source = await fetch(image.url);
      const bytes = new Uint8Array(await source.arrayBuffer());
      if (!mounted.current || current.current !== revision)
        throw new AssetError('asset_context_changed');
      const approval = await prepareAsset(
        bytes,
        account.address!,
        draft,
        location.origin,
      );
      const blob = new Blob(
        [new Uint8Array(imageBytes(approval.imageBase64))],
        { type: 'image/webp' },
      );
      const bitmap = await createImageBitmap(blob);
      const valid =
        bitmap.width === approval.width && bitmap.height === approval.height;
      bitmap.close();
      if (!valid) throw new AssetError('invalid_asset_response');
      if (!mounted.current || current.current !== revision)
        throw new AssetError('asset_context_changed');
      setPreview({
        approval,
        context: revision,
        url: URL.createObjectURL(blob),
      });
    } catch (value) {
      if (mounted.current) failure(value);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy('');
    }
  }
  async function publish() {
    if (
      inFlight.current ||
      !active ||
      recovery ||
      recoveryBlocked ||
      cooldown ||
      expires ||
      !ready ||
      !account.signAsset
    )
      return;
    inFlight.current = true;
    setBusy('Approve in your wallet…');
    setError('');
    const isCurrent = () =>
      mounted.current && current.current === active.context;
    try {
      if (!(await ensureRobinhood(active.context))) return;
      setBusy('Approve in your wallet…');
      const ticket = await recoveryFor(active.approval);
      const signature = await account.signAsset(active.approval, isCurrent);
      if (!isCurrent()) throw new AssetError('asset_context_changed');
      setBusy('Publishing…');
      const result = await publishAsset(
        active.approval,
        signature,
        ticket,
        localStorage,
        isCurrent,
      );
      if (mounted.current) {
        setPreview(null);
        if (result.status === 'processing') {
          setProgress(result);
          setRecoveryNotice('Publishing to IPFS. Check status to continue.');
        } else {
          setProgress(null);
          setPublished({ result, context: active.context });
        }
        if (result.status === 'published' && isCurrent()) {
          try { await cachePublication(result); }
          catch { setRecoveryNotice('Artwork published, but its link could not be saved in this browser.'); }
        }
      }
    } catch (value) {
      if (mounted.current) {
        failure(value);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy('');
    }
  }
  async function check() {
    if (inFlight.current || !recovery || !account.address || cooldown) return;
    inFlight.current = true;
    setBusy('Checking publication…');
    setError('');
    try {
      const result = await checkAssetStatus(
        recovery,
        account.address,
        localStorage,
      );
      if (mounted.current) {
        if (result?.status === 'expired') {
          clearAssetRecovery(localStorage, recovery);
          setPublished(null);
          setPreview(null);
          setRecoveryNotice(
            'That approval expired without publishing. You can prepare a new preview.',
          );
        } else if (result?.status === 'processing') {
          setProgress(result);
          setRecoveryNotice('IPFS publication is still in progress. No new approval is needed.');
        } else if (result) {
          setProgress(null);
          setPublished({ result });
          try { await cachePublication(result); }
          catch { setRecoveryNotice('Artwork published, but its link could not be saved in this browser.'); }
          setPreview(null);
        } else
          setError(
            'Publication is still unresolved. Check again later or contact support; do not publish again.',
          );
      }
    } catch (value) {
      if (mounted.current) failure(value);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy('');
    }
  }
  const currentPublication =
    cachedPublication ??
    (published?.context === context ? published.result : null);
  const previousPublication =
    published && published.result.id !== currentPublication?.id
      ? published.result
      : null;
  if (
    !enabled &&
    !recovery &&
    !recoveryBlocked &&
    !active &&
    !currentPublication &&
    !previousPublication &&
    !error &&
    !recoveryNotice
  )
    return null;
  return (
    <section
      className="asset-publication"
      aria-label="Artwork publication"
      aria-busy={!!busy}
    >
      {recovery ? (
        <>
          {progress && (
            <output>
              Image {progressLabel(progress.progress.image)} · Metadata{' '}
              {progressLabel(progress.progress.metadata)}
              {progress.issue ? ' · Verification delayed' : ''}
            </output>
          )}
          <p>Publication pending · no new signature</p>
          <Button
            type="button"
            variant="outline"
            disabled={!!busy || !account.address || cooldown}
            onClick={check}
          >
            Check upload
          </Button>
        </>
      ) : currentPublication ? (
        <output className="asset-publication-ready">
          <strong>Artwork published</strong>
          <span>Ready for launch review</span>
          <a
            href={currentPublication.metadataUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Metadata
          </a>
        </output>
      ) : active ? (
        <>
          <div className="asset-publication-preview">
            <Image
              src={active.url}
              alt="Processed artwork to publish"
              width={48}
              height={48}
              unoptimized
            />
            <div>
              <strong>
                {active.approval.draft.name} · ${active.approval.draft.ticker}
              </strong>
              {active.approval.draft.description && (
                <p className="asset-publication-description">
                  {active.approval.draft.description}
                </p>
              )}
              <span>
                Public IPFS; copies may remain permanently. One free wallet signature confirms publication and protects your upload allowance.
              </span>
            </div>
          </div>
          <Button
            type="button"
            aria-label={
              expires ? 'Refresh artwork preview' : 'Approve and publish artwork'
            }
            disabled={!!busy || !ready || cooldown || recoveryBlocked}
            onClick={expires ? prepare : publish}
          >
            {expires ? 'Refresh preview' : 'Confirm public artwork'}
          </Button>
        </>
      ) : enabled ? (
        <Button
          type="button"
          variant="outline"
          onClick={prepare}
          disabled={!!busy || !ready || cooldown || recoveryBlocked}
        >
          {account.address ? 'Prepare artwork' : 'Connect wallet first'}
        </Button>
      ) : null}
      {previousPublication && !currentPublication && !recovery && (
        <output>
          Previous artwork published · launch verification pending.{' '}
          <a
            href={previousPublication.metadataUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Metadata
          </a>
        </output>
      )}
      {busy && <output className="asset-publication-status">{busy}</output>}
      {recoveryNotice && <output>{recoveryNotice}</output>}
      {recoveryBlocked && (
        <p className="field-error" role="alert">
          {savedRecovery === 'unavailable'
            ? 'Your browser cannot access recovery information. Enable session storage before publishing.'
            : 'Saved publication information could not be verified. Contact support before publishing again; do not clear it.'}
        </p>
      )}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </section>
  );
}
