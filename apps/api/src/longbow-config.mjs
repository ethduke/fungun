import { readLongLaunchProfile, isIndependentLongbow } from '../../web/lib/long-encoding/long-launch.mjs';
import { readLaunchTokens, launchPairId } from './launch-catalog.mjs';
import { ServiceError } from './errors.mjs';
export function readLongbowConfig(env) {
  if (env.LONGBOW_WALLET_LAUNCH !== 'true') return null;
  try {
    let profile = readLongLaunchProfile(JSON.parse(env.LONGBOW_LAUNCH_PROFILE_JSON));
    if (!isIndependentLongbow(profile)) throw new Error();
    const guards = JSON.parse(env.LONGBOW_LAUNCH_GUARDS_JSON);
    const origin = new URL(env.LAUNCH_ASSET_SERVICE_ORIGIN);
    if (origin.origin !== env.LAUNCH_ASSET_SERVICE_ORIGIN || origin.username || origin.password
      || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && /^[a-z][a-z0-9-]{0,62}\.internal$/.test(origin.hostname) && origin.port === '8790'))) throw new Error();
    const template = profile.quotes[0], guard = guards[template.id];
    const tokens = readLaunchTokens(env);
    if (tokens.length) {
      profile = readLongLaunchProfile({ ...profile, quotes: tokens.map(token => ({ id: launchPairId('longbow', token),
        token: { address: token.address, codeHash: template.token.codeHash }, decimals: 18, symbol: token.symbol, priceSource: 'robinhood' })) });
      for (const q of profile.quotes) guards[q.id] = { tokenBeacon: guard.tokenBeacon, tokenImplementation: guard.tokenImplementation };
    }
    if (env.LONGBOW_EXTRA_QUOTES_JSON) {
      const extra = JSON.parse(env.LONGBOW_EXTRA_QUOTES_JSON);
      if (!Array.isArray(extra) || extra.length > 16) throw new Error();
      profile = readLongLaunchProfile({ ...profile, quotes: [...profile.quotes, ...extra.map(({ quote }) => ({
        id: `longbow-${quote.symbol}`, token: quote.token, decimals: quote.decimals, symbol: quote.symbol, priceSource: 'market',
      }))] });
      for (const { quote, guards: additional } of extra) guards[`longbow-${quote.symbol}`] = { ...additional, symbol: quote.onchainSymbol };
    }
    for (const q of profile.quotes) {
      if (!q.id.startsWith('longbow-') || !['robinhood', 'market'].includes(q.priceSource)) throw new Error();
      const g = guards[q.id];
      const allowed = q.priceSource === 'robinhood' ? ['tokenBeacon', 'tokenImplementation']
        : ['symbol', 'tokenImplementation', 'storageSlot', 'oracle', 'oracleAggregator', 'heartbeatSeconds'];
      if (!g || Object.keys(g).some(k => !allowed.includes(k))) throw new Error();
      if (q.priceSource === 'robinhood' && (!g.tokenBeacon || !g.tokenImplementation)) throw new Error();
      if (q.priceSource === 'market' && (typeof g.symbol !== 'string' || !/^[A-Z0-9._-]{1,24}$/.test(g.symbol))) throw new Error();
      if (g.storageSlot && (!/^0x[a-f0-9]{64}$/i.test(g.storageSlot) || !g.tokenImplementation)) throw new Error();
      if (g.oracle && (!g.oracleAggregator || !Number.isInteger(g.heartbeatSeconds) || g.heartbeatSeconds < 1 || g.heartbeatSeconds > 86400)) throw new Error();
      for (const c of [g.tokenBeacon, g.tokenImplementation, g.oracle, g.oracleAggregator].filter(Boolean))
        if (Object.keys(c).sort().join(',') !== 'address,codeHash'
          || !/^0x[a-f0-9]{40}$/i.test(c.address) || /^0x0+$/i.test(c.address)
          || !/^0x[a-f0-9]{64}$/i.test(c.codeHash) || /^0x0+$/i.test(c.codeHash)) throw new Error();
    }
    return { profile, guards, assetOrigin: origin.origin };
  } catch { throw new ServiceError('long_configuration', 503); }
}
