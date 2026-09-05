import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { ipfsContentId, prepareLongIpfsAssets } from "./ipfs-content.mjs";
import { ipfsMessage, pinataGatewayUrl, PinataPublisher } from "./pinata-publisher.mjs";

const jwt = ["syntheticHeader", "syntheticPayload", "syntheticSignature"].join(".");
const gateway = "launch-assets.mypinata.cloud";
const id = "10000000-1000-1000-1000-100000000001";
const config = { jwt, gateway, enabled: true };
const object = async (text = "{}") => {
  const bytes = Buffer.from(text);
  return { bytes, cid: await ipfsContentId(bytes), mime: "application/json" };
};
const record = (file, changes = {}) => ({ id, cid: file.cid, size: file.bytes.length,
  number_of_files: 1, mime_type: file.mime, ...changes });
const response = (data) => Response.json({ data });
const code = (expected) => (error) => error.code === expected && !String(error).includes(jwt);

test("publisher stays off by default, with no network or enumerable credentials", async () => {
  let requests = 0;
  const publisher = new PinataPublisher({ ...config, enabled: false, fetcher: () => { requests += 1; } });
  const file = await object();
  for (const operation of [() => publisher.pinObject(file), () => publisher.inspectPin(id, file),
    () => publisher.verifyObject(file)]) await assert.rejects(operation(), code("ipfs_publication_disabled"));
  assert.equal(requests, 0);
  assert.equal(JSON.stringify(new PinataPublisher(config)), "{}");
  assert.equal(inspect(new PinataPublisher(config)).includes(jwt), false);
});

test("configuration accepts only fixed Pinata gateway hosts and valid header-safe credentials", async () => {
  for (const bad of ["http://launch-assets.mypinata.cloud", "https://launch-assets.mypinata.cloud",
    "launch-assets.mypinata.cloud/", "launch-assets.mypinata.cloud?key=EXAMPLE", "launch-assets.mypinata.cloud.evil.example",
    "localhost", "127.0.0.1", "launch-assets.mypinata.cloud:443", "user@launch-assets.mypinata.cloud", "a.b.mypinata.cloud"])
    assert.throws(() => new PinataPublisher({ ...config, gateway: bad }), code("ipfs_configuration"));
  for (const bad of [null, "", "EXAMPLE", `${jwt}\nInjected: yes`])
    assert.throws(() => new PinataPublisher({ ...config, jwt: bad }), code("ipfs_configuration"));
  for (const timeoutMs of [0, 9, 15001, NaN])
    assert.throws(() => new PinataPublisher({ ...config, timeoutMs }));
  const file = await object();
  assert.equal(pinataGatewayUrl(gateway, file.cid), `https://${gateway}/ipfs/${file.cid}`);
  assert.throws(() => pinataGatewayUrl(gateway, `${file.cid}/other`));
});

test("a pin sends exact bytes, public network, pinned profile and no user metadata", async () => {
  const file = await object("{\"name\":\"Moon\"}");
  let requests = 0;
  const publisher = new PinataPublisher({ ...config, fetcher: async (url, options) => {
    requests += 1;
    assert.equal(url, "https://uploads.pinata.cloud/v3/files");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers.get("Authorization"), `Bearer ${jwt}`);
    assert.deepEqual([...options.body.keys()], ["file", "network", "cid_version"]);
    assert.equal(options.body.get("network"), "public");
    assert.equal(options.body.get("cid_version"), "v1");
    const upload = options.body.get("file");
    assert.equal(upload.name, `${createHash("sha256").update(file.bytes).digest("hex")}.json`);
    assert.equal(upload.type, file.mime);
    assert.deepEqual(Buffer.from(await upload.arrayBuffer()), file.bytes);
    return response(record(file, { private_provider_data: jwt }));
  } });
  assert.deepEqual(await publisher.pinObject(file), { id, cid: file.cid, size: file.bytes.length, mime: file.mime });
  assert.equal(requests, 1);
});

