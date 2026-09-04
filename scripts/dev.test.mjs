import assert from "node:assert/strict";
import test from "node:test";
import {
  childShutdownSignal,
  resolveDevSettings,
  signalChild,
  waitForHealth,
} from "./dev.mjs";

test("dev settings keep the web origin and API proxy port aligned", () => {
  assert.deepEqual(resolveDevSettings(), {
    appOrigin: "http://127.0.0.1:3000",
    apiPort: 8787,
    webHost: "127.0.0.1",
    webPort: 3000,
  });
  assert.deepEqual(
    resolveDevSettings({}, {
      APP_ORIGIN: "http://localhost:3100",
      READ_SERVICE_PORT: "8888",
    }),
    {
      appOrigin: "http://localhost:3100",
      apiPort: 8888,
      webHost: "localhost",
      webPort: 3100,
    },
  );
  assert.equal(
    resolveDevSettings(
      { READ_SERVICE_PORT: "8999" },
      { READ_SERVICE_PORT: "8888" },
    ).apiPort,
    8999,
  );
});

test("dev settings reject origins and ports that cannot form one local stack", () => {
  for (const local of [
    { APP_ORIGIN: "https://localhost:3000" },
    { APP_ORIGIN: "http://127.0.0.1:3000/" },
    { APP_ORIGIN: "http://0.0.0.0:3000" },
    { APP_ORIGIN: "http://127.0.0.1" },
    { READ_SERVICE_PORT: "invalid" },
    { READ_SERVICE_PORT: "3000" },
  ])
    assert.throws(() => resolveDevSettings({}, local));
});

test("readiness waits through unavailable responses and requires HTTP 200", async () => {
  const statuses = [503, 200];
  const calls = [];
  await waitForHealth("http://127.0.0.1:8787/healthz", {
    intervalMs: 1,
    timeoutMs: 1000,
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return new Response(null, { status: statuses.shift() });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://127.0.0.1:8787/healthz");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.redirect, "error");
});

test("the supervisor signals isolated process groups exactly once", () => {
  const calls = [];
  const child = {
    pid: 1234,
    kill(signal) {
      calls.push(["child", signal]);
    },
  };
  signalChild(child, "SIGINT", {
    platform: "darwin",
    kill: (pid, signal) => calls.push([pid, signal]),
  });
  assert.deepEqual(calls, [[-1234, "SIGINT"]]);
  signalChild(child, "SIGTERM", { platform: "win32" });
  assert.deepEqual(calls[1], ["child", "SIGTERM"]);
  assert.equal(childShutdownSignal("SIGINT"), "SIGINT");
  assert.equal(childShutdownSignal("SIGHUP"), "SIGTERM");
});
