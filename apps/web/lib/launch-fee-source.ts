export type LaunchFeeSource = { amountWei: string; kind: 'verified-contract'; contract: string; blockNumber: string };

export function parseLaunchFeeSource(raw: unknown): LaunchFeeSource {
  const value = raw as LaunchFeeSource;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'amountWei,blockNumber,contract,kind'
    || typeof value.amountWei !== 'string' || !/^(0|[1-9][0-9]{0,16})$/.test(value.amountWei) || BigInt(value.amountWei) > 5n * 10n ** 16n || value.kind !== 'verified-contract'
    || typeof value.contract !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(value.contract)
    || /^0x0{40}$/.test(value.contract)
    || typeof value.blockNumber !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.blockNumber))
    throw new Error('Invalid launch fee source');
  return value;
}
