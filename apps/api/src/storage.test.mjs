import assert from "node:assert/strict";
import test from "node:test";
import { verifyProductionMount, verifyProductionStorage } from "./storage.mjs";
import { initializeBudget } from "./init-budget.mjs";

const mount = "35 22 252:1 / /data rw,relatime - ext4 /dev/vdb rw";
const fs = (overrides = {}) => ({
  readFileSync: () => mount,
  realpathSync: (path) => path,
  lstatSync: (path) => ({
    isDirectory: () => path === "/data",
    isFile: () => path === "/data/read-budget.sqlite",
  }),
  ...overrides,
});

test("production requires one writable disk-backed mount at the exact data directory", () => {
  assert.doesNotThrow(() => verifyProductionMount(fs()));
  for (const value of [
    mount.replace("ext4", "xfs"),
    mount.replace("ext4", "btrfs"),
    mount.replace(" - ", " shared:12 master:1 - "),
  ])
    assert.doesNotThrow(() => verifyProductionMount(fs({ readFileSync: () => value })));
  for (const value of [
    "",
    mount.replace("/data", "/elsewhere"),
    mount.replace("ext4", "tmpfs"),
    mount.replace("ext4", "ramfs"),
    mount.replace("ext4", "overlay"),
    mount.replace("/dev/vdb", "overlay"),
    mount.replace("rw,relatime", "ro,relatime"),
    mount.replace("/dev/vdb rw", "/dev/vdb ro"),
    `${mount}\n${mount.replace("ext4", "tmpfs")}`,
    "invalid /data mount record",
  ])
    assert.throws(() => verifyProductionMount(fs({ readFileSync: () => value })), {
      code: "persistent_budget_storage_required",
    });
  assert.throws(() => verifyProductionMount(fs({ realpathSync: () => "/elsewhere" })));
  assert.throws(() =>
    verifyProductionMount(fs({ lstatSync: () => ({ isDirectory: () => false }) })),
  );
});

test("missing mount metadata fails closed and schema failure never retries initialization", () => {
  assert.throws(() =>
    verifyProductionMount(
      fs({
        readFileSync: () => {
          throw new Error("missing mount metadata");
        },
      }),
    ),
  );
  let creates = 0;
  assert.throws(() =>
    initializeBudget({
      verifyMount: () => {},
      openFile: () => {
        creates++;
        return 7;
      },
      closeFile: () => {},
      createBudget: () => {
        throw new Error("schema unavailable");
      },
    }),
  );
  assert.equal(creates, 1);
});

test("normal startup additionally requires an existing regular file at the exact budget path", () => {
  assert.doesNotThrow(() => verifyProductionStorage("/data/read-budget.sqlite", fs()));
  assert.throws(() => verifyProductionStorage("/data/other.sqlite", fs()));
  assert.throws(() =>
    verifyProductionStorage(
      "/data/read-budget.sqlite",
      fs({
        realpathSync: (path) => (path === "/data" ? path : "/elsewhere"),
      }),
    ),
  );
  assert.throws(() =>
    verifyProductionStorage(
      "/data/read-budget.sqlite",
      fs({
        lstatSync: () => ({ isDirectory: () => true, isFile: () => false }),
      }),
    ),
  );
});

test("initialization verifies the mount before creating a private, exclusive database file", () => {
  const events = [];
  initializeBudget({
    verifyMount: () => events.push("verify"),
    openFile: (path, flags, mode) => {
      assert.equal(path, "/data/read-budget.sqlite");
      assert.equal(flags, "wx");
      assert.equal(mode, 0o600);
      events.push("create");
      return 7;
    },
    closeFile: (fd) => {
      assert.equal(fd, 7);
      events.push("close-file");
    },
    createBudget: () => {
      events.push("initialize");
      return { close: () => events.push("close-budget") };
    },
  });
  assert.deepEqual(events, ["verify", "create", "close-file", "initialize", "close-budget"]);
});

test("unverified mount cannot create quota state and an existing file cannot be reset", () => {
  assert.throws(() =>
    initializeBudget({
      verifyMount: () => {
        throw new Error("mount unavailable");
      },
      openFile: () => assert.fail("must not create a file"),
    }),
  );
  assert.throws(() =>
    initializeBudget({
      verifyMount: () => {},
      openFile: () => {
        throw new Error("file exists");
      },
      createBudget: () => assert.fail("must not reset quota state"),
    }),
  );
});
