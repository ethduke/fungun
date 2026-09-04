export class ServiceError extends Error {
  constructor(code, status = 503, retryAfter = 0, retryScope = "global") {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.retryScope = retryScope;
  }
}

export function safeError(error) {
  return error instanceof ServiceError ? error : new ServiceError("unavailable");
}
