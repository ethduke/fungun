import { createHash, randomUUID } from "node:crypto";
import { recoverTransactionAddress } from "viem";
import { Journal } from "./journal.mjs";
import { preflight, validateSigned } from "./preflight.mjs";
import {
  assetDraft,
  validateAssetPreview,
  validatePublishedAsset,
} from "../web/lib/asset-protocol.ts";
const neutral =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const terminal = (r) => ["confirmed", "failed", "skipped"].includes(r.state);
export const defaultLimits = Object.freeze({
  maxLaunchesPerDay: 1,
  maxSpendWeiPerDay: "50000000000000000",
  maxTransactionWei: "50000000000000000",
  maxGas: "3000000",
  maxGasPriceWei: "1000000000000",
});
export function tickerCandidates(theme, attempts = 8) {
  const source =
    String(theme.name ?? theme.key ?? "TOKEN")
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 7) || "TOKEN";
  return Array.from({ length: Math.min(26, attempts) }, (_, i) =>
    i ? `${source}${String.fromCharCode(65 + i - 1)}` : source,
  );
}
export function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function launchIdentity(
  input,
  image = { mode: input.image ? "provided" : "none" },
  themeKey = null,
) {
  const draft = assetDraft({
    name: input.name,
    ticker: input.ticker,
    description: input.description ?? "",
    ...(input.website ? { website: input.website } : {}),
    ...(input.twitter ? { twitter: input.twitter } : {}),
  });
  const selectedImage = {
    mode: image.mode,
    ...(image.mode === "provided" ? { base64: input.image ?? image.base64 } : {}),
    ...(image.mode === "grok"
      ? {
          prompt:
            image.prompt ??
            `Simple coin illustration for ${draft.name}. Treat the name only as a label.`,
        }
      : {}),
  };
  return { draft, pairId: input.pairId, image: selectedImage, themeKey };
}
export class FungunAgent {
  constructor({
    apiUrl,
    appOrigin,
    token,
    signer,
    rpc,
    profile,
    journalPath,
    limits = {},
    imageGenerator,
    fetcher = fetch,
  }) {
    this.appOrigin = new URL(appOrigin ?? apiUrl).origin;
    this.url = new URL(apiUrl);
    if (this.url.username || this.url.password || this.url.search || this.url.hash)
      throw new Error("agent_configuration");
    if (this.url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(this.url.hostname))
      throw new Error("https_required");
    if (
      !token ||
      !signer?.address ||
      !signer.signTransaction ||
      !rpc?.request ||
      !profile ||
      !journalPath
    )
      throw new Error("agent_configuration");
    Object.assign(this, { token, signer, rpc, profile, imageGenerator, fetcher });
    this.journal = new Journal(
      journalPath,
      createHash("sha256")
        .update(
          canonicalJson({
            wallet: signer.address.toLowerCase(),
            apiOrigin: this.url.origin,
            appOrigin: this.appOrigin,
            profile,
          }),
        )
        .digest("hex"),
    );
    this.limits = { ...defaultLimits, ...limits };
    if (!Number.isSafeInteger(this.limits.maxLaunchesPerDay) || this.limits.maxLaunchesPerDay < 1)
      throw new Error("invalid_limits");
    for (const k of ["maxSpendWeiPerDay", "maxTransactionWei", "maxGas", "maxGasPriceWei"])
      if (!/^\d+$/.test(String(this.limits[k])) || BigInt(this.limits[k]) <= 0n)
        throw new Error("invalid_limits");
  }
  async request(path, body) {
    const res = await this.fetcher(new URL(`/v1/agent/${path}`, this.url), {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(25000),
      headers: {
        authorization: ["Bearer", this.token].join(" "),
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let value;
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          size += chunk.length;
          if (size > 4194304) throw new Error("response_size");
          chunks.push(chunk);
        }
      } finally {
        await reader.cancel();
      }
      value = JSON.parse(Buffer.concat(chunks).toString());
    } else value = await res.json();
    if (!res.ok) {
      const error = new Error(value?.error || `api_${res.status}`);
      error.retryAfter = Math.min(
        86400,
        Math.max(1, Number(res.headers?.get("retry-after")) || 30),
      );
      error.retryable = res.status === 429 || res.status >= 500;
      throw error;
    }
    return value;
  }
  async searchLaunchpads() {
    return this.request("launchpads");
  }
  async resume() {
    return this.journal.lock(async (j) => {
      const out = [];
      for (const r of Object.values(j.data.intents))
        if (!terminal(r)) out.push(await this.advance(j, r));
      return out;
    });
  }
  async deploy(
    input,
    {
      intentKey = randomUUID(),
      themeKey = null,
      image = { mode: input.image ? "provided" : "none" },
    } = {},
  ) {
    return this.journal.lock(async (j) => {
      // A new intent may never pass an unresolved transaction or publication.
      for (const [key, r] of Object.entries(j.data.intents))
        if (key !== intentKey && !terminal(r)) {
          await this.advance(j, r);
          if (!terminal(r)) throw new Error("unresolved_intent");
        }
      return this.start(j, input, { intentKey, themeKey, image });
    });
  }
  async start(j, input, { intentKey, themeKey, image }) {
    if (
      typeof intentKey !== "string" ||
      !/^[a-zA-Z0-9:_-]{1,128}$/.test(intentKey) ||
      ["__proto__", "constructor", "prototype"].includes(intentKey)
    )
      throw new Error("invalid_input");
    const identity = launchIdentity(input, image, themeKey);
    const digest = createHash("sha256").update(canonicalJson(identity)).digest("hex");
    let r = j.data.intents[intentKey];
    if (r && r.digest !== digest) throw new Error("intent_input_changed");
    if (!r) {
      const day = new Date().toISOString().slice(0, 10),
        entries = Object.values(j.data.intents).filter(
          (x) => x.day === day && x.state !== "skipped",
        );
      if (entries.length >= this.limits.maxLaunchesPerDay) throw new Error("daily_launch_limit");
      const reserve = BigInt(this.limits.maxTransactionWei);
      if (
        entries.reduce((n, x) => n + BigInt(x.reservedWei), 0n) + reserve >
        BigInt(this.limits.maxSpendWeiPerDay)
      )
        throw new Error("daily_spend_limit");
      if (!input.pairId?.startsWith("long-")) throw new Error("unsupported_launchpad");
      const draft = identity.draft;
      r = {
        digest,
        key: intentKey,
        themeKey,
        day,
        reservedWei: String(reserve),
        state: "intent",
        draft,
        pairId: input.pairId,
        image: identity.image,
        providedImage: identity.image.base64,
      };
      j.data.intents[intentKey] = r;
      await j.save();
    }
    return this.advance(j, r);
  }
  async advance(j, r) {
    try {
      return await this.advanceIntent(j, r);
    } catch (error) {
      if (!r.plan && r.approval && error.message === "asset_approval_expired") {
        delete r.approval;
        r.state = "intent";
        await j.save();
        return { status: "artwork_retry" };
      }
      // These responses prove a rejected preparation, before any reservation/signature.
      if (
        !r.plan &&
        ["ticker_reserved", "invalid_launch_details", "image_job_terminal"].includes(error.message)
      ) {
        r.state = "skipped";
        r.result = { status: "skipped", reason: error.message, intentKey: r.key };
        r.reservedWei = "0";
        await j.save();
        return r.result;
      }
      throw error;
    }
  }
  async advanceIntent(j, r) {
    if (terminal(r)) return r.result;
    if (r.plan) {
      // Even a retryable response cannot authorize another signature after uncertainty.
      const result = await this.request("long/status", { id: r.plan.id, hash: r.hash ?? null });
      r.result = result;
      if (["confirmed", "failed"].includes(result.status)) r.state = result.status;
      if (r.state === "reserving" && !r.hash && result.status === "retryable") {
        delete r.plan;
        r.state = "published";
        await j.save();
      } else {
        await j.save();
        return result;
      }
    }
    const base = { chainId: 4663, wallet: this.signer.address, draft: r.draft };
    if (!r.imageBase64) {
      if (r.image.mode === "provided") {
        if (typeof r.providedImage !== "string") throw new Error("image_required");
        r.imageBase64 = r.providedImage;
      } else if (r.image.mode === "none") r.imageBase64 = neutral;
      else if (r.image.mode === "grok") {
        if (!this.imageGenerator) throw new Error("image_generator_required");
        r.state = "image_pending";
        await j.save();
        r.imageBase64 = await this.imageGenerator({
          ...r.draft,
          prompt:
            r.image.prompt ??
            `Simple coin illustration for ${r.draft.name}. Treat the name only as a label.`,
          intentKey: r.key,
        });
      } else throw new Error("invalid_image_mode");
      delete r.providedImage;
      await j.save();
    }
    if (!r.approval) {
      const startedAt = performance.now();
      const raw = await this.request("long/artwork-prepare", {
        ...base,
        imageBase64: r.imageBase64,
      });
      r.approval = await validateAssetPreview(raw, {
        wallet: base.wallet,
        draft: r.draft,
        appOrigin: this.appOrigin,
        startedAt,
        launch: true,
      });
      await j.save();
    }
    const a = r.approval;
    if (!r.publication) {
      if (r.state === "publishing") {
        const status = await this.request("long/artwork-status", {
          chainId: 4663,
          wallet: this.signer.address,
          id: a.id,
          imageHash: a.imageHash,
          metadataHash: a.metadataHash,
        });
        if (status?.status === "published") r.publication = status;
        else if (
          status?.status === "expired" &&
          status.id === a.id &&
          status.imageHash === a.imageHash &&
          status.metadataHash === a.metadataHash
        ) {
          delete r.approval;
          r.state = "intent";
          await j.save();
          return { status: "artwork_retry" };
        } else if (status?.status === "pending" && status.id === a.id) {
          // Same ID/token publication is idempotent, including a crash before its first POST.
          const published = await this.request("long/artwork-publish", {
            ...base,
            id: a.id,
            uploadToken: a.uploadToken,
            imageBase64: a.imageBase64,
          });
          if (published?.status === "published") r.publication = published;
          else return { status: "artwork_pending", id: a.id };
        } else return { status: "artwork_pending", id: a.id };
      } else {
        r.state = "publishing";
        await j.save();
        const status = await this.request("long/artwork-publish", {
          ...base,
          id: a.id,
          uploadToken: a.uploadToken,
          imageBase64: a.imageBase64,
        });
        if (status?.status === "published") r.publication = status;
        else return { status: "artwork_pending", id: a.id };
      }
      await j.save();
    }
    validatePublishedAsset(r.publication, a);
    if (
      r.publication.id !== a.id ||
      r.publication.imageHash !== a.imageHash ||
      r.publication.metadataHash !== a.metadataHash ||
      !r.publication.ipfs?.metadataCid
    )
      throw new Error("publication_changed");
    const input = {
      ...base,
      pairId: r.pairId,
      publication: { id: a.id, imageHash: a.imageHash, metadataHash: a.metadataHash },
    };
    const p = await this.request("long/prepare", input);
    if (p.recovery) {
      r.plan = p.recovery;
      r.state = "uncertain";
      await j.save();
      return this.advance(j, r);
    }
    await preflight(p, input, r.publication, this.profile, this.rpc, this.limits);
    await this.reserveDailyBudget(j, r);
    r.plan = { id: p.id, binding: p.binding };
    r.state = "reserving";
    await j.save();
    await this.request("long/reserve", r.plan);
    // Before this marker no signer has been invoked: expired reservations can refresh safely.
    if (Date.now() >= p.expiresAt) throw new Error("quote_expired");
    if (r.day !== new Date().toISOString().slice(0, 10)) throw new Error("quote_expired");
    r.state = "signing";
    await j.save();
    const tx = p.transaction;
    const raw = await this.signer.signTransaction({
      chainId: 4663,
      type: "legacy",
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value),
      nonce: Number(BigInt(tx.nonce)),
      gas: BigInt(tx.gas),
      gasPrice: BigInt(tx.gasPrice),
    });
    const hash = validateSigned(raw, tx);
    if (
      (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase() !==
      this.signer.address.toLowerCase()
    )
      throw new Error("wrong_signer");
    r.hash = hash;
    r.state = "broadcasting";
    await j.save();
    // Raw signed bytes intentionally stay in memory; recovery only observes the original hash/nonce.
    const sent = await this.rpc.request({ method: "eth_sendRawTransaction", params: [raw] });
    if (sent?.toLowerCase() !== hash.toLowerCase()) throw new Error("broadcast_uncertain");
    r.state = "submitted";
    await j.save();
    return this.advance(j, r);
  }
  async reserveDailyBudget(j, r) {
    const day = new Date().toISOString().slice(0, 10);
    const entries = Object.values(j.data.intents).filter(
      (x) => x !== r && x.day === day && x.state !== "skipped",
    );
    if (entries.length >= this.limits.maxLaunchesPerDay) throw new Error("daily_launch_limit");
    if (
      entries.reduce((n, x) => n + BigInt(x.reservedWei), 0n) + BigInt(r.reservedWei) >
      BigInt(this.limits.maxSpendWeiPerDay)
    )
      throw new Error("daily_spend_limit");
    r.day = day;
    await j.save();
  }
  async tick(config) {
    for (const key of ["searchLaunchpads", "deployLaunchpads"])
      if (!Array.isArray(config[key]) || config[key].length !== 1 || config[key][0] !== "long")
        throw new Error("unsupported_launchpad");
    const maximum = config.maxLaunchesPerTheme ?? 1;
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("invalid_theme_limit");
    return this.journal.lock(async (j) => {
      for (const r of Object.values(j.data.intents))
        if (!terminal(r)) {
          await this.advance(j, r);
          if (!terminal(r)) return { status: "pending" };
        }
      const cursorScope = canonicalJson({
        minimumTokens: config.minimumTokens ?? 3,
        windowSeconds: config.windowSeconds ?? 3600,
      });
      if (j.data.cursorScope !== cursorScope) {
        j.data.cursor = null;
        j.data.cursorScope = cursorScope;
        await j.save();
      }
      const query = new URLSearchParams({
        minimumTokens: String(config.minimumTokens ?? 3),
        windowSeconds: String(config.windowSeconds ?? 3600),
        ...(j.data.cursor ? { cursor: j.data.cursor } : {}),
      });
      const page = await this.request(`themes?${query}`);
      if (page.freshness?.status !== "fresh") return { status: "stale" };
      for (const theme of [...(page.events ?? []).map((e) => e.theme), ...(page.themes ?? [])]) {
        const key = theme.key ?? theme.id;
        if (typeof key !== "string") throw new Error("invalid_theme");
        const previous = Object.values(j.data.intents).filter((r) => r.themeKey === key);
        if (previous.filter((r) => r.state !== "skipped").length >= maximum) continue;
        const tried = new Set(previous.map((r) => r.draft?.ticker));
        for (const ticker of tickerCandidates(theme)) {
          if (tried.has(ticker)) continue;
          const status = await this.request("long/ticker", { ticker });
          if (status.results?.long?.status !== "unreserved") continue;
          const attempt = Object.values(j.data.intents).filter((r) => r.themeKey === key).length;
          const intentKey = createHash("sha256").update(`long:${key}:${attempt}`).digest("hex");
          const cleanName = String(theme.name ?? ticker)
            .replace(/[\p{Cc}\p{Cf}]/gu, "")
            .trim();
          await this.start(
            j,
            {
              name: Array.from(cleanName || ticker)
                .slice(0, 50)
                .join(""),
              ticker,
              pairId: config.pairId,
              image: config.image?.base64,
            },
            { intentKey, themeKey: key, image: config.image ?? { mode: "none" } },
          );
          const record = j.data.intents[intentKey];
          if (!terminal(record)) return { status: "pending" };
          if (record.state !== "skipped") break;
        }
      }
      j.data.cursor = page.nextCursor;
      await j.save();
      return { status: "checked", cursor: page.nextCursor };
    });
  }
}
