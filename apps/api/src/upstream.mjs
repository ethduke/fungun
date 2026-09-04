import { ServiceError, safeError } from "./errors.mjs";

export async function readJson(response, maxBytes) {
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
  constructor(budget, fetcher = fetch) {
    this.budget = budget;
    this.fetcher = fetcher;
    this.active = 0;
    this.providers = new Map();
  }

  async json(provider, url, options = {}, maxBytes = 512 * 1024, units = 1) {
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
    if (entry && entry.expires > this.now())
      return entry.error ? Promise.reject(entry.error) : Promise.resolve(entry.value);
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
