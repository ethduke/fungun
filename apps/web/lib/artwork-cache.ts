import { readAssetRecovery, type AssetRecovery, type AssetStorage } from './asset-client.ts';

const cacheKey = 'fungun.artwork-history.v1';
export const ARTWORK_CACHE_TTL = 24 * 60 * 60 * 1000;
const maximumEntries = 20;
type Entry = { sourceKey: string; savedAt: number; ticket: AssetRecovery };

/** Small, optional cache of published IDs; never store upload capabilities or image bytes here. */
export function artworkHistory(storage: AssetStorage, origin: string, walletHash: string, now: number): Entry[] {
  try {
    const raw = storage.getItem(cacheKey);
    if (!raw || raw.length > 48000) return [];
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length > maximumEntries) return [];
    return entries.flatMap((entry): Entry[] => {
      try {
        if (!entry || Object.keys(entry).sort().join(',') !== 'savedAt,sourceKey,ticket'
          || typeof entry.sourceKey !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sourceKey)
          || !Number.isSafeInteger(entry.savedAt) || entry.savedAt > now
          || now - entry.savedAt >= ARTWORK_CACHE_TTL) return [];
        const ticket = readAssetRecovery({ getItem: () => JSON.stringify(entry.ticket) }, origin);
        return ticket?.ipfs && ticket.walletHash === walletHash ? [{ sourceKey: entry.sourceKey, savedAt: entry.savedAt, ticket }] : [];
      } catch { return []; }
    }).sort((a, b) => b.savedAt - a.savedAt);
  } catch { return []; }
}

export function rememberArtwork(storage: AssetStorage, sourceKey: string, ticket: AssetRecovery, now: number) {
  try {
    const entries = artworkHistory(storage, ticket.appOrigin, ticket.walletHash, now);
    const existing = entries.find(entry => entry.sourceKey === sourceKey && entry.ticket.id === ticket.id);
    const entry = existing ?? { sourceKey, ticket, savedAt: now };
    storage.setItem(cacheKey, JSON.stringify([entry, ...entries.filter(item => item.sourceKey !== sourceKey)]
      .slice(0, maximumEntries)));
  } catch { /* Optional cache failure must not interrupt a completed publication. */ }
}

export function forgetArtwork(storage: AssetStorage, sourceKey: string, origin: string, walletHash: string, now: number) {
  try {
    storage.setItem(cacheKey, JSON.stringify(artworkHistory(storage, origin, walletHash, now)
      .filter(entry => entry.sourceKey !== sourceKey)));
  } catch { /* The server still verifies every cached ID. */ }
}
