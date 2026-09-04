import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { ServiceError } from "./errors.mjs";
import { GROK_IMAGE_PRODUCT } from "./grok-image-provider.mjs";
import { createImageWorker } from "./image-generation.mjs";
import { ImageJobStore, initializeImageJobs } from "./image-job-store.mjs";
import {
  createImageHandler,
  imagePaymentRequired,
  TRANSFER_AUTHORIZATION_TYPES,
} from "./image-service.mjs";

// Public, deterministic test keys only. No RPC, paid provider, or real payment call.
const account = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const otherAccount = privateKeyToAccount(`0x${"2".padStart(64, "0")}`);
const token = "a".repeat(64);
const USDG_ADDRESS = `0x${"5".repeat(40)}`;
const origin = "https://fungun.example";
const raw = Buffer.from("mock-provider-image");
const sanitized = Buffer.from("mock-sanitized-webp");
const imageHash = createHash("sha256").update(sanitized).digest("hex");
const config = {
  enabled: true,
  amount: "100000",
  payTo: `0x${"1".repeat(40)}`,
  asset: USDG_ADDRESS,
  domainName: "Global Dollar",
  domainVersion: "1",
  appOrigin: origin,
};
const operation = (index = 1) => ({
  requestId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  wallet: account.address.toLowerCase(),
  name: "Moon Department",
  ticker: "MOON",
  prompt: "A moon in a business suit",
});
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const decodeHeader = (response, header) =>
  JSON.parse(Buffer.from(response.headers.get(header), "base64"));

async function signedProof(job, { signer = account, authorization = {} } = {}) {
  const quote = imagePaymentRequired(job, origin);
  const accepted = quote.accepts[0];
  const auth = {
    from: job.wallet,
    to: accepted.payTo,
    value: accepted.amount,
    validAfter: String(Math.floor(job.created_at / 1000) - 60),
    validBefore: String(Math.floor(job.expires_at / 1000)),
    nonce: accepted.extra.nonce,
    ...authorization,
  };
  const signature = await signer.signTypedData({
    domain: {
      name: accepted.extra.name,
      version: accepted.extra.version,
      chainId: 4663,
      verifyingContract: accepted.asset,
    },
    types: TRANSFER_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      ...auth,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
    },
  });
  return {
    x402Version: 2,
    resource: quote.resource,
    accepted,
    payload: { signature, authorization: auth },
  };
}

function fixture(t, hooks = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "fungun-image-flow-")));
  const path = join(directory, "jobs.sqlite");
  initializeImageJobs(path);
  let currentTime = Date.UTC(2026, 8, 4, 12);
  let store;
  let worker;
  let handler;
  const events = [];
  const counts = { ready: 0, verify: 0, generate: 0, process: 0, settle: 0 };
  const settledProofs = [];
  const provider = {
    async generate(input) {
      counts.generate++;
      events.push("generate");
      await hooks.generate?.(input);
      return { bytes: raw, mime: "image/png", model: "mock-grok" };
    },
  };
  const processor = {
    async process(bytes) {
      counts.process++;
      events.push("process");
      assert.deepEqual(bytes, raw);
      await hooks.process?.(bytes);
      return { bytes: sanitized, width: 1024, height: 1024, mime: "image/webp", sha256: imageHash };
    },
  };
  const payments = {
    async ready() {
      counts.ready++;
    },
    async verify(proof, requirements) {
      counts.verify++;
      events.push("verify");
      await hooks.verify?.(proof, requirements);
      return { isValid: true, payer: proof.payload.authorization.from };
    },
    async settle(proof, requirements) {
      counts.settle++;
      events.push("settle");
      settledProofs.push(structuredClone(proof));
      await hooks.settle?.(proof, requirements);
      return {
        success: true,
        payer: proof.payload.authorization.from,
        transaction: `0x${createHash("sha256").update(requirements.extra.nonce).digest("hex")}`,
        network: requirements.network,
      };
    },
  };
  function boot() {
    store = new ImageJobStore(path, { now: () => currentTime });
    worker = createImageWorker(store, provider, processor, payments, hooks.reader);
    handler = createImageHandler(config, store, worker, payments, hooks.reader);
  }
  boot();
  t.after(async () => {
    await worker.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    counts,
    events,
    settledProofs,
    provider,
    get store() {
      return store;
    },
    get worker() {
      return worker;
    },
    advance(ms) {
      currentTime += ms;
    },
    async restart() {
      await worker.stop();
      store.close();
      boot();
    },
    post(input, proof, authToken = token) {
      return handler(
        new Request(`${origin}/v1/images/grok`, {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            "x-fungun-intent": "image-generation",
            ["authorization"]: `Bearer ${authToken}`,
            ...(proof ? { "payment-signature": encode(proof) } : {}),
          },
          body: JSON.stringify(input),
        }),
      );
    },
    get(id, authToken = token) {
      return handler(
        new Request(`${origin}/v1/images/grok/${id}`, {
          headers: {
            origin,
            "x-fungun-intent": "image-generation",
            ["authorization"]: `Bearer ${authToken}`,
          },
        }),
      );
    },
  };
}

