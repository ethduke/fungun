export function isTrackedStablecoin(row, stableAssets) {
  const address = row?.meme || row?.token;
  if (typeof address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(address))
    return false;
  return (
    stableAssets?.has(
      `${Number(row.chain_id ?? 4663)}:${address.toLowerCase()}`,
    ) ?? false
  );
}
