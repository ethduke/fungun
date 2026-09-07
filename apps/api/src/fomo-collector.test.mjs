import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { FomoCollector } from "./fomo-collector.mjs";
import { FomoStore, fomoUsers } from "./fomo-store.mjs";

function fixture(t, options = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  let time = 1_788_600_000_000;
  const store = new FomoStore(db, fomoUsers({ runn3rrr: "runn3rrr" }), () => time);
  const sockets = [],
    timers = [],
    logs = [];
  const collector = new FomoCollector(store, {
    logger: (entry) => logs.push(entry),
    key: "synthetic-private-key",
    enabled: true,
    now: () => time,
    random: () => 0.5,
    schedule(fn, ms) {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    cancel(timer) {
      if (timer) timer.cancelled = true;
    },
    socketFactory(url, opts) {
      assert.equal(store.attempts(), sockets.length + 1, "reserved durably before network");
      assert.equal(url.pathname, "/ws/alerts");
      assert.equal(url.searchParams.get("chain"), "robinhood");
      assert.equal(url.searchParams.has("trader"), false);
      assert.equal(opts.maxPayload, 256 * 1024);
      const socket = new EventEmitter();
      socket.pings = 0;
      socket.ping = () => socket.pings++;
      socket.terminate = () => socket.emit("close", 1006);
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  return {
    collector,
    store,
    logs,
    sockets,
    timers,
    advance(ms) {
      time += ms;
    },
  };
}

test("one socket, welcome health, quiet-feed ping and secret-free snapshot", async (t) => {
  const f = fixture(t);
  f.collector.start();
  f.collector.start();
  assert.equal(f.sockets.length, 1);
  const socket = f.sockets[0];
  socket.emit("open");
  socket.emit("message", JSON.stringify({ type: "welcome", delaySeconds: 15, realtime: false }));
  const snapshot = f.collector.snapshot();
  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.delay_seconds, 15);
  assert.equal(snapshot.history_complete, false);
  assert.equal(JSON.stringify(snapshot).includes("synthetic-private-key"), false);
  f.timers.at(-1).fn();
  assert.equal(socket.pings, 1);
  socket.emit("pong");
  f.timers.at(-1).fn();
  assert.equal(socket.pings, 2);
  await f.collector.stop();
  assert.equal(f.collector.snapshot().connected, false);
});

test("missed pong disconnects and backs off; access denial stops reconnecting", async (t) => {
  const f = fixture(t);
  f.collector.start();
  f.sockets[0].emit("open");
  f.timers.at(-1).fn();
  f.timers.at(-1).fn();
  assert.equal(f.collector.snapshot().state, "reconnecting");
  assert.equal(f.timers.at(-1).ms, 3000);
  f.advance(3000);
  f.timers.at(-1).fn();
  assert.equal(f.sockets.length, 2);
  f.sockets[1].emit("error", new Error("synthetic-private-key"));
  f.sockets[1].emit("close", 1008);
  assert.equal(f.collector.snapshot().state, "policy_denied");
  assert.equal(f.collector.running, false);
  await f.collector.stop();
});

test("disabled or missing key never connects", (t) => {
  for (const options of [{ enabled: false }, { key: "" }]) {
    const f = fixture(t, options);
    f.collector.start();
    assert.equal(f.sockets.length, 0);
    assert.equal(f.collector.snapshot().connections_24h, 0);
  }
});

test("HTTP credential, payment and access failures pause automatic reconnects", async (t) => {
  for (const statusCode of [401, 402, 403]) {
    const f = fixture(t);
    f.collector.start();
    let destroyed = false;
    f.sockets[0].emit(
      "unexpected-response",
      {
        destroy() {
          destroyed = true;
        },
      },
      { statusCode, resume() {} },
    );
    assert.equal(destroyed, true);
    assert.equal(f.collector.snapshot().state, {401: "invalid_credentials", 402: "credits_exhausted", 403: "access_denied"}[statusCode]);
    assert.equal(f.collector.running, false);
    assert.equal(f.timers.length, 0);
    await f.collector.stop();
  }
});

test("disconnect diagnostics retain useful codes but never provider text or credentials", async (t) => {
  const f = fixture(t);
  f.collector.start();
  f.sockets[0].emit("open");
  f.advance(1234);
  const error = new Error("wss://example.invalid?key=synthetic-private-key");
  error.code = "ECONNRESET";
  f.sockets[0].emit("error", error);
  f.sockets[0].emit("close", 1006, Buffer.from("synthetic-private-key"));
  const entry = f.logs.find((row) => row.event === "disconnected");
  assert.equal(entry.reason, "socket_error");
  assert.equal(entry.error_code, "ECONNRESET");
  assert.equal(entry.close_code, 1006);
  assert.equal(entry.duration_ms, 1234);
  assert.equal(f.logs.at(-1).event, "retry_scheduled");
  assert.equal(f.collector.snapshot().retry_at, f.logs.at(-1).retry_at);
  f.advance(3000);
  f.timers.at(-1).fn();
  error.code = "synthetic-private-key";
  f.sockets[1].emit("error", error);
  f.sockets[1].emit("close", 1006);
  assert.equal(f.logs.filter((row) => row.event === "disconnected").at(-1).error_code, "UNKNOWN");
  assert.doesNotMatch(JSON.stringify(f.logs), /synthetic-private-key|wss:|example.invalid|stack/);
  await f.collector.stop();
});

test("pong timeout and HTTP rejection diagnostics identify the disconnect cause", async (t) => {
  const f = fixture(t);
  f.collector.start();
  f.sockets[0].emit("open");
  f.timers.at(-1).fn();
  f.timers.at(-1).fn();
  assert.equal(f.logs.find((row) => row.event === "disconnected").reason, "pong_timeout");
  f.advance(3000);
  f.timers.at(-1).fn();
  f.sockets[1].emit(
    "unexpected-response",
    { destroy() {} },
    {
      statusCode: 403,
      statusMessage: "synthetic-private-key",
      resume() {},
    },
  );
  const entry = f.logs.filter((row) => row.event === "disconnected").at(-1);
  assert.equal(entry.reason, "http_error");
  assert.equal(entry.http_status, 403);
  assert.equal(f.collector.running, false);
  assert.doesNotMatch(JSON.stringify(f.logs), /synthetic-private-key/);
  await f.collector.stop();
});

test("collector uses the configured budget and resumes precisely at its rolling deadline", async (t) => {
  const f = fixture(t);
  f.store.maxConnections5m = 2;
  f.collector.start();
  f.sockets[0].emit("close", 1006);
  f.advance(3000);
  f.timers.at(-1).fn();
  f.sockets[1].emit("close", 1006);
  f.advance(6000);
  f.timers.at(-1).fn();
  assert.equal(f.sockets.length, 2);
  assert.equal(f.collector.snapshot().state, "cooldown");
  assert.equal(f.collector.snapshot().max_connections_5m, 2);
  assert.equal(f.timers.at(-1).ms, 300_000 - 9000);
  assert.equal(f.logs.at(-1).reason, "cooldown");
  // Only two attempts remain in the rolling window after the first expires.
  f.collector.socketFactory = () => {
    const socket = new EventEmitter();
    socket.terminate = () => socket.emit("close", 1006);
    f.sockets.push(socket);
    return socket;
  };
  f.advance(f.timers.at(-1).ms);
  f.timers.at(-1).fn();
  assert.equal(f.sockets.length, 3);
  assert.equal(f.collector.snapshot().state, "connecting");
  assert.equal(f.collector.snapshot().retry_at, null);
  await f.collector.stop();
});

test("socket creation failure is sanitized and a broken logger cannot prevent retries", (t) => {
  const f = fixture(t, {
    socketFactory() {
      throw new Error("synthetic-private-key");
    },
  });
  f.collector.start();
  assert.equal(f.logs.find((row) => row.event === "disconnected").reason, "socket_creation_failed");
  assert.doesNotMatch(JSON.stringify(f.logs), /synthetic-private-key/);
  assert.equal(f.timers.at(-1).ms, 3000);
  f.collector.logger = () => {
    throw new Error("broken sink");
  };
  f.advance(3000);
  f.timers.at(-1).fn();
  assert.equal(f.collector.snapshot().connections_24h, 2);
  assert.equal(f.timers.at(-1).ms, 6000);
});

test("welcomed connections that flap never grow into an hour-long retry; failures still back off", async (t) => {
  const f = fixture(t);
  f.collector.start();
  for (let i = 0; i < 9; i++) {
    const socket = f.sockets.at(-1);
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "welcome", delaySeconds: 0, realtime: true }));
    f.advance(23_000);
    socket.emit("close", 1006);
    const snapshot = f.collector.snapshot();
    assert.equal(snapshot.delay_seconds, null);
    assert.equal(snapshot.realtime, null);
    assert.equal(snapshot.state, "reconnecting");
    assert.ok(f.timers.at(-1).ms <= 300_000);
    f.advance(f.timers.at(-1).ms);
    f.timers.at(-1).fn();
  }
  f.sockets.at(-1).emit("close", 1006);
  assert.equal(f.timers.at(-1).ms, 60_000, "failed handshakes retain bounded exponential backoff");
  await f.collector.stop();
});

