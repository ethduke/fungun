import type { Hex } from 'viem';
import { isAddress } from 'viem';
import {
  assetHash,
  imageBytes,
  objectFields,
  readAssetJson,
} from './asset-protocol.ts';

export const IMAGE_PRODUCT =
  'openrouter-grok-image-2.0-square-1k-low-memecoin-v1';
export const IMAGE_PAYMENT_TIMEOUT_SECONDS = 300;
export type ImageOperation = {
  requestId: string;
  wallet: string;
  name: string;
  ticker: string;
  prompt: string;
};
export type ImageTerms = {
  scheme: 'exact';
  network: 'eip155:4663';
  asset: `0x${string}`;
  amount: string;
  payTo: `0x${string}`;
  maxTimeoutSeconds: number;
  extra: {
    name: 'Global Dollar';
    version: '1';
    symbol: 'USDG';
    decimals: 6;
    assetTransferMethod: 'eip3009';
    paymentFlow: 'authorization';
    payer: string;
    requestId: string;
    inputHash: string;
    fromBlock?: string;
    product: string;
    nonce: `0x${string}`;
    issuedAt: number;
    expiresAt: number;
  };
};
export type ImageQuote = {
  x402Version: 2;
  resource: { url: string; description: string; mimeType: string };
  accepts: [ImageTerms];
};
export type ImageProof = {
  x402Version: 2;
  resource: ImageQuote['resource'];
  accepted: ImageTerms;
  payload: {
    signature: Hex;
    authorization: {
      from: `0x${string}`;
      to: `0x${string}`;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: `0x${string}`;
    };
  };
};
export type ImageRecovery = {
  input: ImageOperation;
  token: string;
  quote?: ImageQuote;
  proof?: ImageProof;
  submitted?: boolean;
  completed?: boolean;
};
export type ImageJob = {
  requestId: string;
  status: string;
  error?: string;
  payment: { status: string; transaction: string | null; network: string };
  quote?: ImageQuote;
  image?: {
    base64: string;
    mimeType: 'image/webp';
    sha256: string;
    width: number;
    height: number;
    filename: string;
  };
};
const key = 'fungun.image-generation.v1';
export const imageAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;
export class ImageGenerationError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const messages: Record<string, string> = {
  image_request_in_progress:
    'Another saved image request is awaiting confirmation. Recover it before starting another.',
  image_service_not_configured:
    'Image generation is not enabled yet. No payment was requested.',
  image_facilitator_unavailable:
    'The payment service is unavailable. Try again later.',
  image_payment_network_unsupported:
    'USDG payments are not available on this payment service yet.',
  image_pricing_unavailable:
    'The current image price is unavailable. No payment was requested.',
  image_price_above_limit:
    'The current image price exceeds the service limit. No payment was requested.',
  image_price_changed:
    'The provider price changed during generation. No payment was collected; request a new image.',
  image_quote_expired:
    'This price expired. Request a new price before signing.',
  image_request_changed:
    'This request belongs to a different prompt. Finish it before requesting another image.',
  image_not_found:
    'This image request could not be recovered. Keep its saved details and contact support.',
  image_storage_full:
    'Image storage is temporarily full. Please try again later.',
  image_recovery_unavailable:
    'Your browser could not save payment recovery. Enable browser storage before generating.',
  image_rejected:
    'You declined the payment authorization. No request was submitted.',
  image_context_changed:
    'The wallet or coin details changed. Review the request again.',
  invalid_image_request:
    'Use a name under 51 characters, a ticker under 12 characters, and an image description under 1,001 characters.',
  invalid_image_payment: 'The payment authorization could not be verified.',
  image_filtered:
    'The image provider declined this prompt. No payment was settled.',
  image_outcome_unknown:
    'Generation could not be confirmed. This request will not be generated or charged again automatically.',
  image_daily_limit: 'The image limit was reached. No payment was settled.',
  image_settlement_pending:
    'Your image is saved. Payment confirmation is pending; check this request again.',
  image_settlement_failed:
    'Payment could not be completed, and no charge was broadcast. Request a new price to try again.',
  image_payment_expired:
    'The saved authorization expired without a confirmed payment. Request a new price to try again.',
  image_settlement_review_required:
    'Payment status needs operator review. Keep this saved request and contact support.',
};
export function imageErrorText(error: unknown) {
  return error instanceof ImageGenerationError && messages[error.code]
    ? messages[error.code]
    : 'The image request could not be confirmed. Check its status before starting another.';
}

