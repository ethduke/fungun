import {
  LONGBOW_PAIRS,
  LONGBOW_MARKET_TICKERS,
} from './longbow-markets.ts';
import { O1_ROBINHOOD_PAIRS, selectableO1Pairs } from './o1-markets.ts';
import { LONG_MARKET_TICKERS } from './long-encoding/long-markets.mjs';

export { LONG_MARKET_TICKERS };

export type PadId = 'long' | 'o1';
export type LaunchpadId = PadId | 'longbow';
export type ChainId = 4663 | 8453;
export type PairId =
  | 'native'
  | 'crypto-USDG'
  | 'sample-nvda'
  | 'sample-aapl'
  | 'sample-tsla'
  | `long-${(typeof LONG_MARKET_TICKERS)[number]}`
  | `longbow-${(typeof LONGBOW_MARKET_TICKERS)[number]}`
  | `rwa-${string}`;
import type { Catalog } from './read-service';
export type Route = 'rwa' | 'standard';

export interface Destination {
  id: LaunchpadId;
  selected: boolean;
  chainId: ChainId;
  route: Route;
  pairId: PairId;
  editableMetadata: boolean;
}

export interface CoinDraft {
  name: string;
  ticker: string;
  description: string;
  hasImage: boolean;
}

export function normalizeTicker(ticker: string) {
  return ticker.replace(/[^A-Za-z]/g, '').toUpperCase();
}

export function autofillCoinName(
  name: string,
  previousTicker: string,
  ticker: string,
) {
  return !name.trim() || name === previousTicker ? ticker : name;
}

export function buildGrokPrompt(name: string, ticker: string) {
  const symbol = ticker.trim();
  const coinName = name.trim() || symbol;
  const subject = coinName
    ? `a memecoin named ${JSON.stringify(coinName)}${symbol ? ` with ticker ${JSON.stringify(symbol)}` : ''}`
    : 'a memecoin';
  const text = symbol
    ? `The only text should be the ticker ${JSON.stringify(symbol)}.`
    : 'Do not include any text.';
  return `Create a bright, simple logo for ${subject}. Use bold shapes, no small details, and a square composition. ${text}`;
}

export function autofillGrokPrompt(
  previous: { name: string; ticker: string; prompt: string },
  next: { name: string; ticker: string },
) {
  if (
    previous.prompt.trim() &&
    previous.prompt !== buildGrokPrompt(previous.name, previous.ticker)
  )
    return previous.prompt;
  return next.ticker.trim() ? buildGrokPrompt(next.name, next.ticker) : '';
}

export const IMAGE_LIMIT = 2 * 1024 * 1024;
export const DESCRIPTION_LIMIT = 2000;
export const DEFAULT_CHAIN_ID: ChainId = 4663;
// Base remains in the service models but is temporarily paused in the webview.
export const ENABLED_WEBVIEW_CHAINS: readonly ChainId[] = [4663];
export function isWebviewChain(chainId: number) {
  return ENABLED_WEBVIEW_CHAINS.includes(chainId as ChainId);
}

export function launchpadName(id: LaunchpadId) {
  return { long: 'Long', o1: 'O1', longbow: 'Longbow' }[id];
}

export function readablePads(pads: LaunchpadId[]): PadId[] {
  // Long and Longbow use the same on-chain ticker reservation registry.
  return [...new Set(pads.map((pad) => pad === 'longbow' ? 'long' : pad))];
}
export function hasSharedTickerConflict(destinations: Destination[]) {
  return destinations.some(pad => pad.selected && pad.id === 'long')
    && destinations.some(pad => pad.selected && pad.id === 'longbow');
}

export function selectDestination(destinations: Destination[], destination: Destination) {
  const sharesTicker = destination.id === 'long' || destination.id === 'longbow';
  return destinations.map(pad => pad.id === destination.id ? destination
    : destination.selected && sharesTicker && (pad.id === 'long' || pad.id === 'longbow')
      ? { ...pad, selected: false } : pad);
}
export const LONG_PAIRS = LONG_MARKET_TICKERS.map((symbol) => ({
  id: `long-${symbol}` as const,
  symbol,
}));
export const DEFAULT_DESTINATIONS: Destination[] = [
  {
    id: 'long',
    selected: true,
    chainId: 4663,
    route: 'rwa',
    pairId: 'long-NVDA',
    editableMetadata: false,
  },
  {
    id: 'o1',
    selected: false,
    chainId: 4663,
    route: 'standard',
    pairId: 'native',
    editableMetadata: false,
  },
  {
    id: 'longbow',
    selected: false,
    chainId: 4663,
    route: 'rwa',
    pairId: 'longbow-NVDA',
    editableMetadata: false,
  },
];

export function chainName(id: ChainId) {
  return id === 4663 ? 'Robinhood Chain' : 'Base';
}

export function supportsChain(id: LaunchpadId, chainId: ChainId) {
  return chainId === 4663 || (id === 'o1' && chainId === 8453);
}

export function selectChain(destinations: Destination[], chainId: ChainId) {
  if (!isWebviewChain(chainId)) return destinations.map((pad) => ({ ...pad }));
  const next = destinations.map((pad) => {
    if (!supportsChain(pad.id, chainId)) return { ...pad, selected: false };
    if (pad.chainId === chainId) return { ...pad };
    return {
      ...pad,
      chainId,
      route: 'standard' as const,
      pairId: 'native' as const,
    };
  });
  if (!next.some((pad) => pad.selected)) {
    const fallback = next.find((pad) => pad.id === 'o1');
    if (fallback) fallback.selected = true;
  }
  return next;
}