test("429 retries honor Retry-After and remain scheduled after process restart", async (t) => {
  for (const retryAfter of ["120", new Date(1_788_600_120_000).toUTCString(), undefined, "bad"]) {
    const f = fixture(t);
    f.collector.start();
    f.sockets[0].emit("unexpected-response", { destroy() {} }, {
      statusCode: 429, headers: { "retry-after": retryAfter }, resume() {},
    });
    const wait = retryAfter === undefined || retryAfter === "bad" ? 60_000 : 120_000;
    assert.equal(f.collector.running, true);
    assert.equal(f.collector.snapshot().state, "rate_limited");
    assert.equal(f.timers.at(-1).ms, wait);
    await f.collector.stop();
    let attempts = 0;
    const restarted = new FomoCollector(f.store, { enabled: true, key: "synthetic-private-key",
      now: () => 1_788_600_000_000, socketFactory() { attempts++; }, schedule() {}, logger() {} });
    restarted.start();
    assert.equal(attempts, 0);
    assert.equal(restarted.snapshot().state, "rate_limited");
    assert.equal(restarted.snapshot().retry_at, (1_788_600_000_000 + wait) / 1000);
    await restarted.stop();
    f.advance(wait);
    f.collector.start();
    assert.equal(f.sockets.length, 2);
    await f.collector.stop();
  }
});

