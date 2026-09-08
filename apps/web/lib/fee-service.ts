import { decodeFunctionData, encodeAbiParameters, isAddress, keccak256, parseAbi } from 'viem';
import { readStonxProfile } from './long-encoding/stonx-launch.mjs';
import type { ChainId, LaunchpadId as PadId } from './launch-model';
import { supportsChain } from './launch-model.ts';
import { AppError, retrySeconds } from './user-error.ts';
import { localExpiry } from './read-service.ts';
import { parseGasUsd, type GasUsdEstimate } from './fee-usd.ts';

export type FeePayout = {
  asset: string;
  symbol: string;
  decimals: number;
  claimableRaw: string;
};
const feeUnavailableReasons = [
  'fees_disabled',
  'provider_not_configured',
  'contracts_not_configured',
  'not_configured',
] as const;
const claimDisabledReasons = [
  'claims_disabled',
  'contract_unverified',
  'gas_oracle_not_configured',
  'nothing_to_claim',
] as const;
export type FeePosition = {
  id: string;
  target: string;
  collectionToken?: string;
  claimMode?: 'collect' | 'claim';
  payouts: FeePayout[];
  verification: 'live' | 'indexed';
  claimable: boolean;
  feeStream?: 'lp' | 'trading';
  poolFee?: number;
  tickSpacing?: number;
  poolId?: `0x${string}`;
  launchAsset?: string;
  escrowVersion?: 'current' | 'legacy';
  claimDisabledReason?: (typeof claimDisabledReasons)[number];
};
export type FeeSource = {
  address: string;
  chainId: ChainId;
  padId: PadId;
  status: 'ready' | 'partial' | 'unavailable';
  reason?: (typeof feeUnavailableReasons)[number];
  nextCursor?: string | null;
  coverage?: 'wallet_index' | 'configured_pools' | 'beneficiary_events' | 'configured_escrow' | 'beneficiary_index';
  progress?: { scannedThroughBlock: string | null; toBlock: string };
  positions: FeePosition[];
  expiresAt: number;
};
export type ClaimQuote = {
  positionId: string;
  kind: PadId;
  chainId: ChainId;
  address: string;
  target: string;
  feeStream?: 'lp' | 'trading';
  poolFee?: number;
  tickSpacing?: number;
  launchAsset?: string;
  stonxProfile?: ReturnType<typeof readStonxProfile>;
  collectionToken?: string;
  claimMode?: 'collect' | 'claim';
  escrowVersion?: 'current' | 'legacy';
  data: `0x${string}`;
  poolId?: `0x${string}`;
  payouts: FeePayout[];
  value: '0';
  gas: string;
  gasPrice: string;
  estimatedWei: string;
  gasUsd?: GasUsdEstimate | null;
  budgetWei: string;
  l1FeeWei: string;
  operatorFeeWei: string;
  expiresAt: number;
};

export const stonksClaimAbi = parseAbi(['function collectAll(address token)', 'function claim(address token)', 'event Transfer(address indexed from,address indexed to,uint256 value)', 'event PayoutClaimed(address indexed to,address indexed token,uint256 amount)']);
export const ponsClaimAbi = parseAbi([
  'function claim(uint256 amount) returns (uint256)',
  'function claimToken(address token, uint256 amount) returns (uint256)',
  'event Claimed(address indexed recipient, uint256 amount)',
  'event ClaimedToken(address indexed recipient, address indexed token, uint256 amount)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export const claimAbi = parseAbi([
  'function claimFor(address recipient, address currency)',
  'function collectFees(bytes32 poolId) returns (uint128 fees0, uint128 fees1)',
  'event Claimed(address indexed recipient, address indexed currency, address indexed destination, uint256 amount)',
  'event Release(bytes32 indexed poolId, address indexed beneficiary, uint256 fees0, uint256 fees1)',
]);
export const legacyClaimAbi = parseAbi([
  'function claim(address recipient, address currency)',
  'event Claimed(address indexed recipient, address indexed currency, uint256 amount)',
]);
export const isLockedPoolClaim = (kind: string) =>
  kind === 'long' || kind === 'longbow';
export const isPoolFeeClaim = (kind: string) => isLockedPoolClaim(kind) || kind === 'stonx';
const validPoolFee = (value: unknown): value is number => Number.isInteger(value) && typeof value === 'number' && ((value >= 0 && value <= 1000000) || value === 8388608);
const validTickSpacing = (value: unknown): value is number => Number.isInteger(value) && typeof value === 'number' && value >= 1 && value <= 32767;
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const amount = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(0|[1-9]\d{0,77})$/.test(value) &&
  BigInt(value) < 1n << 256n;
