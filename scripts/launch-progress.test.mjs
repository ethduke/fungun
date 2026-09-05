import test from "node:test";
import assert from "node:assert/strict";
import { launchActivity } from "../apps/web/lib/launch-progress.ts";

const state = { busy: "", error: "", recovery: null };
const submitted = { hash: "submitted-transaction" };

test("artwork, fee estimation, wallet approval and receipt reads animate only while active", () => {
  for (const busy of [
    "Uploading artwork…",
    "Estimating launch fees…",
    "Approve launch in wallet…",
    "Checking confirmation…",
  ]) {
    const activity = launchActivity({ ...state, busy, recovery: { hash: null } });
    assert.equal(activity.animated, true);
    assert.equal(activity.label, busy);
    assert.notEqual(activity.phase, "confirmed");
  }
  assert.equal(launchActivity(state).animated, false);
});

test("a transaction hash and pending receipts never trigger the confirmed coin animation", () => {
  for (const receiptStatus of [undefined, "submitted", "confirming"]) {
    const activity = launchActivity({ ...state, recovery: submitted, receiptStatus });
    assert.equal(activity.phase, "pending");
    assert.equal(activity.animated, true);
  }
  assert.equal(
    launchActivity({ ...state, recovery: submitted, receiptStatus: "confirmed" }).phase,
    "confirmed",
  );
});

test("errors, failed receipts and uncertain recovery stop progress without declaring success", () => {
  for (const receiptStatus of ["prepared", "uncertain", "unexpected"]) {
    const activity = launchActivity({ ...state, recovery: submitted, receiptStatus });
    assert.equal(activity.phase, "uncertain");
    assert.equal(activity.animated, false);
  }
  assert.equal(launchActivity({ ...state, recovery: { hash: null } }).animated, false);
  const failed = launchActivity({ ...state, recovery: submitted, receiptStatus: "failed" });
  assert.equal(failed.phase, "failed");
  assert.equal(failed.animated, false);
  const error = launchActivity({
    ...state,
    busy: "Checking confirmation…",
    error: "Receipt unverified",
    recovery: submitted,
  });
  assert.equal(error.phase, "error");
  assert.equal(error.animated, false);
});
