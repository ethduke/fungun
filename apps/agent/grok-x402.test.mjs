import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { createGrokImageGenerator } from "./grok-x402.mjs";
import { IMAGE_PRODUCT } from "../web/lib/image-generation.ts";

const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const origin = "https://images.example.invalid";
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-image-"));
  const account = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
  const now = 1800000000000;
  let signedCount = 0,
    paidPosts = 0,
    gets = 0,
    operation;
  const webp = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WEBP"),
    Buffer.alloc(20),
  ]);
  const quoteFor = (input) => ({
    x402Version: 2,
    resource: {
      url: `${origin}/api/images/grok`,
      description: "One Grok memecoin image",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:4663",
        asset: address(9),
        amount: "1000",
        payTo: address(8),
        maxTimeoutSeconds: 300,
        extra: {
          name: "Global Dollar",
          version: "1",
          symbol: "USDG",
          decimals: 6,
          assetTransferMethod: "eip3009",
          paymentFlow: "authorization",
          payer: input.wallet,
          requestId: input.requestId,
          inputHash: hash(JSON.stringify({ input, product: IMAGE_PRODUCT, origin })),
          product: IMAGE_PRODUCT,
          nonce: `0x${"12".repeat(32)}`,
          issuedAt: now,
          expiresAt: now + 300000,
        },
      },
    ],
  });
  const completed = (input) => ({
    requestId: input.requestId,
    status: "completed",
    payment: { status: "paid", transaction: `0x${"34".repeat(32)}`, network: "eip155:4663" },
    image: {
      base64: webp.toString("base64"),
      mimeType: "image/webp",
      sha256: hash(webp),
      width: 1,
      height: 1,
      filename: `${hash(webp)}.webp`,
    },
  });
  const fetcher = async (url, init) => {
    assert.equal(new URL(url).origin, origin);
    assert.equal(init.redirect, "error");
    if (init.method === "GET") {
      gets++;
      return Response.json(
        options.getResponse ? options.getResponse(operation) : completed(operation),
      );
    }
    operation = JSON.parse(init.body);
    if (init.headers["payment-signature"]) {
      paidPosts++;
      if (options.dropPaid) throw new Error("network secret detail must not escape");
      return Response.json(completed(operation));
    }
    const quote = quoteFor(operation);
    options.mutateQuote?.(quote);
    return Response.json(quote, {
      status: 402,
      headers: {
        "payment-required": Buffer.from(JSON.stringify(quote)).toString("base64"),
        ...(options.quoteRetry ? { "retry-after": "30" } : {}),
      },
    });
  };
  const config = {
    origin,
    signer: {
      address: account.address,
      signTypedData: async (payload) => {
        signedCount++;
        return account.signTypedData(payload);
      },
    },
    journalPath: join(dir, "images.sqlite"),
    paymentAsset: address(9),
    paymentRecipient: address(8),
    maxPaymentBaseUnits: "2000",
    maxDailyPaymentBaseUnits: "2000",
    fetcher,
    now: () => now,
  };
  let generator = createGrokImageGenerator(config);
  t.after(() => {
    generator.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    config,
    dir,
    call: (input) =>
      generator({
        name: "Quorvix Lantern",
        ticker: "QVXL",
        prompt: "A fictional lantern",
        intentKey: "first",
        ...input,
      }),
    restart: () => {
      generator.close();
      generator = createGrokImageGenerator(config);
    },
    counts: () => ({ signedCount, paidPosts, gets }),
    expected: webp.toString("base64"),
  };
}

test("pays once, checks image, persists recovery privately, reuses result after restart", async (t) => {
  const f = fixture(t);
  assert.equal(await f.call(), f.expected);
  f.restart();
  assert.equal(await f.call(), f.expected);
  assert.deepEqual(f.counts(), { signedCount: 1, paidPosts: 1, gets: 0 });
  assert.equal(statSync(f.config.journalPath).mode & 0o777, 0o600);
  assert(!readFileSync(f.config.journalPath).includes(Buffer.from("payment-signature")));
});

test("lost paid response only recovers by GET without a second signature or payment", async (t) => {
  const f = fixture(t, { dropPaid: true });
  await assert.rejects(f.call(), /image_request_uncertain/);
  f.restart();
  assert.equal(await f.call(), f.expected);
  assert.deepEqual(f.counts(), { signedCount: 1, paidPosts: 1, gets: 1 });
});

test("rejects changed recipient, wrong asset, oversized amount and mismatched input before signing", async (t) => {
  for (const mutateQuote of [
    (q) => {
      q.accepts[0].payTo = address(7);
    },
    (q) => {
      q.accepts[0].asset = address(7);
    },
    (q) => {
      q.accepts[0].amount = "9000";
    },
    (q) => {
      q.accepts[0].extra.inputHash = "b".repeat(64);
    },
    (q) => {
      q.accepts[0].network = "eip155:8453";
    },
  ]) {
    const f = fixture(t, { mutateQuote });
    await assert.rejects(f.call());
    assert.equal(f.counts().signedCount, 0);
  }
});

test("daily budget and stable intent survive restart", async (t) => {
  const f = fixture(t);
  await f.call();
  await assert.rejects(f.call({ ticker: "QVXY" }), /image_intent_changed/);
  await f.call({ intentKey: "second" });
  f.restart();
  await assert.rejects(f.call({ intentKey: "third" }), /image_daily_budget/);
  assert.equal(f.counts().signedCount, 2);
});

test("unresolved recovery does not repay", async (t) => {
  const f = fixture(t, {
    dropPaid: true,
    getResponse: (input) => ({
      requestId: input.requestId,
      status: "generating",
      payment: { network: "eip155:4663" },
    }),
  });
  await assert.rejects(f.call(), /image_request_uncertain/);
  await assert.rejects(f.call(), /image_job_pending/);
  assert.equal(f.counts().signedCount, 1);
});

test("Retry-After on unpaid quote never consumes a signing attempt", async (t) => {
  const f = fixture(t, { quoteRetry: true });
  await assert.rejects(f.call(), /image_retry_later/);
  assert.equal(f.counts().signedCount, 0);
  f.restart();
  await assert.rejects(f.call(), /image_retry_later/);
  assert.equal(f.counts().signedCount, 0);
});

test("stale unsigned quote rotates request before signing, then completes normally", async (t) => {
  let stale = true;
  const f = fixture(t, {
    mutateQuote: (quote) => {
      if (stale) {
        quote.accepts[0].extra.issuedAt -= 120000;
        quote.accepts[0].extra.expiresAt -= 120000;
        stale = false;
      }
    },
  });
  await assert.rejects(f.call(), /image_quote_refreshed/);
  assert.equal(f.counts().signedCount, 0);
  f.restart();
  assert.equal(await f.call(), f.expected);
  assert.equal(f.counts().signedCount, 1);
});
