export type LaunchActivity = {
  phase:
    | 'idle'
    | 'active'
    | 'pending'
    | 'uncertain'
    | 'confirmed'
    | 'failed'
    | 'error';
  label: string;
  animated: boolean;
};

/** Display state only. This never signs, submits, retries, or checks a launch. */
export function launchActivity({
  busy,
  error,
  recovery,
  receiptStatus,
}: {
  busy: string;
  error: string;
  recovery: { hash: string | null } | null;
  receiptStatus?: string;
}): LaunchActivity {
  if (error) return { phase: 'error', label: '', animated: false };
  if (receiptStatus === 'confirmed')
    return { phase: 'confirmed', label: 'Coin is live', animated: false };
  if (receiptStatus === 'failed')
    return { phase: 'failed', label: 'Launch failed', animated: false };
  if (busy) return { phase: 'active', label: busy, animated: true };
  if (!recovery) return { phase: 'idle', label: '', animated: false };
  if (
    !recovery.hash ||
    (receiptStatus && !['submitted', 'confirming'].includes(receiptStatus))
  )
    return {
      phase: 'uncertain',
      label: receiptStatus === 'retryable' ? '' : 'Connecting to your launch…',
      animated: false,
    };
  return { phase: 'pending', label: 'Awaiting confirmation…', animated: true };
}
