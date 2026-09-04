const text = (value) => (typeof value === 'string' ? value.trim() : '');

export function feedLaunchpad(row) {
  const raw = text(row.launchpad);
  const version = /^(?:v)?([34])$/i.exec(String(row.version ?? ''))?.[1];
  const uni = /^(?:uniswap|uni)\s*v?\s*([34])?$/i.exec(raw);
  const protocol = uni?.[1] || version;
  const venue = protocol ? `UniV${protocol}` : 'Uniswap';
  if (/^long(?: launchpad)?$/i.test(raw))
    return { label: 'Long', title: 'Long Launchpad', isLong: true };
  if (/^longbow(?: launchpad)?$/i.test(raw))
    return { label: 'Longbow', title: 'Longbow Launchpad' };
  if (/^o1(?: launchpad)?[\s·:-]+(?:migrated|migration|mig\.?)$/i.test(raw))
    return {
      label: 'O1 Mig.',
      title: `O1 migrated${protocol ? ` · ${venue}` : ''}`,
    };
  if (/^(?:o1(?: launchpad)?[\s·:-]+rwa|rwa[\s·:-]+o1)$/i.test(raw))
    return { label: 'O1 RWA', title: 'O1 stock-paired launch' };
  if (/^o1(?: launchpad)?$/i.test(raw))
    return { label: 'O1', title: 'O1 Launchpad' };
  if (uni)
    return { label: venue, title: protocol ? `Uniswap v${protocol}` : venue };
  const unidentifiedHook = /^hook:/i.test(raw);
  if (!raw || /^unknown(?: launchpad| hook)?$/i.test(raw) || unidentifiedHook)
    return {
      label: protocol ? venue : unidentifiedHook ? 'Hook' : 'Unknown',
      title: protocol
        ? `Uniswap v${protocol}${unidentifiedHook ? ' · Unidentified hook' : ''}`
        : unidentifiedHook
          ? 'Unidentified hook'
          : 'Launchpad unavailable',
    };
  return { label: raw, title: raw };
}

// Match pool provenance, never a token address, symbol, or address suffix.
export function identifyO1Launchpad(row, hooks) {
  const hook = /^hook:(0x[0-9a-f]{40})$/i.exec(text(row.launchpad))?.[1];
  if (!hook) return row.launchpad;
  const routes = hooks?.get(
    `${Number(row.chain_id ?? 4663)}:${hook.toLowerCase()}`,
  );
  if (!routes) return row.launchpad;
  if (
    routes.includes('rwa') &&
    (row.quote_kind === 'shares' || !routes.includes('standard'))
  )
    return 'O1 RWA';
  return 'O1';
}
