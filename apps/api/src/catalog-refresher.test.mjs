import assert from "node:assert/strict";
import test from "node:test";
import { createCatalogRefresher } from "./catalog-refresher.mjs";

test("catalog refresher is server-driven, coalesced and disabled by default", async () => {
  const calls = [];
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const adapters = {
    async refreshCatalog(chainId) {
      calls.push(chainId);
      if (chainId === 4663) await waiting;
    },
  };
  const disabled = createCatalogRefresher(adapters);
  disabled.kick();
  await disabled.idle();
  assert.deepEqual(calls, []);

  const enabled = createCatalogRefresher(adapters, { enabled: true, intervalMs: 60_000 });
  enabled.kick();
  enabled.kick();
  assert.deepEqual(calls, [4663]);
  release();
  await enabled.idle();
  assert.deepEqual(calls, [4663, 8453]);
  await enabled.stop();
});

test("catalog refresher keeps provider failures inside the worker", async () => {
  let calls = 0;
  const refresher = createCatalogRefresher(
    {
      async refreshCatalog() {
        calls++;
        throw new Error("private provider response");
      },
    },
    { enabled: true, chains: [4663], intervalMs: 60_000 },
  );
  refresher.kick();
  await refresher.idle();
  assert.equal(calls, 1);
  await refresher.stop();
});
