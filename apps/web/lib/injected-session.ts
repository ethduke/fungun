import type { Config } from 'wagmi';
import { getConnection, watchConnection } from 'wagmi/actions';

const pending = new WeakMap<Config, Promise<void>>();

// Injected wallets normally emit accountsChanged. Reconcile silently as well:
// a background tab or extension reconnect can miss that event.
export function refreshWalletSession(config: Config): Promise<void> {
  const existing = pending.get(config);
  if (existing) return existing;
  const connection = getConnection(config);
  if (!connection.isConnected || !connection.connector) return Promise.resolve();
  const connector = connection.connector;
  let changed = false;
  const unwatch = watchConnection(config, { onChange: () => { changed = true; } });
  let timer: ReturnType<typeof setTimeout>;
  const job = (async () => {
    try {
      const accounts = await Promise.race([
        connector.getAccounts(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('wallet_unavailable')), 4000);
        }),
      ]);
      // A newer event or explicit disconnect always wins over an older read.
      if (changed) return;
      if (!accounts.length) connector.emitter.emit('disconnect');
      else if (accounts.map(a => a.toLowerCase()).join(',') !==
        connection.addresses?.map(a => a.toLowerCase()).join(','))
        connector.emitter.emit('change', { accounts });
    } finally {
      clearTimeout(timer!);
      unwatch();
    }
  })();
  pending.set(config, job);
  void job.finally(() => { if (pending.get(config) === job) pending.delete(config); }).catch(() => {});
  return job;
}

export function observeWalletSession(config: Config, browser: Window = window, page: Document = document) {
  let active = true;
  const refresh = () => {
    if (active && page.visibilityState === 'visible') void refreshWalletSession(config).catch(() => {});
  };
  browser.addEventListener('focus', refresh);
  page.addEventListener('visibilitychange', refresh);
  const timer = setInterval(refresh, 2000);
  refresh();
  return () => {
    active = false;
    clearInterval(timer);
    browser.removeEventListener('focus', refresh);
    page.removeEventListener('visibilitychange', refresh);
  };
}