async function quote(f, input = operation()) {
  const response = await f.post(input);
  assert.equal(response.status, 402);
  const body = await response.json();
  assert.deepEqual(decodeHeader(response, "payment-required"), body);
  return f.store.get(input.requestId);
}

test("unpaid request returns a USDG x402 quote and never verifies, generates, or settles", async (t) => {
  const f = fixture(t);
  const input = operation();
  const job = await quote(f, input);
  const terms = JSON.parse(job.requirements);
  assert.equal(terms.scheme, "exact");
  assert.equal(terms.network, "eip155:4663");
  assert.equal(terms.asset, USDG_ADDRESS);
  assert.equal(terms.amount, config.amount);
  assert.equal(terms.payTo, config.payTo);
  assert.equal(terms.extra.assetTransferMethod, "eip3009");
  assert.equal(job.product, GROK_IMAGE_PRODUCT);
  assert.equal(job.state, "awaiting_payment");
  const status = await f.get(input.requestId);
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.status, "awaiting_payment");
  assert.equal(body.image, undefined);
  await f.worker.idle();
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.counts, { ready: 1, verify: 0, generate: 0, process: 0, settle: 0 });
});

test("signed flow persists sanitized artwork before settlement and replays completed output after restart", async (t) => {
  const input = operation();
  let f;
  f = fixture(t, {
    generate() {
      assert.equal(f.store.get(input.requestId).state, "generating");
    },
    settle() {
      const job = f.store.get(input.requestId);
      assert.equal(job.state, "settlement_pending");
      assert.deepEqual(Buffer.from(job.image), sanitized);
      assert.equal(job.raw_image, null);
      assert.equal(job.image_hash, imageHash);
    },
  });
  const job = await quote(f, input);
  const proof = await signedProof(job);
  const accepted = await f.post(input, proof);
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).image, undefined);
  await f.worker.idle();
  assert.deepEqual(f.events, ["verify", "generate", "process", "settle"]);
  const completed = await f.get(input.requestId);
  assert.equal(completed.status, 200);
  const result = await completed.json();
  const payment = decodeHeader(completed, "payment-response");
  assert.equal(result.status, "completed");
  assert.equal(result.payment.status, "paid");
  assert.equal(result.payment.transaction, payment.transaction);
  assert.deepEqual(result.image, {
    base64: sanitized.toString("base64"),
    mimeType: "image/webp",
    sha256: imageHash,
    width: 1024,
    height: 1024,
    filename: `${imageHash}.webp`,
  });
  await f.restart();
  const recovered = await f.get(input.requestId);
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), result);
  assert.deepEqual(decodeHeader(recovered, "payment-response"), payment);
  const replay = await f.post(input);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), result);
  await f.worker.idle();
  assert.equal(f.counts.generate, 1);
  assert.equal(f.counts.verify, 1);
  assert.equal(f.counts.settle, 1);
  const unauthorized = await f.get(input.requestId, "b".repeat(64));
  assert.equal(unauthorized.status, 404);
  assert.deepEqual(await unauthorized.json(), { error: "image_not_found" });
});

test("concurrent identical signed requests generate and settle exactly once", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture(t, { generate: () => gate });
  const input = operation();
  const proof = await signedProof(await quote(f, input));
  try {
    const responses = await Promise.all(Array.from({ length: 3 }, () => f.post(input, proof)));
    assert.ok(responses.every((response) => response.status === 202));
    assert.equal(f.counts.generate, 1);
    assert.equal(f.counts.process, 0);
    assert.equal(f.counts.settle, 0);
    assert.equal(f.store.get(input.requestId).state, "generating");
  } finally {
    release();
  }
  await f.worker.idle();
  assert.equal(f.counts.generate, 1);
  assert.equal(f.counts.process, 1);
  assert.equal(f.counts.settle, 1);
  assert.equal((await f.get(input.requestId)).status, 200);
});

