import assert from "node:assert/strict";
import test from "node:test";
import {
  childShutdownSignal,
  resolveDevSettings,
  signalChild,
  startWebProcess,
  waitForHealth,
  webEnvironment,
} from "./dev.mjs";

test("the web child receives exactly the reviewed environment, never shell secrets", () => {
  const settings = resolveDevSettings({}, {
    APP_ORIGIN: "http://localhost:3100", READ_SERVICE_PORT: "8888",
  });
  const publicSettings = {
    PATH: "/usr/bin", HOME: "/synthetic-home", TMPDIR: "/tmp", TMP: "/tmp",
    TEMP: "/tmp", LANG: "en_US.UTF-8", LC_ALL: "C", TZ: "UTC",
    CODEX_SANDBOX: "seatbelt", READ_SERVICE_ORIGIN: "http://127.0.0.1:8888",
    ASSET_SERVICE_ORIGIN: "http://127.0.0.1:8788",
    ASSET_PUBLIC_ORIGIN: "https://assets.example.invalid", ASSET_UPLOADS: "enabled",
    ASSET_STORAGE: "ipfs", PINATA_GATEWAY: "example.mypinata.cloud",
    IMAGE_USDG_ADDRESS: `0x${"11".repeat(20)}`,
  };
  const forbidden = [
    "PINATA_JWT", "OPENROUTER_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY",
    "TELEGRAM_BOT_TOKEN", "O1_API_KEY",
    "BASE_RPC_URL", "ROBINHOOD_RPC_URL", "PRIVATE_KEY", "MNEMONIC",
    "X402_FACILITATOR_TOKEN", "X402_FACILITATOR_PRIVATE_KEY", "UNKNOWN_SECRET",
    "NEXT_PUBLIC_PINATA_JWT", "NEXT_PUBLIC_CUSTOM", "VITE_CUSTOM",
    "NODE_OPTIONS", "NODE_DEBUG", "DEBUG", "FUNGUN_WEB_TARGET",
    "WRANGLER_LOG", "WRANGLER_WRITE_LOGS", "CLOUDFLARE_API_TOKEN",
  ];
  const canary = ["synthetic", "shell", "credential"].join("-");
  const inherited = { ...publicSettings,
    ...Object.fromEntries(forbidden.map(name => [name, canary])),
    NODE_ENV: "production", APP_ORIGIN: "https://wrong.example.invalid",
    READ_SERVICE_PORT: "9999",
  };
  const calls = [];
  const child = {};
  assert.equal(startWebProcess(settings, inherited, (...args) => {
    calls.push(args);
    return child;
  }), child);
  assert.equal(calls.length, 1);
  const [command, args, options] = calls[0];
  assert.equal(command, process.execPath);
  assert.deepEqual(args, ["node_modules/vinext/dist/cli.js", "dev", "--hostname", "localhost", "--port", "3100"]);
  assert.deepEqual(options.env, { NODE_ENV: "development",
    APP_ORIGIN: settings.appOrigin, READ_SERVICE_PORT: "8888", ...publicSettings });
  assert.ok(!JSON.stringify(calls).includes(canary));
  assert.equal(inherited.PINATA_JWT, canary, "Filtering does not mutate the parent environment");
});

test("web environment ignores inherited properties and non-string values", () => {
  const inherited = Object.assign(Object.create({ PATH: "/inherited", ASSET_STORAGE: "ipfs" }), {
    HOME: "/synthetic-home", TMPDIR: undefined, LANG: 42, PINATA_GATEWAY: null,
  });
  assert.deepEqual(webEnvironment(inherited, resolveDevSettings()), {
    NODE_ENV: "development", APP_ORIGIN: "http://127.0.0.1:3000",
    READ_SERVICE_PORT: "8787", HOME: "/synthetic-home",
  });
});

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
