import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import sharp from "sharp";
import { assetHash } from "../../web/lib/asset-protocol.ts";
import {
  generatedImageBlob,
  IMAGE_PRODUCT,
  newImageRecovery,
  readImageRecovery,
  requestImage,
  saveImageRecovery,
  validateImageQuote,
  validateImageQuoteInput,
} from "../../web/lib/image-generation.ts";
import { signImagePayment } from "../../web/lib/image-wallet.ts";
import { createImageProxy } from "../../web/lib/image-proxy.ts";

const origin = "https://web.example.test";
Object.defineProperty(globalThis, "location", { value: { origin }, configurable: true });
const asset = `0x${"1".padStart(40, "0")}`;
const payTo = `0x${"2".padStart(40, "0")}`;
async function setup() {
  const account = privateKeyToAccount(generatePrivateKey());
  const record = newImageRecovery({
    wallet: account.address,
    name: "Moon",
    ticker: "MOON",
    prompt: "A happy moon.",
  });
  const input = record.input;
  const now = Date.now();
  const quote = {
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
        asset,
        amount: "100000",
        payTo,
        maxTimeoutSeconds: 300,
        extra: {
          assetTransferMethod: "eip3009",
          paymentFlow: "authorization",
          name: "Global Dollar",
          version: "1",
          symbol: "USDG",
          decimals: 6,
          payer: input.wallet,
          requestId: input.requestId,
          inputHash: await assetHash(
            new TextEncoder().encode(JSON.stringify({ input, product: IMAGE_PRODUCT, origin })),
          ),
          product: IMAGE_PRODUCT,
          nonce: `0x${"a".repeat(64)}`,
          issuedAt: now,
          expiresAt: now + 300000,
        },
      },
    ],
  };
  const calls = [];
  const provider = {
    async request({ method, params }) {
      calls.push(method);
      if (method === "eth_accounts") return [account.address];
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_signTypedData_v4") {
        assert.equal(params[0].toLowerCase(), input.wallet);
        return account.signTypedData(JSON.parse(params[1]));
      }
      assert.fail(`Unexpected wallet request ${method}`);
    },
  };
  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
    removeItem: (key) => records.delete(key),
  };
  return { account, record, quote, provider, calls, records, storage };
}
const mutateTerms = (quote, changes) => ({
  ...quote,
  accepts: [{ ...quote.accepts[0], ...changes }],
});

test("same-origin image proxy preserves x402 headers and rejects a different configured token", async () => {
  const { record, quote } = await setup();
  quote.accepts[0].extra.fromBlock = "0x100";
  await validateImageQuoteInput(quote, record.input, origin);
  const encoded = Buffer.from(JSON.stringify(quote)).toString("base64");
  const config = {
    appOrigin: origin,
    serviceOrigin: "https://assets.example.test",
    paymentAsset: asset,
    production: true,
  };
  let calls = 0;
  const proxy = createImageProxy(
    () => config,
    async (_url, init) => {
      calls++;
      assert.equal(init.headers.authorization, `Bearer ${record.token}`);
      assert.equal(init.headers.origin, origin);
      assert.equal(init.headers.cookie, undefined);
      assert.equal(init.redirect, "error");
      return Response.json(quote, { status: 402, headers: { "payment-required": encoded } });
    },
  );
  const request = () =>
    new Request(`${origin}/api/images/grok`, {
      method: "POST",
      body: JSON.stringify(record.input),
      headers: {
        origin,
        "content-type": "application/json",
        "x-fungun-intent": "image-generation",
        ["authorization"]: `Bearer ${record.token}`,
        cookie: "EXAMPLE",
      },
    });
  const quoted = await proxy(request());
  assert.equal(quoted.status, 402);
  assert.equal(quoted.headers.get("payment-required"), encoded);
  assert.equal(quoted.headers.get("cache-control"), "no-store");
  config.paymentAsset = payTo;
  assert.equal((await proxy(request())).status, 503);
  const denied = request();
  denied.headers.set("origin", "https://other.example.test");
  assert.equal((await proxy(denied)).status, 403);
  assert.equal(calls, 2);
});
const mutateExtra = (quote, changes) =>
  mutateTerms(quote, { extra: { ...quote.accepts[0].extra, ...changes } });
const state = (record, status, accounting, extra = {}) => ({
  requestId: record.input.requestId,
  status,
  payment: { status: accounting, transaction: null, network: "eip155:4663" },
  ...extra,
});

