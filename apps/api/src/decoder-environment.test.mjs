import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { verifyDecoderEnvironment } from "./decoder-runtime.mjs";

test("decoder accepts only the exact non-secret Fly private-IP field", () => {
  for (const address of ["fdaa::1", "FDAA:0:0:0:0:0:0:2"])
    assert.doesNotThrow(() => verifyDecoderEnvironment({ NODE_ENV: "production", FLY_PRIVATE_IP: address }));
  assert.doesNotThrow(() => verifyDecoderEnvironment({ NODE_ENV: "production" }));
  for (const value of ["", undefined, "127.0.0.1", "::1", "2001:db8::1", "fdaa::1%eth0", "https://example.com", randomBytes(32).toString("hex")])
    assert.throws(() => verifyDecoderEnvironment({ FLY_PRIVATE_IP: value }), /Invalid decoder platform metadata/);
});

test("Fly metadata exemption never admits credential-like names or leaks values", () => {
  const value = randomBytes(32).toString("hex");
  for (const name of ["FLY_PRIVATE_IP_EXTRA", "fly_private_ip", "PRIVATE_KEY", "RPC_HTTP_URL", "O1_API_KEY",
    "XAI_API_KEY", "FLY_API_TOKEN", "AWS_SECRET_ACCESS_KEY", "PASSWORD", "AUTHORIZATION", "WALLET", "SEED_PHRASE"]) {
    assert.throws(() => verifyDecoderEnvironment({ FLY_PRIVATE_IP: "fdaa::1", [name]: value }),
      (error) => error.message === "Unexpected decoder credentials." && !error.message.includes(value));
  }
});
