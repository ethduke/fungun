import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import sharp from "sharp";
import { Budget } from "./budget.mjs";
import { AssetStore, initializeAssetStore } from "./asset-store.mjs";
import { maintainAssets, maintenanceArguments } from "./asset-maintenance.mjs";

const draft = { name: "Moon", ticker: "MOON", description: "" };
async function fixture(t, legacy = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fungun-asset-maintenance-")));
  let current = 1800000000000;
  const now = () => current;
  if (legacy) {
    const budget = new Budget(join(root, "assets.sqlite"), now);
    budget.db.exec(readFileSync(new URL("../migrations/001-assets.sql", import.meta.url), "utf8"));
    const insert = budget.db.prepare("INSERT INTO settings VALUES (?, ?)");
    for (const [key, value] of [
      ["asset-schema", "1"],
      ["asset-bytes", "0"],
      ["asset-origin", "https://assets.example.com"],
      ["asset-app-origin", "https://web.example.com"],
    ])
      insert.run(key, value);
    budget.close();
    const { chmodSync } = await import("node:fs");
    chmodSync(join(root, "assets.sqlite"), 0o600);
    mkdirSync(join(root, "objects"), { mode: 0o700 });
  } else initializeAssetStore(root, false, now);
  const opened = [];
  const config = {
    root,
    now,
    publicOrigin: "https://assets.example.com",
    appOrigin: "https://web.example.com",
  };
  const open = () => {
    const store = new AssetStore(config);
    opened.push(store);
    return store;
  };
  t.after(() => {
    for (const store of opened) store.close();
    rmSync(root, { recursive: true });
  });
  const account = privateKeyToAccount(generatePrivateKey());
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } })
    .webp()
    .toBuffer();
  const execute = (mode, extra = {}) =>
    maintainAssets({ root, now, mode, execute: true, serviceStopped: true, ...extra });
  return {
    root,
    now,
    config,
    open,
    execute,
    account,
    image,
    advance: (ms) => {
      current += ms;
    },
  };
}
function preserved(store) {
  return {
    settings: store.db.prepare("SELECT * FROM settings WHERE name != 'clock' ORDER BY name").all(),
    counters: store.db.prepare("SELECT * FROM counters ORDER BY scope").all(),
    objects: store.db.prepare("SELECT * FROM asset_objects ORDER BY name").all(),
    files: readdirSync(store.directory).map((name) => [
      name,
      readFileSync(join(store.directory, name)).toString("base64"),
    ]),
  };
}
const query = (approval, wallet) => ({
  id: approval.id,
  wallet,
  imageHash: approval.imageHash,
  metadataHash: approval.metadataHash,
});

test("maintenance defaults to read-only and requires explicit offline write flags", async (t) => {
  assert.deepEqual(maintenanceArguments([]), {
    mode: "inspect",
    execute: false,
    serviceStopped: false,
  });
  for (const args of [
    ["--execute"],
    ["--expire-pending", "--execute"],
    ["--inspect", "--execute", "--service-stopped"],
    ["--expire-pending", "--expire-pending"],
    ["--unknown"],
  ])
    assert.throws(() => maintenanceArguments(args));
  const { root, now, open, account, image, advance, execute } = await fixture(t);
  const store = open();
  const approval = store.challenge(account.address, image, draft);
  advance(300001);
  const before = preserved(store);
  const clock = store.db.prepare("SELECT value FROM settings WHERE name='clock'").get().value;
  const planned = maintainAssets({ root, now, mode: "expire-pending" });
  assert.equal(planned.eligible, 1);
  assert.equal(planned.changed, 0);
  assert.equal(store.status(query(approval, account.address)).status, "pending");
  assert.deepEqual(preserved(store), before);
  assert.equal(
    store.db.prepare("SELECT value FROM settings WHERE name='clock'").get().value,
    clock,
  );
  assert.throws(() => execute("expire-pending", { serviceStopped: false }));
});