const address = (value: unknown): value is string =>
  typeof value === 'string' && isAddress(value, { strict: false });
const nonzeroAddress = (value: unknown): value is string =>
  address(value) && !/^0x0{40}$/i.test(value);
const id = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function payouts(values: FeePayout[]) {
  return (
    Array.isArray(values) &&
    values.length > 0 &&
    values.length <= 2 &&
    new Set(values.map((value) => value?.asset?.toLowerCase())).size ===
      values.length &&
    values.every(
      (value) =>
        value &&
        address(value.asset) &&
        typeof value.symbol === 'string' &&
        /^[A-Za-z0-9._-]{1,24}$/.test(value.symbol) &&
        Number.isInteger(value.decimals) &&
        value.decimals >= 0 &&
        value.decimals <= 36 &&
        (!/^0x0{40}$/i.test(value.asset) ||
          (value.symbol === 'ETH' && value.decimals === 18)) &&
        amount(value.claimableRaw),
    )
  );
}

let retryAt = 0;
const pending = new Map<string, Promise<unknown>>();
async function request(kind: 'fees' | 'claim-prepare', input: object) {
  if (performance.now() < retryAt)
    throw new AppError(
      'rate_limited',
      Math.ceil((retryAt - performance.now()) / 1000),
    );
  const key = JSON.stringify([kind, input]);
  if (pending.has(key)) return pending.get(key);
  const job = (async () => {
    const start = performance.now();
    const response = await fetch(`/api/${kind}`, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-fungun-intent': kind },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(24_000),
    }).catch(() => {
      throw new AppError('network');
    });
    if (response.status === 429) {
      retryAt = Math.max(
        retryAt,
        performance.now() +
          retrySeconds(response.headers.get('retry-after')) * 1000,
      );
      throw new AppError(
        'rate_limited',
        Math.ceil((retryAt - performance.now()) / 1000),
      );
    }
    const value = (await response.json().catch(() => {
      throw new AppError('invalid_response');
    })) as {
      error?: string;
      serverTime: number;
      expiresAt: number;
      gasUsd?: unknown;
      estimatedWei: string;
    };
    if (!response.ok) {
      const safeCodes = [
        'not_configured',
        'contract_unverified',
        'quote_expired',
        'nothing_to_claim',
        'insufficient_funds',
        'reverted',
        'gas_limit',
        'gas_limit_low',
        'fee_changed',
        'wrong_chain',
        'cursor_expired',
        'scan_limit',
      ];
      throw new AppError(
        value?.error && safeCodes.includes(value.error)
          ? value.error
          : 'unavailable',
      );
    }
    if (!value || !Number.isFinite(value.serverTime))
      throw new AppError('invalid_response');
    if (kind === 'claim-prepare')
      value.gasUsd = parseGasUsd(
        value.gasUsd,
        value.estimatedWei,
        value.serverTime,
        performance.now(),
        performance.now() - start,
      );
    value.expiresAt = localExpiry(
      value.expiresAt,
      value.serverTime,
      performance.now(),
      performance.now() - start,
      kind === 'fees' ? 45_000 : 20_000,
    );
    return value;
  })().finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

