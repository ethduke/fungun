import assert from "node:assert/strict";
import test from "node:test";
import { ServiceError } from "./errors.mjs";
import { checkReadDeadline, Upstream, withinReadDeadline } from "./upstream.mjs";

const readPolicy = { queue: true, retry: true };
const url = "https://example.invalid/fees";
const read = (upstream, provider = "rpc", policy = readPolicy) =>
  upstream.json(provider, url, {}, 1024, 1, policy);
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("queued reads wait for shared provider capacity without extra requests or budget", async () => {
  let calls = 0;
  let debits = 0;
  const release = [];
  const upstream = new Upstream(
    {
      upstream() {
        debits++;
      },
    },
    async () => {
      calls++;
      await new Promise((resolve) => release.push(resolve));
      return Response.json({ ok: true });
    },
  );
  // Existing readers need not opt into the queue to release capacity to fees.
  const first = read(upstream, "rpc", {});
  const second = read(upstream, "rpc", {});
  const third = read(upstream);
  await flush();
  assert.equal(calls, 2);
  assert.equal(debits, 2);
  assert.equal(upstream.waiting.size, 1);
  release.shift()();
  await first;
  await flush();
  assert.equal(calls, 3);
  assert.equal(debits, 3);
  assert.equal(upstream.active, 2);
  for (const done of release) done();
  await Promise.all([second, third]);
  assert.equal(upstream.active, 0);
  assert.equal(upstream.waiting.size, 0);
});

test("queued reads retain the global four-request cap across providers", async () => {
  const release = [];
  let peak = 0;
  const upstream = new Upstream({ upstream() {} }, async () => {
    peak = Math.max(peak, upstream.active);
    await new Promise((resolve) => release.push(resolve));
    return Response.json({ ok: true });
  });
  const jobs = ["rpc", "rpc", "o1", "o1", "market"].map((provider) => read(upstream, provider));
  await flush();
  assert.equal(release.length, 4);
  release.shift()();
  await flush();
  assert.equal(release.length, 4);
  for (const done of release) done();
  await Promise.all(jobs);
  assert.equal(peak, 4);
});

test("read retry is bounded to one and charges every transport attempt", async () => {
  for (const failure of [
    () => {
      throw new TypeError("fetch failed with confidential details");
    },
    () => {
      throw new DOMException("timed out", "TimeoutError");
    },
    () => new Response(null, { status: 503 }),
  ]) {
    let calls = 0;
    let debits = 0;
    const upstream = new Upstream(
      {
        upstream() {
          debits++;
        },
      },
      async () => {
        calls++;
        return failure();
      },
    );
    await assert.rejects(read(upstream), (error) => {
      assert.ok(["unavailable", "upstream_unavailable"].includes(error.code));
      assert.ok(!error.message.includes("confidential"));
      return true;
    });
    assert.equal(calls, 2);
    assert.equal(debits, 2);
    assert.equal(upstream.active, 0);
  }
});