function invalid(): never {
  throw new ImageGenerationError('invalid_image_payment');
}
function fields(
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    required.every((field) => Object.hasOwn(value, field)) &&
    Object.keys(value).every(
      (field) => required.includes(field) || optional.includes(field),
    )
  );
}
function address(value: unknown): value is `0x${string}` {
  return (
    typeof value === 'string' && isAddress(value) && !/^0x0+$/i.test(value)
  );
}
function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function transaction(value: unknown): value is string {
  return typeof value === 'string' && /^0x[a-f0-9]{64}$/i.test(value);
}
function validOperation(value: unknown): value is ImageOperation {
  return (
    objectFields(value, ['requestId', 'wallet', 'name', 'ticker', 'prompt']) &&
    typeof value.requestId === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value.requestId,
    ) &&
    address(value.wallet) &&
    value.wallet === value.wallet.toLowerCase() &&
    typeof value.name === 'string' &&
    value.name === value.name.trim() &&
    Array.from(value.name).length <= 50 &&
    !/\p{Cc}/u.test(value.name) &&
    typeof value.ticker === 'string' &&
    /^[A-Z]{0,11}$/.test(value.ticker) &&
    typeof value.prompt === 'string' &&
    !!value.prompt &&
    value.prompt === value.prompt.trim() &&
    Array.from(value.prompt).length <= 1000 &&
    !/\p{Cc}/u.test(value.prompt.replace(/[\r\n\t]/g, ''))
  );
}

/** Shape validation keeps corrupt saved data away from render-time code. */
export function validateImageRecovery(
  raw: unknown,
  origin: string,
): ImageRecovery {
  if (
    !fields(
      raw,
      ['input', 'token'],
      ['quote', 'proof', 'submitted', 'completed'],
    ) ||
    !hash(raw.token) ||
    !validOperation(raw.input) ||
    ('submitted' in raw && typeof raw.submitted !== 'boolean') ||
    ('completed' in raw && typeof raw.completed !== 'boolean')
  )
    return invalid();
  const quote =
    'quote' in raw
      ? validateImageQuote(raw.quote, raw.input, origin)
      : undefined;
  if ('proof' in raw) {
    if (!quote || raw.submitted !== true || raw.completed === true)
      return invalid();
    validateImageProof(raw.proof, quote, raw.input);
  }
  if (raw.submitted === true && raw.completed !== true && !raw.proof)
    return invalid();
  if (raw.completed === true && (raw.submitted !== true || quote || raw.proof))
    return invalid();
  return raw as ImageRecovery;
}
export function saveImageRecovery(record: ImageRecovery, storage?: Storage) {
  try {
    validateImageRecovery(record, location.origin);
    const target = storage ?? localStorage;
    const existing = readImageRecovery(target);
    if (
      existing?.submitted &&
      !existing.completed &&
      (existing.input.requestId !== record.input.requestId || !record.submitted)
    )
      throw new ImageGenerationError('image_request_in_progress');
    const value = JSON.stringify(record);
    if (value.length > 24000) throw new Error();
    target.setItem(key, value);
    if (target.getItem(key) !== value) throw new Error();
  } catch (error) {
    if (error instanceof ImageGenerationError) throw error;
    throw new ImageGenerationError('image_recovery_unavailable');
  }
}
export function readImageRecovery(
  storage?: Pick<Storage, 'getItem'>,
): ImageRecovery | null {
  try {
    const raw = (storage ?? localStorage).getItem(key);
    if (!raw) return null;
    if (raw.length > 24000) throw new Error();
    return validateImageRecovery(JSON.parse(raw), location.origin);
  } catch {
    throw new ImageGenerationError('image_recovery_unavailable');
  }
}
export function clearImageRecovery(record: ImageRecovery, storage?: Storage) {
  try {
    const target = storage ?? localStorage;
    if (readImageRecovery(target)?.input.requestId === record.input.requestId)
      target.removeItem(key);
  } catch {
    throw new ImageGenerationError('image_recovery_unavailable');
  }
}
export function newImageRecovery(
  input: Omit<ImageOperation, 'requestId'>,
): ImageRecovery {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) =>
    v.toString(16).padStart(2, '0'),
  ).join('');
  const operation = {
    requestId: crypto.randomUUID(),
    wallet: input.wallet.toLowerCase(),
    name: input.name.trim(),
    ticker: input.ticker.trim(),
    prompt: input.prompt.trim(),
  };
  if (!validOperation(operation))
    throw new ImageGenerationError('invalid_image_request');
  return { input: operation, token };
}