test("malformed quote shapes and unrelated brief hashes cannot make any wallet call", async () => {
  const { record, quote, provider, calls } = await setup();
  const invalidQuotes = [
    null,
    { ...quote, accepts: [null] },
    { ...quote, accepts: { 0: quote.accepts[0], length: 1 } },
    { ...quote, resource: null },
    {
      ...quote,
      resource: { ...quote.resource, url: "https://other.example.test/api/images/grok" },
    },
    { ...quote, resource: { ...quote.resource, description: "Unexpected resource" } },
    mutateTerms(quote, { amount: 100000 }),
    mutateTerms(quote, { amount: "oops" }),
    mutateTerms(quote, { amount: "10000001" }),
    mutateTerms(quote, { network: "eip155:1" }),
    mutateTerms(quote, { maxTimeoutSeconds: 301 }),
    mutateExtra(quote, { paymentFlow: "permit2" }),
    mutateTerms(quote, { asset: `0x${"0".repeat(40)}` }),
    mutateExtra(quote, { inputHash: "b".repeat(64) }),
    mutateExtra(quote, { payer: payTo }),
    mutateExtra(quote, { expiresAt: quote.accepts[0].extra.expiresAt + 1 }),
  ];
  for (const invalid of invalidQuotes)
    await assert.rejects(
      signImagePayment(provider, invalid, record.input, () => true),
      { code: "invalid_image_payment" },
    );
  assert.deepEqual(calls, []);
  await assert.rejects(
    validateImageQuoteInput(quote, { ...record.input, prompt: "A different prompt." }, origin),
    { code: "invalid_image_payment" },
  );
  assert.equal(validateImageQuote(quote, record.input, origin), quote);
  assert.equal(await validateImageQuoteInput(quote, record.input, origin), quote);
});

test("saved recovery validates complete quote, proof and flags before the UI receives it", async () => {
  const { record, quote, provider, storage, records } = await setup();
  saveImageRecovery({ ...record, quote }, storage);
  assert.deepEqual(readImageRecovery(storage), { ...record, quote });
  const proof = await signImagePayment(provider, quote, record.input, () => true);
  const signed = { ...record, quote, proof, submitted: true };
  saveImageRecovery(signed, storage);
  assert.deepEqual(readImageRecovery(storage), signed);
  assert.throws(
    () =>
      saveImageRecovery(
        newImageRecovery({
          wallet: record.input.wallet,
          name: "Another moon",
          ticker: "MOON",
          prompt: "Another image",
        }),
        storage,
      ),
    { code: "image_request_in_progress" },
  );
  assert.throws(() => saveImageRecovery({ ...record, quote }, storage), {
    code: "image_request_in_progress",
  });
  const cacheKey = [...records.keys()][0];
  const invalidRecords = [
    { ...record, quote: { accepts: {} } },
    { ...record, quote: mutateTerms(quote, { amount: "oops" }) },
    { ...record, submitted: "true" },
    { ...record, submitted: true },
    { ...record, completed: true },
    { ...signed, submitted: false },
    { ...signed, completed: true },
    { ...signed, quote: undefined },
    { ...signed, proof: { ...proof, payload: { ...proof.payload, signature: "EXAMPLE" } } },
    {
      ...signed,
      proof: {
        ...proof,
        payload: {
          ...proof.payload,
          authorization: { ...proof.payload.authorization, value: "1" },
        },
      },
    },
    { ...record, input: { ...record.input, wallet: `0x${"0".repeat(40)}` } },
  ];
  for (const invalid of invalidRecords) {
    records.set(cacheKey, JSON.stringify(invalid));
    assert.throws(() => readImageRecovery(storage), { code: "image_recovery_unavailable" });
  }
  const completed = { ...record, submitted: true, completed: true };
  records.set(cacheKey, JSON.stringify(signed));
  saveImageRecovery(completed, storage);
  assert.deepEqual(readImageRecovery(storage), completed);
});

