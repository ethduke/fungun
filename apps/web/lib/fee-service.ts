import { decodeFunctionData, isAddress, parseAbi } from 'viem';
import type { ChainId, PadId } from './launch-model';
import { AppError, retrySeconds } from './user-error.ts';
import { localExpiry } from './read-service.ts';

export type FeePayout = {
  asset: string;
  symbol: string;
  decimals: number;
  claimableRaw: string;
};
export type FeePosition = {
  id: string;
  target: string;
  payouts: FeePayout[];
  verification: 'live' | 'indexed';
  claimable: boolean;
};
export type FeeSource = {
  address: string;
  chainId: ChainId;
  padId: PadId;
  status: 'ready' | 'partial' | 'unavailable';
  reason?: string;
  positions: FeePosition[];
  expiresAt: number;
};
export type ClaimQuote = {
  positionId: string;
  kind: PadId;
  chainId: ChainId;
  address: string;
  target: string;
  data: `0x${string}`;
  poolId?: `0x${string}`;
  payouts: FeePayout[];
  value: '0';
  gas: string;
  gasPrice: string;
  estimatedWei: string;
  budgetWei: string;
  l1FeeWei: string;
  operatorFeeWei: string;
  expiresAt: number;
};

export const claimAbi = parseAbi([
  'function claimFor(address recipient, address currency)',
  'function collectFees(bytes32 poolId) returns (uint128 fees0, uint128 fees1)',
  'event Claimed(address indexed recipient, address indexed currency, address indexed destination, uint256 amount)',
  'event Release(bytes32 indexed poolId, address indexed beneficiary, uint256 fees0, uint256 fees1)',
]);
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const amount = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(0|[1-9]\d{0,77})$/.test(value) &&
  BigInt(value) < 1n << 256n;
const address = (value: unknown): value is string =>
  typeof value === 'string' && isAddress(value, { strict: false });
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
    })) as { error?: string; serverTime: number; expiresAt: number };
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
      ];
      throw new AppError(
        value?.error && safeCodes.includes(value.error)
          ? value.error
          : 'unavailable',
      );
    }
    if (!value || !Number.isFinite(value.serverTime))
      throw new AppError('invalid_response');
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
    !address(result.address) ||
    !equal(result.address, owner) ||
    result.chainId !== chainId ||
    result.padId !== padId ||
    !['ready', 'partial', 'unavailable'].includes(result.status) ||
    !Number.isFinite(result.expiresAt) ||
    !Array.isArray(result.positions) ||
    result.positions.length > 25 ||
    new Set(result.positions.map((position) => position?.id)).size !==
      result.positions.length ||
    result.positions.some(
      (position) =>
        !position ||
        !id(position.id) ||
        !address(position.target) ||
        !payouts(position.payouts) ||
        !['live', 'indexed'].includes(position.verification) ||
        typeof position.claimable !== 'boolean' ||
        (position.claimable && position.verification !== 'live'),
    ) ||
    (result.status === 'unavailable' && result.positions.length)
  )
    throw new AppError('invalid_response');
  return result;
}

export async function loadFees(owner: string, chainId: ChainId, padId: PadId) {
  return parseFees(
    await request('fees', { address: owner, chainId, padId }),
    owner,
    chainId,
    padId,
  );
}

export function validateClaim(value: unknown): ClaimQuote {
  const quote = value as ClaimQuote;
  if (
    !quote ||
    !id(quote.positionId) ||
    !['long', 'o1'].includes(quote.kind) ||
    quote.chainId !== (quote.kind === 'long' ? 4663 : 8453) ||
    !address(quote.address) ||
    !address(quote.target) ||
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
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: claimAbi, data: quote.data });
  } catch {
    throw new AppError('invalid_response');
  }
  if (
    quote.kind === 'long'
      ? quote.payouts.length !== 2 ||
        decoded.functionName !== 'collectFees' ||
        quote.data.length !== 74 ||
        decoded.args[0] !== quote.poolId
      : quote.payouts.length !== 1 ||
        decoded.functionName !== 'claimFor' ||
        quote.data.length !== 138 ||
        !equal(decoded.args[0], quote.address) ||
        !equal(decoded.args[1], quote.payouts[0].asset)
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
    !equal(quote.target, position.target) ||
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