export function pairingName(id: PairId) {
  if (id === 'crypto-USDG') return 'USDG';
  return id === 'native'
    ? 'ETH'
    : ([...LONG_PAIRS, ...LONGBOW_PAIRS, ...O1_ROBINHOOD_PAIRS].find(
        (pair) => pair.id === id,
      )?.symbol ?? 'Unselected');
}

export function validateDraft(
  draft: CoinDraft,
  destinations: Destination[],
  chainId?: ChainId,
  catalog?: Catalog | null,
  _now = performance.now(),
) {
  const errors: Record<string, string> = {};
  const active = destinations.filter((pad) => pad.selected);
  if (!draft.name.trim() || Array.from(draft.name.trim()).length > 50)
    errors.name = 'Use a name between 1 and 50 characters.';
  if (!/^[A-Z]{1,11}$/.test(draft.ticker))
    errors.ticker = 'Use 1–11 English letters.';
  if (new TextEncoder().encode(draft.description).length > DESCRIPTION_LIMIT)
    errors.description = 'Description must be at most 2,000 UTF-8 bytes.';
  if (!draft.hasImage) errors.image = 'Add a coin image to continue.';
  if (!active.length) errors.destinations = 'Select at least one launchpad.';
  if (hasSharedTickerConflict(destinations))
    errors.destinations = 'Choose Long or Longbow. They share a 24-hour ticker reservation.';
  if (new Set(active.map((pad) => pad.chainId)).size > 1)
    errors.destinations = 'Select launchpads on one chain at a time.';
  if (
    chainId !== undefined &&
    active.some(
      (pad) => pad.chainId !== chainId || !supportsChain(pad.id, chainId),
    )
  )
    errors.destinations = 'Choose launchpads available on the selected chain.';
  for (const pad of active) {
    if (
      (pad.id === 'long' || pad.id === 'longbow') &&
      (pad.chainId !== 4663 || pad.route !== 'rwa' || pad.editableMetadata)
    )
      errors.destinations = `${launchpadName(pad.id)} requires Robinhood Chain, RWA pairing and immutable metadata.`;
    if (pad.chainId !== 4663 && pad.chainId !== 8453)
      errors.destinations = 'Unsupported chain.';
    if (
      pad.route === 'rwa' &&
      (pad.id === 'long'
        ? !LONG_PAIRS.some((pair) => pair.id === pad.pairId)
        : pad.id === 'longbow'
          ? !LONGBOW_PAIRS.some((pair) => pair.id === pad.pairId)
          : !selectableO1Pairs(
              pad.chainId,
              catalog?.chainId === pad.chainId ? catalog.pads.o1 : undefined,
            ).some((pair) => pair.id === pad.pairId))
    )
      errors.destinations = 'Choose an available RWA pairing.';
    if (pad.route === 'standard' && pad.pairId !== 'native' && !(pad.id === 'o1' && pad.chainId === 4663 && pad.pairId === 'crypto-USDG'))
      errors.destinations = 'Choose an available crypto pairing.';
  }
  if (
    (chainId !== undefined && !isWebviewChain(chainId)) ||
    active.some((pad) => !isWebviewChain(pad.chainId))
  )
    errors.destinations = 'Base is paused. Choose Robinhood Chain.';
  return errors;
}

export function draftStatus(
  errors: Record<string, string>,
  imagePending: boolean,
) {
  if (imagePending) return 'checking';
  return Object.keys(errors).length ? 'incomplete' : 'complete';
}

export function imageKind(bytes: Uint8Array): string | null {
  const starts = (...values: number[]) =>
    values.every((value, i) => bytes[i] === value);
  const ascii = (offset: number, text: string) =>
    Array.from(text).every(
      (char, i) => bytes[offset + i] === char.charCodeAt(0),
    );
  if (
    bytes.length >= 24 &&
    starts(137, 80, 78, 71, 13, 10, 26, 10) &&
    ascii(12, 'IHDR')
  )
    return 'image/png';
  if (bytes.length >= 12 && starts(255, 216, 255)) return 'image/jpeg';
  if (bytes.length >= 30 && ascii(0, 'RIFF') && ascii(8, 'WEBP'))
    return 'image/webp';
  if (bytes.length >= 13 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')))
    return 'image/gif';
  return null;
}

export function imageFileError(size: number, mime: string, header: Uint8Array) {
  if (size === 0 || size > IMAGE_LIMIT)
    return 'Choose an image smaller than 2 MiB.';
  const detected = imageKind(header);
  let normalizedMime = mime.trim().toLowerCase();
  if (normalizedMime === 'image/jpg') normalizedMime = 'image/jpeg';
  if (normalizedMime === 'image/x-webp') normalizedMime = 'image/webp';
  const genericMime =
    !normalizedMime || normalizedMime === 'application/octet-stream';
  // File.type may come from a mislabeled extension; decoded content is authoritative.
  const rasterMime = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
  ].includes(normalizedMime);
  if (!detected || (!genericMime && !rasterMime))
    return 'Choose a valid PNG, JPEG, WebP or GIF image.';
  return null;
}
