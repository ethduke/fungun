export type PadId = 'long' | 'o1';
export type ChainId = 4663 | 8453;
export type PairId = 'native' | 'sample-nvda' | 'sample-aapl' | 'sample-tsla';
export type Route = 'rwa' | 'standard';

export interface Destination {
  id: PadId;
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

export const IMAGE_LIMIT = 2 * 1024 * 1024;
export const DESCRIPTION_LIMIT = 2000;
export const SAMPLE_PAIRS = [
  { id: 'sample-nvda', symbol: 'NVDA', label: 'NVIDIA' },
  { id: 'sample-aapl', symbol: 'AAPL', label: 'Apple' },
  { id: 'sample-tsla', symbol: 'TSLA', label: 'Tesla' },
] as const;

export const DEFAULT_DESTINATIONS: Destination[] = [
  {
    id: 'long',
    selected: true,
    chainId: 4663,
    route: 'rwa',
    pairId: 'sample-nvda',
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
];

export function chainName(id: ChainId) {
  return id === 4663 ? 'Robinhood Chain' : 'Base';
}

export function pairingName(id: PairId) {
  return id === 'native'
    ? 'Native / standard'
    : (SAMPLE_PAIRS.find((pair) => pair.id === id)?.symbol ?? 'Unselected');
}

export function validateDraft(draft: CoinDraft, destinations: Destination[]) {
  const errors: Record<string, string> = {};
  const active = destinations.filter((pad) => pad.selected);
  if (!draft.name.trim() || Array.from(draft.name.trim()).length > 50)
    errors.name = 'Use a name between 1 and 50 characters.';
  if (
    !draft.ticker ||
    Array.from(draft.ticker).length > 11 ||
    /\s/.test(draft.ticker)
  )
    errors.ticker = 'Use 1–11 characters, without spaces.';
  else if (
    active.some((pad) => pad.id === 'long') &&
    !/^[A-Z]+$/.test(draft.ticker)
  )
    errors.ticker = 'Long requires uppercase letters A–Z only.';
  if (new TextEncoder().encode(draft.description).length > DESCRIPTION_LIMIT)
    errors.description = 'Description must be at most 2,000 UTF-8 bytes.';
  if (!draft.hasImage) errors.image = 'Add a coin image to continue.';
  if (!active.length) errors.destinations = 'Select at least one launchpad.';
  for (const pad of active) {
    if (
      pad.id === 'long' &&
      (pad.chainId !== 4663 || pad.route !== 'rwa' || pad.editableMetadata)
    )
      errors.destinations =
        'Long requires Robinhood Chain, RWA pairing and immutable metadata.';
    if (pad.chainId !== 4663 && pad.chainId !== 8453)
      errors.destinations = 'Unsupported chain.';
    if (
      pad.route === 'rwa' &&
      !SAMPLE_PAIRS.some((pair) => pair.id === pad.pairId)
    )
      errors.destinations = 'Choose a sample RWA pairing.';
    if (pad.route === 'standard' && pad.pairId !== 'native')
      errors.destinations = 'Standard launches require native pairing.';
  }
  return errors;
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
  const normalizedMime = mime === 'image/jpg' ? 'image/jpeg' : mime;
  if (!detected || (normalizedMime && detected !== normalizedMime))
    return 'Choose a valid PNG, JPEG, WebP or GIF image.';
  return null;
}
