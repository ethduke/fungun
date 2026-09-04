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
import { BulletProgress } from '@/components/launch-motion';
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
  return (
    <div className="asset-publication" aria-busy={!!busy}>
      <div className="asset-publication-heading">
        <strong>Launch artwork</strong>
        <span>Long · Robinhood</span>
      </div>
      {!published && cachedPublication && (
        <output>Artwork and metadata saved. <a href={cachedPublication.metadataUrl} target="_blank" rel="noopener noreferrer">View metadata</a> · Ready for launch verification.</output>
      )}
      {published && (
        <output>
          {published.context !== context
            ? 'Previous artwork published.'
            : 'Artwork published.'}{' '}
          <a
            href={published.result.metadataUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            View metadata
          </a>{' '}
          Launch verification is still pending.
        </output>
      )}
      {recovery ? (
        <>
          {progress && !busy && !error && (
            <BulletProgress
              label={`Image ${progressLabel(progress.progress.image)} · Metadata ${progressLabel(progress.progress.metadata)}`}
              active={!progress.issue}
            />
          )}
          <p>
            Previous publication needs a status check. Connect the same wallet;
            no new signature is needed.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={!!busy || !account.address || cooldown}
            onClick={check}
          >
            Check publication status
          </Button>
        </>
      ) : active ? (
        <>
          <div className="asset-publication-preview">
            <Image
              src={active.url}
              alt="Processed artwork to publish"
              width={88}
              height={88}
              unoptimized
            />
            <div>
              <strong>
                {active.approval.draft.name} · ${active.approval.draft.ticker}
              </strong>
              <p>{active.approval.draft.description || 'No description'}</p>
            </div>
          </div>
          <p>
            Publish this image and metadata publicly. Copies may remain
            permanently. Wallet approval costs no gas.
          </p>
          <div className="asset-publication-actions">
            <Button
              type="button"
              disabled={
                !!busy || !ready || expires || cooldown || recoveryBlocked
              }
              onClick={publish}
            >
              Approve &amp; publish
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={!!busy || cooldown}
              onClick={prepare}
            >
              {expires ? 'Refresh preview' : 'Check again'}
            </Button>
          </div>
          {expires && (
            <output>
              Preview expired. Check the image again before approving.
            </output>
          )}
        </>
      ) : (
        <>
          <p>
            {!enabled
              ? 'Select Long to prepare its launch artwork.'
              : !account.address
                ? 'Connect your wallet to prepare the image.'
                : account.chainId !== ASSET_CHAIN_ID
                  ? 'Your wallet will ask to switch to Robinhood Chain.'
                  : 'Upload for validation, then review before publishing.'}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={prepare}
            disabled={
              !!busy ||
              !ready ||
              cooldown ||
              recoveryBlocked ||
              published?.context === context ||
              !!cachedPublication
            }
          >
            Upload for preview
          </Button>
        </>
      )}
      {busy && <BulletProgress label={busy} />}
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
    </div>
  );
}