test("changed input, another payer, altered terms, and proof reuse on another job are rejected", async (t) => {
  const f = fixture(t);
  const input = operation();
  const job = await quote(f, input);
  const changed = await f.post({ ...input, prompt: "Different paid artwork" });
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: "image_request_changed" });
  const valid = await signedProof(job);
  const changedTerms = structuredClone(valid);
  changedTerms.accepted.amount = "1";
  for (const proof of [
    await signedProof(job, { signer: otherAccount }),
    await signedProof(job, { authorization: { from: otherAccount.address.toLowerCase() } }),
    await signedProof(job, { authorization: { to: otherAccount.address.toLowerCase() } }),
    await signedProof(job, { authorization: { value: "1" } }),
    changedTerms,
  ]) {
    const rejected = await f.post(input, proof);
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: "invalid_image_payment" });
  }
  const another = operation(2);
  await quote(f, another);
  const reused = await f.post(another, valid);
  assert.equal(reused.status, 400);
  assert.deepEqual(await reused.json(), { error: "invalid_image_payment" });
  assert.deepEqual(f.events, []);
  assert.equal(f.counts.verify, 0);
  assert.equal(f.counts.generate, 0);
  assert.equal(f.counts.settle, 0);
});

test("facilitator verification failure cannot start generation or settlement", async (t) => {
  const f = fixture(t, {
    verify() {
      throw new ServiceError("image_payment_invalid", 402);
    },
  });
  const input = operation();
  const proof = await signedProof(await quote(f, input));
  const result = await f.post(input, proof);
  assert.equal(result.status, 402);
  assert.deepEqual(await result.json(), { error: "image_payment_invalid" });
  await f.worker.idle();
  assert.equal(f.store.get(input.requestId).state, "awaiting_payment");
  assert.deepEqual(f.events, ["verify"]);
});

test("restart treats an interrupted generation as unknown and never calls the provider again", async (t) => {
  const f = fixture(t);
  const input = operation();
  const job = await quote(f, input);
  const proof = await signedProof(job);
  f.store.authorize(job.id, proof);
  assert.equal(f.store.claim(job.id), true);
  // Simulate a process dying after the upstream response but before saving it.
  await f.provider.generate({ name: input.name, ticker: input.ticker, prompt: input.prompt });
  assert.equal(f.store.get(job.id).state, "generating");
  await f.restart();
  const interrupted = f.store.get(job.id);
  assert.equal(interrupted.state, "unknown");
  assert.equal(interrupted.error, "image_outcome_unknown");
  assert.equal(interrupted.accounting, "not_charged");
  assert.equal(interrupted.image, null);
  for (const result of [await f.get(job.id), await f.post(input, proof)]) {
    assert.equal(result.status, 202);
    const body = await result.json();
    assert.equal(body.status, "unknown");
    assert.equal(body.image, undefined);
  }
  await f.worker.idle();
  assert.equal(f.counts.generate, 1);
  assert.equal(f.counts.process, 0);
  assert.equal(f.counts.settle, 0);
});

test("pending settlement survives restart and retries the same proof without regenerating", async (t) => {
  let f;
  f = fixture(t, {
    settle() {
      if (f.counts.settle === 1) throw new ServiceError("image_payment_outcome_unknown", 502);
    },
  });
  const input = operation();
  const proof = await signedProof(await quote(f, input));
  assert.equal((await f.post(input, proof)).status, 202);
  await f.worker.idle();
  const pending = f.store.get(input.requestId);
  assert.equal(pending.state, "settlement_pending");
  assert.equal(pending.accounting, "settlement_pending");
  assert.equal(pending.error, "image_settlement_pending");
  assert.deepEqual(Buffer.from(pending.image), sanitized);
  assert.equal(pending.raw_image, null);
  await f.restart();
  f.advance(30_000);
  const recovering = await f.get(input.requestId);
  assert.equal(recovering.status, 202);
  assert.equal((await recovering.json()).image, undefined);
  await f.worker.idle();
  const result = await f.get(input.requestId);
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.status, "completed");
  assert.equal(body.error, undefined);
  assert.equal(body.image.sha256, imageHash);
  assert.equal(f.counts.generate, 1);
  assert.equal(f.counts.process, 1);
  assert.equal(f.counts.settle, 2);
  assert.deepEqual(f.settledProofs, [proof, proof]);
});

test("nearly expired authorization is rejected before spending on a queued generation", async (t) => {
  const f = fixture(t);
  const input = operation();
  const job = await quote(f, input);
  f.store.authorize(job.id, await signedProof(job));
  f.advance(400_000);
  f.worker.kick();
  await f.worker.idle();
  const result = f.store.get(job.id);
  assert.equal(result.state, "failed");
  assert.equal(result.accounting, "not_charged");
  assert.equal(result.error, "image_quote_expired");
  assert.equal(f.counts.generate, 0);
  assert.equal(f.counts.settle, 0);
});

