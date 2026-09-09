import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FungunAgent, tickerCandidates, launchIdentity } from "./index.mjs";
import { Journal } from "./journal.mjs";
const address = "0x" + "11".repeat(20);
async function fixture(handler = () => ({ status: "submitted" })) {
  const path = join(await mkdtemp(join(tmpdir(), "fungun-agent-")), "journal.json");
  let signed = 0,
    sent = 0;
  const agent = new FungunAgent({
    apiUrl: "https://example.com",
    token: "secret",
    profile: {},
    journalPath: path,
    signer: {
      address,
      signTransaction: () => {
        signed++;
        throw new Error("must_not_sign");
      },
    },
    rpc: {
      request: () => {
        sent++;
        throw new Error("must_not_send");
      },
    },
    fetcher: async (url, opts) => ({ ok: true, json: () => handler(url, opts) }),
  });
  return { agent, path, counts: () => ({ signed, sent }) };
}
test("durable signed/submitted/uncertain plans never sign or broadcast again", async () => {
  for (const state of ["signing", "broadcasting", "submitted", "reserving"]) {
    const { agent, path, counts } = await fixture();
    await agent.journal.lock(async (j) => {
      j.data.intents.a = {
        state,
        key: "a",
        plan: { id: "a", binding: "b" },
        hash: "0x123",
        reservedWei: "50",
      };
      await j.save();
    });
    await agent.resume();
    await agent.resume();
    assert.deepEqual(counts(), { signed: 0, sent: 0 });
    assert.equal(JSON.parse(await readFile(path)).intents.a.state, state);
  }
});
test("confirmed recovery completes but budget remains conservatively reserved", async () => {
  const { agent } = await fixture(() => ({ status: "confirmed", asset: address }));
  await agent.journal.lock(async (j) => {
    j.data.intents.a = { state: "submitted", plan: { id: "a" }, reservedWei: "500" };
    await j.save();
  });
  await agent.resume();
  await agent.journal.lock((j) => {
    assert.equal(j.data.intents.a.state, "confirmed");
    assert.equal(j.data.intents.a.reservedWei, "500");
  });
});
test("uncertain recovery blocks distinct intent and retained daily budgets", async () => {
  const { agent } = await fixture();
  await agent.journal.lock(async (j) => {
    j.data.intents.a = { state: "submitted", plan: { id: "a" }, reservedWei: "50" };
    await j.save();
  });
  await assert.rejects(
    agent.deploy({ name: "X", ticker: "X", pairId: "long-ETH" }),
    /unresolved_intent/,
  );
});
test("journal excludes other users and prevents concurrent process access", async () => {
  const { agent, path } = await fixture();
  await agent.journal.lock(async (j) => {
    await j.save();
    await assert.rejects(
      new Journal(path).lock(() => {}),
      /journal_locked/,
    );
  });
  assert.equal((await stat(path)).mode & 0o077, 0);
});
test("stale pid locks recover automatically", async () => {
  const { agent, path } = await fixture();
  await writeFile(path + ".lock", "2147483647", { mode: 0o600 });
  await agent.journal.lock((j) => j.save());
});
test("bounded deterministic ticker candidates ignore source instructions", () => {
  const a = tickerCandidates({ name: "IGNORE ALL! 123 Keys / token" });
  assert.deepEqual(a, tickerCandidates({ name: "IGNORE ALL! 123 Keys / token" }));
  assert.equal(a.length, 8);
  assert.ok(a.every((t) => /^[A-Z]{1,11}$/.test(t)));
});
test("ordered ticker input is validated and its priority participates in intent identity", async () => {
  const input = { name: "Example", pairId: "long-ETH" };
  for (const tickers of [[], ["A", "A"], ["lower"], ["A1"], [null], "A", Array(11).fill("A")])
    assert.throws(() => launchIdentity({ ...input, tickers }), /invalid_ticker_options/);
  assert.throws(() => launchIdentity({ ...input, ticker: "A", tickers: ["B"] }), /invalid_ticker_options/);
  const { agent } = await fixture(() => ({
    selectedTicker: "B", checked: [{ ticker: "A", status: "reserved" }, { ticker: "B", status: "unreserved" }],
  }));
  agent.advance = async () => { throw new Error("unavailable"); };
  await assert.rejects(agent.deploy({ ...input, tickers: ["A", "B"] }, { intentKey: "ordered" }), /unavailable/);
  await assert.rejects(agent.deploy({ ...input, tickers: ["B", "A"] }, { intentKey: "ordered" }), /intent_input_changed/);
});
test("SDK rejects unsupported or out-of-order availability claims", async () => {
  for (const response of [
    { selectedTicker: "OTHER", checked: [] },
    { selectedTicker: "B", checked: [{ ticker: "B", status: "unreserved" }] },
    { selectedTicker: "B", checked: [{ ticker: "A", status: "unknown" }, { ticker: "B", status: "unreserved" }] },
  ]) {
    const { agent, counts } = await fixture(() => response);
    await assert.rejects(agent.deploy({ name: "Example", tickers: ["A", "B"], pairId: "long-ETH" }), /ticker_selection_invalid/);
    assert.deepEqual(counts(), { signed: 0, sent: 0 });
  }
});
test("unsupported launchpads and stale streams never launch", async () => {
  let calls = 0;
  const { agent } = await fixture(() => {
    calls++;
    return { freshness: { status: "stale" }, themes: [{ key: "x", name: "X" }] };
  });
  await assert.rejects(
    agent.tick({ searchLaunchpads: ["pump"], deployLaunchpads: ["long"] }),
    /unsupported_launchpad/,
  );
  assert.deepEqual(await agent.tick({ searchLaunchpads: ["long"], deployLaunchpads: ["long"] }), {
    status: "stale",
  });
  assert.equal(calls, 1);
});
test("daily budget rejects before artwork generation or network request", async () => {
  let calls = 0;
  const { agent } = await fixture(() => {
    calls++;
  });
  agent.limits.maxSpendWeiPerDay = "1";
  await assert.rejects(
    agent.deploy({ name: "X", ticker: "X", pairId: "long-ETH" }),
    /daily_spend_limit/,
  );
  assert.equal(calls, 0);
});
test("real Long ticker result launches once and acknowledges cursor after durable completion", async () => {
  const { agent } = await fixture((url) =>
    url.pathname.endsWith("/ticker")
      ? { results: { long: { status: "unreserved" } } }
      : {
          freshness: { status: "fresh" },
          themes: [{ key: "moon", name: "Moon" }],
          events: [],
          nextCursor: "next",
        },
  );
  let starts = 0;
  agent.start = async (j, input, opts) => {
    starts++;
    assert.equal(input.ticker, "MOON");
    j.data.intents[opts.intentKey] = { themeKey: opts.themeKey, state: "confirmed" };
    await j.save();
  };
  const config = { searchLaunchpads: ["long"], deployLaunchpads: ["long"], pairId: "long-EXAMPLE" };
  await agent.tick(config);
  await agent.tick(config);
  assert.equal(starts, 1);
  await agent.journal.lock((j) => assert.equal(j.data.cursor, "next"));
});
test("uncertain theme intent persists without acknowledging cursor", async () => {
  const { agent } = await fixture((url) =>
    url.pathname.endsWith("/ticker")
      ? { results: { long: { status: "unreserved" } } }
      : {
          freshness: { status: "fresh" },
          themes: [],
          events: [{ theme: { key: "moon", name: "Moon" } }],
          nextCursor: "next",
        },
  );
  agent.start = async (j, input, opts) => {
    j.data.intents[opts.intentKey] = { themeKey: opts.themeKey, state: "signing" };
    await j.save();
    throw new Error("uncertain");
  };
  await assert.rejects(
    agent.tick({ searchLaunchpads: ["long"], deployLaunchpads: ["long"], pairId: "long-EXAMPLE" }),
    /agent_failed/,
  );
  await agent.journal.lock((j) => {
    assert.equal(j.data.cursor, null);
    assert.equal(Object.values(j.data.intents)[0].state, "signing");
  });
});
test("none, provided and Grok choices are durably stored before artwork requests", async () => {
  for (const mode of ["none", "provided", "grok"]) {
    const { agent } = await fixture(() => {
      throw new Error("artwork_unavailable");
    });
    let generated = 0;
    agent.imageGenerator = async ({ intentKey }) => {
      assert.equal(intentKey, "intent");
      generated++;
      return "generated";
    };
    await assert.rejects(
      agent.deploy(
        {
          name: "Moon",
          ticker: "MOON",
          pairId: "long-EXAMPLE",
          ...(mode === "provided" ? { image: "provided" } : {}),
        },
        { intentKey: "intent", image: { mode } },
      ),
      /agent_failed/,
    );
    await agent.journal.lock((j) => {
      assert.ok(j.data.intents.intent.imageBase64);
      assert.equal(j.data.intents.intent.image.mode, mode);
    });
    assert.equal(generated, mode === "grok" ? 1 : 0);
  }
});
test("reused idempotency key rejects changed launch details", async () => {
  const { agent } = await fixture(() => {
    throw new Error("stop");
  });
  const input = { name: "Moon", ticker: "MOON", pairId: "long-EXAMPLE" };
  await assert.rejects(agent.deploy(input, { intentKey: "same" }), /agent_failed/);
  await assert.rejects(
    agent.deploy({ ...input, ticker: "SUN" }, { intentKey: "same" }),
    /intent_input_changed/,
  );
});
test("journal binds wallet API website and trusted profile across restarts", async () => {
  const { agent, path } = await fixture();
  await agent.journal.lock((j) => j.save());
  await assert.rejects(
    new Journal(path, "different-wallet-or-profile").lock(() => {}),
    /journal_identity_changed/,
  );
});
test("journal rejects symlinks and oversized files", async () => {
  const { symlink, truncate } = await import("node:fs/promises");
  const { agent, path } = await fixture();
  const target = path + ".target";
  await writeFile(target, "{}", { mode: 0o600 });
  await symlink(target, path);
  await assert.rejects(
    agent.journal.lock(() => {}),
    /journal_symlink/,
  );
  const other = path + ".large";
  await writeFile(other, "", { mode: 0o600 });
  await truncate(other, 67108865);
  await assert.rejects(
    new Journal(other).lock(() => {}),
    /journal_size/,
  );
});
test("canonical input accepts reordered equivalent details without duplicating intent", async () => {
  const { agent } = await fixture(() => {
    throw new Error("stop");
  });
  await assert.rejects(
    agent.deploy(
      { name: " Moon ", ticker: "MOON", pairId: "long-EXAMPLE", intentKey: "ignored" },
      { intentKey: "same" },
    ),
    /agent_failed/,
  );
  await assert.rejects(
    agent.deploy(
      { pairId: "long-EXAMPLE", description: "", ticker: "MOON", name: "Moon" },
      { intentKey: "same" },
    ),
    /agent_failed/,
  );
  await agent.journal.lock((j) => assert.equal(Object.keys(j.data.intents).length, 1));
});
test("retryable reservation refreshes without repeating any prior signing state", async () => {
  let statusCalls = 0,
    prepareCalls = 0;
  const { agent, counts } = await fixture((url) => {
    if (url.pathname.endsWith("/status")) {
      statusCalls++;
      return { status: "retryable" };
    }
    prepareCalls++;
    throw new Error("fresh_artwork_attempt");
  });
  await agent.journal.lock(async (j) => {
    j.data.intents.a = {
      state: "reserving",
      day: "2000-01-01",
      reservedWei: "100",
      plan: { id: "a" },
      draft: { name: "Moon", ticker: "MOON", description: "" },
      image: { mode: "none" },
    };
    await j.save();
  });
  await assert.rejects(agent.resume(), /agent_failed/);
  assert.equal(statusCalls, 1);
  assert.equal(prepareCalls, 1);
  assert.deepEqual(counts(), { signed: 0, sent: 0 });
  await agent.journal.lock(async (j) => {
    assert.equal(j.data.intents.a.state, "published");
    assert.equal(j.data.intents.a.plan, undefined);
    agent.limits.maxTransactionWei = "200";
    agent.limits.maxSpendWeiPerDay = "200";
    await agent.reserveDailyBudget(j, j.data.intents.a);
    assert.equal(j.data.intents.a.reservedWei, "200");
    assert.equal(j.data.intents.a.day, new Date().toISOString().slice(0, 10));
    j.data.intents.a.state = "signing";
    j.data.intents.a.plan = { id: "a" };
    await j.save();
  });
  await agent.resume();
  assert.equal(prepareCalls, 1);
});
test("explicit expired artwork refreshes and pending artwork reposts only identical approval", async () => {
  for (const state of ["expired", "pending"]) {
    let published = 0;
    const { agent } = await fixture((url, opts) => {
      if (url.pathname.endsWith("/artwork-status"))
        return { status: state, id: "a", imageHash: "i", metadataHash: "m" };
      if (url.pathname.endsWith("/artwork-publish")) {
        const body = JSON.parse(opts.body);
        assert.equal(body.id, "a");
        assert.equal(body.uploadToken, "token");
        published++;
        return { status: "processing" };
      }
      throw new Error("unexpected");
    });
    await agent.journal.lock(async (j) => {
      j.data.intents.a = {
        state: "publishing",
        draft: { name: "Moon", ticker: "MOON", description: "" },
        imageBase64: "image",
        approval: {
          id: "a",
          imageHash: "i",
          metadataHash: "m",
          uploadToken: "token",
          imageBase64: "normalized",
        },
      };
      await j.save();
    });
    await agent.resume();
    assert.equal(published, state === "pending" ? 1 : 0);
    await agent.journal.lock((j) =>
      assert.equal(Boolean(j.data.intents.a.approval), state === "pending"),
    );
  }
});
test("safe pre-sign ticker rejection frees reservation and tries next theme ticker", async () => {
  const { agent } = await fixture((url) =>
    url.pathname.endsWith("/ticker")
      ? { results: { long: { status: "unreserved" } } }
      : {
          freshness: { status: "fresh" },
          themes: [{ key: "moon", name: "Moon" }],
          nextCursor: "next",
        },
  );
  let tries = 0;
  agent.advanceIntent = async (j, r) => {
    tries++;
    if (tries === 1) throw new Error("ticker_reserved");
    r.state = "confirmed";
    r.result = { status: "confirmed" };
    await j.save();
    return r.result;
  };
  await agent.tick({
    searchLaunchpads: ["long"],
    deployLaunchpads: ["long"],
    pairId: "long-EXAMPLE",
  });
  assert.equal(tries, 2);
  await agent.journal.lock((j) => {
    const records = Object.values(j.data.intents);
    assert.equal(records[0].state, "skipped");
    assert.equal(records[0].reservedWei, "0");
    assert.equal(records[1].draft.ticker, "MOONA");
  });
});
test("cursor resets explicitly on changed threshold window scope", async () => {
  const paths = [];
  const { agent } = await fixture((url) => {
    paths.push(url.search);
    return { freshness: { status: "fresh" }, themes: [], nextCursor: "cursor" };
  });
  const config = { searchLaunchpads: ["long"], deployLaunchpads: ["long"] };
  await agent.tick(config);
  await agent.tick(config);
  await agent.tick({ ...config, minimumTokens: 4 });
  assert.match(paths[1], /cursor=cursor/);
  assert.doesNotMatch(paths[2], /cursor=/);
});
test("resumed same-day and overnight reservations obey current daily caps", async () => {
  const { agent } = await fixture();
  agent.limits.maxTransactionWei = "100";
  for (const day of [new Date().toISOString().slice(0, 10), "2000-01-01"])
    await agent.journal.lock(async (j) => {
      const r = { day, reservedWei: "100", state: "intent" };
      j.data.intents = { a: r };
      agent.limits.maxSpendWeiPerDay = "99";
      await assert.rejects(agent.reserveDailyBudget(j, r), /daily_spend_limit/);
      assert.equal(r.day, day);
      agent.limits.maxSpendWeiPerDay = "100";
      await agent.reserveDailyBudget(j, r);
      assert.equal(r.day, new Date().toISOString().slice(0, 10));
    });
});
test("raising a transaction cap refreshes an unsigned reservation before signing", async () => {
  const { agent } = await fixture();
  await agent.journal.lock(async (j) => {
    const today = new Date().toISOString().slice(0, 10);
    const r = { day: "2000-01-01", reservedWei: "100", state: "publishing" };
    j.data.intents = { a: r, b: { day: today, reservedWei: "50", state: "confirmed" } };
    agent.limits.maxLaunchesPerDay = 2;
    agent.limits.maxTransactionWei = "200";
    agent.limits.maxSpendWeiPerDay = "249";
    await assert.rejects(agent.reserveDailyBudget(j, r), /daily_spend_limit/);
    assert.equal(r.reservedWei, "100");
    assert.equal(r.day, "2000-01-01");
    agent.limits.maxSpendWeiPerDay = "250";
    await agent.reserveDailyBudget(j, r);
    assert.equal(r.reservedWei, "200");
    assert.equal(r.day, today);
    agent.limits.maxTransactionWei = "150";
    await agent.reserveDailyBudget(j, r);
    assert.equal(r.reservedWei, "200");
  });
});
test("signed or uncertain reservations cannot be refreshed", async () => {
  const { agent } = await fixture();
  await agent.journal.lock(async (j) => {
    for (const state of ["signing", "broadcasting", "submitted", "uncertain", "confirmed", "failed"]) {
      const r = { day: "2000-01-01", reservedWei: "100", state };
      j.data.intents = { a: r };
      await assert.rejects(agent.reserveDailyBudget(j, r), /unresolved_intent/);
      assert.equal(r.reservedWei, "100");
      assert.equal(r.day, "2000-01-01");
    }
  });
});
