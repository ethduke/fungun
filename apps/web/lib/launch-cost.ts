import type { ChainId, Destination, LaunchpadId } from './launch-model';
import { parseLaunchFeeSource, type LaunchFeeSource } from './launch-fee-source.ts';
import { launchpadForPair, type LongPlan } from './long-wallet.ts';

const WEI_PER_ETH = 10n ** 18n;
const MAX_AMOUNT = (1n << 256n) - 1n;
export const HIGH_NETWORK_FEE_WEI = 10n ** 16n;

export type NetworkEstimate =
  | { chainId: 4663; gasUnits: bigint; gasPriceWei: bigint }
  | {
      chainId: 8453;
      gasUnits: bigint;
      baseFeePerGasWei: bigint;
      priorityFeePerGasWei: bigint;
      maxFeePerGasWei: bigint;
      l1DataFeeWei: bigint;
      operatorFeeWei: bigint;
    };

export type CostStep = {
  kind: 'approval' | 'setup' | 'launch';
  network: NetworkEstimate;
  valueWei: bigint;
  launchpadFeeWei: bigint;
};

/** Display the gas limit actually requested from the wallet, including its buffer. */
export function longWalletCostStep(plan: Pick<LongPlan, 'transaction' | 'launchpadFeeWei'>): CostStep {
  return { kind: 'launch', valueWei: BigInt(plan.transaction.value), launchpadFeeWei: BigInt(plan.launchpadFeeWei),
    network: { chainId: 4663, gasUnits: BigInt(plan.transaction.gas), gasPriceWei: BigInt(plan.transaction.gasPrice) } };
}

export type LaunchCostQuote = {
  contextKey: string;
  chainId: ChainId;
  quotedAt: number;
  expiresAt: number;
  nativeOnly: boolean;
  pads: { id: LaunchpadId; steps: CostStep[]; launchFeeSource?: LaunchFeeSource }[];
};

export type ApproximateLaunchCost = {
  chainId: 4663; pairId: string; gasUnits: bigint; gasPriceWei: bigint;
  basis: 'recent-simulations' | 'gas-limit'; expiresAt: number;
  launchpadFeeWei: bigint; launchFeeSource: LaunchFeeSource;
};
export function parseApproximateLaunchCost(raw: unknown, started: number, pairId: string = 'long-NVDA'): ApproximateLaunchCost {
  const value = raw as Record<string, unknown>;
  if (!value || value.chainId !== 4663 || value.pairId !== pairId || typeof value.launchpadFeeWei !== 'string' || !/^(0|[1-9][0-9]{0,16})$/.test(value.launchpadFeeWei)
    || !['recent-simulations', 'gas-limit'].includes(String(value.basis))
    || typeof value.gasUnits !== 'string' || !/^\d{1,7}$/.test(value.gasUnits)
    || typeof value.gasPriceWei !== 'string' || !/^\d{1,13}$/.test(value.gasPriceWei)
    || ![value.quotedAt, value.expiresAt, value.serverTime].every(Number.isSafeInteger)) throw new Error('Invalid gas estimate');
  const gasUnits = BigInt(value.gasUnits), gasPriceWei = BigInt(value.gasPriceWei);
  const launchFeeSource = parseLaunchFeeSource(value.launchFeeSource);
  if (launchFeeSource.amountWei !== value.launchpadFeeWei) throw new Error('Invalid launch fee');
  const quoted = Number(value.quotedAt), expires = Number(value.expiresAt), server = Number(value.serverTime);
  if (gasUnits < 21000n || gasUnits > (launchpadForPair(pairId) === 'o1' ? 8000000n : 3000000n) || gasPriceWei <= 0n || gasPriceWei > 10n ** 12n
    || expires - quoted !== 300000 || server < quoted || server >= expires || !Number.isFinite(started) || started < 0)
    throw new Error('Invalid gas estimate');
  return { chainId: 4663, pairId, gasUnits, gasPriceWei, launchpadFeeWei: BigInt(value.launchpadFeeWei), launchFeeSource,
    basis: value.basis as ApproximateLaunchCost['basis'], expiresAt: started + expires - server };
}
export function approximateLaunchQuote(estimate: ApproximateLaunchCost | null, contextKey: string, now: number): LaunchCostQuote | null {
  if (!estimate || estimate.expiresAt <= now) return null;
  const gasUnits = estimate.basis === 'gas-limit' ? estimate.gasUnits
    : (estimate.gasUnits * 120n + 99n) / 100n;
  return { contextKey, chainId: 4663, quotedAt: now, expiresAt: now + 30000, nativeOnly: true,
    pads: [{ id: launchpadForPair(estimate.pairId), launchFeeSource: estimate.launchFeeSource, steps: [{ kind: 'launch', valueWei: estimate.launchpadFeeWei, launchpadFeeWei: estimate.launchpadFeeWei,
      network: { chainId: 4663, gasUnits, gasPriceWei: estimate.gasPriceWei } }] }] };
}