test("both Long bundle objects can be pinned and independently verified", async () => {
  const image = Buffer.alloc(32);
  image.write("RIFF"); image.writeUInt32LE(24, 4); image.write("WEBPVP8 ", 8);
  const bundle = await prepareLongIpfsAssets(image, { name: "Moon", ticker: "MOON" });
  const calls = [];
  const publisher = new PinataPublisher({ ...config, fetcher: async (url, options) => {
    calls.push(options.method);
    const file = url.endsWith(bundle.image.cid) || options.body?.get("file").type === "image/webp"
      ? bundle.image : bundle.metadata;
    return options.method === "POST" ? response(record(file)) : new Response(file.bytes, { headers: { "content-type": file.mime } });
  } });
  for (const file of [bundle.image, bundle.metadata]) {
    assert.equal((await publisher.pinObject(file)).cid, file.cid);
    assert.equal((await publisher.verifyObject(file)).contentVerified, true);
  }
  assert.deepEqual(calls, ["POST", "GET", "POST", "GET"]);
});

test("mutated bytes or unsupported content never reach the provider", async () => {
  let requests = 0;
  const publisher = new PinataPublisher({ ...config, fetcher: () => { requests += 1; } });
  const file = await object();
  for (const bad of [null, { ...file, bytes: Buffer.from("changed") }, { ...file, mime: "image/svg+xml" },
    { ...file, bytes: Buffer.alloc(16385) }, { ...file, cid: "invalid" }, { ...file, mime: "image/webp" }])
    await assert.rejects(publisher.pinObject(bad), code("invalid_ipfs_asset"));
  assert.equal(requests, 0);
});

test("publisher snapshots caller bytes before any asynchronous work", async () => {
  const file = await object();
  const publisher = new PinataPublisher({ ...config, fetcher: async (_, options) => {
    assert.equal(await options.body.get("file").text(), "{}");
    return response(record({ ...file, bytes: Buffer.from("{}") }));
  } });
  const pending = publisher.pinObject(file);
  file.bytes.fill(0);
  assert.equal((await pending).cid, file.cid);
});

test("ambiguous uploads, mismatched records and upstream errors are redacted and never retried", async () => {
  const file = await object();
  const foreign = await object("other");
  const results = [
    () => { throw new Error(jwt); },
    () => Response.json({ error: jwt }, { status: 429 }),
    () => Response.json({ error: jwt }, { status: 500 }),
    () => new Response(null, { status: 302, headers: { location: `https://other.example/${jwt}` } }),
    () => new Response("not json", { headers: { "content-type": "application/json" } }),
    () => response(record(file, { cid: foreign.cid })),
    () => response(record(file, { id: "../private" })),
    () => response(record(file, { size: 999 })),
    () => response(record(file, { number_of_files: 2 })),
    () => response(record(file, { mime_type: "text/html" })),
    () => response({ huge: "x".repeat(8193) }),
  ];
  for (const result of results) {
    let requests = 0;
    const publisher = new PinataPublisher({ ...config, fetcher: async () => { requests += 1; return result(); } });
    await assert.rejects(publisher.pinObject(file), code("ipfs_publication_uncertain"));
    assert.equal(requests, 1);
  }
});

test("gateway verification is exact, bounded, unauthenticated and has no follow-up writes", async () => {
  const file = await object();
  let requests = 0;
  const publisher = new PinataPublisher({ ...config, fetcher: async (url, options) => {
    requests += 1;
    assert.equal(url, `https://${gateway}/ipfs/${file.cid}`);
    assert.equal(options.method, "GET");
    assert.deepEqual(options.headers, { Accept: file.mime });
    assert.equal(JSON.stringify(options).includes(jwt), false);
    assert.equal(options.redirect, "error");
    return new Response(file.bytes, { headers: { "content-type": "application/json; charset=utf-8" } });
  } });
  assert.deepEqual(await publisher.verifyObject(file), { cid: file.cid, size: 2, contentVerified: true, launchReady: false });
  assert.equal(requests, 1);
});