test("lost paid POST response reloads and resends exactly the same proof without another signature", async () => {
  const { record, quote, provider, calls, storage } = await setup();
  const proof = await signImagePayment(provider, quote, record.input, () => true);
  const signed = { ...record, quote, proof, submitted: true };
  saveImageRecovery(signed, storage);
  const sent = [];
  await assert.rejects(
    requestImage(signed, "POST", async (path, options) => {
      sent.push({ path, headers: options.headers, body: options.body });
      assert.deepEqual(readImageRecovery(storage), signed);
      throw new Error("Transport lost after request");
    }),
    /Transport lost/,
  );
  const restored = readImageRecovery(storage);
  const status = await requestImage(restored, "GET", async (path, options) => {
    assert.equal(path, `/api/images/grok/${record.input.requestId}`);
    assert.equal(options.headers["payment-signature"], undefined);
    assert.equal(options.body, undefined);
    return Response.json(state(record, "awaiting_payment", "unpaid", { quote }));
  });
  assert.equal(status.job.status, "awaiting_payment");
  await requestImage(restored, "POST", async (path, options) => {
    sent.push({ path, headers: options.headers, body: options.body });
    return Response.json(state(record, "authorized", "authorized"), { status: 202 });
  });
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(calls.filter((method) => method === "eth_signTypedData_v4").length, 1);
  assert.deepEqual(readImageRecovery(storage), signed);
});

test("request rejects wrong brief hash before transport and checks the 402 header/body pair", async () => {
  const { record, quote } = await setup();
  await assert.rejects(
    requestImage(
      { ...record, quote: mutateExtra(quote, { inputHash: "b".repeat(64) }) },
      "POST",
      () => assert.fail("Unexpected transport"),
    ),
    { code: "invalid_image_payment" },
  );
  const response = await requestImage(record, "POST", async () =>
    Response.json(quote, {
      status: 402,
      headers: { "payment-required": btoa(JSON.stringify(quote)) },
    }),
  );
  assert.deepEqual(response.quote, quote);
  await assert.rejects(
    requestImage(record, "POST", async () =>
      Response.json(quote, {
        status: 402,
        headers: {
          "payment-required": btoa(JSON.stringify(mutateTerms(quote, { amount: "200000" }))),
        },
      }),
    ),
    { code: "invalid_image_payment" },
  );
  await assert.rejects(
    requestImage(
      record,
      "POST",
      async () =>
        new Response(JSON.stringify(quote), {
          status: 402,
          headers: { "content-type": "text/html", "payment-required": btoa(JSON.stringify(quote)) },
        }),
    ),
    { code: "invalid_image_payment" },
  );
});

test("inconsistent job accounting and malformed completion cannot unlock a pending request", async () => {
  const { record, quote } = await setup();
  for (const job of [
    state(record, "failed", "paid"),
    state(record, "unknown", "authorized"),
    state(record, "generating", "unpaid"),
    state(record, "completed", "paid"),
    state(record, "authorized", "authorized", { quote }),
    state(record, "awaiting_payment", "unpaid"),
    { ...state(record, "failed", "not_charged"), payment: null },
    state(record, "settlement_pending", "settlement_pending", {
      payment: { status: "settlement_pending", network: "eip155:4663", transaction: "oops" },
    }),
  ])
    await assert.rejects(
      requestImage(record, "GET", async () => Response.json(job)),
      { code: "invalid_image_payment" },
    );
  for (const [status, accounting] of [
    ["authorized", "authorized"],
    ["generating", "authorized"],
    ["generated", "authorized"],
    ["settlement_pending", "settlement_pending"],
    ["failed", "not_charged"],
    ["unknown", "not_charged"],
  ]) {
    const expected = state(record, status, accounting);
    assert.deepEqual(
      (await requestImage(record, "GET", async () => Response.json(expected))).job,
      expected,
    );
  }
});

test("completed image bytes are verified before becoming a reusable Blob", async () => {
  const { record } = await setup();
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } })
    .webp()
    .toBuffer();
  const sha256 = await assetHash(bytes);
  const job = state(record, "completed", "paid", {
    payment: { status: "paid", network: "eip155:4663", transaction: `0x${"c".repeat(64)}` },
    image: {
      base64: bytes.toString("base64"),
      mimeType: "image/webp",
      sha256,
      width: 8,
      height: 8,
      filename: `${sha256}.webp`,
    },
  });
  const received = (await requestImage(record, "GET", async () => Response.json(job))).job;
  const blob = await generatedImageBlob(received);
  assert.equal(blob.type, "image/webp");
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array(bytes));
  for (const image of [
    { ...job.image, sha256: "d".repeat(64) },
    { ...job.image, base64: "EXAMPLE" },
    { ...job.image, height: 9 },
  ])
    await assert.rejects(generatedImageBlob({ ...job, image }), { code: "invalid_image_payment" });
});