export type UsdRate = {
  microUsdPerEth: bigint;
  sourceLabel: string;
  quotedAt: number;
  expiresAt: number;
};

export type CostAmounts = {
  launchpadWei: bigint;
  networkWei: bigint;
  otherValueWei: bigint;
  totalWei: bigint;
  transactions: number;
};

type UnavailableReason =
  | 'not_ready'
  | 'expired'
  | 'changed'
  | 'incomplete'
  | 'invalid'
  | 'token_cost';
export type LaunchCosts = {
  pads: Partial<Record<LaunchpadId, CostAmounts>>;
  total: CostAmounts | null;
  reason?: UnavailableReason;
};

export function launchCostKey(input: {
  name: string;
  ticker: string;
  description: string;
  imageRevision: string;
  account?: string;
  walletChainId?: number;
  destinations: Destination[];
}) {
  return JSON.stringify([
    input.name,
    input.ticker,
    input.description,
    input.imageRevision,
    input.account?.toLowerCase() ?? '',
    input.walletChainId ?? null,
    input.destinations
      .filter((pad) => pad.selected)
      .map((pad) => [pad.id, pad.chainId, pad.pairId, pad.editableMetadata])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}

function amount(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_AMOUNT;
}

function fresh(quotedAt: number, expiresAt: number, now: number, ttl: number) {
  return (
    [quotedAt, expiresAt, now].every(Number.isFinite) &&
    quotedAt >= 0 &&
    quotedAt <= now &&
    expiresAt > now &&
    expiresAt - quotedAt <= ttl
  );
}

export function costRefreshDelay(
  quote: LaunchCostQuote | null | undefined,
  rate: UsdRate | null | undefined,
  observed: number,
  current: number,
) {
  if (![observed, current].every(Number.isFinite)) return null;
  const delays: number[] = [];
  for (const [snapshot, ttl] of [
    [quote, 30_000],
    [rate, 60_000],
  ] as const) {
    if (
      !snapshot ||
      ![snapshot.quotedAt, snapshot.expiresAt].every(Number.isFinite) ||
      snapshot.quotedAt < 0 ||
      snapshot.quotedAt > current ||
      snapshot.expiresAt <= snapshot.quotedAt ||
      snapshot.expiresAt - snapshot.quotedAt > ttl
    )
      continue;
    for (const time of [snapshot.quotedAt, snapshot.expiresAt])
      if (time > observed) delays.push(Math.max(0, time - current));
  }
  return delays.length ? Math.min(...delays) : null;
}

export function estimateNetworkFee(input: NetworkEstimate): bigint | null {
  if (!input || !amount(input.gasUnits) || input.gasUnits === 0n) return null;
  if (input.chainId === 4663) {
    if (!amount(input.gasPriceWei) || input.gasPriceWei === 0n) return null;
    // Nitro gas units already include the L1 posting component.
    const fee = input.gasUnits * input.gasPriceWei;
    return amount(fee) ? fee : null;
  }
  if (
    input.chainId !== 8453 ||
    ![
      input.baseFeePerGasWei,
      input.priorityFeePerGasWei,
      input.maxFeePerGasWei,
      input.l1DataFeeWei,
      input.operatorFeeWei,
    ].every(amount) ||
    input.maxFeePerGasWei < input.baseFeePerGasWei ||
    input.priorityFeePerGasWei > input.maxFeePerGasWei
  )
    return null;
  const suggested = input.baseFeePerGasWei + input.priorityFeePerGasWei;
  const effective =
    suggested < input.maxFeePerGasWei ? suggested : input.maxFeePerGasWei;
  if (effective === 0n) return null;
  const fee =
    input.gasUnits * effective + input.l1DataFeeWei + input.operatorFeeWei;
  return amount(fee) ? fee : null;
}

function emptyCosts(): CostAmounts {
  return {
    launchpadWei: 0n,
    networkWei: 0n,
    otherValueWei: 0n,
    totalWei: 0n,
    transactions: 0,
  };
}

function addCosts(total: CostAmounts, value: CostAmounts) {
  total.launchpadWei += value.launchpadWei;
  total.networkWei += value.networkWei;
  total.otherValueWei += value.otherValueWei;
  total.totalWei += value.totalWei;
  total.transactions += value.transactions;
}

export function calculateLaunchCosts(
  quote: LaunchCostQuote | null | undefined,
  selection: { contextKey: string; chainId: ChainId; pads: LaunchpadId[] },
  now: number,
): LaunchCosts {
  const unavailable = (reason: UnavailableReason): LaunchCosts => ({
    pads: {},
    total: null,
    reason,
  });
  if (!quote) return unavailable('not_ready');
  if (
    quote.contextKey !== selection.contextKey ||
    quote.chainId !== selection.chainId
  )
    return unavailable('changed');
  if (!fresh(quote.quotedAt, quote.expiresAt, now, 30_000))
    return unavailable('expired');
  if (quote.nativeOnly !== true) return unavailable('token_cost');
  if (
    ![4663, 8453].includes(quote.chainId) ||
    !Array.isArray(quote.pads) ||
    quote.pads.length > 3 ||
    !selection.pads.length ||
    selection.pads.length > 3 ||
    quote.pads.some((pad) => !pad || typeof pad !== 'object') ||
    new Set(selection.pads).size !== selection.pads.length ||
    new Set(quote.pads.map((pad) => pad.id)).size !== quote.pads.length
  )
    return unavailable('invalid');
  const pads: LaunchCosts['pads'] = {};
  const total = emptyCosts();
  padLoop: for (const pad of quote.pads) {
    if (
      !selection.pads.includes(pad.id) ||
      !['long', 'o1', 'longbow'].includes(pad.id) ||
      (pad.id !== 'o1' && quote.chainId !== 4663) ||
      !Array.isArray(pad.steps) ||
      pad.steps.length > 8 ||
      pad.steps.some((step) => !step || typeof step !== 'object') ||
      pad.steps.filter((step) => step.kind === 'launch').length !== 1
    )
      return unavailable('invalid');
    const costs = emptyCosts();
    for (const step of pad.steps) {
      if (
        !['approval', 'setup', 'launch'].includes(step.kind) ||
        step.network?.chainId !== quote.chainId ||
        !amount(step.valueWei) ||
        !amount(step.launchpadFeeWei) ||
        step.launchpadFeeWei > step.valueWei
      )
        return unavailable('invalid');
      const networkWei = estimateNetworkFee(step.network);
      if (networkWei === null) continue padLoop;
      addCosts(costs, {
        launchpadWei: step.launchpadFeeWei,
        networkWei,
        otherValueWei: step.valueWei - step.launchpadFeeWei,
        totalWei: step.valueWei + networkWei,
        transactions: 1,
      });
    }
    pads[pad.id] = costs;
    addCosts(total, costs);
    if (!amount(total.totalWei)) return unavailable('invalid');
  }
  if (selection.pads.some((id) => !pads[id]))
    return { pads, total: null, reason: 'incomplete' };
  return { pads, total };
}

export function costNotice(reason?: UnavailableReason) {
  const messages: Record<UnavailableReason, string> = {
    not_ready:
      'Review a supported launch to estimate its fee and gas.',
    expired:
      'This estimate expired. Refresh it before launching; network fees may have changed.',
    changed: 'Your launch or wallet changed. A new estimate is needed.',
    incomplete:
      'Some fees could not be estimated. The total is unavailable until every launch and required step is checked.',
    invalid:
      'The cost estimate could not be verified. Refresh it before continuing.',
    token_cost:
      'This launch includes token payments that are not priced yet. A complete total is unavailable.',
  };
  return reason
    ? messages[reason]
    : 'Estimated fees can change before confirmation. Your wallet shows the final request.';
}

export function highGasNotice(networkWei: bigint) {
  return networkWei >= HIGH_NETWORK_FEE_WEI
    ? 'High network fees: this estimate reached the 0.01 ETH warning level. Consider waiting and refreshing the estimate before launching.'
    : null;
}

export function formatEth(wei: bigint | null | undefined) {
  if (!amount(wei)) return '— ETH';
  if (wei > 0n && wei < 10n ** 10n) return '<0.00000001 ETH';
  const fraction = (wei % WEI_PER_ETH)
    .toString()
    .padStart(18, '0')
    .slice(0, 8)
    .replace(/0+$/, '');
  return `${wei / WEI_PER_ETH}${fraction ? `.${fraction}` : ''} ETH`;
}

export function formatEthBudget(wei: bigint | null | undefined) {
  if (!amount(wei)) return '— ETH';
  const precision = 10n ** 10n;
  return formatEth(((wei + precision - 1n) / precision) * precision);
}

export function formatUsd(
  wei: bigint | null | undefined,
  rate: UsdRate | null | undefined,
  now: number,
) {
  if (
    !amount(wei) ||
    !rate ||
    !amount(rate.microUsdPerEth) ||
    rate.microUsdPerEth === 0n ||
    typeof rate.sourceLabel !== 'string' ||
    !/^[A-Za-z0-9 .-]{1,40}$/.test(rate.sourceLabel) ||
    !fresh(rate.quotedAt, rate.expiresAt, now, 60_000)
  )
    return 'USD unavailable';
  const product = wei * rate.microUsdPerEth;
  const centDenominator = WEI_PER_ETH * 10_000n;
  if (product > 0n && product < centDenominator) return '≈ <$0.01';
  const cents = (product + centDenominator / 2n) / centDenominator;
  return `≈ $${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}
