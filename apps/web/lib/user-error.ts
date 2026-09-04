export type ErrorContext =
  | 'connect'
  | 'disconnect'
  | 'catalog'
  | 'ticker'
  | 'fees'
  | 'claim_review'
  | 'estimate'
  | 'launch'
  | 'claim';

export class AppError extends Error {
  readonly code: string;
  readonly retrySeconds?: number;

  constructor(code: string, retrySeconds?: number) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.retrySeconds = retrySeconds;
  }
}

const messages: Record<string, string> = {
  wrong_account: 'Connect the wallet that owns these fees before claiming.',
  quote_expired:
    'This estimate expired. Refresh the fees and review a new claim.',
  nothing_to_claim:
    'There are no fees to claim now. The balance may have changed; refresh the list.',
  contract_unverified:
    'This fee contract is not verified for claims here yet. No wallet request was made.',
  rejected: 'You cancelled the wallet request. Try again when you’re ready.',
  unauthorized:
    'Allow this site to connect to your account in your wallet, then try again.',
  disconnected: 'Your wallet is disconnected. Open it and reconnect.',
  wrong_chain:
    'Your wallet is on a different network. Switch to the selected network, then try again.',
  unsupported:
    'Your wallet does not support this request. Try another compatible wallet.',
  pending:
    'Your wallet is busy. Check for an open request and finish or cancel it before trying again.',
  insufficient_funds:
    'There isn’t enough ETH on the selected network for this transaction and network fees. Add ETH on that network or wait for lower fees.',
  fee_changed:
    'Network fees changed and this quote is too low. Refresh the estimate, or wait for lower fees.',
  invalid_fee:
    'The wallet’s fee settings could not be used. Restore its suggested fees and refresh the estimate.',
  gas_limit:
    'This transaction exceeds the allowed gas limit. Do not increase it blindly; review the transaction settings and estimate again.',
  gas_limit_low:
    'The proposed gas limit is too low for this transaction. Refresh the estimate instead of guessing a higher limit.',
  reverted:
    'The contract rejected this transaction. Review the launch or claim details; paying more gas won’t fix a rejected request.',
  nonce:
    'Your wallet has a pending or newer transaction. Check its activity before trying again.',
  timeout:
    'The request took too long. Check your connection and try again shortly.',
  network:
    'The service could not be reached. Check your connection and try again.',
  invalid_response:
    'The service returned data we could not verify. Nothing has been treated as a valid result. Try again later.',
  invalid_request:
    'This request could not be checked. Review your inputs and try again.',
  origin_denied:
    'This page could not access the service. Reload it from the official site and try again.',
  not_configured:
    'Live checks are not connected yet. Please try again once the service is enabled.',
};

const walletCodes: Record<number, string> = {
  4001: 'rejected',
  4100: 'unauthorized',
  4200: 'unsupported',
  4900: 'disconnected',
  4901: 'wrong_chain',
  4902: 'wrong_chain',
  [-32002]: 'pending',
  [-32005]: 'rate_limited',
};

const names: Record<string, string> = {
  UserRejectedRequestError: 'rejected',
  InsufficientFundsError: 'insufficient_funds',
  FeeCapTooLowError: 'fee_changed',
  FeeCapTooHighError: 'invalid_fee',
  TipAboveFeeCapError: 'invalid_fee',
  GasPriceTooLowError: 'fee_changed',
  IntrinsicGasTooLowError: 'gas_limit_low',
  IntrinsicGasTooHighError: 'gas_limit',
  ContractFunctionRevertedError: 'reverted',
  ExecutionRevertedError: 'reverted',
  NonceTooLowError: 'nonce',
  NonceTooHighError: 'nonce',
  ChainMismatchError: 'wrong_chain',
  ConnectorChainMismatchError: 'wrong_chain',
  ChainNotConfiguredError: 'wrong_chain',
  ProviderNotFoundError: 'disconnected',
  TimeoutError: 'timeout',
  HttpRequestError: 'network',
};

export function retrySeconds(value: string | null) {
  const seconds = value?.trim() ? Number(value) : NaN;
  return Math.min(
    86400,
    Math.max(5, Number.isFinite(seconds) ? Math.ceil(seconds) : 30),
  );
}

export function describeError(error: unknown, context: ErrorContext): string {
  let code: string | undefined;
  let wait = 30;
  const seen = new Set<unknown>();
  let current = error;
  for (
    let depth = 0;
    depth < 8 && current && typeof current === 'object' && !seen.has(current);
    depth++
  ) {
    seen.add(current);
    const entry = current as { name?: string; code?: number; cause?: unknown };
    if (current instanceof AppError) {
      code = current.code;
      wait = retrySeconds(String(current.retrySeconds ?? 30));
      break;
    }
    code =
      (typeof entry.code === 'number' ? walletCodes[entry.code] : undefined) ??
      (typeof entry.name === 'string' && Object.hasOwn(names, entry.name)
        ? names[entry.name]
        : undefined) ??
      code;
    current = entry.cause;
  }
  let message =
    code === 'rate_limited'
      ? `Too many checks right now. Try again in ${wait < 60 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}.`
      : code && Object.hasOwn(messages, code)
        ? messages[code]
        : undefined;
  if (!message) {
    const fallbacks: Record<ErrorContext, string> = {
      connect:
        'The wallet connection did not finish. Open your wallet and try again.',
      disconnect:
        'The wallet could not disconnect. You can remove this site from your wallet’s connected sites.',
      catalog: 'Pairings could not be loaded. Try refreshing them shortly.',
      ticker:
        'The ticker could not be checked. Try again shortly; availability is still unknown.',
      fees: 'Fees could not be loaded. Balances are unknown, not zero. Try refreshing shortly.',
      claim_review:
        'This claim could not be safely estimated. No wallet request was made. Refresh the fees and try again.',
      estimate:
        'The launch cost could not be estimated. Refresh the quote before continuing.',
      launch: 'The launch could not be confirmed.',
      claim: 'The fee claim could not be confirmed.',
    };
    message = fallbacks[context];
  }
  if (context === 'launch' || context === 'claim')
    message +=
      ' Check your wallet activity before retrying; a transaction may already have been sent.';
  return message;
}