export function parseFees(
  value: unknown,
  owner: string,
  chainId: ChainId,
  padId: PadId,
): FeeSource {
  const result = value as FeeSource;
  if (
    !result ||
    !nonzeroAddress(result.address) ||
    !equal(result.address, owner) ||
    result.chainId !== chainId ||
    result.padId !== padId ||
    !['long', 'o1', 'longbow', 'pons', 'stonks', 'stonx'].includes(padId) ||
    !supportsChain(padId, chainId) ||
    (padId === 'pons' && result.status !== 'unavailable' &&
      (result.coverage !== 'configured_escrow' || result.status !== 'partial' || result.nextCursor != null)) ||
    !['ready', 'partial', 'unavailable'].includes(result.status) ||
    (result.reason !== undefined &&
      (!feeUnavailableReasons.includes(result.reason) ||
        result.status !== 'unavailable')) ||
    !Number.isFinite(result.expiresAt) ||
    (result.nextCursor != null && !id(result.nextCursor)) ||
    (result.nextCursor != null && result.status !== 'partial') ||
    (result.coverage !== undefined &&
      !['wallet_index', 'configured_pools', 'beneficiary_events', 'configured_escrow', 'beneficiary_index'].includes(
        result.coverage,
      )) ||
    (result.progress !== undefined &&
      (!result.progress ||
        !amount(result.progress.toBlock) ||
        (result.progress.scannedThroughBlock !== null &&
          (!amount(result.progress.scannedThroughBlock) ||
            BigInt(result.progress.scannedThroughBlock) >
              BigInt(result.progress.toBlock))))) ||
    !Array.isArray(result.positions) ||
    result.positions.length > 25 ||
    new Set(result.positions.map((position) => position?.id)).size !==
      result.positions.length ||
    result.positions.some(
      (position) =>
        !position ||
        !id(position.id) ||
        !nonzeroAddress(position.target) ||
        !payouts(position.payouts) ||
        (padId === 'pons' && (position.verification !== 'live' || position.payouts.length !== 1)) ||
        (padId === 'stonks' && (!nonzeroAddress(position.collectionToken) || !['collect', 'claim'].includes(position.claimMode ?? '') || position.verification !== 'live')) ||
        !['live', 'indexed'].includes(position.verification) ||
        typeof position.claimable !== 'boolean' ||
        (padId === 'stonx' && (!validPoolFee(position.poolFee) || !validTickSpacing(position.tickSpacing) || !['lp', 'trading'].includes(position.feeStream ?? '') || !nonzeroAddress(position.launchAsset)
          || !/^0x[\da-f]{64}$/i.test(position.poolId ?? '') || !equal(position.payouts[0].asset, position.launchAsset))) ||
        (isPoolFeeClaim(padId) &&
          (position.verification !== 'live' ||
            position.payouts.length !== 2)) ||
        (position.escrowVersion !== undefined &&
          (padId !== 'o1' ||
            !['current', 'legacy'].includes(position.escrowVersion))) ||
        (position.claimDisabledReason !== undefined &&
          (!claimDisabledReasons.includes(position.claimDisabledReason) ||
            position.claimable)) ||
        (position.claimable && position.verification !== 'live'),
    ) ||
    (result.status === 'unavailable' && result.positions.length) ||
    (result.status === 'ready' &&
      (result.coverage === 'configured_pools' ||
        result.positions.some((position) => position.verification !== 'live')))
  )
    throw new AppError('invalid_response');
  return result;
}

export async function loadFees(
  owner: string,
  chainId: ChainId,
  padId: PadId,
  cursor?: string,
) {
  if (cursor !== undefined && !id(cursor))
    throw new AppError('invalid_request');
  return parseFees(
    await request('fees', {
      address: owner,
      chainId,
      padId,
      ...(cursor ? { cursor } : {}),
    }),
    owner,
    chainId,
    padId,
  );
}

type FeeLookup = { chainId: ChainId; padId: PadId };
export type FeeLookupResult = FeeLookup &
  (
    | {
        source: FeeSource;
        error?: never;
        pageError?: unknown;
        scanning?: boolean;
        pages?: number;
      }
    | { source?: never; error: unknown }
  );

// Two launchpads can load together without flooding the shared RPC provider.
// Navigation/account changes stop queued work; shared in-flight reads may finish.
export async function loadFeeSources(
  owner: string,
  sources: readonly FeeLookup[],
  onResult: (result: FeeLookupResult) => void,
  isCurrent: () => boolean,
) {
  let next = 0;
  const worker = async () => {
    while (isCurrent() && next < sources.length) {
      const source = sources[next++];
      let result: FeeLookupResult;
      try {
        let page = await loadFees(owner, source.chainId, source.padId);
        let pages = 1;
        let pageError: unknown;
        const seen = new Set<string>();
        // Complete O1's bounded wallet index automatically. Long event scans can
        // span thousands of pages, so their continuation remains explicit.
        while ((source.padId === 'o1' || source.padId === 'stonx') && page.nextCursor && isCurrent()) {
          onResult({ ...source, source: page, scanning: true, pages });
          if (!isCurrent()) return;
          try {
            if (seen.has(page.nextCursor) || pages >= 512)
              throw new AppError('scan_limit');
            seen.add(page.nextCursor);
            const nextPage = await loadFees(
              owner,
              source.chainId,
              source.padId,
              page.nextCursor,
            );
            if (!isCurrent()) return;
            page = mergeFeePages(page, nextPage);
            pages++;
          } catch (error) {
            pageError = error;
            break;
          }
        }
        result = {
          ...source,
          source: page,
          pages,
          ...(pageError ? { pageError } : {}),
        };
      } catch (error) {
        result = { ...source, error };
      }
      if (isCurrent()) onResult(result);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(2, sources.length) }, worker),
  );
}

