import test from "node:test";
import assert from "node:assert/strict";
import { assessDecoderIsolation } from "./decoder-diagnostics.mjs";

const evidence = { baseline: true, status: "CapEff:\t0000000000000000\nNoNewPrivs:\t1\n",
  mounts: "1 2 0:1 / / ro,nosuid - overlay overlay ro\n", memory: String(512 * 1024 * 1024) };

test("decoder diagnostics reports local hardening without claiming network or publication readiness", () => {
  assert.deepEqual(assessDecoderIsolation(evidence), { baselineRuntime: true, effectiveCapabilitiesDropped: true,
    noNewPrivileges: true, rootReadOnly: true, memoryCapped: true, networkIsolation: "unverified", publicationReady: false });
  assert.equal(assessDecoderIsolation({ ...evidence, networkIsolation: "verified", publicationReady: true }).publicationReady, false);
});

test("missing and unsafe runtime evidence fails closed", () => {
  assert.deepEqual(assessDecoderIsolation(), { baselineRuntime: false, effectiveCapabilitiesDropped: false,
    noNewPrivileges: false, rootReadOnly: false, memoryCapped: false, networkIsolation: "unverified", publicationReady: false });
  for (const memory of ["max", "", "-1", "0", "536870913", "1e6", "9007199254740993"])
    assert.equal(assessDecoderIsolation({ ...evidence, memory }).memoryCapped, false);
  assert.equal(assessDecoderIsolation({ ...evidence, status: "CapEff:\t0000000000000001\nNoNewPrivs:\t0\n" }).effectiveCapabilitiesDropped, false);
  assert.equal(assessDecoderIsolation({ ...evidence, status: "CapEff:\t0000000000000001\nNoNewPrivs:\t0\n" }).noNewPrivileges, false);
  assert.equal(assessDecoderIsolation({ ...evidence, mounts: "1 2 0:1 / / rw - overlay overlay rw\n" }).rootReadOnly, false);
});
