import { CATALOG_REFRESH_CHECK_MS } from "./catalog-snapshots.mjs";

export function createCatalogRefresher(
  adapters,
  { enabled = false, chains = [4663, 8453], intervalMs = CATALOG_REFRESH_CHECK_MS } = {},
) {
  let closed = false;
  let running = null;

  async function refresh() {
    for (const chainId of chains) {
      if (closed) break;
      try {
        await adapters.refreshCatalog(chainId);
      } catch {
        // The durable retry deadline and last valid snapshot remain authoritative.
      }
    }
  }

  function kick() {
    if (!enabled || closed || running) return;
    running = refresh().finally(() => {
      running = null;
    });
  }

  const timer = enabled ? setInterval(kick, intervalMs) : null;
  timer?.unref();

  return {
    kick,
    idle: async () => {
      await running;
    },
    stop: async () => {
      closed = true;
      clearInterval(timer);
      await running;
    },
  };
}