// Pages can overlap while the index changes. A shared escrow/currency position
// is one balance, never additive; replace its amount only after identity checks.
export function mergeFeePages(previous: FeeSource, page: FeeSource): FeeSource {
  if (
    !equal(previous.address, page.address) ||
    previous.chainId !== page.chainId ||
    previous.padId !== page.padId ||
    previous.coverage !== page.coverage ||
    page.status === 'unavailable'
  )
    throw new AppError('invalid_response');
  const positions = new Map(
    previous.positions.map((position) => [position.id, position]),
  );
  for (const position of page.positions) {
    const existing = positions.get(position.id);
    if (
      existing &&
      (!equal(existing.target, position.target) || existing.collectionToken !== position.collectionToken || existing.claimMode !== position.claimMode ||
        (existing.escrowVersion ?? 'current') !==
          (position.escrowVersion ?? 'current') ||
        existing.feeStream !== position.feeStream || existing.poolFee !== position.poolFee || existing.tickSpacing !== position.tickSpacing || existing.poolId !== position.poolId || existing.launchAsset !== position.launchAsset ||
        existing.payouts.length !== position.payouts.length ||
        existing.payouts.some(
          (payout, index) =>
            !equal(payout.asset, position.payouts[index].asset) ||
            payout.symbol !== position.payouts[index].symbol ||
            payout.decimals !== position.payouts[index].decimals,
        ))
    )
      throw new AppError('invalid_response');
    positions.set(position.id, position);
  }
  if (positions.size > 4096) throw new AppError('invalid_response');
  const merged = [...positions.values()];
  return {
    ...page,
    positions: merged,
    expiresAt: Math.min(previous.expiresAt, page.expiresAt),
    status:
      page.status === 'partial' ||
      page.nextCursor ||
      page.coverage === 'configured_pools' ||
      merged.some((position) => position.verification !== 'live')
        ? 'partial'
        : 'ready',
  };
}

