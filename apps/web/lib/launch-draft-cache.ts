import {
  autofillCoinName,
  autofillGrokPrompt,
  DEFAULT_CHAIN_ID,
  DEFAULT_DESTINATIONS,
  IMAGE_LIMIT,
  imageFileError,
  isWebviewChain,
  normalizeTicker,
  type ChainId,
  type Destination,
} from './launch-model.ts';
import type { PublishedAsset } from './asset-protocol.ts';

export type DraftImage = { url: string; size: number; blob?: Blob };
export type DraftPublication = {
  sourceKey: string;
  result: PublishedAsset;
};
export type LaunchDraft = {
  selection: { chainId: ChainId; destinations: Destination[] };
  name: string;
  ticker: string;
  description: string;
  prompt: string;
  image: DraftImage | null;
  published: DraftPublication | null;
};
export type CachedLaunchDraft = Omit<LaunchDraft, 'image'> & {
  version: 1;
  image: Blob | null;
};

export const DRAFT_CACHE_ERROR =
  'This browser could not save your draft. Keep this page open until the image is saved, or enable browser storage and retry.';

export function emptyLaunchDraft(): LaunchDraft {
  return {
    selection: {
      chainId: DEFAULT_CHAIN_ID,
      destinations: DEFAULT_DESTINATIONS.map((item) => ({ ...item })),
    },
    name: '',
    ticker: '',
    description: '',
    prompt: '',
    image: null,
    published: null,
  };
}

export function updateDraftField<K extends keyof LaunchDraft>(
  current: LaunchDraft,
  key: K,
  value: LaunchDraft[K],
): LaunchDraft {
  let updated = { ...current, [key]: value };
  if (key === 'ticker' && typeof value === 'string') {
    updated.ticker = normalizeTicker(value);
    updated.name = autofillCoinName(
      current.name,
      current.ticker,
      updated.ticker,
    );
  }
  if (key === 'name' || key === 'ticker')
    updated = { ...updated, prompt: autofillGrokPrompt(current, updated) };
  if (!sameDraftArtwork(current, updated)) updated.published = null;
  return updated;
}