test("5xx retries; policy and credentials remain paused until key rotation", async (t) => {
  const f = fixture(t);
  f.collector.start();
  f.sockets[0].emit("unexpected-response", { destroy() {} }, {
    statusCode: 503, headers: { "retry-after": "30" }, resume() {},
  });
  assert.equal(f.timers.at(-1).ms, 30_000);
  f.advance(30_000);
  f.timers.at(-1).fn();
  f.sockets[1].emit("close", 1008);
  const make = (key) => new FomoCollector(f.store, { enabled: true, key,
    now: () => 1_788_600_030_000, schedule() {}, logger() {},
    socketFactory() { throw new Error("fixture no network"); } });
  const same = make("synthetic-private-key");
  same.start();
  assert.equal(same.snapshot().state, "policy_denied");
  assert.equal(f.store.attempts(), 2);
  const rotated = make("synthetic-rotated-key");
  rotated.start();
  assert.equal(rotated.snapshot().state, "reconnecting");
  assert.equal(f.store.attempts(), 3);
  await rotated.stop();
});

test("welcome alone does not reset backoff; sustained welcome plus pong does", async (t) => {
  const f = fixture(t);
  f.collector.start();
  for (const [duration, pong, expected] of [[10_000, true, 3000], [61_000, false, 6000], [61_000, true, 3000]]) {
    const socket = f.sockets.at(-1);
    socket.emit("open");
    socket.emit("message", '{"type":"welcome"}');
    f.advance(duration);
    if (pong) socket.emit("pong");
    socket.emit("close", 1006);
    assert.equal(f.timers.at(-1).ms, expected);
    f.advance(expected);
    f.timers.at(-1).fn();
  }
  await f.collector.stop();
});

test("initial retry uses jitter", (t) => {
  for (const [random, expected] of [[0, 2400], [1, 3600]]) {
    const f = fixture(t, { random: () => random });
    f.collector.start();
    f.sockets[0].emit("close", 1006);
    assert.equal(f.timers.at(-1).ms, expected);
  }
});
