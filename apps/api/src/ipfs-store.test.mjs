import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { initializeIpfsStore, IpfsStore } from "./ipfs-store.mjs";
import { createIpfsWorker } from "./ipfs-worker.mjs";

const draft = { name: "Moon", ticker: "MOON", description: "" };
export async function ipfsFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fungun-ipfs-")));
  let now = Date.now();
  const config = { root, appOrigin: "http://127.0.0.1:3000", gateway: "launch-assets.mypinata.cloud", now: () => now };
  initializeIpfsStore(root, false, config.now);
  let store = new IpfsStore(config);
  const workers = [];
  t.after(async () => { for (const worker of workers) await worker.stop(); store.close(); rmSync(root, { recursive: true }); });
  const account = privateKeyToAccount(generatePrivateKey());
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).webp().toBuffer();
  const calls = [];
  const receipts = new Map();
  const publisher = {
    async pinObject(content) {
      calls.push(["POST", content.cid]);
      const receipt = { id: crypto.randomUUID(), cid: content.cid, size: content.bytes.length, mime: content.mime };
      receipts.set(content.cid, receipt);
      return receipt;
    },
    async findPin(content) { calls.push(["FIND", content.cid]); const found = receipts.get(content.cid); if (!found) throw new Error(); return found; },
    async inspectPin(id, content) { calls.push(["PIN", content.cid]); assert.equal(receipts.get(content.cid).id, id); },
    async verifyObject(content) { calls.push(["GET", content.cid]); },
  };
  const fixture = { config, account, image, draft, calls, receipts, publisher,
    get store() { return store; },
    advance: (ms = 60001) => { now += ms; },
    reopen: () => { store.close(); store = new IpfsStore(config); },
    worker: (enabled = true) => { const worker = createIpfsWorker(store, publisher, { enabled }); workers.push(worker); return worker; },
    async approval() {
      const preview = await store.challenge(account.address, image, draft);
      return { ...preview, wallet: account.address, signature: await account.signMessage({ message: preview.message }), image, draft };
    },
  };
  return fixture;
}

test("IPFS reservation survives restart, binds exact content, and stores no wallet signature", async (t) => {
  const f = await ipfsFixture(t), approval = await f.approval();
  const accepted = await f.store.accept(approval);
  assert.equal(accepted.status, "processing");
  assert.deepEqual(accepted.progress, { image: "ready", metadata: "ready" });
  assert.equal(f.calls.length, 0);
  assert.match(approval.message, /Intent version: 2/);
  assert.match(approval.message, /Storage: public IPFS/);
  f.reopen();
  assert.deepEqual(f.store.status(approval), accepted);
  const worker = f.worker(); worker.kick(); await worker.idle();
  const result = f.store.status(approval);
  assert.equal(result.status, "published");
  assert.equal(result.launchReady, false);
  assert.equal(f.store.get(approval.id).approved, null);
  assert.deepEqual(readdirSync(join(f.config.root, "ipfs-staging")), []);
  assert.equal(f.calls.filter(([method]) => method === "POST").length, 2);
  const count = f.calls.length;
  assert.deepEqual(await f.store.accept(approval), result);
  worker.kick(); await worker.idle();
  assert.equal(f.calls.length, count);
  f.store.db.exec("PRAGMA wal_checkpoint(FULL)");
  for (const name of readdirSync(f.config.root).filter((name) => name.startsWith("ipfs.sqlite"))) {
    const bytes = readFileSync(join(f.config.root, name));
    assert.equal(bytes.includes(Buffer.from(approval.signature)), false);
    assert.equal(bytes.includes(Buffer.from(f.account.address.toLowerCase())), false);
  }
});

test("an authenticated repeat repairs a crash during private staging", async (t) => {
  const f = await ipfsFixture(t), approval = await f.approval();
  await f.store.accept(approval);
  unlinkSync(join(f.config.root, "ipfs-staging", `${approval.id}.image`));
  f.store.db.prepare("UPDATE ipfs_objects SET state='staging' WHERE publication_id=?").run(approval.id);
  f.reopen();
  assert.equal((await f.store.accept(approval)).status, "processing");
  const worker = f.worker(); worker.kick(); await worker.idle();
  assert.equal(f.store.status(approval).status, "published");
});

test("lost acknowledgment recovers by CID without repeating the image upload", async (t) => {
  const f = await ipfsFixture(t), approval = await f.approval();
  await f.store.accept(approval);
  const pin = f.publisher.pinObject;
  f.publisher.pinObject = async (content) => { await pin(content); throw new Error("lost response"); };
  const first = f.worker(); first.kick(); await first.idle(); await first.stop();
  assert.equal(f.store.status(approval).progress.image, "sending");
  await assert.rejects(f.store.challenge(f.account.address, f.image, { ...draft, name: "Changed" }), { code: "asset_publication_uncertain" });
  f.reopen(); f.advance(); f.publisher.pinObject = pin;
  const second = f.worker(); second.kick(); await second.idle();
  assert.equal(f.store.status(approval).status, "published");
  assert.equal(f.calls.filter(([method, cid]) => method === "POST" && cid === approval.ipfs.imageCid).length, 1);
  assert.equal(f.calls.filter(([method]) => method === "FIND").length, 1);
});

