import { ServiceError, safeError } from "./errors.mjs";

export async function readJson(response, maxBytes) {
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
    throw new ServiceError("rate_limited", 429, retryAfter);
  }
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel();
    throw new ServiceError("upstream_unavailable");
  }
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
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  }

  async json(provider, url, options = {}, maxBytes = 512 * 1024, units = 1) {
    const retryAt = this.retryAt.get(provider) ?? 0;
    if (retryAt > this.now())
      throw new ServiceError("rate_limited", 429, Math.ceil((retryAt - this.now()) / 1000));
    if (this.active >= 4 || (this.providers.get(provider) ?? 0) >= 2)
      throw new ServiceError("busy", 429, 5);
    this.budget.upstream(provider, units);
    this.active += 1;
    this.providers.set(provider, (this.providers.get(provider) ?? 0) + 1);
    try {
      const response = await this.fetcher(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(6000),
      });
      return await readJson(response, maxBytes);
    } catch (error) {
      const safe = safeError(error);
      if (safe.status === 429)
        this.retryAt.set(
          provider,
          Math.max(this.retryAt.get(provider) ?? 0, this.now() + safe.retryAfter * 1000),
        );
      throw safe;
    } finally {
      this.active -= 1;
      this.providers.set(provider, this.providers.get(provider) - 1);
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
