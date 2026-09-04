'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ImagePlus,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { LaunchpadCard } from '@/components/launchpad-card';
import { LaunchSection } from '@/components/launch-section';
import {
  autofillCoinName,
  grokPromptPlaceholder,
  IMAGE_LIMIT,
  imageFileError,
  imageKind,
  isWebviewChain,
  readablePads,
  selectChain,
  supportsChain,
  validateDraft,
  type ChainId,
  type Destination,
} from '@/lib/launch-model';
import { usePreviewTools } from '@/lib/preview-webmcp';
import { useDraftField } from '@/lib/launch-draft';
import { useReadService } from '@/lib/use-read-service';
import { tickerNotice } from '@/lib/read-service';
import { launchCostKey } from '@/lib/launch-cost';
import { useConnectedAccount } from '@/lib/account-context';

export default function Home() {
  const account = useConnectedAccount();
  const [selection, setSelection] = useDraftField('selection');
  const { chainId, destinations } = selection;
  const [name, setName] = useDraftField('name');
  const [ticker, setTicker] = useDraftField('ticker');
  const [description, setDescription] = useDraftField('description');
  const [prompt, setPrompt] = useDraftField('prompt');
  const [image, setImage] = useDraftField('image');
  const [imageError, setImageError] = useState('');
  const [imagePending, setImagePending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [generationOpen, setGenerationOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageSequence = useRef(0);
  const active = destinations.filter((pad) => pad.selected);
  const readPads = readablePads(active.map((pad) => pad.id));
  const reads = useReadService(
    chainId,
    ticker,
    readPads,
  );
  const errors = validateDraft(
    { name, ticker, description, hasImage: !!image },
    destinations,
    chainId,
    reads.catalog,
    reads.now,
  );
  const imageBytes = image
    ? `${Math.max(1, Math.round(image.size / 1024))} KB`
    : '';

  useEffect(
    () => () => {
      imageSequence.current += 1;
    },
    [],
  );

  useEffect(() => {
    function copyTrackedToken(event: Event) {
      if (!(event instanceof CustomEvent)) return;
      const { name: copiedName, ticker: copiedTicker } = event.detail ?? {};
      if (typeof copiedName !== 'string' || typeof copiedTicker !== 'string') return;
      // A pending upload must not attach another token's artwork to this draft.
      imageSequence.current += 1;
      setName(copiedName);
      setTicker(copiedTicker);
      setImage(null);
      setImagePending(false);
      setImageError('');
      document.querySelector('[aria-labelledby="coin-details-heading"]')
        ?.scrollIntoView({ behavior: 'instant', block: 'start' });
      document.getElementById('coin-name')?.focus({ preventScroll: true });
    }
    document.addEventListener('fungun:copy-tracked-token', copyTrackedToken);
    return () => document.removeEventListener('fungun:copy-tracked-token', copyTrackedToken);
  }, [setName, setTicker, setImage]);

  usePreviewTools(
    () => ({
      mode: 'preview',
      name,
      ticker,
      hasImage: !!image,
      destinations: active,
      validationErrors: errors,
      liveChecks: {
        catalogs:
          !!reads.catalog &&
          Object.values(reads.catalog.pads).some(
            (pad) => pad?.status === 'ready',
          ),
        ticker: !!reads.check,
      },
      signingEnabled: false,
    }),
    (value) => {
      setName(value.name);
      setTicker(value.ticker);
    },
  );

  async function selectImage(file?: File) {
    if (!file) return;
    const sequence = ++imageSequence.current;
    setImageError('');
    setImagePending(true);
    try {
      if (!file.size || file.size > IMAGE_LIMIT)
        throw new Error('Choose an image smaller than 2 MiB.');
      const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
      const error = imageFileError(file.size, file.type, header);
      if (error) throw new Error(error);
      const source = file.slice(0, file.size, imageKind(header) ?? '');
      const bitmap = await createImageBitmap(source);
      const oversized = bitmap.width > 4096 || bitmap.height > 4096;
      bitmap.close();
      if (oversized)
        throw new Error('Use an image no larger than 4096 × 4096 pixels.');
      if (sequence === imageSequence.current)
        setImage({ url: URL.createObjectURL(source), size: file.size });
    } catch (error) {
      if (sequence === imageSequence.current) {
        setImage(null);
        const safeErrors = [
          'Choose an image smaller than 2 MiB.',
          'Choose a valid PNG, JPEG, WebP or GIF image.',
          'Use an image no larger than 4096 × 4096 pixels.',
        ];
        setImageError(
          error instanceof Error && safeErrors.includes(error.message)
            ? error.message
            : 'This image could not be decoded. Choose another file.',
        );
      }
    } finally {
      if (sequence === imageSequence.current) setImagePending(false);
    }
  }

  function updateDestination(destination: Destination) {
    setSelection((current) => {
      if (
        destination.chainId !== current.chainId ||
        !supportsChain(destination.id, current.chainId)
      )
        return current;
      return {
        ...current,
        destinations: current.destinations.map((pad) =>
          pad.id === destination.id ? destination : pad,
        ),
      };
    });
  }

  function updateChain(nextChainId: ChainId) {
    if (nextChainId === chainId || !isWebviewChain(nextChainId)) return;
    setSelection((current) => ({
      chainId: nextChainId,
      destinations: selectChain(current.destinations, nextChainId),
    }));
  }

  return (
    <>
      <main className="workspace">
        <div className="intro">
          <div>
            <p className="eyebrow">YOUR NEXT IDEA STARTS HERE</p>
            <h1>
              Launch a coin<span>.</span>
            </h1>
            <p className="intro-copy">
              Create it once. Choose where it begins.
            </p>
          </div>
          <div className="intro-note">
            <ShieldCheck size={18} />
            <span>
              Your wallet. Your signature.
              <br />
              <strong>No keys leave your wallet.</strong>
            </span>
          </div>
        </div>
        <form onSubmit={(event) => event.preventDefault()} noValidate>
          <div className="composer-grid">
            <section
              className="composer-panel"
              aria-labelledby="coin-details-heading"
            >
              <div className="section-heading">
                <span className="step-number">01</span>
                <h2 id="coin-details-heading">Make it yours</h2>
                <span className="section-aside">COIN DETAILS</span>
              </div>
              <Tabs defaultValue="upload" className="image-tabs">
                <TabsList aria-label="Image source">
                  <TabsTrigger value="upload">
                    <ImagePlus />
                    Upload image
                  </TabsTrigger>
                  <TabsTrigger value="generate">
                    <Sparkles />
                    Generate with Grok
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="upload">
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="sr-only"
                    aria-label="Choose coin image"
                    tabIndex={-1}
                    onChange={(event) => {
                      void selectImage(event.target.files?.[0]);
                      event.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    className={`upload-zone ${dragging ? 'is-dragging' : ''} ${image ? 'has-image' : ''}`}
                    aria-label={
                      image ? 'Replace coin image' : 'Upload coin image'
                    }
                    onClick={() => fileInput.current?.click()}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragging(false);
                      void selectImage(event.dataTransfer.files[0]);
                    }}
                  >
                    {image ? (
                      <>
                        <Image
                          unoptimized
                          width={170}
                          height={170}
                          src={image.url}
                          alt="Your coin preview"
                          className="coin-image"
                        />
                        <span className="image-replace">
                          <ImagePlus size={14} />
                          Change image
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="upload-icon">
                          <ImagePlus size={25} />
                        </span>
                        <strong>Give your coin a face</strong>
                        <span>
                          Drop an image here, or <u>browse files</u>
                        </span>
                        <small>PNG, JPG, WEBP OR GIF · UP TO 2 MiB</small>
                      </>
                    )}
                    {imagePending && (
                      <output className="image-pending">Checking image…</output>
                    )}
                  </button>
                  {image && (
                    <div className="image-file-note">
                      <span>
                        <Check size={13} />
                        {imageBytes} · Kept in this browser only
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Remove coin image"
                        onClick={() => {
                          imageSequence.current += 1;
                          setImage(null);
                          setImagePending(false);
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  )}
                  {imageError && (
                    <p role="alert" className="field-error">
                      {imageError}
                    </p>
                  )}
                </TabsContent>
                <TabsContent value="generate">
                  <div className="generation-editor">
                    <label htmlFor="image-prompt">
                      Describe your coin image
                    </label>
                    <Textarea
                      id="image-prompt"
                      placeholder={grokPromptPlaceholder(name, ticker)}
                      maxLength={1000}
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                    />
                    <div className="generation-bottom">
                      <span>
                        <span className="x402-mark">x402</span>Pay per image
                      </span>
                      <span>{prompt.length}/1000</span>
                    </div>
                    <Button
                      variant="outline"
                      className="generation-button"
                      disabled={!prompt.trim()}
                      onClick={() => setGenerationOpen(true)}
                    >
                      <Sparkles size={16} />
                      Preview generation
                    </Button>
                    <p className="sample-note">
                      Preview only. Your prompt is not sent or charged.
                    </p>
                  </div>
                </TabsContent>
              </Tabs>
              <div className="identity-fields">
                <div className="field">
                  <label htmlFor="coin-name">Coin name</label>
                  <Input
                    id="coin-name"
                    placeholder="e.g. Moon Department"
                    value={name}
                    maxLength={100}
                    autoComplete="off"
                    onChange={(event) => setName(event.target.value)}
                    onBlur={() => setName((value) => value.trim())}
                    aria-invalid={!!name && !!errors.name}
                    aria-describedby={
                      name && errors.name ? 'name-error' : undefined
                    }
                  />
                  {name && errors.name && (
                    <p id="name-error" className="field-error">
                      {errors.name}
                    </p>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="coin-ticker">
                    Ticker <span>1–11 characters</span>
                  </label>
                  <div className="ticker-input">
                    <span>$</span>
                    <Input
                      id="coin-ticker"
                      placeholder="MOON"
                      value={ticker}
                      maxLength={30}
                      autoComplete="off"
                      spellCheck={false}
                      autoCapitalize="characters"
                      onChange={(event) => {
                        const nextTicker = event.target.value.toUpperCase();
                        setName((current) =>
                          autofillCoinName(current, ticker, nextTicker),
                        );
                        setTicker(nextTicker);
                      }}
                      aria-invalid={!!ticker && !!errors.ticker}
                      aria-describedby={
                        ticker && errors.ticker ? 'ticker-error' : undefined
                      }
                    />
                  </div>
                  {ticker && errors.ticker && (
                    <p id="ticker-error" className="field-error">
                      {errors.ticker}
                    </p>
                  )}
                </div>
              </div>
              <div className="ticker-status">
                <span>
                  <span className="small-dot neutral" />
                  {reads.checking
                    ? 'Checking…'
                    : reads.check
                      ? 'Reservation check'
                      : 'Availability not checked'}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={
                    !ticker ||
                    !!errors.ticker ||
                    !readPads.length ||
                    !isWebviewChain(chainId) ||
                    reads.checking
                  }
                  onClick={() => void reads.runCheck()}
                >
                  Check ticker <ArrowRight size={12} />
                </Button>
              </div>
              {(reads.check || reads.checkError) && (
                <output className="notice" aria-live="polite">
                  {reads.checkError ?? tickerNotice(reads.check)}
                </output>
              )}
              <Collapsible className="extra-details">
                <CollapsibleTrigger className="details-trigger">
                  Add a description <span>Optional</span>
                  <ChevronDown size={16} />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <label htmlFor="coin-description" className="sr-only">
                    Description
                  </label>
                  <Textarea
                    id="coin-description"
                    value={description}
                    maxLength={2000}
                    placeholder="A few words about your coin."
                    onChange={(event) => setDescription(event.target.value)}
                    aria-invalid={!!errors.description}
                  />
                  <p
                    className={
                      errors.description ? 'field-error' : 'sample-note'
                    }
                  >
                    {errors.description ??
                      `${new TextEncoder().encode(description).length}/2,000 UTF-8 bytes`}
                  </p>
                </CollapsibleContent>
              </Collapsible>
            </section>
            <section
              className="composer-panel destinations"
              aria-labelledby="launchpads-heading"
            >
              <div className="section-heading">
                <span className="step-number">02</span>
                <h2 id="launchpads-heading">Choose your launchpads</h2>
              </div>
              <RadioGroup
                className="chain-filter"
                aria-label="Launch chain"
                value={String(chainId)}
                onValueChange={(value) => {
                  if (isWebviewChain(Number(value)))
                    updateChain(Number(value) as ChainId);
                }}
              >
                <label className="chain-choice" htmlFor="chain-robinhood">
                  <RadioGroupItem id="chain-robinhood" value="4663" />
                  Robinhood
                </label>
                <label className="chain-choice" htmlFor="chain-base">
                  <RadioGroupItem id="chain-base" value="8453" disabled />
                  Base (paused)
                </label>
              </RadioGroup>
              {destinations
                .filter((pad) => supportsChain(pad.id, chainId))
                .map((pad) => (
                  <LaunchpadCard
                    key={pad.id}
                    destination={pad}
                    onChange={updateDestination}
                    catalog={pad.id === 'longbow' ? undefined : reads.catalog?.pads[pad.id]}
                    loading={reads.catalogLoading}
                  />
                ))}
              {errors.destinations && (
                <p role="alert" className="field-error">
                  {errors.destinations}
                </p>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={reads.catalogLoading}
                onClick={reads.refreshCatalog}
              >
                {reads.catalogLoading
                  ? 'Loading O1 pairings…'
                  : 'Refresh O1 pairings'}
              </Button>
              {reads.catalogError && (
                <p role="alert" className="notice">
                  {reads.catalogError}
                </p>
              )}
            </section>
          </div>
          <LaunchSection
            chainId={chainId}
            costContextKey={launchCostKey({
              name,
              ticker,
              description,
              imageRevision: image?.url ?? '',
              account: account.address,
              walletChainId: account.chainId,
              destinations,
            })}
            name={name}
            ticker={ticker}
            image={image}
            imagePending={imagePending}
            errors={errors}
            destinations={active}
            onChange={updateDestination}
            catalog={reads.catalog}
            tickerCheck={reads.check}
            checking={reads.checking}
            now={reads.now}
          />
        </form>
        <footer className="workspace-footer">
          <span>YOUR IDEA. YOUR WALLET. YOUR LAUNCH.</span>
          <span>
            Long + O1 + Longbow <span>·</span>Preview — no transactions
          </span>
        </footer>
      </main>
      <Dialog open={generationOpen} onOpenChange={setGenerationOpen}>
        <DialogContent className="app-dialog">
          <DialogHeader>
            <span className="dialog-icon">
              <Sparkles />
            </span>
            <DialogTitle>Generate with Grok</DialogTitle>
            <DialogDescription>
              In the next milestone, you’ll review an x402 price, approve
              payment in your wallet, and receive your image.
            </DialogDescription>
          </DialogHeader>
          <p className="prompt-preview">{prompt}</p>
          <div className="generation-steps">
            <span>
              <span>1</span>Review price & payment network
            </span>
            <span>
              <span>2</span>Approve a one-time wallet payment
            </span>
            <span>
              <span>3</span>Generate and attach your image
            </span>
          </div>
          <p className="notice">
            No price has been quoted. No prompt, payment or signature has been
            sent.
          </p>
          <Button disabled>
            <LockKeyhole size={16} />
            Payment not enabled
          </Button>
          <Button variant="outline" onClick={() => setGenerationOpen(false)}>
            Back to prompt
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
