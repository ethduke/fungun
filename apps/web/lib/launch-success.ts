type NoticeStorage = Pick<Storage, 'getItem' | 'setItem'>;

// Transaction identity survives route changes, draft restoration and reloads.
// Claim before displaying, so remounts cannot replay an already-shown notice.
export function claimLaunchSuccessNotice(transactionUrl: string, storage?: NoticeStorage) {
  try {
    const saved = storage ?? window.localStorage;
    const key = `fungun:launch-success:v1:${transactionUrl.toLowerCase()}`;
    if (saved.getItem(key) !== null) return false;
    saved.setItem(key, '1');
    return true;
  } catch {
    // Without durable storage, keep details available through the manual button.
    return false;
  }
}
