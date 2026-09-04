import { parseUnits } from 'viem';
import { localExpiry } from './read-service.ts';

export type GasUsdEstimate = {
  amount: string;
  ethPrice: string;
  observedAt: number;
  source: 'coinbase';
  expiresAt: number;
};
const decimal = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(?:0|[1-9]\d{0,77})(?:\.\d{1,18})?$/.test(value);

export function parseGasUsd(
  value: unknown,
  estimatedWei: string,
  serverTime: number,
  receivedAt: number,
  elapsed: number,
): GasUsdEstimate | null {
  const estimate = value as GasUsdEstimate | null;
  if (
    !estimate ||
    estimate.source !== 'coinbase' ||
    !decimal(estimate.amount) ||
    !decimal(estimate.ethPrice) ||
    !/^(?:0|[1-9]\d{0,77})$/.test(estimatedWei) ||
    !Number.isSafeInteger(estimate.observedAt) ||
    estimate.observedAt <= 0 ||
    estimate.observedAt > serverTime ||
    serverTime - estimate.observedAt >= 60_000
  )
    return null;
  const price = parseUnits(estimate.ethPrice, 18);
  if (
    price <= 0n ||
    price >= 10n ** 27n ||
    parseUnits(estimate.amount, 18) !==
      (BigInt(estimatedWei) * price) / 10n ** 18n
  )
    return null;
  return {
    amount: estimate.amount,
    ethPrice: estimate.ethPrice,
    observedAt: estimate.observedAt,
    source: 'coinbase',
    expiresAt: localExpiry(
      estimate.observedAt + 60_000,
      serverTime,
      receivedAt,
      elapsed,
      60_000,
    ),
  };
}

export function formatGasUsd(
  estimate: GasUsdEstimate | null | undefined,
  now = performance.now(),
) {
  if (!estimate || now >= estimate.expiresAt) return 'USD unavailable';
  const amount = parseUnits(estimate.amount, 18);
  const cent = 10n ** 16n;
  if (amount > 0n && amount < cent) return '≈ <$0.01';
  const cents = (amount + cent / 2n) / cent;
  return `≈ $${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}
