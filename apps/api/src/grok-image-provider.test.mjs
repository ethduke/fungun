import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ImagePromptError, MEMECOIN_IMAGE_SYSTEM_PROMPT } from "./image-prompt.mjs";
import { IMAGE_BYTE_LIMIT } from "./launch-image.mjs";
import {
  createGrokImageProvider,
  GROK_IMAGE_ENDPOINT,
  GROK_IMAGE_MODEL,
  GROK_IMAGE_PRICE_VARIANT,
  GROK_IMAGE_PRICING_ENDPOINT,
  GROK_IMAGE_PRICING_RESPONSE_LIMIT,
  GROK_IMAGE_PRODUCT,
  GROK_IMAGE_RESPONSE_LIMIT,
} from "./grok-image-provider.mjs";

const draft = { name: "Moon Department", ticker: "MOON", prompt: "A moon in a business suit" };
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);
const item = () => ({ b64_json: png.toString("base64"), media_type: "image/png" });
const response = (entry = item(), cost = 0.04) =>
  Response.json({ data: [entry], usage: { cost } });
const pricingResponse = (costUsd = 0.04, changes = {}) =>
  Response.json({
    id: GROK_IMAGE_MODEL,
    endpoints: [
      {
        provider_slug: "xai",
        provider_tag: "xai",
        pricing: [
          {
            billable: "output_image",
            unit: "image",
            variant: GROK_IMAGE_PRICE_VARIANT,
            cost_usd: costUsd,
          },
        ],
        ...changes,
      },
    ],
  });
const provider = (fetcher, options = {}) =>
  createGrokImageProvider({ apiKey: "EXAMPLE", fetcher, ...options });

test("each new prompt snapshots the current exact Grok image SKU price", async () => {
  const calls = [];
  const prices = [0.04, "0.0470001"];
  const api = provider(async (...args) => {
    calls.push(args);
    return pricingResponse(prices.shift());
  });
  assert.deepEqual(await api.quote(draft), { amount: "40000" });
  assert.deepEqual(
    await api.quote({ ...draft, prompt: "A different moon prompt" }),
    { amount: "47001" },
  );
  assert.equal(calls.length, 2);
  for (const [url, options] of calls) {
    assert.equal(url, GROK_IMAGE_PRICING_ENDPOINT);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, {
      ["Authorization"]: "Bearer EXAMPLE",
      Accept: "application/json",
    });
    assert.equal(options.body, undefined);
  }
});

test("pricing fails closed on another provider, SKU, unit, or invalid amount", async () => {
  const invalid = [
    pricingResponse(0.04, { provider_tag: "other", provider_slug: "other" }),
    pricingResponse(0.04, { provider_tag: "other", provider_slug: "xai" }),
    pricingResponse(0.04, {
      pricing: [{ billable: "output_image", unit: "image", variant: "medium_1k", cost_usd: 0.06 }],
    }),
    pricingResponse(0.04, {
      pricing: [{ billable: "output_image", unit: "token", variant: "low_1k", cost_usd: 0.04 }],
    }),
    pricingResponse(0),
    pricingResponse("1e-2"),
    pricingResponse(10.01),
    Response.json({ id: GROK_IMAGE_MODEL, endpoints: [] }),
  ];
  for (const result of invalid)
    await assert.rejects(provider(async () => result).quote(draft), {
      code: "image_pricing_unavailable",
      status: 503,
    });
});

test("pricing responses are bounded and time out without generation", async () => {
  let cancelled = 0;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(GROK_IMAGE_PRICING_RESPONSE_LIMIT + 1));
    },
    cancel() {
      cancelled++;
    },
  });
  await assert.rejects(
    provider(async () => new Response(stream, { headers: { "content-type": "application/json" } })).quote(
      draft,
    ),
    { code: "image_pricing_unavailable" },
  );
  assert.equal(cancelled, 1);
  let signal;
  await assert.rejects(
    provider(
      (_url, options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
      { pricingTimeoutMs: 10 },
    ).quote(draft),
    { code: "image_pricing_unavailable" },
  );
  assert.equal(signal.aborted, true);
});