export function validateClaim(value: unknown): ClaimQuote {
  const quote = value as ClaimQuote;
  if (
    !quote ||
    !id(quote.positionId) ||
    !['long', 'o1', 'longbow', 'pons', 'stonks', 'stonx'].includes(quote.kind) ||
    !(isLockedPoolClaim(quote.kind)
      ? quote.chainId === 4663
      : [4663, 8453].includes(quote.chainId)) ||
    (quote.kind === 'pons' && quote.chainId !== 4663) ||
    (['stonks', 'stonx'].includes(quote.kind) && quote.chainId !== 8453) ||
    !nonzeroAddress(quote.address) ||
    !nonzeroAddress(quote.target) ||
    (quote.escrowVersion !== undefined &&
      (quote.kind !== 'o1' ||
        !['current', 'legacy'].includes(quote.escrowVersion))) ||
    !payouts(quote.payouts) ||
    !quote.payouts.some((payout) => BigInt(payout.claimableRaw) > 0n) ||
    quote.value !== '0' ||
    !Number.isFinite(quote.expiresAt) ||
    ![
      quote.gas,
      quote.gasPrice,
      quote.estimatedWei,
      quote.budgetWei,
      quote.l1FeeWei,
      quote.operatorFeeWei,
    ].every(amount) ||
    BigInt(quote.gas) < 21_000n ||
    BigInt(quote.gas) > 3_000_000n ||
    BigInt(quote.gasPrice) === 0n ||
    BigInt(quote.budgetWei) < BigInt(quote.estimatedWei) ||
    typeof quote.data !== 'string' ||
    !/^0x[\da-f]+$/i.test(quote.data)
  )
    throw new AppError('invalid_response');
  if (quote.kind === 'stonx') {
    try {
      const p = readStonxProfile(quote.stonxProfile), q = p.quotes[0];
      if (p.quotes.length !== 1 || !validPoolFee(quote.poolFee) || !validTickSpacing(quote.tickSpacing) || !['lp', 'trading'].includes(quote.feeStream ?? '') || !nonzeroAddress(quote.launchAsset)
        || quote.payouts.length !== 2 || !equal(quote.payouts[0].asset, quote.launchAsset) || quote.payouts[0].decimals !== 18
        || !equal(quote.payouts[1].asset, q.token.address) || quote.payouts[1].symbol !== q.symbol || quote.payouts[1].decimals !== q.decimals
        || BigInt(quote.launchAsset) >= BigInt(q.token.address)
        || !equal(quote.target, quote.feeStream === 'lp' ? p.poolInitializer.address : p.dopplerHook.address)) throw Error();
      const expectedPool = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
        [quote.launchAsset as `0x${string}`, q.token.address, quote.poolFee, quote.tickSpacing, p.poolInitializer.address]));
      if (quote.poolId !== expectedPool) throw Error();
    } catch { throw new AppError('invalid_response'); }
  }
  if (quote.kind === 'pons') {
    if (quote.payouts.length !== 1 || quote.poolId !== undefined) throw new AppError('invalid_response');
    try {
      const decoded = decodeFunctionData({ abi: ponsClaimAbi, data: quote.data });
      const native = /^0x0{40}$/i.test(quote.payouts[0].asset);
      if (native
        ? decoded.functionName !== 'claim' || quote.data.length !== 74 || decoded.args[0] !== BigInt(quote.payouts[0].claimableRaw)
        : decoded.functionName !== 'claimToken' || quote.data.length !== 138 || !equal(decoded.args[0], quote.payouts[0].asset) || decoded.args[1] !== BigInt(quote.payouts[0].claimableRaw))
        throw new Error();
    } catch { throw new AppError('invalid_response'); }
    return quote;
  }
  let decoded;
  try {
    decoded = decodeFunctionData({
      abi: quote.kind === 'stonks' ? stonksClaimAbi : quote.escrowVersion === 'legacy' ? legacyClaimAbi : claimAbi,
      data: quote.data,
    });
  } catch {
    throw new AppError('invalid_response');
  }
  if (
    quote.kind === 'stonks'
      ? !nonzeroAddress(quote.collectionToken) || !['collect', 'claim'].includes(quote.claimMode ?? '')
        || quote.data.length !== 74 || decoded.functionName !== (quote.claimMode === 'collect' ? 'collectAll' : 'claim')
        || !equal(decoded.args[0] as string, quote.collectionToken!)
        || (quote.claimMode === 'claim' ? quote.payouts.length !== 1 || !equal(quote.collectionToken!, quote.payouts[0].asset)
          : quote.payouts.length !== 2 || !quote.payouts.some(p => equal(p.asset, quote.collectionToken!)))
      : isPoolFeeClaim(quote.kind)
      ? quote.payouts.length !== 2 ||
        decoded.functionName !== 'collectFees' ||
        quote.data.length !== 74 ||
        decoded.args[0] !== quote.poolId
      : quote.payouts.length !== 1 ||
        decoded.functionName !==
          (quote.escrowVersion === 'legacy' ? 'claim' : 'claimFor') ||
        quote.data.length !== 138 ||
        !equal(decoded.args[0], quote.address) ||
        !equal(decoded.args[1] as string, quote.payouts[0].asset)
  )
    throw new AppError('invalid_response');
  return quote;
}

export async function prepareClaim(
  owner: string,
  source: FeeSource,
  position: FeePosition,
) {
  const quote = validateClaim(
    await request('claim-prepare', { address: owner, positionId: position.id }),
  );
  if (
    !equal(quote.address, owner) ||
    quote.chainId !== source.chainId ||
    quote.kind !== source.padId ||
    quote.positionId !== position.id ||
    quote.collectionToken !== position.collectionToken || quote.claimMode !== position.claimMode ||
    !equal(quote.target, position.target) ||
    (source.padId === 'stonx' && (quote.feeStream !== position.feeStream || quote.poolFee !== position.poolFee || quote.tickSpacing !== position.tickSpacing || quote.poolId !== position.poolId || quote.launchAsset !== position.launchAsset)) ||
    (quote.escrowVersion ?? 'current') !==
      (position.escrowVersion ?? 'current') ||
    quote.payouts.length !== position.payouts.length ||
    quote.payouts.some(
      (payout, index) =>
        !equal(payout.asset, position.payouts[index].asset) ||
        payout.symbol !== position.payouts[index].symbol ||
        payout.decimals !== position.payouts[index].decimals,
    )
  )
    throw new AppError('invalid_response');
  return quote;
}