export function validateImageQuote(
  raw: unknown,
  input: ImageOperation,
  origin: string,
): ImageQuote {
  if (
    !validOperation(input) ||
    !objectFields(raw, ['x402Version', 'resource', 'accepts']) ||
    raw.x402Version !== 2 ||
    !objectFields(raw.resource, ['url', 'description', 'mimeType']) ||
    raw.resource.url !== `${origin}/api/images/grok` ||
    raw.resource.description !== 'One Grok memecoin image' ||
    raw.resource.mimeType !== 'application/json' ||
    !Array.isArray(raw.accepts) ||
    raw.accepts.length !== 1
  )
    return invalid();
  const terms = raw.accepts[0];
  if (
    !objectFields(terms, [
      'scheme',
      'network',
      'asset',
      'amount',
      'payTo',
      'maxTimeoutSeconds',
      'extra',
    ]) ||
    terms.scheme !== 'exact' ||
    terms.network !== 'eip155:4663' ||
    !address(terms.asset) ||
    typeof terms.amount !== 'string' ||
    !/^[1-9][0-9]{0,7}$/.test(terms.amount) ||
    BigInt(terms.amount) > 10000000n ||
    !address(terms.payTo) ||
    terms.maxTimeoutSeconds !== IMAGE_PAYMENT_TIMEOUT_SECONDS ||
    !fields(
      terms.extra,
      [
        'name',
        'version',
        'symbol',
        'decimals',
        'assetTransferMethod',
        'paymentFlow',
        'payer',
        'requestId',
        'inputHash',
        'product',
        'nonce',
        'issuedAt',
        'expiresAt',
      ],
      ['fromBlock'],
    )
  )
    return invalid();
  const extra = terms.extra;
  if (
    (extra.fromBlock !== undefined &&
      (typeof extra.fromBlock !== 'string' ||
        !/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(extra.fromBlock))) ||
    extra.name !== 'Global Dollar' ||
    extra.version !== '1' ||
    extra.symbol !== 'USDG' ||
    extra.decimals !== 6 ||
    extra.assetTransferMethod !== 'eip3009' ||
    extra.paymentFlow !== 'authorization' ||
    extra.payer !== input.wallet ||
    extra.requestId !== input.requestId ||
    !hash(extra.inputHash) ||
    extra.product !== IMAGE_PRODUCT ||
    typeof extra.nonce !== 'string' ||
    !/^0x[a-f0-9]{64}$/.test(extra.nonce) ||
    typeof extra.issuedAt !== 'number' ||
    !Number.isSafeInteger(extra.issuedAt) ||
    extra.issuedAt < 60000 ||
    typeof extra.expiresAt !== 'number' ||
    !Number.isSafeInteger(extra.expiresAt) ||
    extra.expiresAt - extra.issuedAt !==
      IMAGE_PAYMENT_TIMEOUT_SECONDS * 1000
  )
    return invalid();
  return raw as ImageQuote;
}
/** Reconstruct the server's ordered canonical input before any wallet call. */
export async function validateImageQuoteInput(
  raw: unknown,
  input: ImageOperation,
  origin: string,
): Promise<ImageQuote> {
  const quote = validateImageQuote(raw, input, origin);
  const normalized = {
    requestId: input.requestId,
    wallet: input.wallet,
    name: input.name,
    ticker: input.ticker,
    prompt: input.prompt,
  };
  const inputHash = await assetHash(
    new TextEncoder().encode(
      JSON.stringify({ input: normalized, product: IMAGE_PRODUCT, origin }),
    ),
  );
  if (quote.accepts[0].extra.inputHash !== inputHash) return invalid();
  return quote;
}
export function validateImageProof(
  raw: unknown,
  quote: ImageQuote,
  input: ImageOperation,
): ImageProof {
  if (
    !objectFields(raw, ['x402Version', 'resource', 'accepted', 'payload']) ||
    raw.x402Version !== 2 ||
    JSON.stringify(raw.resource) !== JSON.stringify(quote.resource) ||
    JSON.stringify(raw.accepted) !== JSON.stringify(quote.accepts[0]) ||
    !objectFields(raw.payload, ['signature', 'authorization']) ||
    typeof raw.payload.signature !== 'string' ||
    !/^0x[a-f0-9]{130}$/i.test(raw.payload.signature) ||
    !objectFields(raw.payload.authorization, [
      'from',
      'to',
      'value',
      'validAfter',
      'validBefore',
      'nonce',
    ])
  )
    return invalid();
  const auth = raw.payload.authorization;
  const terms = quote.accepts[0];
  if (
    auth.from !== input.wallet ||
    auth.to !== terms.payTo ||
    auth.value !== terms.amount ||
    auth.nonce !== terms.extra.nonce ||
    auth.validAfter !== String(Math.floor(terms.extra.issuedAt / 1000) - 60) ||
    auth.validBefore !== String(Math.floor(terms.extra.expiresAt / 1000))
  )
    return invalid();
  return raw as ImageProof;
}
const accounting: Record<string, string> = {
  awaiting_payment: 'unpaid',
  authorized: 'authorized',
  generating: 'authorized',
  generated: 'authorized',
  settlement_pending: 'settlement_pending',
  completed: 'paid',
  failed: 'not_charged',
  unknown: 'not_charged',
};
function validImage(raw: unknown): raw is NonNullable<ImageJob['image']> {
  return (
    objectFields(raw, [
      'base64',
      'mimeType',
      'sha256',
      'width',
      'height',
      'filename',
    ]) &&
    typeof raw.base64 === 'string' &&
    raw.base64.length > 0 &&
    raw.base64.length <= Math.ceil(2097152 / 3) * 4 &&
    raw.mimeType === 'image/webp' &&
    hash(raw.sha256) &&
    raw.filename === `${raw.sha256}.webp` &&
    typeof raw.width === 'number' &&
    Number.isSafeInteger(raw.width) &&
    raw.width >= 1 &&
    raw.width <= 4096 &&
    raw.height === raw.width
  );
}
async function validateImageJob(
  raw: unknown,
  input: ImageOperation,
  origin: string,
): Promise<ImageJob> {
  if (
    !fields(
      raw,
      ['requestId', 'status', 'payment'],
      ['quote', 'image', 'error'],
    ) ||
    raw.requestId !== input.requestId ||
    typeof raw.status !== 'string' ||
    !Object.hasOwn(accounting, raw.status) ||
    !objectFields(raw.payment, ['status', 'transaction', 'network']) ||
    raw.payment.network !== 'eip155:4663' ||
    raw.payment.status !== accounting[raw.status] ||
    ('error' in raw &&
      (typeof raw.error !== 'string' || !/^[a-z0-9_]{1,64}$/.test(raw.error)))
  )
    return invalid();
  if (raw.status === 'completed') {
    if (
      !transaction(raw.payment.transaction) ||
      !validImage(raw.image) ||
      'quote' in raw ||
      'error' in raw
    )
      return invalid();
  } else {
    if (
      'image' in raw ||
      (raw.status === 'settlement_pending'
        ? raw.payment.transaction !== null &&
          !transaction(raw.payment.transaction)
        : raw.payment.transaction !== null)
    )
      return invalid();
  }
  if (raw.status === 'awaiting_payment') {
    if (!('quote' in raw)) return invalid();
    await validateImageQuoteInput(raw.quote, input, origin);
  } else if ('quote' in raw) return invalid();
  return raw as ImageJob;
}
export async function requestImage(
  record: ImageRecovery,
  method: 'POST' | 'GET',
  fetcher: typeof fetch = fetch,
): Promise<{ quote?: ImageQuote; job?: ImageJob }> {
  validateImageRecovery(record, location.origin);
  if (record.quote)
    await validateImageQuoteInput(record.quote, record.input, location.origin);
  if (method === 'POST' && record.completed) return invalid();
  const response = await fetcher(
    `/api/images/grok${method === 'GET' ? `/${record.input.requestId}` : ''}`,
    {
      method,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(45000),
      headers: {
        'content-type': 'application/json',
        'x-fungun-intent': 'image-generation',
        ['authorization']: `Bearer ${record.token}`,
        ...(method === 'POST' && record.proof
          ? { 'payment-signature': btoa(JSON.stringify(record.proof)) }
          : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(record.input) } : {}),
    },
  );
  if (
    response.headers.get('content-type')?.split(';')[0].trim() !==
    'application/json'
  ) {
    await response.body?.cancel();
    return invalid();
  }
  let raw: unknown;
  try {
    raw = await readAssetJson(response.body);
  } catch {
    return invalid();
  }
  if (response.status === 402) {
    if (record.proof || method !== 'POST') return invalid();
    const header = response.headers.get('payment-required');
    try {
      if (
        !header ||
        header.length > 16000 ||
        JSON.stringify(JSON.parse(atob(header))) !== JSON.stringify(raw)
      )
        return invalid();
    } catch {
      return invalid();
    }
    return {
      quote: await validateImageQuoteInput(raw, record.input, location.origin),
    };
  }
  if (!response.ok)
    throw new ImageGenerationError(
      fields(raw, ['error']) &&
        typeof raw.error === 'string' &&
        /^[a-z0-9_]{1,64}$/.test(raw.error)
        ? raw.error
        : 'unavailable',
    );
  return { job: await validateImageJob(raw, record.input, location.origin) };
}
export async function generatedImageBlob(job: ImageJob) {
  const image = job.image;
  if (
    job?.status !== 'completed' ||
    job.payment?.status !== 'paid' ||
    !transaction(job.payment.transaction) ||
    !validImage(image)
  )
    return invalid();
  let bytes: Uint8Array;
  try {
    bytes = imageBytes(image.base64);
  } catch {
    return invalid();
  }
  if (
    (await assetHash(bytes)) !== image.sha256 ||
    new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RIFF' ||
    new TextDecoder().decode(bytes.subarray(8, 12)) !== 'WEBP'
  )
    return invalid();
  return new Blob([new Uint8Array(bytes)], { type: 'image/webp' });
}