test("unresolved upload never expires, refunds, or issues a fresh owner approval", async (t) => {
  const f = await ipfsFixture(t), approval = await f.approval();
  await f.store.accept(approval);
  f.publisher.pinObject = async () => { f.calls.push(["POST"]); throw new Error(); };
  const worker = f.worker(); worker.kick(); await worker.idle();
  for (let i = 0; i < 7; i++) { f.advance(); worker.kick(); await worker.idle(); }
  assert.equal(f.calls.filter(([method]) => method === "POST").length, 1);
  assert.equal(f.store.status(approval).status, "processing");
  assert.ok(f.store.get(approval.id).approved);
  await assert.rejects(f.store.challenge(f.account.address, f.image, draft), { code: "asset_publication_uncertain" });
});

test("pending expiry is safe, but context changes and foreign status are rejected", async (t) => {
  const f = await ipfsFixture(t), approval = await f.approval();
  await assert.rejects(f.store.accept({ ...approval, draft: { ...draft, name: "Changed" } }), { code: "asset_approval_changed" });
  const other = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(f.store.accept({ ...approval, signature: await other.signMessage({ message: approval.message }) }), { code: "invalid_asset_approval" });
  assert.throws(() => f.store.status({ ...approval, wallet: other.address }), { code: "asset_approval_changed" });
  for (let i = 0; i < 6; i++) f.advance();
  assert.equal(f.store.status(approval).status, "expired");
  await assert.rejects(f.store.accept(approval), { code: "asset_approval_expired" });
  assert.notEqual((await f.approval()).id, approval.id);
});

test("corrupt staged bytes and disabled workers cannot make upstream requests", async (t) => {
  const f = await ipfsFixture(t), approval = await f.approval();
  await f.store.accept(approval);
  const disabled = f.worker(false); disabled.kick(); await disabled.idle();
  assert.equal(f.calls.length, 0);
  writeFileSync(join(f.config.root, "ipfs-staging", `${approval.id}.image`), Buffer.from("invalid"));
  const enabled = f.worker(); enabled.kick(); await enabled.idle();
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.status(approval).status, "processing");
});

test("a pinned image resumes verification without a second POST after a gateway error", async (t) => {
  const f = await ipfsFixture(t), approval = await f.approval();
  await f.store.accept(approval);
  const verify = f.publisher.verifyObject;
  f.publisher.verifyObject = async () => { throw new Error(); };
  const worker = f.worker(); worker.kick(); await worker.idle();
  assert.equal(f.store.status(approval).progress.image, "pinned");
  f.publisher.verifyObject = verify; f.advance(); worker.kick(); await worker.idle();
  assert.equal(f.store.status(approval).status, "published");
  assert.equal(f.calls.filter(([method]) => method === "POST").length, 2);
});

test("temporary verification retries in two seconds and retains completed image checks", async (t) => {
  const f = await ipfsFixture(t), approval = await f.approval();
  await f.store.accept(approval);
  const verify = f.publisher.verifyObject;
  f.publisher.verifyObject = async (content) => {
    if (content.mime === "application/json") throw new Error("Temporary gateway failure");
    return verify(content);
  };
  const worker = f.worker(); worker.kick(); await worker.idle();
  assert.equal(f.store.status(approval).progress.image, "verified");
  assert.equal(f.store.get(approval.id).next_check - f.store.clock(), 2000);
  const calls = f.calls.length;
  f.advance(1999); worker.kick(); await worker.idle(); assert.equal(f.calls.length, calls);
  f.advance(1); f.publisher.verifyObject = verify; worker.kick(); await worker.idle();
  assert.equal(f.store.status(approval).status, "published");
  assert.equal(f.calls.filter(([method]) => method === "POST").length, 2);
  assert.equal(f.calls.filter(([method, cid]) => method === "PIN" && cid === approval.ipfs.imageCid).length, 1);
  assert.equal(f.calls.filter(([method, cid]) => method === "GET" && cid === approval.ipfs.imageCid).length, 1);
});

test("provider budget cooldown overrides fast retry and prevents further requests", async (t) => {
  const f = await ipfsFixture(t), approval = await f.approval();
  await f.store.accept(approval);
  f.store.budget.debit([["pinata-requests", 20, 60000]], 20);
  const worker = f.worker(); worker.kick(); await worker.idle();
  const next = f.store.get(approval.id).next_check;
  assert.ok(next >= (Math.floor(f.store.clock() / 60000) + 1) * 60000);
  f.advance(1000); worker.kick(); await worker.idle();
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.get(approval.id).next_check, next);
});

test("a publication arriving during another upload is drained without waiting for the timer", async (t) => {
  const f = await ipfsFixture(t), first = await f.approval();
  await f.store.accept(first);
  const pin = f.publisher.pinObject;
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.publisher.pinObject = async (content) => { entered(); await gate; return pin(content); };
  const worker = f.worker(); worker.kick(); await started;
  const other = privateKeyToAccount(generatePrivateKey());
  const preview = await f.store.challenge(other.address, f.image, { ...draft, name: "Second" });
  const second = { ...preview, wallet: other.address, image: f.image, draft: { ...draft, name: "Second" },
    signature: await other.signMessage({ message: preview.message }) };
  await f.store.accept(second); worker.kick(); release(); await worker.idle();
  assert.equal(f.store.status(first).status, "published");
  assert.equal(f.store.status(second).status, "published");
  assert.equal(f.calls.filter(([method]) => method === "POST").length, 4);
});
