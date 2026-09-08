export const walletStorageKey = 'fungun.wallet';

// Keep this lightweight so returning users can restore the lazy wallet panel.
// Storage can be unavailable in private or embedded browsers.
export const walletStorage = {
  getItem(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {}
  },
  removeItem(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {}
  },
};

export function hasPreviousWalletConnection(): boolean {
  return walletStorage.getItem(`${walletStorageKey}.recentConnectorId`) !== null;
}

export function subscribeWalletSession(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}
