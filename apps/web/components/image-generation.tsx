'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { formatUnits } from 'viem';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BulletProgress } from '@/components/launch-motion';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useConnectedAccount } from '@/lib/account-context';
import { useDraftCache, useDraftField } from '@/lib/launch-draft';
import {
  clearImageRecovery,
  generatedImageBlob,
  imageErrorText,
  ImageGenerationError,
  newImageRecovery,
  readImageRecovery,
  requestImage,
  saveImageRecovery,
  type ImageRecovery,
  type ImageJob,
} from '@/lib/image-generation';
import './image-generation.css';

function usdPrice(amount: string) {
  return formatUnits(BigInt(amount), 6);
}

export function ImageGeneration({
  open,
  onOpenChange,
  onImageAttach,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onImageAttach?: () => void;
}) {
  const account = useConnectedAccount();
  const [name] = useDraftField('name');
  const [ticker] = useDraftField('ticker');
  const [prompt] = useDraftField('prompt');
  const [currentImage, setImage] = useDraftField('image');
  const { hydrated } = useDraftCache();
  const [record, setRecord] = useState<ImageRecovery | null>(null);
  const [job, setJob] = useState<ImageJob | null>(null);
  const [result, setResult] = useState<{ url: string; blob: Blob } | null>(
    null,
  );
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState(false);
  const flight = useRef(false);
  const mounted = useRef(false);
  const context = JSON.stringify([
    name.trim(),
    ticker.trim(),
    prompt.trim(),
    account.address?.toLowerCase(),
    account.chainId,
    currentImage?.url,
  ]);
  const latest = useRef(context);
  useLayoutEffect(() => {
    latest.current = context;
  }, [context]);
  const attached = useRef('');
  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => {
      if (!mounted.current) return;
      try {
        setRecord(readImageRecovery());
      } catch (e) {
        setError(imageErrorText(e));
        setBlocked(true);
      }
    });
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(
    () => () => {
      if (result) URL.revokeObjectURL(result.url);
    },
    [result],
  );
  function remember(next: ImageRecovery) {
    saveImageRecovery(next);
    setRecord(next);
  }
  const matches =
    !!record &&
    record.input.name === name.trim() &&
    record.input.ticker === ticker.trim() &&
    record.input.prompt === prompt.trim();
  const canSign =
    hydrated &&
    matches &&
    account.address?.toLowerCase() === record?.input.wallet &&
    account.chainId === 4663 &&
    !!account.signImage;
  function attach(blob: Blob, id: string, explicit = false) {
    if (!explicit && attached.current === id) return;
    onImageAttach?.();
    attached.current = id;
    setImage({ url: URL.createObjectURL(blob), size: blob.size, blob });
  }
  async function consume(
    next: ImageRecovery,
    value: Awaited<ReturnType<typeof requestImage>>,
    revision: string,
  ) {
    if (!mounted.current) return;
    if (value.quote) {
      remember({ ...next, quote: value.quote });
      return;
    }
    if (!value.job) return;
    const received = value.job;
    setJob(received);
    if (received.quote) {
      remember({ ...next, quote: received.quote });
      return;
    }
    if (received.status === 'completed') {
      const blob = await generatedImageBlob(received);
      const bitmap = await createImageBitmap(blob);
      const valid =
        bitmap.width === received.image!.width &&
        bitmap.height === received.image!.height;
      bitmap.close();
      if (!valid) throw new ImageGenerationError('invalid_image_payment');
      if (!mounted.current) return;
      remember({
        input: next.input,
        token: next.token,
        completed: true,
        submitted: true,
      });
      setResult({ blob, url: URL.createObjectURL(blob) });
      const current = JSON.parse(latest.current) as string[];
      if (
        latest.current === revision &&
        current[0] === next.input.name &&
        current[1] === next.input.ticker &&
        current[2] === next.input.prompt &&
        !current[5]
      )
        attach(blob, next.input.requestId);
    }
  }
  async function check() {
    if (flight.current || !record) return;
    flight.current = true;
    setBusy('Checking image status…');
    setError('');
    const revision = latest.current;
    try {
      await consume(record, await requestImage(record, 'GET'), revision);
    } catch (e) {
      if (mounted.current) setError(imageErrorText(e));
    } finally {
      flight.current = false;
      if (mounted.current) setBusy('');
    }
  }
  useEffect(() => {
    if (
      !hydrated ||
      !record ||
      blocked ||
      job?.status === 'failed' ||
      job?.status === 'unknown' ||
      job?.status === 'completed'
    )
      return;
    if (!record.submitted && !record.proof) return;
    // Polls only the free recovery endpoint. It never signs or submits another payment.
    const timer = setTimeout(
      () => {
        void check();
      },
      job ? 4000 : 0,
    );
    return () => clearTimeout(timer);
  });
  async function quote() {
    if (flight.current || !hydrated || !account.address || blocked) return;
    if (
      record &&
      (record.submitted || record.proof) &&
      !record.completed &&
      !['failed', 'unknown'].includes(job?.status || '')
    )
      return;
    flight.current = true;
    setBusy('Getting USDG price…');
    setError('');
    setJob(null);
    setResult(null);
    try {
      if (record && ['failed', 'unknown'].includes(job?.status || ''))
        clearImageRecovery(record);
      const next = newImageRecovery({
        wallet: account.address,
        name: name.trim(),
        ticker: ticker.trim(),
        prompt: prompt.trim(),
      });
      remember(next);
      await consume(next, await requestImage(next, 'POST'), latest.current);
    } catch (e) {
      if (mounted.current) setError(imageErrorText(e));
    } finally {
      flight.current = false;
      if (mounted.current) setBusy('');
    }
  }
  async function pay() {
    if (
      flight.current ||
      !record?.quote ||
      !canSign ||
      !account.signImage ||
      blocked
    )
      return;
    flight.current = true;
    setBusy('Approve image payment in wallet…');
    setError('');
    const revision = latest.current;
    let next = record;
    try {
      // Durable operation exists before signing; the exact proof is saved before any paid POST.
      saveImageRecovery(next);
      const proof =
        next.proof ??
        (await account.signImage(
          next.quote!,
          next.input,
          () => mounted.current && latest.current === revision,
        ));
      if (!mounted.current || latest.current !== revision)
        throw new ImageGenerationError('image_context_changed');
      next = { ...next, proof, submitted: true };
      remember(next);
      setBusy('Starting your image…');
      await consume(next, await requestImage(next, 'POST'), revision);
    } catch (e) {
      if (mounted.current) setError(imageErrorText(e));
    } finally {
      flight.current = false;
      if (mounted.current) setBusy('');
    }
  }
  async function resume() {
    if (flight.current || !record?.proof) return;
    flight.current = true;
    setBusy('Recovering payment…');
    setError('');
    try {
      const status = await requestImage(record, 'GET');
      await consume(record, status, latest.current);
      // Only retry an unsatisfied job with the identical saved proof; never obtain a new signature.
      if (status.job?.status === 'awaiting_payment')
        await consume(
          record,
          await requestImage(record, 'POST'),
          latest.current,
        );
    } catch (e) {
      if (mounted.current) setError(imageErrorText(e));
    } finally {
      flight.current = false;
      if (mounted.current) setBusy('');
    }
  }
  const terms = record?.quote?.accepts[0];
  const unresolved =
    !!record &&
    (record.submitted || !!record.proof) &&
    !record.completed &&
    !['failed', 'unknown'].includes(job?.status || '');
  const statusText: Record<string, string> = {
    authorized: 'Payment authorized…',
    generating: 'Generating artwork…',
    generated: 'Saving artwork…',
    settlement_pending: 'Confirming USDG payment…',
    completed: 'Image ready.',
  };
  const progressText = busy || (!error && job && statusText[job.status]);
  const progressing = !!busy || ['authorized', 'generating', 'generated', 'settlement_pending'].includes(job?.status || '');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="app-dialog">
        <DialogHeader>
          <span className="dialog-icon">
            <Sparkles />
          </span>
          <DialogTitle>Generate with Grok</DialogTitle>
          <DialogDescription>
            One square coin image, paid in USDG. Your image and coin draft are
            saved for reloads.
          </DialogDescription>
        </DialogHeader>
        <p className="prompt-preview">{record?.input.prompt || prompt}</p>
        {result && (
          <div className="generated-image-result">
            <Image
              src={result.url}
              alt="Generated coin artwork"
              width={200}
              height={200}
              unoptimized
            />
            <Button
              disabled={!matches}
              onClick={() => {
                attach(result.blob, record!.input.requestId, true);
                onOpenChange(false);
              }}
            >
              Use as coin picture
            </Button>
          </div>
        )}
        {terms && !record?.submitted && (
          <div className="generation-steps">
            <strong>{usdPrice(terms.amount)} USDG · one image</strong>
            <span>Robinhood Chain · one-time authorization</span>
            <span className="payment-address">Recipient: {terms.payTo}</span>
            <span className="payment-address">USDG token: {terms.asset}</span>
            <span>Payment settles after your image is generated.</span>
          </div>
        )}
        {record && (
          <small className="payment-address">
            Request: {record.input.requestId}
          </small>
        )}
        {progressText && (
          <BulletProgress
            label={progressText}
            active={progressing}
            complete={!busy && job?.status === 'completed'}
          />
        )}
        {job && !progressText && (
          <output aria-live="polite">
            {imageErrorText(new ImageGenerationError(job.error || 'unavailable'))}
          </output>
        )}
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        {!account.address && (
          <Button onClick={account.openWallet}>Connect wallet</Button>
        )}
        {account.address && account.chainId !== 4663 && (
          <p className="notice">
            Switch your wallet to Robinhood Chain to authorize USDG.
          </p>
        )}
        {!matches && record && (
          <p className="notice">
            This saved image uses different coin details. Restore those details
            before selecting it as the coin picture.
          </p>
        )}
        {record?.quote && !record.submitted && (
          <Button
            disabled={!!busy || !canSign || blocked}
            onClick={() => void pay()}
          >
            Authorize {usdPrice(terms!.amount)} USDG &amp; generate
          </Button>
        )}
        {unresolved && (
          <>
            <Button
              variant="outline"
              disabled={!!busy}
              onClick={() => void check()}
            >
              Check image status
            </Button>
            {record.proof && (
              <Button
                variant="ghost"
                disabled={!!busy}
                onClick={() => void resume()}
              >
                Resume saved request
              </Button>
            )}
          </>
        )}
        {record?.completed && !result && (
          <Button disabled={!!busy} onClick={() => void check()}>
            Recover saved image
          </Button>
        )}
        {!unresolved && (
          <Button
            variant="outline"
            disabled={
              !!busy ||
              !hydrated ||
              !account.address ||
              !prompt.trim() ||
              blocked
            }
            onClick={() => void quote()}
          >
            {record ? 'Request a new image price' : 'Review USDG price'}
          </Button>
        )}
        {record && !record.submitted && !record.proof && (
          <Button
            variant="ghost"
            disabled={!!busy}
            onClick={() => {
              clearImageRecovery(record);
              setRecord(null);
              setJob(null);
              setError('');
            }}
          >
            Discard quote
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
