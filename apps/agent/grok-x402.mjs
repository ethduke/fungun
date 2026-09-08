import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isAddress, recoverTypedDataAddress } from "viem";
import {
  newImageRecovery,
  validateImageQuoteInput,
  imageAuthorizationTypes,
  generatedImageBlob,
} from "../web/lib/image-generation.ts";

const fail = (code) => {
  throw new Error(code);
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const uint = (value) => typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value);
const safeOrigin = (value) => {
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || url.protocol !== "https:")
      fail("image_origin_invalid");
    return url.origin;
  } catch {
    return fail("image_origin_invalid");
  }
};
async function json(response) {
  if (response.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
    fail("image_response_invalid");
  const reader = response.body?.getReader();
  if (!reader) fail("image_response_invalid");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 3 * 1024 * 1024) fail("image_response_too_large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks));
  } catch {
    return fail("image_response_invalid");
  } finally {
    await reader.cancel();
  }
}

/** Local-only EIP-3009 signer. No prompt, no private key upload, no automatic repayment. */
export function createGrokImageGenerator({
  origin,
  signer,
  journalPath,
  paymentAsset,
  paymentRecipient,
  maxPaymentBaseUnits,
  maxDailyPaymentBaseUnits,
  fetcher = fetch,
  now = Date.now,
}) {
  safeOrigin(origin);
  if (
    !signer ||
    !isAddress(signer.address) ||
    typeof signer.signTypedData !== "function" ||
    !isAddress(paymentAsset) ||
    !isAddress(paymentRecipient) ||
    /^0x0+$/i.test(paymentAsset) ||
    /^0x0+$/i.test(paymentRecipient) ||
    !uint(maxPaymentBaseUnits) ||
    !uint(maxDailyPaymentBaseUnits) ||
    BigInt(maxPaymentBaseUnits) > BigInt(maxDailyPaymentBaseUnits) ||
    typeof journalPath !== "string" ||
    !journalPath ||
    journalPath === ":memory:"
  )
    fail("image_config_invalid");
  mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
  try {
    const stat = lstatSync(journalPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      fail("image_journal_permissions");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const fd = openSync(
    journalPath,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  closeSync(fd);
  chmodSync(journalPath, 0o600);
  const db = new DatabaseSync(journalPath);
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS image_agent_jobs (
      key TEXT PRIMARY KEY, context TEXT NOT NULL, input TEXT NOT NULL, capability TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'new', amount INTEGER NOT NULL DEFAULT 0,
      day TEXT, output TEXT, retry_at INTEGER NOT NULL DEFAULT 0
    );`);
  let active = false;
  const row = (key) => db.prepare("SELECT * FROM image_agent_jobs WHERE key=?").get(key);
  const saveOutput = async (key, raw, input) => {
    if (!raw || raw.requestId !== input.requestId || raw.payment?.network !== "eip155:4663")
      fail("image_response_invalid");
    if (raw.status === "completed") {
      const blob = await generatedImageBlob(raw);
      const image = Buffer.from(await blob.arrayBuffer()).toString("base64");
      db.prepare("UPDATE image_agent_jobs SET state='completed',output=? WHERE key=?").run(
        image,
        key,
      );
      return image;
    }
    if (["failed", "unknown"].includes(raw.status)) {
      db.prepare("UPDATE image_agent_jobs SET state='terminal' WHERE key=?").run(key);
      fail("image_job_terminal");
    }
    fail("image_job_pending");
  };
  async function request(record, method, proof) {
    if (record.retry_at > now()) fail("image_retry_later");
    const input = JSON.parse(record.input);
    let response;
    try {
      response = await fetcher(
        `${origin}/api/images/grok${method === "GET" ? `/${input.requestId}` : ""}`,
        {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(45000),
          headers: {
            origin,
            "content-type": "application/json",
            "x-fungun-intent": "image-generation",
            ["authorization"]: `Bearer ${record.capability}`,
            ...(proof
              ? { "payment-signature": Buffer.from(JSON.stringify(proof)).toString("base64") }
              : {}),
          },
          ...(method === "POST" ? { body: record.input } : {}),
        },
      );
    } catch {
      fail("image_request_uncertain");
    }
    const retry = Number(response.headers.get("retry-after"));
    if (Number.isFinite(retry) && retry > 0)
      db.prepare("UPDATE image_agent_jobs SET retry_at=? WHERE key=?").run(
        now() + Math.min(retry, 86400) * 1000,
        record.key,
      );
    const raw = await json(response);
    return { response, raw };
  }
  const rotateUnpaid = (record) => {
    const saved = JSON.parse(record.input);
    const fresh = newImageRecovery(saved);
    const changed = db
      .prepare(
        "UPDATE image_agent_jobs SET input=?,capability=?,retry_at=0 WHERE key=? AND state='new' AND input=?",
      )
      .run(JSON.stringify(fresh.input), fresh.token, record.key, record.input);
    if (changed.changes !== 1) fail("image_job_pending");
    fail("image_quote_refreshed");
  };
  const generate = async ({ name, ticker, prompt, intentKey }) => {
    if (active) fail("image_job_busy");
    active = true;
    try {
      if (typeof intentKey !== "string" || !intentKey || intentKey.length > 256)
        fail("image_intent_invalid");
      const context = JSON.stringify({
        origin,
        wallet: signer.address.toLowerCase(),
        name,
        ticker,
        prompt,
        paymentAsset: paymentAsset.toLowerCase(),
        paymentRecipient: paymentRecipient.toLowerCase(),
      });
      const key = sha(intentKey);
      let record = row(key);
      if (record && record.context !== context) fail("image_intent_changed");
      if (!record) {
        const recovery = newImageRecovery({ wallet: signer.address, name, ticker, prompt });
        db.exec("BEGIN IMMEDIATE");
        try {
          if (db.prepare("SELECT count(*) AS n FROM image_agent_jobs").get().n >= 1000)
            fail("image_journal_full");
          db.prepare(
            "INSERT OR IGNORE INTO image_agent_jobs (key,context,input,capability) VALUES (?,?,?,?)",
          ).run(key, context, JSON.stringify(recovery.input), recovery.token);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        record = row(key);
        if (record.context !== context) fail("image_intent_changed");
      }
      if (record.state === "completed") return record.output;
      if (record.state === "terminal") fail("image_job_terminal");
      const input = JSON.parse(record.input);
      if (record.state === "submitted") {
        const { response, raw } = await request(record, "GET");
        if (!response.ok) fail("image_recovery_unavailable");
        return await saveOutput(key, raw, input);
      }
      // Repeating an unpaid quote request uses the same durable request and capability.
      const { response, raw } = await request(record, "POST");
      if (response.status !== 402) {
        if (response.ok) return await saveOutput(key, raw, input);
        if (response.status === 409 && raw?.error === "image_quote_expired") rotateUnpaid(record);
        fail("image_quote_unavailable");
      }
      let header;
      try {
        const encoded = response.headers.get("payment-required");
        if (!encoded || encoded.length > 16000) fail("image_quote_invalid");
        header = JSON.parse(Buffer.from(encoded, "base64").toString());
      } catch {
        fail("image_quote_invalid");
      }
      if (JSON.stringify(header) !== JSON.stringify(raw)) fail("image_quote_invalid");
      const quote = await validateImageQuoteInput(raw, input, origin);
      const terms = quote.accepts[0];
      if (terms.extra.expiresAt - now() < 240000) rotateUnpaid(record);
      if (row(key).retry_at > now()) fail("image_retry_later");
      if (
        !same(terms.asset, paymentAsset) ||
        !same(terms.payTo, paymentRecipient) ||
        BigInt(terms.amount) > BigInt(maxPaymentBaseUnits) ||
        terms.extra.issuedAt > now() + 5000 ||
        terms.extra.expiresAt - now() < 240000
      )
        fail("image_payment_not_allowed");
      const authorization = {
        from: input.wallet,
        to: terms.payTo,
        value: terms.amount,
        validAfter: String(Math.floor(terms.extra.issuedAt / 1000) - 60),
        validBefore: String(Math.floor(terms.extra.expiresAt / 1000)),
        nonce: terms.extra.nonce,
      };
      const payload = {
        domain: {
          name: terms.extra.name,
          version: terms.extra.version,
          chainId: 4663,
          verifyingContract: terms.asset,
        },
        types: imageAuthorizationTypes,
        primaryType: "TransferWithAuthorization",
        message: {
          ...authorization,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
        },
      };
      // Commit the payment reservation BEFORE signing. Any interrupted attempt recovers by GET only.
      db.exec("BEGIN IMMEDIATE");
      try {
        const latest = row(key);
        if (latest.state !== "new" || latest.input !== record.input) fail("image_job_pending");
        const day = new Date(now()).toISOString().slice(0, 10);
        const spent = db
          .prepare("SELECT COALESCE(SUM(amount),0) AS n FROM image_agent_jobs WHERE day=?")
          .get(day).n;
        if (BigInt(spent) + BigInt(terms.amount) > BigInt(maxDailyPaymentBaseUnits))
          fail("image_daily_budget");
        db.prepare("UPDATE image_agent_jobs SET state='submitted',amount=?,day=? WHERE key=?").run(
          Number(terms.amount),
          day,
          key,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      let signature;
      try {
        signature = await signer.signTypedData(payload);
        if (!same(await recoverTypedDataAddress({ ...payload, signature }), signer.address))
          fail("image_signer_mismatch");
      } catch {
        fail("image_signing_failed");
      }
      const proof = {
        x402Version: 2,
        resource: quote.resource,
        accepted: terms,
        payload: { signature, authorization },
      };
      const paid = await request(row(key), "POST", proof);
      if (!paid.response.ok) fail("image_payment_uncertain");
      return await saveOutput(key, paid.raw, input);
    } finally {
      active = false;
    }
  };
  generate.close = () => {
    if (active) fail("image_job_busy");
    db.close();
  };
  return generate;
}