test("one fixed OpenRouter request uses Grok through xai without sending wallet or payment data", async () => {
  const calls = [];
  const api = provider(async (...args) => {
    calls.push(args);
    return response();
  });
  const image = await api.generate(draft);
  assert.equal(api.configured, true);
  assert.equal(api.model, GROK_IMAGE_MODEL);
  assert.equal(api.product, GROK_IMAGE_PRODUCT);
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, GROK_IMAGE_ENDPOINT);
  assert.equal(url, "https://openrouter.ai/api/v1/images");
  assert.equal(options.method, "POST");
  assert.equal(options.redirect, "error");
  assert.deepEqual(options.headers, {
    ["Authorization"]: "Bearer EXAMPLE",
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  const { prompt, ...settings } = JSON.parse(options.body);
  assert.ok(prompt.startsWith(MEMECOIN_IMAGE_SYSTEM_PROMPT));
  assert.ok(prompt.endsWith(JSON.stringify(draft)));
  assert.deepEqual(settings, {
    model: "x-ai/grok-imagine-image-2.0",
    n: 1,
    aspect_ratio: "1:1",
    resolution: "1K",
    quality: "low",
    stream: false,
    provider: { only: ["xai"], allow_fallbacks: false },
  });
  assert.deepEqual(image, {
    bytes: png,
    mime: "image/png",
    sha256: createHash("sha256").update(png).digest("hex"),
    model: GROK_IMAGE_MODEL,
    costAmount: "40000",
  });
});

test("input validation and missing server configuration fail before pricing or generation", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return response();
  };
  for (const apiKey of ["", " ", undefined, null, "secret\nvalue"]) {
    const api = createGrokImageProvider({ apiKey, fetcher });
    assert.equal(api.configured, false);
    await assert.rejects(api.generate(draft), {
      code: "image_service_not_configured",
      status: 503,
    });
    await assert.rejects(api.quote(draft), {
      code: "image_service_not_configured",
      status: 503,
    });
  }
  for (const input of [
    null,
    { ...draft, wallet: "0x123" },
    { ...draft, model: "other" },
    { prompt: "" },
  ])
    for (const method of ["quote", "generate"])
      await assert.rejects(provider(fetcher)[method](input), ImagePromptError);
  assert.equal(calls, 0);
});

test("completed generation exposes exact provider cost rounded up to USDG base units", async () => {
  const image = await provider(async () => response(item(), "0.0470001")).generate(draft);
  assert.equal(image.costAmount, "47001");
});