/** Compare the exact source used for publication, excluding prompt and routes. */
export function sameDraftArtwork(a: LaunchDraft, b: LaunchDraft) {
  return (
    a.name === b.name &&
    a.ticker === b.ticker &&
    a.description === b.description &&
    a.image === b.image
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit;
}
function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function invalid(): never {
  throw new Error('The saved draft could not be read.');
}

function selection(value: unknown): LaunchDraft['selection'] {
  if (
    !record(value) ||
    !isWebviewChain(Number(value.chainId)) ||
    !Array.isArray(value.destinations) ||
    ![3, 4].includes(value.destinations.length)
  )
    return invalid();
  const destinations: Destination[] = value.destinations.map((item) => {
    if (
      !record(item) ||
      !['long', 'o1', 'longbow', 'stonks'].includes(String(item.id)) ||
      typeof item.selected !== 'boolean' ||
      ![4663, 8453].includes(Number(item.chainId)) ||
      typeof item.chainId !== 'number' ||
      !['standard', 'rwa'].includes(String(item.route)) ||
      !text(item.pairId, 160) ||
      !/^[A-Za-z0-9-]+$/.test(item.pairId) ||
      typeof item.editableMetadata !== 'boolean'
    )
      return invalid();
    // Only copy recognized fields: credentials or arbitrary cache properties
    // can never enter the in-memory draft or a later write.
    return {
      id: item.id as Destination['id'],
      selected: item.selected,
      chainId: item.chainId as ChainId,
      route: item.route as Destination['route'],
      pairId: item.pairId as Destination['pairId'],
      editableMetadata: item.editableMetadata,
    };
  });
  if (new Set(destinations.map((item) => item.id)).size !== destinations.length) return invalid();
  if (!destinations.some(item => item.id === 'stonks')) destinations.push({ ...DEFAULT_DESTINATIONS.find(item => item.id === 'stonks')! });
  if (destinations.length !== 4) return invalid();
  return { chainId: Number(value.chainId) as ChainId, destinations };
}

export function validateDraftPublication(
  value: unknown,
): DraftPublication | null {
  if (value === null || value === undefined) return null;
  if (!record(value) || !hash(value.sourceKey) || !record(value.result))
    return null;
  const result = value.result;
  if (
    typeof result.id !== 'string' ||
    !/^[a-f0-9]{48}$/.test(result.id) ||
    !hash(result.imageHash) ||
    !hash(result.metadataHash) ||
    result.status !== 'published' ||
    result.launchReady !== false ||
    !text(result.imageUrl, 2048) ||
    !text(result.metadataUrl, 2048)
  )
    return null;
  let imageUrl = result.imageUrl, metadataUrl = result.metadataUrl;
  try {
    const image = new URL(result.imageUrl);
    const metadata = new URL(result.metadataUrl);
    const ipfs = result.ipfs;
    if (image.protocol !== 'https:' ||
      image.username ||
      image.password ||
      metadata.origin !== image.origin)
      return null;
    if (ipfs) {
      if (!record(ipfs) || ipfs.profile !== 'pinata-v1-256k' || ipfs.schema !== 'long-ipfs-v1'
        || !text(ipfs.imageCid, 59) || !/^b[a-z2-7]{58}$/.test(ipfs.imageCid)
        || !text(ipfs.metadataCid, 59) || !/^b[a-z2-7]{58}$/.test(ipfs.metadataCid)) return null;
      const canonical = image.href === `${image.origin}/ipfs/${ipfs.imageCid}`
        && metadata.href === `${image.origin}/ipfs/${ipfs.metadataCid}`;
      const legacy = image.href === `${image.origin}/files/${ipfs.imageCid}`
        && metadata.href === `${image.origin}/files/${ipfs.metadataCid}`;
      if (!canonical && !legacy) return null;
      imageUrl = `${image.origin}/ipfs/${ipfs.imageCid}`;
      metadataUrl = `${image.origin}/ipfs/${ipfs.metadataCid}`;
    } else if (image.href !== `${image.origin}/launch-assets/${result.imageHash}.webp`
      || metadata.href !== `${image.origin}/launch-assets/${result.metadataHash}.json`)
      return null;
  } catch {
    return null;
  }
  return {
    sourceKey: value.sourceKey,
    result: {
      id: result.id,
      imageHash: result.imageHash,
      metadataHash: result.metadataHash,
      imageUrl,
      metadataUrl,
      status: 'published',
      launchReady: false,
      ...(record(result.ipfs) ? { ipfs: result.ipfs as PublishedAsset['ipfs'] } : {}),
    },
  };
}

async function checkedImage(blob: Blob): Promise<Blob> {
  const header = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  if (imageFileError(blob.size, blob.type, header)) return invalid();
  return blob;
}

/** Persist actual image bytes. A URL is only an in-session display handle. */
export async function draftImageBlob(
  image: DraftImage,
  fetcher: typeof fetch = fetch,
  origin = typeof location === 'undefined' ? '' : location.origin,
): Promise<Blob> {
  if (image.size <= 0 || image.size > IMAGE_LIMIT) return invalid();
  if (image.blob instanceof Blob) {
    if (image.blob.size !== image.size) return invalid();
    return checkedImage(image.blob);
  }
  if (!origin || !image.url.startsWith(`blob:${origin}/`)) return invalid();
  const response = await fetcher(image.url, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return invalid();
  const blob = await response.blob();
  if (blob.size !== image.size) return invalid();
  return checkedImage(blob);
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}

export async function draftArtworkKey(
  draft: Pick<LaunchDraft, 'name' | 'ticker' | 'description'>,
  image: Blob,
) {
  const imageHash = await sha256(new Uint8Array(await image.arrayBuffer()));
  return sha256(
    new TextEncoder().encode(
      JSON.stringify([draft.name, draft.ticker, draft.description, imageHash]),
    ),
  );
}

/** Content identity survives object-URL changes and isolates accounts and launch destinations. */
export async function launchRecoveryScope(wallet: string, pairId: string,
  draft: Pick<LaunchDraft, 'name' | 'ticker' | 'description'>, image: Blob, chainId: ChainId = 4663) {
  return sha256(new TextEncoder().encode(JSON.stringify([
    chainId, wallet.toLowerCase(), pairId, await draftArtworkKey(draft, image),
  ])));
}

export async function encodeLaunchDraft(
  draft: LaunchDraft,
): Promise<CachedLaunchDraft> {
  const image = draft.image ? await draftImageBlob(draft.image) : null;
  const published = validateDraftPublication(draft.published);
  return {
    version: 1,
    selection: selection(draft.selection),
    name: draft.name,
    ticker: draft.ticker,
    description: draft.description,
    prompt: draft.prompt,
    image,
    published:
      image &&
      published &&
      published.sourceKey === (await draftArtworkKey(draft, image))
        ? published
        : null,
  };
}

export async function decodeLaunchDraft(
  value: unknown,
): Promise<CachedLaunchDraft | null> {
  if (value === undefined || value === null) return null;
  if (
    !record(value) ||
    value.version !== 1 ||
    !text(value.name, 100) ||
    !text(value.ticker, 30) ||
    !text(value.description, 8000) ||
    !text(value.prompt, 12000) ||
    (value.image !== null && !(value.image instanceof Blob))
  )
    return invalid();
  const ticker = normalizeTicker(value.ticker);
  const draft: CachedLaunchDraft = {
    version: 1,
    selection: selection(value.selection),
    name: autofillCoinName(value.name, value.ticker, ticker),
    ticker,
    description: value.description,
    prompt: value.prompt,
    image: value.image ? await checkedImage(value.image) : null,
    published: validateDraftPublication(value.published),
  };
  if (
    !draft.image ||
    !draft.published ||
    draft.published.sourceKey !== (await draftArtworkKey(draft, draft.image))
  )
    draft.published = null;
  return draft;
}

const DATABASE = 'fungun.launch-draft';
const STORE = 'drafts';
const KEY = 'current';

function openDraftDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error(DRAFT_CACHE_ERROR));
      return;
    }
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error(DRAFT_CACHE_ERROR));
    }, 5000);
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      clearTimeout(timeout);
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(timeout);
      settled = true;
      reject(new Error(DRAFT_CACHE_ERROR));
    };
    request.onblocked = () => {
      clearTimeout(timeout);
      settled = true;
      reject(new Error(DRAFT_CACHE_ERROR));
    };
  });
}