test("explicit schema migration preserves data and startup refuses unmigrated storage", async (t) => {
  const { root, now, config, open, execute } = await fixture(t, true);
  assert.throws(() => new AssetStore(config), { code: "asset_migration_required" });
  const db = new DatabaseSync(join(root, "assets.sqlite"));
  t.after(() => db.close());
  const columns = [
    randomBytes(24).toString("hex"),
    ...Array.from({ length: 3 }, () => randomBytes(32).toString("hex")),
    12,
    now(),
    now() + 300000,
    "pending",
  ];
  db.prepare("INSERT INTO asset_challenges VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(...columns);
  const rows = db.prepare("SELECT * FROM asset_challenges").all();
  const settings = db
    .prepare("SELECT * FROM settings WHERE name != 'asset-schema' ORDER BY name")
    .all();
  assert.equal(maintainAssets({ root, now, mode: "migrate-schema" }).schema, 1);
  assert.throws(() => execute("expire-pending"), { code: "asset_migration_required" });
  assert.equal(execute("migrate-schema").schema, 2);
  assert.equal(execute("migrate-schema").changed, 0);
  assert.deepEqual(db.prepare("SELECT * FROM asset_challenges").all(), rows);
  assert.deepEqual(
    db.prepare("SELECT * FROM settings WHERE name != 'asset-schema' ORDER BY name").all(),
    settings,
  );
  assert.equal(
    open().db.prepare("SELECT value FROM settings WHERE name = 'asset-schema'").get().value,
    "2",
  );
});

test("terminal expiry preserves quotas/files and remains final after restart and clock rollback", async (t) => {
  const { open, execute, account, image, advance } = await fixture(t);
  const store = open();
  const approval = store.challenge(account.address, image, draft);
  const request = {
    id: approval.id,
    wallet: account.address,
    image,
    draft,
    signature: await account.signMessage({ message: approval.message }),
  };
  advance(300000);
  assert.equal(execute("expire-pending").changed, 0);
  advance(1);
  const before = preserved(store);
  assert.equal(execute("expire-pending").changed, 1);
  assert.equal(execute("expire-pending").changed, 0);
  assert.deepEqual(preserved(store), before);
  const again = open();
  assert.deepEqual(again.status(query(approval, account.address)), {
    id: approval.id,
    status: "expired",
    imageHash: approval.imageHash,
    metadataHash: approval.metadataHash,
  });
  advance(-300001);
  await assert.rejects(again.publish(request), { code: "asset_approval_expired" });
  assert.equal(again.status(query(approval, account.address)).status, "expired");
  assert.throws(() => execute("expire-pending"), { code: "asset_clock_unavailable" });
  assert.deepEqual(preserved(store), before);
});

test("failed schema migration rolls back its DDL, indexes, rows and settings", async (t) => {
  const { root, now, execute } = await fixture(t, true);
  const db = new DatabaseSync(join(root, "assets.sqlite"));
  t.after(() => db.close());
  db.prepare("INSERT INTO asset_challenges VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    randomBytes(24).toString("hex"), ...Array.from({ length: 3 }, () => randomBytes(32).toString("hex")),
    12, now(), now() + 300000, "pending",
  );
  db.exec("CREATE TRIGGER reject_schema BEFORE UPDATE ON settings WHEN NEW.name = 'asset-schema' AND NEW.value = '2' BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END");
  const snapshot = () => ({
    schema: db.prepare("SELECT name, type, sql FROM sqlite_schema ORDER BY name").all(),
    rows: db.prepare("SELECT * FROM asset_challenges ORDER BY id").all(),
    settings: db.prepare("SELECT * FROM settings ORDER BY name").all(),
    counters: db.prepare("SELECT * FROM counters ORDER BY scope").all(),
  });
  const before = snapshot();
  assert.throws(() => execute("migrate-schema"));
  assert.deepEqual(snapshot(), before);
});

test("expiry wins an in-flight signature race without publication or quota charges", async (t) => {
  const { open, execute, account, image, advance } = await fixture(t);
  const store = open();
  const approval = store.challenge(account.address, image, draft);
  const signature = await account.signMessage({ message: approval.message });
  const before = preserved(store);
  const pending = store.publish({
    id: approval.id,
    wallet: account.address,
    image,
    draft,
    signature,
  });
  advance(300001);
  assert.equal(execute("expire-pending").changed, 1);
  await assert.rejects(pending, { code: "asset_approval_expired" });
  assert.deepEqual(preserved(store), before);
  assert.equal(store.status(query(approval, account.address)).status, "expired");
});

test("maintenance leaves reserved failures and published receipts untouched", async (t) => {
  const { open, execute, account, image, advance } = await fixture(t);
  const store = open();
  const good = store.challenge(account.address, image, draft);
  const request = {
    id: good.id,
    wallet: account.address,
    image,
    draft,
    signature: await account.signMessage({ message: good.message }),
  };
  const published = await store.publish(request);
  const badDraft = { ...draft, name: "Other" };
  const bad = store.challenge(account.address, image, badDraft);
  writeFileSync(join(store.directory, `${bad.metadataHash}.json`), "invalid");
  await assert.rejects(
    store.publish({
      id: bad.id,
      wallet: account.address,
      image,
      draft: badDraft,
      signature: await account.signMessage({ message: bad.message }),
    }),
  );
  const before = preserved(store);
  advance(300001);
  assert.equal(execute("expire-pending").changed, 0);
  assert.equal(store.status(query(bad, account.address)).status, "uncertain");
  assert.deepEqual(await store.publish(request), published);
  assert.deepEqual(preserved(store), before);
  assert.throws(() =>
    store.status({ ...query(good, account.address), id: randomBytes(24).toString("hex") }),
  );
});

test("publication rechecks expiry inside its reservation transaction", async (t) => {
  const { open, account, image, advance } = await fixture(t);
  const store = open();
  const approval = store.challenge(account.address, image, draft);
  const debit = store.budget.debit.bind(store.budget);
  store.budget.debit = (...args) => {
    debit(...args);
    advance(300001);
  };
  await assert.rejects(
    store.publish({
      id: approval.id,
      wallet: account.address,
      image,
      draft,
      signature: await account.signMessage({ message: approval.message }),
    }),
    { code: "asset_approval_expired" },
  );
  assert.equal(store.db.prepare("SELECT state FROM asset_challenges").get().state, "pending");
  assert.equal(
    store.db.prepare("SELECT value FROM settings WHERE name='asset-bytes'").get().value,
    "0",
  );
  assert.deepEqual(readdirSync(store.directory), []);
});

test("maintenance failures roll back atomically and never repair missing quota state", async (t) => {
  const { open, execute, account, image, advance } = await fixture(t);
  const store = open();
  store.challenge(account.address, image, draft);
  advance(300001);
  const before = preserved(store);
  store.db.exec(
    "CREATE TRIGGER block_expiry BEFORE UPDATE OF state ON asset_challenges BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
  );
  assert.throws(() => execute("expire-pending"));
  assert.equal(store.db.prepare("SELECT state FROM asset_challenges").get().state, "pending");
  assert.deepEqual(preserved(store), before);
  store.db.prepare("DELETE FROM settings WHERE name = 'asset-bytes'").run();
  assert.throws(() => execute("expire-pending"), { code: "asset_storage_unavailable" });
  assert.equal(
    store.db.prepare("SELECT value FROM settings WHERE name='asset-bytes'").get(),
    undefined,
  );
});

test("history survives new previews and reaches a bounded admission ceiling", async (t) => {
  const { open, execute, account, image, advance } = await fixture(t);
  const store = open();
  const first = store.challenge(account.address, image, draft);
  advance(300001);
  store.challenge(account.address, image, draft);
  assert.equal(store.status(query(first, account.address)).status, "pending");
  execute("expire-pending");
  const row = store.db.prepare("SELECT * FROM asset_challenges WHERE id = ?").get(first.id);
  const insert = store.db.prepare("INSERT INTO asset_challenges VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  store.db.exec("BEGIN");
  for (let index = 2; index < 4096; index++)
    insert.run(
      randomBytes(24).toString("hex"),
      row.owner,
      row.image_hash,
      row.metadata_hash,
      row.bytes,
      row.created,
      row.expires,
      "expired",
    );
  store.db.exec("COMMIT");
  assert.throws(() => store.challenge(account.address, image, draft), {
    code: "asset_history_full",
  });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM asset_challenges").get().n, 4096);
  assert.equal(
    open().db.prepare("SELECT value FROM settings WHERE name='asset-bytes'").get().value,
    "0",
  );
});