test("read retries exclude quota, invalid data, permanent HTTP errors and JSON-RPC errors", async () => {
  for (const response of [
    () => new Response(null, { status: 429, headers: { "retry-after": "10" } }),
    () => new Response(null, { status: 401 }),
    () => new Response(null, { status: 501 }),
    () => new Response("invalid", { headers: { "content-type": "application/json" } }),
    () => new Response("<html>", { headers: { "content-type": "text/html" } }),
    () => new Response("x".repeat(1025), { headers: { "content-type": "application/json" } }),
  ]) {
    let calls = 0;
    const upstream = new Upstream({ upstream() {} }, async () => {
      calls++;
      return response();
    });
    await assert.rejects(read(upstream));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const payload = { jsonrpc: "2.0", id: 0, error: { code: 3, message: "execution reverted" } };
  const upstream = new Upstream({ upstream() {} }, async () => {
    calls++;
    return Response.json(payload);
  });
  assert.deepEqual(await read(upstream), payload);
  assert.equal(calls, 1);
});

test("retry still respects budget and provider cooldown without another fetch", async () => {
  let calls = 0;
  let debits = 0;
  const upstream = new Upstream(
    {
      upstream() {
        if (++debits === 2) throw new ServiceError("rate_limited", 429, 60);
      },
    },
    async () => {
      calls++;
      throw new TypeError("network unavailable");
    },
  );
  await assert.rejects(read(upstream), { code: "rate_limited", retryAfter: 60 });
  await assert.rejects(read(upstream), { code: "rate_limited", retryAfter: 60 });
  assert.equal(calls, 1);
  assert.equal(debits, 2);
  assert.equal(upstream.active, 0);
});

test("waiting reads recheck a new provider cooldown before being charged", async () => {
  let calls = 0;
  let debits = 0;
  const release = [];
  const upstream = new Upstream(
    {
      upstream() {
        debits++;
      },
    },
    async () => {
      calls++;
      await new Promise((resolve) => release.push(resolve));
      return new Response(null, { status: 429, headers: { "retry-after": "10" } });
    },
  );
  const jobs = Array.from({ length: 3 }, () => read(upstream).catch((error) => error));
  await flush();
  release.shift()();
  await flush();
  release.shift()();
  const errors = await Promise.all(jobs);
  assert.ok(errors.every((error) => error.code === "rate_limited"));
  assert.equal(calls, 2);
  assert.equal(debits, 2);
  assert.equal(upstream.active, 0);
});

test("capacity queue has a finite size and deadline without spending budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let debits = 0;
  const upstream = new Upstream(
    {
      upstream() {
        debits++;
      },
    },
    () => new Promise(() => {}),
  );
  void read(upstream);
  void read(upstream);
  const queued = Array.from({ length: 12 }, () => read(upstream).catch((error) => error));
  await assert.rejects(read(upstream), { code: "busy" });
  assert.equal(debits, 2);
  t.mock.timers.tick(6000);
  assert.ok((await Promise.all(queued)).every((error) => error.code === "busy"));
  assert.equal(upstream.waiting.size, 0);
  assert.equal(debits, 2);
});

test("fee operation deadline aborts a queued read without charging it", async () => {
  const release = [];
  let debits = 0;
  const upstream = new Upstream(
    {
      upstream() {
        debits++;
      },
    },
    async () => {
      await new Promise((resolve) => release.push(resolve));
      return Response.json({ ok: true });
    },
  );
  const existing = [read(upstream), read(upstream)];
  const expired = withinReadDeadline(() => read(upstream), 10).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await expired).code, "upstream_unavailable");
  assert.equal(upstream.waiting.size, 0);
  assert.equal(debits, 2);
  for (const done of release) done();
  await Promise.all(existing);
});

test("fee deadline cancels an in-flight fetch and prevents retry or later paid stages", async () => {
  let calls = 0;
  let debits = 0;
  let aborted = false;
  const upstream = new Upstream(
    {
      upstream() {
        debits++;
      },
    },
    (_url, { signal }) => {
      calls++;
      return new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    },
  );
  const expired = withinReadDeadline(async () => {
    try {
      await read(upstream);
    } catch {}
    checkReadDeadline();
    return read(upstream);
  }, 10).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await expired).code, "upstream_unavailable");
  assert.equal(aborted, true);
  assert.equal(debits, 1);
  assert.equal(calls, 1);
  assert.equal(upstream.active, 0);
});

test("a retry delay cannot start a second fetch past the operation deadline", async () => {
  let calls = 0;
  const upstream = new Upstream({ upstream() {} }, async () => {
    calls++;
    throw new TypeError("network unavailable");
  });
  const expired = withinReadDeadline(() => read(upstream), 10).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.equal((await expired).code, "upstream_unavailable");
  assert.equal(calls, 1);
  // An unrelated task does not inherit the expired request's deadline.
  assert.doesNotThrow(checkReadDeadline);
});
