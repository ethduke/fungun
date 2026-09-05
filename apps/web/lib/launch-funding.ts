import { formatUnits } from 'viem';

export type LaunchFunding = { chainId: 4663; balanceWei: string; requiredWei: string;
  shortfallWei: string; basis: 'simulation' | 'gas-limit' };

export function parseLaunchFunding(raw: unknown): LaunchFunding | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const value = raw as LaunchFunding;
  if (Object.keys(value).sort().join(',') !== 'balanceWei,basis,chainId,requiredWei,shortfallWei'
    || value.chainId !== 4663 || !['simulation', 'gas-limit'].includes(value.basis)
    || [value.balanceWei, value.requiredWei, value.shortfallWei].some(amount =>
      typeof amount !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(amount))) return;
  const balance = BigInt(value.balanceWei), required = BigInt(value.requiredWei);
  if (balance >= required || required > 5n * 10n ** 16n
    || required - balance !== BigInt(value.shortfallWei)) return;
  return value;
}

export function fundingMessage(value: LaunchFunding) {
  const eth = (amount: string) => `${formatUnits(BigInt(amount), 18)} ETH`;
  return `You have ${eth(value.balanceWei)} on Robinhood Chain. ${value.basis === 'gas-limit'
    ? 'Allow up to' : 'This launch needs'} ${eth(value.requiredWei)}${value.basis === 'simulation' ? ' including the gas buffer' : ' for gas'}; add ${eth(value.shortfallWei)}.`;
}
