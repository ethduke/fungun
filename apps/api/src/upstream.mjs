import { ServiceError, safeError } from "./errors.mjs";
import { AsyncLocalStorage } from "node:async_hooks";

const readScope = new AsyncLocalStorage();
export function checkReadDeadline() {
  if (readScope.getStore()?.signal.aborted) throw new ServiceError("upstream_unavailable");
}

export function withinReadDeadline(load, timeout = 20_000) {
  const signal = AbortSignal.timeout(timeout);
  return readScope.run({ signal }, async () => {
    let abort;
    const expired = new Promise((_, reject) => {
      abort = () => reject(new ServiceError("upstream_unavailable"));
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([Promise.resolve().then(load), expired]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  });
}

export async function readJson(response, maxBytes, retryScope = "global") {
  if (response.status === 429) {
    const value = response.headers.get("retry-after")?.trim();
    const seconds =
      value && /^\d+$/.test(value)
        ? Number(value)
        : value
          ? (Date.parse(value) - Date.now()) / 1000
          : NaN;
    const retryAfter = Math.min(
      86400,
      Math.max(5, Number.isFinite(seconds) ? Math.ceil(seconds) : 30),
    );
    await response.body?.cancel();
    throw new ServiceError("rate_limited", 429, retryAfter, retryScope);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const cursorProblem =
    response.status === 409 && /application\/(?:problem\+)?json/.test(contentType);
  if (
    (!response.ok && !cursorProblem) ||
    (!contentType.includes("application/json") && !cursorProblem)
  ) {
    await response.body?.cancel();
    throw new ServiceError("upstream_unavailable");
  }
  if (cursorProblem) maxBytes = Math.min(maxBytes, 4096);
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new ServiceError("upstream_unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ServiceError("upstream_unavailable");
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new ServiceError("upstream_unavailable");
      chunks.push(value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (cursorProblem) {
      if (["cursor_stale", "cursor_filter_mismatch"].includes(value?.code))
        throw new ServiceError("cursor_expired", 409);
      throw new ServiceError("upstream_unavailable");
    }
    return value;
  } finally {
    await reader.cancel();
  }
}

export class Upstream {
  constructor(budget, fetcher = fetch, now = Date.now) {
    this.budget = budget;
    this.fetcher = fetcher;
    this.now = now;
    this.active = 0;
    this.providers = new Map();
    this.retryAt = new Map();
    this.waiting = new Set();
  }

  checkCooldown(provider) {
    const retryAt = this.retryAt.get(provider) ?? 0;
    if (retryAt > this.now())
      throw new ServiceError(
        "rate_limited",
        429,
        Math.ceil((retryAt - this.now()) / 1000),
        "operation",
      );
  }

  available(provider) {
    return this.active < 4 && (this.providers.get(provider) ?? 0) < 2;
  }

  reserve(provider) {
    this.active += 1;
    this.providers.set(provider, (this.providers.get(provider) ?? 0) + 1);
    return () => {
      this.active -= 1;
      this.providers.set(provider, this.providers.get(provider) - 1);
      for (const entry of this.waiting) {
        if (!this.available(entry.provider)) continue;
        this.removeWaiting(entry);
        entry.resolve(this.reserve(entry.provider));
      }
    };
  }

  removeWaiting(entry) {
    this.waiting.delete(entry);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.abort);
  }

  acquire(provider, queued) {
    checkReadDeadline();
    this.checkCooldown(provider);
    if (this.available(provider)) return Promise.resolve(this.reserve(provider));
    if (!queued || this.waiting.size >= 12)
      return Promise.reject(new ServiceError("busy", 429, 5, "operation"));
    return new Promise((resolve, reject) => {
      const entry = { provider, resolve, signal: readScope.getStore()?.signal };
      entry.abort = () => {
        this.removeWaiting(entry);
        reject(new ServiceError("upstream_unavailable"));
      };
      entry.timer = setTimeout(() => {
        this.removeWaiting(entry);
        reject(new ServiceError("busy", 429, 5, "operation"));
      }, 6000);
      entry.signal?.addEventListener("abort", entry.abort, { once: true });
      this.waiting.add(entry);
    });
  }

  async json(provider, url, options = {}, maxBytes = 512 * 1024, units = 1, policy = {}) {
    // Opt in only for known read operations. Every retry passes admission and
    // budget checks again; successful requests and rate limits are never replayed.
    for (let attempt = 0; ; attempt++) {
      const release = await this.acquire(provider, policy.queue === true);
      let transient = false;
      let requested = false;
      try {
        checkReadDeadline();
        this.checkCooldown(provider);
        this.budget.upstream(provider, units);
        const operationSignal = readScope.getStore()?.signal;
        const timeoutSignal = AbortSignal.timeout(6000);
        requested = true;
        const response = await this.fetcher(url, {
          ...options,
          redirect: "error",
          signal: operationSignal
            ? AbortSignal.any([operationSignal, timeoutSignal])
            : timeoutSignal,
        });
        transient = [408, 500, 502, 503, 504].includes(response.status);
        return await readJson(response, maxBytes, "operation");
      } catch (error) {
        const safe = safeError(error);
        const scoped =
          safe.status === 429 && safe.retryScope !== "operation"
            ? new ServiceError(safe.code, 429, safe.retryAfter, "operation")
            : safe;
        if (scoped.status === 429 && requested)
          this.retryAt.set(
            provider,
            Math.max(this.retryAt.get(provider) ?? 0, this.now() + scoped.retryAfter * 1000),
          );
        transient ||=
          requested && ["TypeError", "TimeoutError", "AbortError"].includes(error?.name);
        if (!policy.retry || attempt > 0 || !transient || scoped.status === 429) throw scoped;
        checkReadDeadline();
      } finally {
        release();
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

export class ReadCache {
  constructor(now = Date.now, limit = 256) {
    this.now = now;
    this.limit = limit;
    this.entries = new Map();
    this.pending = new Map();
  }

  get(key, ttl, load) {
    const entry = this.entries.get(key);
    if (entry && entry.expires > this.now()) {
      if (!entry.error) return Promise.resolve(entry.value);
      const error =
        entry.error.status === 429
          ? new ServiceError(
              entry.error.code,
              429,
              Math.max(1, Math.ceil((entry.expires - this.now()) / 1000)),
              entry.error.retryScope,
            )
          : entry.error;
      return Promise.reject(error);
    }
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.pending.size >= 8) return Promise.reject(new ServiceError("busy", 429, 5));
    const put = (entry) => {
      this.entries.delete(key);
      while (this.entries.size >= this.limit) this.entries.delete(this.entries.keys().next().value);
      this.entries.set(key, entry);
    };
    const promise = Promise.resolve()
      .then(load)
      .then((value) => {
        put({ value, expires: this.now() + ttl });
        return value;
      })
      .catch((error) => {
        const safe = safeError(error);
        put({ error: safe, expires: this.now() + Math.max(15_000, safe.retryAfter * 1000) });
        throw safe;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
