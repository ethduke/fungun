#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { apiEnvironment } from "../apps/api/src/runtime-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOrigin = "http://127.0.0.1:3000";
const defaultApiPort = 8787;
const isolateProcessGroups = process.platform !== "win32";

function selected(name, inherited, local) {
  const source = Object.hasOwn(inherited, name) ? inherited : local;
  return typeof source[name] === "string" ? source[name] : "";
}

export function resolveDevSettings(inherited = {}, local = {}) {
  const origin = selected("APP_ORIGIN", inherited, local) || defaultOrigin;
  let app;
  try {
    app = new URL(origin);
  } catch {
    throw new Error("APP_ORIGIN must be an exact local HTTP origin.");
  }
  if (
    app.origin !== origin ||
    app.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(app.hostname) ||
    !/^\d+$/.test(app.port)
  )
    throw new Error("APP_ORIGIN must be an exact local HTTP origin with a port.");
  const webPort = Number(app.port);
  const apiPort = Number(
    selected("READ_SERVICE_PORT", inherited, local) || defaultApiPort,
  );
  if (
    !Number.isInteger(webPort) ||
    webPort < 1024 ||
    webPort > 65535 ||
    !Number.isInteger(apiPort) ||
    apiPort < 1024 ||
    apiPort > 65535 ||
    apiPort === webPort
  )
    throw new Error("Web and read-service ports must be distinct local ports.");
  return {
    appOrigin: origin,
    apiPort,
    webHost: app.hostname,
    webPort,
  };
}

function pause(ms, signal) {
  return new Promise((resolvePause, rejectPause) => {
    if (signal?.aborted) return rejectPause(new Error("Readiness check stopped."));
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolvePause();
    }
    function aborted() {
      clearTimeout(timer);
      rejectPause(new Error("Readiness check stopped."));
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export async function waitForHealth(
  url,
  {
    fetcher = fetch,
    timeoutMs = 15_000,
    intervalMs = 100,
    signal,
  } = {},
) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (signal?.aborted) throw new Error("Readiness check stopped.");
    const remaining = Math.max(1, deadline - performance.now());
    const timeout = AbortSignal.timeout(
      Math.max(1, Math.ceil(Math.min(1000, remaining))),
    );
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetcher(url, {
        cache: "no-store",
        redirect: "error",
        signal: requestSignal,
      });
      await response.body?.cancel();
      if (response.status === 200) return;
    } catch {
      if (signal?.aborted) throw new Error("Readiness check stopped.");
    }
    await pause(Math.min(intervalMs, Math.max(1, deadline - performance.now())), signal);
  }
  throw new Error("Read service did not become ready in time.");
}

