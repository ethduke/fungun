'use client';

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ImagePlus,
  Info,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
import {
  chainName,
  DEFAULT_DESTINATIONS,
  IMAGE_LIMIT,
  imageFileError,
  pairingName,
  validateDraft,
  type Destination,
} from '@/lib/launch-model';
import { usePreviewTools } from '@/lib/preview-webmcp';

const WalletConnection = lazy(() => import('@/components/connect-panel'));
type ImagePreview = { url: string; size: number };

export default function Home() {
  const [destinations, setDestinations] =
    useState<Destination[]>(DEFAULT_DESTINATIONS);
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [image, setImage] = useState<ImagePreview | null>(null);
  const [imageError, setImageError] = useState('');
  const [imagePending, setImagePending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [tickerNotice, setTickerNotice] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [generationOpen, setGenerationOpen] = useState(false);
  const [walletStarted, setWalletStarted] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageSequence = useRef(0);
  const active = destinations.filter((pad) => pad.selected);
  const errors = validateDraft(
    { name, ticker, description, hasImage: !!image },
    destinations,
  );
  const imageBytes = image
    ? `${Math.max(1, Math.round(image.size / 1024))} KB`
    : '';

  useEffect(
    () => () => {
      if (image) URL.revokeObjectURL(image.url);
    },
    [image],
  );
  useEffect(
    () => () => {
      imageSequence.current += 1;
    },
    [],
  );

  usePreviewTools(
    () => ({
      mode: 'preview',
      name,
      ticker,
      hasImage: !!image,
      destinations: active,
      validationErrors: errors,
      liveChecks: false,
      signingEnabled: false,
    }),
    (value) => {
      setName(value.name);
      setTicker(value.ticker);
      setTickerNotice(false);
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
      const bitmap = await createImageBitmap(file);
      const oversized = bitmap.width > 4096 || bitmap.height > 4096;
      bitmap.close();
      if (oversized)
        throw new Error('Use an image no larger than 4096 × 4096 pixels.');
      if (sequence === imageSequence.current)
        setImage({ url: URL.createObjectURL(file), size: file.size });
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
    setDestinations((current) =>
      current.map((pad) => (pad.id === destination.id ? destination : pad)),
    );
    setTickerNotice(false);
  }

  function review() {
    setAttempted(true);
    if (!Object.keys(errors).length && !imagePending) setReviewOpen(true);
  }

  return (
    <div className="site-shell">
      <header className="site-header">
        <Link
          href="/"
          prefetch={false}
          className="brand"
          aria-label="Fungun home"
        >
          <span className="brand-mark" aria-hidden="true">
            f
          </span>
          fungun<span className="brand-period">.</span>
        </Link>
        <span className="header-context">
          LAUNCH STUDIO <span>/</span> 01
        </span>
        <div className="header-actions">
          <span className="preview-pill">
            <span />
            Local preview
          </span>
          {walletStarted ? (
            <Suspense
              fallback={
                <Button className="wallet-button" disabled>
                  Loading wallets…
                </Button>
              }
            >
              <WalletConnection />
            </Suspense>
          ) : (
            <Button
              className="wallet-button"
              onClick={() => setWalletStarted(true)}
            >
              <Wallet size={16} />
              Connect wallet
            </Button>
          )}
        </div>
      </header>
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
        <form
          onSubmit={(event) => {
            event.preventDefault();
            review();
          }}
          noValidate
        >
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
                  {(imageError || (attempted && errors.image)) && (
                    <p role="alert" className="field-error">
                      {imageError || errors.image}
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
                      placeholder="A little moon wearing a very serious business suit…"
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
                    aria-invalid={attempted && !!errors.name}
                    aria-describedby={
                      attempted && errors.name ? 'name-error' : undefined
                    }
                  />
                  {attempted && errors.name && (
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
                      onChange={(event) => {
                        setTicker(event.target.value);
                        setTickerNotice(false);
                      }}
                      aria-invalid={(attempted || !!ticker) && !!errors.ticker}
                      aria-describedby={
                        (attempted || ticker) && errors.ticker
                          ? 'ticker-error'
                          : undefined
                      }
                    />
                  </div>
                  {(attempted || ticker) && errors.ticker && (
                    <p id="ticker-error" className="field-error">
                      {errors.ticker}
                    </p>
                  )}
                </div>
              </div>
              <div className="ticker-status">
                <span>
                  <span className="small-dot neutral" />
                  Availability not checked
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!ticker || !!errors.ticker || !active.length}
                  onClick={() => setTickerNotice(true)}
                >
                  Check ticker <ArrowRight size={12} />
                </Button>
              </div>
              {tickerNotice && (
                <output className="notice">
                  Live checks are not connected. Long checks a 24-hour
                  reservation; O1 availability remains unverified. No RPC
                  request was sent.
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
                <span className="count-pill">{active.length} selected</span>
              </div>
              <p className="panel-caption">
                One launchpad, or both. Each launch is independent.
              </p>
              {destinations.map((pad) => (
                <LaunchpadCard
                  key={pad.id}
                  destination={pad}
                  onChange={updateDestination}
                />
              ))}
              {attempted && errors.destinations && (
                <p role="alert" className="field-error">
                  {errors.destinations}
                </p>
              )}
              <div className="launchpad-note">
                <ShieldCheck size={17} />
                <p>
                  You approve every deployment in your wallet.
                  <br />
                  Nothing is signed in this preview.
                </p>
              </div>
            </section>
          </div>
          <div className="review-bar">
            <div>
              <span className="eyebrow">ESTIMATED TOTAL</span>
              <div className="total-price">
                — <span>Deployment + network fees</span>
              </div>
            </div>
            <span className="review-status">
              {active.length
                ? `${active.length} separate ${active.length === 1 ? 'deployment' : 'deployments'}`
                : 'No launchpads selected'}
              <small>Live quote not connected</small>
            </span>
            <Button
              type="submit"
              className="review-button"
              disabled={imagePending}
            >
              Review launch
              <ArrowRight size={18} />
            </Button>
          </div>
          {attempted && Object.keys(errors).length > 0 && (
            <p role="alert" className="form-error">
              Add a valid image, name, ticker and launchpad selection to review
              your draft.
            </p>
          )}
        </form>
        <footer className="workspace-footer">
          <span>YOUR IDEA. YOUR WALLET. YOUR LAUNCH.</span>
          <span>
            Long + O1 <span>·</span>Preview — no transactions
          </span>
        </footer>
      </main>
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent className="app-dialog review-dialog">
          <DialogHeader>
            <p className="eyebrow">ONE LAST LOOK</p>
            <DialogTitle>Review your launch</DialogTitle>
            <DialogDescription>
              This is a draft preview, not a transaction. Fees, ticker
              availability and pair eligibility are not verified.
            </DialogDescription>
          </DialogHeader>
          <div className="review-identity">
            {image && (
              <Image
                unoptimized
                width={49}
                height={49}
                src={image.url}
                alt="Coin preview"
              />
            )}
            <div>
              <strong>{name.trim()}</strong>
              <span>${ticker}</span>
            </div>
            <span className="preview-label">Draft</span>
          </div>
          <div className="review-destinations">
            {active.map((pad) => (
              <div key={pad.id} className="review-destination">
                <div>
                  <strong>{pad.id === 'long' ? 'Long' : 'O1'}</strong>
                  <span>{chainName(pad.chainId)}</span>
                </div>
                <dl>
                  <div>
                    <dt>Pairing</dt>
                    <dd>
                      {pairingName(pad.pairId)}
                      {pad.route === 'rwa' ? ' · sample' : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>Metadata</dt>
                    <dd>{pad.editableMetadata ? 'Editable' : 'Immutable'}</dd>
                  </div>
                  <div>
                    <dt>Deployment fee</dt>
                    <dd>Not quoted</dd>
                  </div>
                  <div>
                    <dt>Network gas</dt>
                    <dd>Not estimated</dd>
                  </div>
                  <div>
                    <dt>Ticker</dt>
                    <dd>Not checked</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
          {active.length > 1 && (
            <p className="notice">
              <Info size={15} />
              These are separate token deployments sharing your branding. One
              can succeed while another fails.
            </p>
          )}
          <Button className="disabled-launch" disabled>
            <LockKeyhole size={16} />
            Live launch is not enabled
          </Button>
          <Button variant="outline" onClick={() => setReviewOpen(false)}>
            Back to editing
          </Button>
        </DialogContent>
      </Dialog>
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
    </div>
  );
}
