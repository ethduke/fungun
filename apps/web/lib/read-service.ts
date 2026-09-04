import type { ChainId, PadId } from './launch-model';

export type CatalogPair = { id: `rwa-${string}`; symbol: string };
export type CatalogPad = {
  status: 'ready' | 'unavailable';
  pairs: CatalogPair[];
};
export type Catalog = {
  chainId: ChainId;
  expiresAt: number;
  pads: Partial<Record<PadId, CatalogPad>>;
};
export type TickerResult = {
  status: 'unreserved' | 'reserved' | 'unverified';
  checkedAt?: number;
  expiresAt?: number;
};
export type TickerCheck = {
  chainId: ChainId;
  ticker: string;
  results: Partial<Record<PadId, TickerResult>>;
};

export function tickerKey(chainId: ChainId, ticker: string, pads: PadId[]) {
  return JSON.stringify([chainId, ticker, [...pads].sort()]);
}

export function tickerLabel(result?: TickerResult, now = performance.now()) {
  if (!result) return 'Not checked';
  if (result.status === 'unverified') return 'Unverified';
  if (!result.expiresAt || result.expiresAt <= now) return 'Check again';
  return result.status === 'unreserved' ? 'Unreserved' : 'Reserved';
}

const records = new Map<string, { expiresAt: number; data: unknown }>();
const pending = new Map<string, Promise<unknown>>();
let retryAt = 0;

export function localExpiry(
  expiresAt: number,
  serverTime: number,
  receivedAt: number,
  elapsed: number,
  maximum: number,
) {
  if (![expiresAt, serverTime, receivedAt, elapsed].every(Number.isFinite))
    throw new Error('Invalid response time.');
  return (
    receivedAt +
    Math.max(0, Math.min(maximum, expiresAt - serverTime) - elapsed)
  );
}

export function expiryDelay(
  expiries: (number | undefined)[],
  observed: number,
  current: number,
) {
  const pending = expiries.filter(
    (value): value is number => Number.isFinite(value) && value! > observed,
  );
  return pending.length ? Math.max(0, Math.min(...pending) - current) : null;
}

async function request(kind: 'catalog' | 'ticker', input: object) {
  if (performance.now() < retryAt)
    throw new Error('Please wait before checking again.');
  const key = `${kind}:${JSON.stringify(input)}`;
  const cached = records.get(key);
  if (cached && cached.expiresAt > performance.now()) return cached.data;
  if (pending.has(key)) return pending.get(key);
  const job = (async () => {
    const started = performance.now();
    const response = await fetch(`/api/${kind}`, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-fungun-intent': kind },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(24_000),
    });
    if (!response.ok) {
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        retryAt =
          performance.now() +
          Math.min(
            86400,
            Math.max(5, Number.isFinite(seconds) ? seconds : 30),
          ) *
            1000;
      }
      throw new Error('Read service unavailable. Try again later.');
    }
    const data = (await response.json()) as {
      serverTime: number;
      expiresAt: number;
      results?: Record<string, TickerResult>;
    };
    const received = performance.now();
    if (!data || !Number.isFinite(data.serverTime))
      throw new Error('Invalid response time.');
    if (kind === 'catalog')
      data.expiresAt = localExpiry(
        data.expiresAt,
        data.serverTime,
        received,
        received - started,
        300_000,
      );
    else if (data.results && typeof data.results === 'object')
      for (const result of Object.values(data.results) as TickerResult[])
        if (result?.status !== 'unverified')
          result.expiresAt = localExpiry(
            result.expiresAt!,
            data.serverTime,
            received,
            received - started,
            15_000,
          );
    if (records.size >= 32) records.delete(records.keys().next().value!);
    records.set(key, {
      data,
      expiresAt: received + (kind === 'catalog' ? 15_000 : 5000),
    });
    return data;
  })().finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

export function parseCatalog(value: unknown, chainId: ChainId): Catalog {
  const catalog = value as Catalog;
  if (
    !catalog ||
    catalog.chainId !== chainId ||
    !Number.isFinite(catalog.expiresAt) ||
    !catalog.pads ||
    typeof catalog.pads !== 'object'
  )
    throw new Error('Invalid catalog.');
  for (const [pad, entry] of Object.entries(catalog.pads)) {
    if (
      !['long', 'o1'].includes(pad) ||
      (chainId === 8453 && pad === 'long') ||
      !entry ||
      !['ready', 'unavailable'].includes(entry.status) ||
      !Array.isArray(entry.pairs) ||
      entry.pairs.length > 1000 ||
      entry.pairs.some(
        (pair) =>
          !pair ||
          typeof pair.id !== 'string' ||
          !/^rwa-[a-f0-9]{24}$/.test(pair.id) ||
          typeof pair.symbol !== 'string' ||
          !/^[A-Za-z0-9._-]{1,24}$/.test(pair.symbol),
      )
    )
      throw new Error('Invalid catalog.');
  }
  if (!catalog.pads.o1 || (chainId === 4663 && !catalog.pads.long))
    throw new Error('Incomplete catalog.');
  return catalog;
}

export async function loadCatalog(chainId: ChainId) {
  return parseCatalog(await request('catalog', { chainId }), chainId);
}

export async function checkTicker(
  chainId: ChainId,
  ticker: string,
  pads: PadId[],
): Promise<TickerCheck> {
  const value = (await request('ticker', {
    chainId,
    ticker,
    pads: [...pads].sort(),
  })) as TickerCheck;
  if (
    !value ||
    value.chainId !== chainId ||
    value.ticker !== ticker ||
    !value.results ||
    Object.keys(value.results).length !== pads.length ||
    pads.some((pad) => {
      const result = value.results[pad];
      return (
        !result ||
        !['unreserved', 'reserved', 'unverified'].includes(result.status) ||
        (pad === 'o1' && result.status !== 'unverified') ||
        (result.status !== 'unverified' &&
          (!Number.isFinite(result.checkedAt) ||
            !Number.isFinite(result.expiresAt)))
      );
    })
  )
    throw new Error('Invalid ticker result.');
  return value;
}