test("lost settlement is reconciled after restart without another settle or generation", async (t) => {
  let available = false;
  let reads = 0;
  const reader = {
    async anchor() {
      return "0x100";
    },
    async recover(proof, requirements) {
      reads++;
      assert.equal(requirements.extra.fromBlock, "0x100");
      return available
        ? {
            success: true,
            network: requirements.network,
            payer: proof.payload.authorization.from,
            transaction: `0x${"b".repeat(64)}`,
          }
        : null;
    },
  };
  const f = fixture(t, {
    reader,
    settle() {
      throw new ServiceError("image_settlement_pending", 202);
    },
  });
  const input = operation();
  const proof = await signedProof(await quote(f, input));
  await f.post(input, proof);
  await f.worker.idle();
  await f.get(input.requestId);
  await f.worker.idle();
  assert.equal(f.counts.settle, 1);
  assert.equal(reads, 1);
  assert.equal(f.store.get(input.requestId).state, "settlement_pending");
  available = true;
  await f.restart();
  f.advance(30000);
  await f.get(input.requestId);
  await f.worker.idle();
  assert.equal(f.store.get(input.requestId).state, "completed");
  assert.equal(f.counts.generate, 1);
  assert.equal(f.counts.settle, 1);
});

test("a definitive no-broadcast settlement failure closes the saved image as uncharged", async (t) => {
  const reader = {
    async anchor() {
      return "0x100";
    },
    async recover() {
      assert.fail("Definitive failures must not enter ambiguous reconciliation");
    },
  };
  const f = fixture(t, {
    reader,
    settle() {
      throw new ServiceError("image_settlement_failed", 402);
    },
  });
  const input = operation();
  const proof = await signedProof(await quote(f, input));
  await f.post(input, proof);
  await f.worker.idle();
  const result = f.store.get(input.requestId);
  assert.equal(result.state, "failed");
  assert.equal(result.accounting, "not_charged");
  assert.equal(result.error, "image_settlement_failed");
  assert.deepEqual(Buffer.from(result.image), sanitized);
  assert.equal(f.counts.generate, 1);
  assert.equal(f.counts.settle, 1);
});

test("an ambiguous settlement closes only after confirmed chain expiry", async (t) => {
  let expired = false;
  const reader = {
    async anchor() {
      return "0x100";
    },
    async recover() {
      return null;
    },
    async expired() {
      return expired;
    },
  };
  const f = fixture(t, {
    reader,
    settle() {
      throw new ServiceError("image_settlement_pending", 202);
    },
  });
  const input = operation();
  const proof = await signedProof(await quote(f, input));
  await f.post(input, proof);
  await f.worker.idle();
  assert.equal(f.store.get(input.requestId).state, "settlement_pending");
  expired = true;
  await f.get(input.requestId);
  await f.worker.idle();
  const result = f.store.get(input.requestId);
  assert.equal(result.state, "failed");
  assert.equal(result.accounting, "not_charged");
  assert.equal(result.error, "image_payment_expired");
  assert.equal(f.counts.settle, 1);
});

test("ambiguous history remains pending and surfaces operator review", async (t) => {
  const reader = {
    async anchor() {
      return "0x100";
    },
    async recover() {
      throw new ServiceError("image_settlement_review_required", 409);
    },
  };
  const f = fixture(t, {
    reader,
    settle() {
      throw new ServiceError("image_settlement_pending", 202);
    },
  });
  const input = operation();
  const proof = await signedProof(await quote(f, input));
  await f.post(input, proof);
  await f.worker.idle();
  await f.get(input.requestId);
  await f.worker.idle();
  const result = f.store.get(input.requestId);
  assert.equal(result.state, "settlement_pending");
  assert.equal(result.accounting, "settlement_pending");
  assert.equal(result.error, "image_settlement_review_required");
  assert.equal(f.counts.settle, 1);
});

test("a second store owner cannot invalidate an active generation claim", async (t) => {
  const f = fixture(t);
  const job = await quote(f);
  f.store.authorize(job.id, await signedProof(job));
  assert.equal(f.store.claim(job.id), true);
  assert.throws(() => new ImageJobStore(f.path), { code: "image_store_locked" });
  assert.equal(f.store.get(job.id).state, "generating");
});

test("an expired unused authorization recovers as not charged and cannot start generation", async (t) => {
  const f = fixture(t);
  const input = operation();
  const proof = await signedProof(await quote(f, input));
  f.advance(600001);
  const status = await (await f.get(input.requestId)).json();
  assert.equal(status.status, "failed");
  assert.equal(status.payment.status, "not_charged");
  assert.equal(status.error, "image_quote_expired");
  assert.equal((await f.post(input, proof)).status, 409);
  assert.equal(f.counts.generate, 0);
  assert.equal(f.counts.settle, 0);
});