function loadLocalEnvironment() {
  try {
    return parseEnv(readFileSync(resolve(root, ".env"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error("The ignored local environment file could not be loaded.");
  }
}

export function webEnvironment(inherited, settings) {
  const environment = {
    NODE_ENV: "development",
    APP_ORIGIN: settings.appOrigin,
    READ_SERVICE_PORT: String(settings.apiPort),
  };
  // Add only reviewed public settings. Never inherit arbitrary shell variables,
  // public-prefix variables, Node injection options, or provider credentials.
  for (const name of [
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ",
    "CODEX_SANDBOX",
    "READ_SERVICE_ORIGIN", "ASSET_SERVICE_ORIGIN", "ASSET_PUBLIC_ORIGIN",
    "ASSET_UPLOADS", "ASSET_STORAGE", "PINATA_GATEWAY", "IMAGE_USDG_ADDRESS",
  ])
    if (Object.hasOwn(inherited, name) && typeof inherited[name] === "string")
      environment[name] = inherited[name];
  return environment;
}

export function startWebProcess(settings, inherited = process.env, spawnProcess = spawn) {
  return spawnProcess(
    process.execPath,
    ["node_modules/vinext/dist/cli.js", "dev", "--hostname", settings.webHost,
      "--port", String(settings.webPort)],
    {
      cwd: resolve(root, "apps/web"),
      env: webEnvironment(inherited, settings),
      detached: isolateProcessGroups,
      stdio: "inherit",
    },
  );
}

export function signalChild(
  child,
  signal,
  { platform = process.platform, kill = process.kill } = {},
) {
  if (platform !== "win32" && Number.isInteger(child.pid) && child.pid > 0)
    return kill(-child.pid, signal);
  return child.kill(signal);
}

export function childShutdownSignal(signal) {
  return signal === "SIGHUP" ? "SIGTERM" : signal;
}

export async function runDev() {
  if (process.argv.length > 2)
    throw new Error("Set APP_ORIGIN and READ_SERVICE_PORT instead of passing dev-server arguments.");
  const local = loadLocalEnvironment();
  const settings = resolveDevSettings(process.env, local);
  const inherited = {
    ...process.env,
    NODE_ENV: "development",
    APP_ORIGIN: settings.appOrigin,
    READ_SERVICE_PORT: String(settings.apiPort),
  };
  const children = new Map();
  const processGroups = new Set();
  const ready = new AbortController();
  const finished = Promise.withResolvers();
  const signalHandlers = new Map();
  let stopping = false;
  let result = 0;
  let forcedStop;

  const signalAll = (signal) => {
    const targets = isolateProcessGroups
      ? [...processGroups].map((pid) => ({ pid }))
      : [...children.keys()];
    for (const child of targets) {
      try {
        signalChild(child, signal);
      } catch {
        // The process or process group already exited.
      }
    }
  };
  const finishIfStopped = () => {
    if (stopping && children.size === 0) {
      // A leader may exit before one of its helper processes. No process from a
      // completed dev stack should outlive the supervisor.
      signalAll("SIGKILL");
      finished.resolve();
    }
  };
  const stop = (code, signal = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    result = code;
    ready.abort();
    signalAll(signal);
    finishIfStopped();
    if (children.size)
      forcedStop = setTimeout(() => {
        signalAll("SIGKILL");
      }, 30_000).unref();
  };
  const watch = (child, label) => {
    children.set(child, label);
    if (isolateProcessGroups && Number.isInteger(child.pid) && child.pid > 0)
      processGroups.add(child.pid);
    child.once("error", () => {
      if (!stopping) {
        console.error(`${label} could not start.`);
        stop(1);
      }
    });
    child.once("close", (code) => {
      children.delete(child);
      if (!stopping) {
        if (code === 0) {
          console.log(`${label} stopped; shutting down the local stack.`);
          stop(0);
        } else {
          console.error(`${label} stopped unexpectedly.`);
          stop(Number.isInteger(code) && code > 0 ? code : 1);
        }
      }
      finishIfStopped();
    });
  };

  const handledSignals = isolateProcessGroups
    ? ["SIGINT", "SIGTERM", "SIGHUP"]
    : ["SIGINT", "SIGTERM"];
  for (const signal of handledSignals) {
    const handler = () => {
      if (stopping) signalAll("SIGKILL");
      else stop(0, childShutdownSignal(signal));
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  const exitHandler = () => {
    signalAll("SIGTERM");
  };
  process.once("exit", exitHandler);
  let failure;
  try {
    console.log(`Starting read service on port ${settings.apiPort}…`);
    const api = spawn(process.execPath, ["src/server.mjs"], {
      cwd: resolve(root, "apps/api"),
      env: apiEnvironment(inherited, local),
      detached: isolateProcessGroups,
      stdio: "inherit",
    });
    watch(api, "Read service");
    try {
      await waitForHealth(`http://127.0.0.1:${settings.apiPort}/healthz`, {
        signal: ready.signal,
      });
    } catch {
      if (!stopping) {
        console.error("Read service failed its local readiness check.");
        stop(1);
      }
    }

    if (!stopping) {
      console.log(`Read service ready; starting web app at ${settings.appOrigin}…`);
      const web = startWebProcess(settings);
      watch(web, "Web app");
    }

    await finished.promise;
  } catch (error) {
    failure = error;
    stop(1);
    await finished.promise;
  } finally {
    clearTimeout(forcedStop);
    process.removeListener("exit", exitHandler);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  }
  if (failure) throw failure;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runDev()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error("Local development services could not start.");
      process.exitCode = 1;
    });
