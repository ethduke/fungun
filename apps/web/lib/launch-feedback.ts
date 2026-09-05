import { AssetError, assetErrorText } from './asset-protocol.ts';
import { LaunchError, LaunchPreflightError, launchMessage } from './long-wallet.ts';

export type LaunchFeedback = { error: string; fundingError: string };
export const emptyLaunchFeedback: LaunchFeedback = { error: '', fundingError: '' };
type FeedbackAction =
  | { type: 'failure'; error: unknown }
  | { type: 'message'; message: string }
  | { type: 'clear-error' }
  | { type: 'funding-verified' };

/** A successful status read or a retry does not prove that the wallet can afford gas. */
export function launchFeedback(state: LaunchFeedback, action: FeedbackAction): LaunchFeedback {
  if (action.type === 'clear-error') return { ...state, error: '' };
  if (action.type === 'funding-verified') return { ...state, fundingError: '' };
  if (action.type === 'message') return { ...state, error: action.message };
  let cause = action.error;
  for (let depth = 0; depth < 8 && cause instanceof LaunchPreflightError; depth++) cause = cause.cause;
  const message = cause instanceof AssetError ? assetErrorText(cause) : launchMessage(cause);
  return cause instanceof LaunchError && cause.message === 'insufficient_funds'
    ? { error: '', fundingError: message }
    : { ...state, error: message };
}