async function transactDraft(
  mode: IDBTransactionMode,
  value?: CachedLaunchDraft,
): Promise<unknown> {
  const database = await openDraftDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      const request =
        mode === 'readonly' ? store.get(KEY) : store.put(value, KEY);
      const timeout = setTimeout(() => {
        try {
          transaction.abort();
        } catch {
          /* It may already be finished. */
        }
        reject(new Error(DRAFT_CACHE_ERROR));
      }, 5000);
      transaction.oncomplete = () => {
        clearTimeout(timeout);
        resolve(request.result);
      };
      transaction.onerror = transaction.onabort = () => {
        clearTimeout(timeout);
        reject(new Error(DRAFT_CACHE_ERROR));
      };
    });
  } finally {
    database.close();
  }
}

export async function readCachedLaunchDraft() {
  return decodeLaunchDraft(await transactDraft('readonly'));
}
export async function saveCachedLaunchDraft(draft: CachedLaunchDraft) {
  await transactDraft('readwrite', draft);
}

/** Serial commits prevent a slower image write from replacing newer edits. */
export function createDraftWriteQueue(
  save: (value: CachedLaunchDraft) => Promise<void> = saveCachedLaunchDraft,
  encode: (
    value: LaunchDraft,
  ) => Promise<CachedLaunchDraft> = encodeLaunchDraft,
) {
  let tail = Promise.resolve();
  return (draft: LaunchDraft): Promise<void> => {
    // Start reading a legacy object URL immediately, before it can be revoked.
    const snapshot = encode(draft);
    // Attach rejection handling now, even if an older commit is still pending.
    void snapshot.catch(() => {});
    const next = tail.then(async () => save(await snapshot));
    tail = next.catch(() => {});
    return next;
  };
}
