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
    timers = [];
  const collector = new FomoCollector(store, {
    key: "synthetic-private-key",
    enabled: true,
    now: () => time,
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
  assert.equal(f.timers.at(-1).ms, 60_000);
  f.advance(60_000);
  f.timers.at(-1).fn();
  assert.equal(f.sockets.length, 2);
  f.sockets[1].emit("error", new Error("synthetic-private-key"));
  f.sockets[1].emit("close", 1008);
  assert.equal(f.collector.snapshot().state, "access_denied");
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

test("HTTP credential and quota failures stop automatic reconnects", async (t) => {
  for (const statusCode of [401, 403, 429]) {
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
    assert.equal(f.collector.snapshot().state, "access_denied");
    assert.equal(f.collector.running, false);
    assert.equal(f.timers.length, 0);
    await f.collector.stop();
  }
});
