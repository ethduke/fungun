import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget } from "./budget.mjs";

test("production refuses missing quota state instead of recreating it", () => {
  const directory = mkdtempSync(join(tmpdir(), "fungun-budget-schema-"));
  const path = join(directory, "test.sqlite");
  const initial = new Budget(path);
  initial.debit([["spent", 1, 60_000]]);
  initial.close();
  const valid = new Budget(path, Date.now, false);
  assert.throws(() => valid.debit([["spent", 1, 60_000]]));
  valid.db.exec("DROP TABLE counters");
  valid.close();
  try {
    assert.throws(() => new Budget(path, Date.now, false), { code: "budget_storage_unavailable" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("durable budget survives restart and cannot refill after clock rollback", () => {
  const directory = mkdtempSync(join(tmpdir(), "fungun-budget-"));
  const path = join(directory, "test.sqlite");
  let now = 60_000;
  let budget = new Budget(path, () => now);
  try {
    budget.debit([["test", 1, 60_000]]);
    assert.throws(() => budget.debit([["test", 1, 60_000]]), { code: "rate_limited" });
    budget.close();
    budget = new Budget(path, () => now);
    assert.throws(() => budget.debit([["test", 1, 60_000]]), { code: "rate_limited" });
    now = 120_000;
    budget.debit([["test", 1, 60_000]]);
    now = 60_000;
    assert.throws(() => budget.debit([["test", 1, 60_000]]), { code: "rate_limited" });
  } finally {
    budget.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("all allowances debit atomically with separate minute and daily counters", () => {
  const budget = new Budget(":memory:", () => 10);
  try {
    budget.debit([
      ["shared", 2, 60_000],
      ["shared", 1, 86_400_000],
    ]);
    assert.throws(() =>
      budget.debit([
        ["shared", 2, 60_000],
        ["shared", 1, 86_400_000],
      ]),
    );
    assert.deepEqual(
      budget.db
        .prepare("SELECT used FROM counters ORDER BY scope")
        .all()
        .map((r) => r.used),
      [1, 1],
    );
  } finally {
    budget.close();
  }
});

test("request fairness limits and provider caps do not store raw client IPs", () => {
  const budget = new Budget(":memory:");
  try {
    for (let i = 0; i < 20; i++) budget.request("synthetic-client", true);
    assert.throws(() => budget.request("synthetic-client", true), { status: 429 });
    assert.ok(
      !JSON.stringify(budget.db.prepare("SELECT * FROM counters").all()).includes(
        "synthetic-client",
      ),
    );
    for (let i = 0; i < 180; i++) budget.upstream("o1");
    assert.throws(() => budget.upstream("rpc"), { status: 429 });
  } finally {
    budget.close();
  }
});

test('a fee refresh and launch preflights fit together while burst and daily caps remain bounded', () => {
  let now = 10;
  const budget = new Budget(':memory:', () => now);
  try {
    // Fee scan plus launch/claim checks exceeds the former 60-read cap.
    for (let i = 0; i < 6; i++) budget.upstream('rpc', 30);
    assert.throws(() => budget.upstream('rpc'), { code: 'rate_limited' });
    for (let i = 180; i < 1400; i++) {
      if (i % 100 === 80) now += 60000;
      budget.upstream('rpc');
    }
    now += 60000;
    assert.throws(() => budget.upstream('rpc'), { code: 'rate_limited' });
    for (let i = 0; i < 600; i++) {
      if (i % 100 === 0) now += 60000;
      budget.upstream('o1');
    }
    now += 60000;
    assert.throws(() => budget.upstream('market'), { code: 'rate_limited' });
  } finally { budget.close(); }
});
