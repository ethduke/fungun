export class ServiceError extends Error {
  constructor(code, status = 503, retryAfter = 0, retryScope = "global") {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.retryScope = retryScope;
  }
}

export class InsufficientFundsError extends ServiceError {
  constructor(balance, required, basis = "simulation") {
    super("insufficient_funds", 409);
    this.funding = { chainId: 4663, balanceWei: balance.toString(), requiredWei: required.toString(),
      shortfallWei: (required - balance).toString(), basis };
  }
}
export function serviceErrorBody(error) {
  const safe = safeError(error);
  return { error: safe.code, ...(safe instanceof InsufficientFundsError ? { funding: safe.funding } : {}) };
}

export function safeError(error) {
  return error instanceof ServiceError ? error : new ServiceError("unavailable");
}