test("invalid, oversized and redirected gateway content fails closed", async () => {
  const file = await object();
  const results = [
    () => new Response("[]", { headers: { "content-type": file.mime } }),
    () => new Response("{}extra", { headers: { "content-type": file.mime } }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () => new Response("{}", { headers: { "content-type": file.mime, "content-length": "999999" } }),
    () => new Response(null, { status: 302, headers: { location: "https://other.example/file" } }),
    () => new Response("{}", { status: 206, headers: { "content-type": file.mime } }),
  ];
  for (const result of results) {
    const publisher = new PinataPublisher({ ...config, fetcher: async () => result() });
    await assert.rejects(publisher.verifyObject(file), code("ipfs_verification_unavailable"));
  }
});

test("gateway access denial is distinguished from a temporary retrieval delay without leaking its body", async () => {
  const file = await object();
  for (const status of [401, 403]) {
    let requests = 0;
    const publisher = new PinataPublisher({ ...config, fetcher: async () => {
      requests++; return new Response(jwt, { status });
    } });
    await assert.rejects(publisher.verifyObject(file), error => code("ipfs_gateway_access_denied")(error) && error.retryAfter === 60);
    assert.equal(requests, 1);
  }
});

test("account pin inspection is read-only and binds its record to the expected file", async () => {
  const file = await object();
  const calls = [];
  const publisher = new PinataPublisher({ ...config, fetcher: async (url, options) => {
    calls.push(options.method);
    assert.equal(url, `https://api.pinata.cloud/v3/files/public/${id}`);
    assert.equal(options.headers.get("Authorization"), `Bearer ${jwt}`);
    return response(record(file));
  } });
  assert.deepEqual(await publisher.inspectPin(id, file), { id, cid: file.cid, size: 2, mime: file.mime });
  await assert.rejects(publisher.inspectPin("../private", file), code("invalid_ipfs_asset"));
  assert.deepEqual(calls, ["GET"]);
  const wrong = new PinataPublisher({ ...config, fetcher: async () => response(record(file, { id: id.replace(/1$/, "2") })) });
  await assert.rejects(wrong.inspectPin(id, file), code("ipfs_verification_unavailable"));
});

test("timeouts cover fetch and body reads, abort transport, and release the concurrency slot", async () => {
  const file = await object();
  let signal;
  let release;
  let requests = 0;
  const publisher = new PinataPublisher({ ...config, timeoutMs: 20, fetcher: async (_, options) => {
    signal = options.signal; requests += 1;
    return new Promise((resolve) => { release = resolve; });
  } });
  const pending = publisher.pinObject(file);
  await assert.rejects(publisher.pinObject(file), code("ipfs_busy"));
  await assert.rejects(pending, code("ipfs_publication_uncertain"));
  assert.equal(signal.aborted, true);
  assert.equal(requests, 1);
  release(response(record(file)));
  let cancelled = false;
  const bodyPublisher = new PinataPublisher({ ...config, timeoutMs: 20, fetcher: async () =>
    new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": file.mime } }) });
  await assert.rejects(bodyPublisher.verifyObject(file), code("ipfs_verification_unavailable"));
  assert.equal(cancelled, true);
});

test("user-facing errors describe uncertainty without leaking technical details", () => {
  assert.match(ipfsMessage("ipfs_publication_uncertain"), /Do not upload again/);
  assert.match(ipfsMessage("ipfs_verification_unavailable"), /pending/);
  assert.equal(ipfsMessage(jwt).includes(jwt), false);
  assert.equal(typeof ipfsMessage("__proto__"), "string");
});

test("CID reconciliation uses one bounded read and rejects missing or ambiguous account pins", async () => {
  const file = await object();
  let requests = 0;
  const publisher = new PinataPublisher({ ...config, fetcher: async (url, options) => {
    requests++;
    assert.equal(url, `https://api.pinata.cloud/v3/files/public?cid=${file.cid}&limit=2`);
    assert.equal(options.method, "GET");
    return response({ files: [record(file)], next_page_token: "" });
  } });
  assert.equal((await publisher.findPin(file)).id, id);
  assert.equal(requests, 1);
  for (const data of [
    { files: [], next_page_token: "" },
    { files: [record(file), record(file)], next_page_token: "" },
    { files: [record(file)], next_page_token: "more" },
    { files: [record(file)] },
    { files: [record(file, { size: 999 })], next_page_token: "" },
  ]) {
    const bad = new PinataPublisher({ ...config, fetcher: async () => response(data) });
    await assert.rejects(bad.findPin(file), code("ipfs_verification_unavailable"));
  }
});
