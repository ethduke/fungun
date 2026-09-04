import type { ChainId, PadId } from './launch-model';
import { AppError, retrySeconds } from './user-error.ts';

const CATALOG_MAX_AGE = 6 * 60 * 60 * 1000;

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
  reason?: 'unsupported' | 'not_configured' | 'unavailable';
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
const operationRetryAt = new Map<'catalog' | 'ticker', number>();

export function localExpiry(
  expiresAt: number,
  serverTime: number,
  receivedAt: number,
  elapsed: number,
  maximum: number,
) {
  if (![expiresAt, serverTime, receivedAt, elapsed].every(Number.isFinite))
    throw new AppError('invalid_response');
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
  const key = `${kind}:${JSON.stringify(input)}`;
  const cached = records.get(key);
  if (cached && cached.expiresAt > performance.now()) return cached.data;
  if (pending.has(key)) return pending.get(key);
  const blockedUntil = Math.max(retryAt, operationRetryAt.get(kind) ?? 0);
  if (performance.now() < blockedUntil)
    throw new AppError(
      'rate_limited',
      Math.ceil((blockedUntil - performance.now()) / 1000),
    );
  const job = (async () => {
    const started = performance.now();
    const response = await fetch(`/api/${kind}`, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-fungun-intent': kind },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(24_000),
    }).catch((error: unknown) => {
      throw new AppError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'timeout'
          : 'network',
      );
    });
    if (!response.ok) {
      if (response.status === 429) {
        const seconds = retrySeconds(response.headers.get('retry-after'));
        const deadline = performance.now() + seconds * 1000;
        if (response.headers.get('x-fungun-retry-scope') === 'operation')
          operationRetryAt.set(
            kind,
            Math.max(operationRetryAt.get(kind) ?? 0, deadline),
          );
        else retryAt = Math.max(retryAt, deadline);
        const next = Math.max(retryAt, operationRetryAt.get(kind) ?? 0);
        throw new AppError(
          'rate_limited',
          Math.ceil((next - performance.now()) / 1000),
        );
      }
      throw new AppError(
        response.status === 403
          ? 'origin_denied'
          : [400, 413, 415].includes(response.status)
            ? 'invalid_request'
            : [408, 504].includes(response.status)
              ? 'timeout'
              : 'unavailable',
      );
    }
    const data = (await response.json().catch(() => {
      throw new AppError('invalid_response');
    })) as {
      serverTime: number;
      expiresAt: number;
      results?: Record<string, TickerResult>;
    };
    const received = performance.now();
    if (!data || !Number.isFinite(data.serverTime))
      throw new AppError('invalid_response');
    if (kind === 'catalog')
      data.expiresAt = localExpiry(
        data.expiresAt,
        data.serverTime,
        received,
        received - started,
        CATALOG_MAX_AGE,
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
      expiresAt: kind === 'catalog' ? data.expiresAt : received + 5000,
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
    throw new AppError('invalid_response');
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
      throw new AppError('invalid_response');
  }
  if (!catalog.pads.o1 || (chainId === 4663 && !catalog.pads.long))
    throw new AppError('invalid_response');
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
        (result.reason !== undefined &&
          !['unsupported', 'not_configured', 'unavailable'].includes(
            result.reason,
          )) ||
        (pad === 'o1' && result.status !== 'unverified') ||
        (result.status !== 'unverified' &&
          (!Number.isFinite(result.checkedAt) ||
            !Number.isFinite(result.expiresAt)))
      );
    })
  )
    throw new AppError('invalid_response');
  return value;
}

export function tickerNotice(check: TickerCheck | null) {
  if (!check) return null;
  return Object.entries(check.results)
    .map(([pad, result]) => {
      const label = pad === 'long' ? 'Long' : 'O1';
      if (result?.status !== 'unverified')
        return `${label}: reservation checked; see Launch below.`;
      if (result.reason === 'unsupported')
        return `${label}: ticker checking is not supported yet.`;
      if (result.reason === 'not_configured')
        return `${label}: live ticker checks are not connected yet.`;
      return `${label}: the ticker could not be verified. Try checking again later.`;
    })
    .join(' ');
}
