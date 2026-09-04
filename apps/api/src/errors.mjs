export class ServiceError extends Error {
  constructor(code, status = 503, retryAfter = 0) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function safeError(error) {
  return error instanceof ServiceError ? error : new ServiceError("unavailable");
}
