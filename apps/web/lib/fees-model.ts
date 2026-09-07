import { isAddress, formatUnits } from 'viem';
import {
  supportsChain,
  type ChainId,
  type LaunchpadId as PadId,
} from './launch-model.ts';

export const FEE_LOOKUP_DELAY = 500;
const MAX_FEE_RAW = (BigInt(1) << BigInt(256)) - BigInt(1);
export const FEE_SOURCES = [
  { padId: 'long', chainId: 4663 },
  { padId: 'o1', chainId: 4663 },
  { padId: 'longbow', chainId: 4663 },
  { padId: 'stonks', chainId: 8453 },
] as const;

export interface FeeBalance {
  padId: PadId;
  chainId: ChainId;
  asset: string;
  symbol: string;
  decimals: number;
  claimableRaw: string;
}

export function normalizeFeeAddress(input: string) {
  const value = input.trim();
  return isAddress(value) && !/^0x0{40}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

export function createFeePreview(address: string) {
  const normalized = normalizeFeeAddress(address);
  if (!normalized) throw new Error('Enter a valid wallet address.');
  return {
    address: normalized,
    mode: 'preview' as const,
    balances: [] as FeeBalance[],
    unavailableSources: FEE_SOURCES,
    claimsEnabled: false as const,
  };
}

export type FeePreview = ReturnType<typeof createFeePreview>;

export function feeQueryState(input: string, result: FeePreview | null) {
  if (!input.trim()) return 'idle';
  const address = normalizeFeeAddress(input);
  if (!address) return 'invalid';
  return result?.address === address ? 'unavailable' : 'loading';
}

export function groupFeeBalances(balances: FeeBalance[]) {
  const groups = new Map<
    string,
    {
      key: string;
      chainId: ChainId;
      symbol: string;
      decimals: number;
      amount: bigint;
      launchpads: Set<PadId>;
    }
  >();
  for (const balance of balances) {
    if (
      !['long', 'o1', 'longbow', 'stonks'].includes(balance.padId) ||
      !supportsChain(balance.padId, balance.chainId) ||
      (balance.asset !== 'native' &&
        !isAddress(balance.asset, { strict: false })) ||
      !Number.isInteger(balance.decimals) ||
      balance.decimals < 0 ||
      balance.decimals > 36 ||
      !/^(0|[1-9]\d{0,77})$/.test(balance.claimableRaw)
    )
      throw new Error('Invalid fee balance.');
    const asset = /^0x0{40}$/i.test(balance.asset)
      ? 'native'
      : balance.asset.toLowerCase();
    const key = `${balance.chainId}:${asset}`;
    const group = groups.get(key) ?? {
      key,
      chainId: balance.chainId,
      symbol: balance.symbol,
      decimals: balance.decimals,
      amount: BigInt(0),
      launchpads: new Set<PadId>(),
    };
    if (group.decimals !== balance.decimals || group.symbol !== balance.symbol)
      throw new Error('Conflicting fee asset metadata.');
    const amount = BigInt(balance.claimableRaw);
    if (amount > MAX_FEE_RAW || group.amount + amount > MAX_FEE_RAW)
      throw new Error('Fee balance exceeds supported bounds.');
    group.amount += amount;
    group.launchpads.add(balance.padId);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    key: group.key,
    chainId: group.chainId,
    symbol: group.symbol,
    claimable: formatUnits(group.amount, group.decimals),
    launchpads: [...group.launchpads],
  }));
}