test("base64 and inline data URLs use detected PNG, JPEG or WebP signatures", async () => {
  for (const [bytes, mime] of [
    [png, "image/png"],
    [Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg"],
    [Buffer.from("RIFF\x04\0\0\0WEBP", "binary"), "image/webp"],
  ]) {
    // These are transport/signature checks; the existing decoder validates pixels.
    for (const entry of [
      { b64_json: bytes.toString("base64") },
      { b64_json: `data:${mime};base64,${bytes.toString("base64")}`, media_type: mime },
      { url: `data:${mime};base64,${bytes.toString("base64")}` },
    ]) {
      const image = await provider(async () => response(entry)).generate(draft);
      assert.deepEqual(image.bytes, bytes);
      assert.equal(image.mime, mime);
    }
  }
});

test("URLs, MIME mismatches, unsupported formats and noncanonical base64 cannot become assets", async () => {
  for (const entry of [
    { url: "https://provider.invalid/temporary-image.png" },
    { url: "http://169.254.169.254/latest/meta-data/" },
    { b64_json: "" },
    { b64_json: png.toString("base64") + "\n" },
    { b64_json: png.toString("base64") + "$" },
    { b64_json: png.toString("base64").replace(/=$/, "") },
    { ...item(), media_type: "image/jpeg" },
    { b64_json: `data:image/jpeg;base64,${png.toString("base64")}` },
    { b64_json: `data:image/png;base64,${png.toString("base64")}`, media_type: "image/webp" },
    { b64_json: Buffer.from("<svg></svg>").toString("base64") },
    { b64_json: Buffer.from("GIF89a").toString("base64") },
    { b64_json: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" },
  ]) {
    let calls = 0;
    await assert.rejects(
      provider(async () => {
        calls++;
        return response(entry);
      }).generate(draft),
      { code: "image_provider_response_invalid", status: 502 },
    );
    assert.equal(calls, 1);
  }
});

test("response requires exactly one image and rejects explicit moderation failures", async () => {
  for (const body of [
    null,
    {},
    { data: [] },
    { data: [item(), item()] },
    { data: [null] },
    { error: { message: "secret" }, data: [item()] },
  ])
    await assert.rejects(provider(async () => Response.json(body)).generate(draft), {
      code: "image_provider_response_invalid",
    });
  await assert.rejects(
    provider(async () => response({ ...item(), respect_moderation: false })).generate(draft),
    {
      code: "image_filtered",
      status: 422,
    },
  );
});

test("response requires a valid completed-request cost", async () => {
  for (const usage of [undefined, null, {}, { cost: 0 }, { cost: "1e-2" }, { cost: 10.01 }]) {
    const body = { data: [item()], ...(usage === undefined ? {} : { usage }) };
    await assert.rejects(provider(async () => Response.json(body)).generate(draft), {
      code: "image_provider_response_invalid",
      status: 502,
    });
  }
});

test("upstream HTTP failures and transport errors are redacted and never retried", async () => {
  for (const status of [400, 401, 402, 403, 429, 500, 502, 503]) {
    let calls = 0;
    await assert.rejects(
      provider(async () => {
        calls++;
        return new Response("SECRET provider details", { status });
      }).generate(draft),
      (error) => {
        assert.equal(error.code, "image_provider_unavailable");
        assert.equal(error.status, status === 429 ? 503 : 502);
        assert.equal(error.message, error.code);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(
    provider(async () => {
      calls++;
      throw new Error("SECRET bearer key");
    }).generate(draft),
    { code: "image_outcome_unknown", status: 502 },
  );
  assert.equal(calls, 1);
});

test("declared or streamed oversized bodies are cancelled before publishing", async () => {
  for (const declared of [true, false]) {
    let cancelled = 0;
    const stream = new ReadableStream({
      start(controller) {
        if (!declared) controller.enqueue(new Uint8Array(GROK_IMAGE_RESPONSE_LIMIT + 1));
      },
      cancel() {
        cancelled++;
      },
    });
    const headers = { "content-type": "application/json" };
    if (declared) headers["content-length"] = String(GROK_IMAGE_RESPONSE_LIMIT + 1);
    await assert.rejects(provider(async () => new Response(stream, { headers })).generate(draft), {
      code: "image_provider_response_invalid",
    });
    assert.equal(cancelled, 1);
  }
});

test("decoded image limit remains 2 MiB even when a larger base64 payload fits transport bounds", async () => {
  const bytes = Buffer.alloc(IMAGE_BYTE_LIMIT + 1);
  png.copy(bytes);
  await assert.rejects(
    provider(async () => response({ b64_json: bytes.toString("base64") })).generate(draft),
    {
      code: "image_provider_response_invalid",
    },
  );
});

test("non-JSON and malformed bodies fail without provider details", async () => {
  for (const makeResponse of [
    () => new Response("SECRET invalid JSON", { headers: { "content-type": "application/json" } }),
    () => new Response("SECRET HTML", { headers: { "content-type": "text/html" } }),
    () => new Response(null, { headers: { "content-type": "application/json" } }),
  ]) {
    await assert.rejects(provider(async () => makeResponse()).generate(draft), {
      code: "image_provider_response_invalid",
    });
  }
});

test("deadline bounds an unresponsive fetch and cancels a response arriving afterward", async () => {
  let calls = 0;
  let signal;
  let finish;
  let cancelled = 0;
  const api = provider(
    (_url, options) => {
      calls++;
      signal = options.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    { timeoutMs: 10 },
  );
  await assert.rejects(api.generate(draft), { code: "image_outcome_unknown" });
  assert.equal(signal.aborted, true);
  finish(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 1);
  assert.equal(calls, 1);
});

test("deadline also bounds a stalled body and does not await stalled cancellation", async () => {
  let signal;
  let cancelled = 0;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('{"data":['));
    },
    cancel() {
      cancelled++;
      return new Promise(() => {});
    },
  });
  const api = provider(
    async (_url, options) => {
      signal = options.signal;
      return new Response(stream, { headers: { "content-type": "application/json" } });
    },
    { timeoutMs: 10 },
  );
  await assert.rejects(api.generate(draft), { code: "image_outcome_unknown" });
  assert.equal(cancelled, 1);
  assert.equal(signal.aborted, true);
});
