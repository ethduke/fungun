import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  keccak256,
  zeroAddress,
  toHex,
  parseTransaction,
  recoverTransactionAddress,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { FungunAgent } from "./index.mjs";
import { stonxFixture } from "./stonx-fixture.mjs";
import { o1Fixture } from "./o1-fixture.mjs";
import { Budget } from "../api/src/budget.mjs";
import { ServiceError } from "../api/src/errors.mjs";
import { createAgentHandler } from "../api/src/agent-api.mjs";
import { validateAssetInput } from "../api/src/asset-service.mjs";
import { initializeIpfsStore, IpfsStore } from "../api/src/ipfs-store.mjs";
import { createIpfsWorker } from "../api/src/ipfs-worker.mjs";
import { buildUnsignedLongLaunch } from "../web/lib/long-encoding/long-launch.mjs";

const address = (n) => toHex(BigInt(n), { size: 20 });
const contract = (n) => ({ address: address(n), codeHash: keccak256("0x6001") });
const profile = {
  chainId: 4663,
  launcher: contract(1),
  airlock: contract(2),
  tokenFactory: { ...contract(3), initCodeHash: toHex(103n, { size: 32 }) },
  governanceFactory: contract(4),
  poolInitializer: contract(5),
  liquidityMigrator: contract(6),
  dopplerHook: contract(7),
  integrator: address(8),
  protocolBeneficiary: address(9),
  quotes: [
    {
      id: "long-EXAMPLE",
      token: { ...contract(10), address: address(2n ** 160n - 1n) },
      oracle: contract(11),
      decimals: 18,
      oracleDecimals: 8,
    },
  ],
};

async function fixture(t, { loseBroadcast = false, losePublication = false,
  tickers, taken = [], raceTicker, grok = false, loseTickerLookup = false,
  stonxMode = false, platform = stonxMode ? "stonx" : "long", targetChain = platform === "stonx" ? 8453 : 4663,
  wrongChain = false } = {}) {
  const independent = platform === "stonx" ? stonxFixture()
    : platform === "o1" ? o1Fixture(targetChain) : null;
  const effectiveProfile = independent?.profile ?? profile;
  const chainId = targetChain;
  const launchpad = platform === "o1" && chainId === 8453 ? "o1-base" : platform;
  const paths = [];
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-deploy-integration-")));
  initializeIpfsStore(root);
  const origin = "https://app.example.com",
    assetOrigin = "https://launch-assets.mypinata.cloud";
  const store = new IpfsStore({ root, appOrigin: origin, gateway: "launch-assets.mypinata.cloud" });
  const budget = new Budget(":memory:");
  const account = privateKeyToAccount(generatePrivateKey());
  const token = "EXAMPLE_INTEGRATION_CREDENTIAL";
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "green" } })
    .webp()
    .toBuffer();
  const counts = { sign: 0, broadcast: 0, publish: 0, pin: 0, reserve: 0, prepare: 0, status: 0 };
  const contents = new Map();
  const checkedTickers = [];
  const preparedTickers = [];
  let imageGenerations = 0, tickerLookupLost = false;
  let submittedHash, plan, publication, serialized;
  const worker = createIpfsWorker(
    store,
    {
      async pinObject(content) {
        counts.pin++;
        contents.set(content.cid, Buffer.from(content.bytes));
        return {
          id: randomUUID(),
          cid: content.cid,
          size: content.bytes.length,
          mime: content.mime,
        };
      },
      async inspectPin() {},
      async verifyObject() {},
      async findPin() {
        assert.fail("unexpected pin retry");
      },
    },
    { enabled: true },
  );
  const assetFetcher = async (url, options) => {
    assert.equal(new URL(url).origin, assetOrigin);
    const kind = new URL(url).pathname.slice("/v1/asset-".length);
    assert.equal(options.headers["x-fungun-intent"], `asset-${kind}`);
    assert.equal(options.headers.authorization, undefined);
    const input = validateAssetInput(kind, JSON.parse(options.body));
    if (kind === "launch-prepare")
      return Response.json({
        ...(await store.launchChallenge(input.wallet, input.image, input.draft)),
        imageBase64: image.toString("base64"),
        width: 8,
        height: 8,
        serverTime: store.clock(),
      });
    if (kind === "launch-publish") {
      counts.publish++;
      assert.equal("signature" in input, false);
      await store.acceptLaunch(input);
      worker.kick();
      await worker.idle();
      publication = store.status({
        ...input,
        imageHash: store.get(input.id).image_hash,
        metadataHash: store.get(input.id).metadata_hash,
      });
      if (losePublication) throw Error("synthetic dropped publication acknowledgment");
      return Response.json(publication);
    }
    assert.equal(kind, "status");
    return Response.json(store.status(input));
  };
  const launches = {
    run: async (kind, input) => {
      if (kind === "launch-prepare") {
        counts.prepare++;
        preparedTickers.push(input.draft.ticker);
        if (input.draft.ticker === raceTicker) throw new ServiceError("ticker_reserved", 409);
        assert.equal(input.wallet, account.address.toLowerCase());
        assert.equal(input.publication.id, publication.id);
        assert.equal(input.publication.metadataHash, publication.metadataHash);
        const metadata = JSON.parse(contents.get(publication.ipfs.metadataCid));
        assert.equal(metadata.symbol, input.draft.ticker);
        assert.equal(metadata.website, input.draft.website);
        assert.equal(metadata.twitter, input.draft.twitter);
        if (independent) {
          assert.equal(input.chainId, chainId);
          assert.equal(input.pairId, independent.input.pairId);
          if (platform === "longbow") assert.equal(input.draft.launchpad, "longbow");
          if (platform === "o1") assert.equal(input.editableMetadata, false);
          if (platform === "pons") assert.equal(metadata.image_hash, metadata.image);
          plan = independent.planFor(input, publication);
          if (platform === "stonx") independent.changes.create = [plan.predictedAsset, plan.predictedAsset, zeroAddress, zeroAddress, zeroAddress];
          return plan;
        }
        const intentId = "00000000-0000-4000-8000-000000000001";
        const { publication: _ignoredPublication, ...launchInput } = input;
        const built = buildUnsignedLongLaunch(
          {
            ...launchInput,
            metadataUri: `ipfs://${publication.ipfs.metadataCid}`,
            startingTick: -160000,
            intentId,
          },
          profile,
        );
        const now = Date.now();
        plan = {
          ...built,
          predictedPool: address(12),
          id: "a".repeat(64),
          chainId: 4663,
          profile,
          quotedAt: now,
          expiresAt: now + 30000,
          startingTick: -160000,
          intentId,
          transaction: {
            ...built.transaction,
            chainId: "0x1237",
            value: "0x0",
            nonce: "0x0",
            gas: "0x7530",
            gasPrice: "0x1",
          },
          estimatedGas: "25000",
          maximumGasWei: "30000",
        };
        return plan;
      }
      assert.equal(input.id, plan.id);
      if (kind === "launch-reserve") {
        counts.reserve++;
        assert.equal(input.binding, plan.binding);
        return { status: "reserved", id: plan.id };
      }
      assert.equal(kind, "launch-status");
      counts.status++;
      assert.equal(input.hash, submittedHash);
      return { status: "confirmed", id: plan.id, hash: submittedHash, asset: plan.predictedAsset };
    },
  };
  const launchConfig = platform === "o1" && chainId === 8453 ? "o1BaseLaunch" : `${platform}Launch`;
  const config = { origin, [launchConfig]: { assetOrigin, profile: effectiveProfile } };
  const server = createServer(
    createAgentHandler(
      {
        config,
        budget,
        launches,
        adapters: { ticker: async (_chain, ticker) => {
          checkedTickers.push(ticker);
          if (loseTickerLookup && counts.prepare && !tickerLookupLost) {
            tickerLookupLost = true;
            throw new ServiceError("unavailable", 503);
          }
          return { results: { [platform === "longbow" ? "long" : platform]: { status: taken.includes(ticker) ? "reserved" : "unreserved" } } };
        } },
        fetcher: assetFetcher,
        agent: {
          enabled: true,
          publicAssetOrigin: assetOrigin,
          clients: [
            {
              id: "integration",
              wallet: account.address.toLowerCase(),
              scopes: [`${platform}:deploy`],
              tokenHash: createHash("sha256").update(token).digest("hex"),
            },
          ],
        },
      },
      (_, res) => {
        res.statusCode = 404;
        res.end();
      },
    ),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await worker.stop();
    store.close();
    budget.close();
    rmSync(root, { recursive: true, force: true });
  });
  const signer = {
    address: account.address,
    signTransaction: async (tx) => {
      counts.sign++;
      serialized = await account.signTransaction(tx);
      return serialized;
    },
  };
  const rpc = {
    request: async ({ method, params }) => {
      if (method === "eth_sendRawTransaction") {
        counts.broadcast++;
        assert.equal(counts.reserve, 1);
        assert.equal(counts.sign, 1);
        assert.equal(
          (await recoverTransactionAddress({ serializedTransaction: params[0] })).toLowerCase(),
          account.address.toLowerCase(),
        );
        const tx = parseTransaction(params[0]);
        assert.equal(tx.chainId, chainId);
        assert.equal(tx.data, plan.transaction.data);
        assert.equal(tx.to.toLowerCase(), effectiveProfile.launcher.address.toLowerCase());
        assert.equal(tx.nonce, 0);
        submittedHash = keccak256(params[0]);
        if (loseBroadcast) throw Error("synthetic dropped broadcast acknowledgment");
        return submittedHash;
      }
      if (wrongChain && method === "eth_chainId") return toHex(chainId === 8453 ? 4663 : 8453);
      if (independent) return independent.rpc.request({ method, params });
      const responses = {
        eth_chainId: "0x1237",
        eth_getCode: "0x6001",
        eth_getTransactionCount: "0x0",
        eth_getBalance: "0xffffffffffffffff",
        eth_call: encodeAbiParameters(
          parseAbiParameters("address,address,address,address,address"),
          [plan.predictedAsset, address(12), address(13), address(14), address(15)],
        ),
      };
      assert.ok(Object.hasOwn(responses, method));
      return responses[method];
    },
  };
  const settings = {
    apiUrl: `http://127.0.0.1:${server.address().port}`,
    appOrigin: origin,
    token,
    signer,
    rpc,
    profile: effectiveProfile,
    ...(independent?.baseFeeOracle ? { baseFeeOracle: independent.baseFeeOracle } : {}),
    fetcher: (url, options) => {
      paths.push(new URL(url).pathname);
      return fetch(url, options);
    },
    imageGenerator: async () => { imageGenerations++; return image.toString("base64"); },
    journalPath: join(root, "agent-journal.json"),
  };
  let agent = new FungunAgent(settings);
  const input = {
    name: "Quorvix Lantern",
    ...(tickers ? { tickers } : { ticker: "QVXL" }),
    description: "A test coin",
    website: "https://example.com",
    twitter: "https://x.com/example",
    pairId: independent?.input.pairId ?? effectiveProfile.quotes[0].id,
    ...(platform === "o1" ? { editableMetadata: false } : {}),
    image: image.toString("base64"),
  };
  return {
    counts,
    paths,
    checkedTickers,
    preparedTickers,
    input,
    deploy: () => agent.deploy(input, { intentKey: "stable-intent",
      ...(grok ? { image: { mode: "grok", prompt: "A fictional lantern." } } : {}) }),
    resume: () => agent.resume(),
    restart: () => {
      agent = new FungunAgent(settings);
    },
    expected: () => plan.predictedAsset,
    imageGenerations: () => imageGenerations,
    journal: () => JSON.parse(readFileSync(settings.journalPath)),
    assertNoSignedBytes: () => {
      assert.equal(readFileSync(settings.journalPath).includes(Buffer.from(serialized)), false);
    },
  };
}

test("deploy traverses real authenticated API, IPFS capability publication and local transaction signing once", async (t) => {
  const f = await fixture(t);
  const result = await f.deploy();
  assert.equal(result.status, "confirmed");
  assert.equal(result.asset, f.expected());
  assert.deepEqual(f.counts, {
    sign: 1,
    broadcast: 1,
    publish: 1,
    pin: 2,
    reserve: 1,
    prepare: 1,
    status: 1,
  });
  f.restart();
  assert.deepEqual(await f.deploy(), result);
  assert.deepEqual(await f.resume(), []);
  assert.equal(f.counts.broadcast, 1);
  f.assertNoSignedBytes();
});
test("lost broadcast acknowledgment recovers original hash after restart without re-signing", async (t) => {
  const f = await fixture(t, { loseBroadcast: true });
  await assert.rejects(f.deploy(), /agent_failed/);
  f.restart();
  const [result] = await f.resume();
  assert.equal(result.status, "confirmed");
  assert.equal(result.asset, f.expected());
  assert.deepEqual(await f.deploy(), result);
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.broadcast, 1);
  assert.equal(f.counts.reserve, 1);
  f.assertNoSignedBytes();
});
test("lost IPFS publication acknowledgment recovers status and never republishes", async (t) => {
  const f = await fixture(t, { losePublication: true });
  await assert.rejects(f.deploy(), /unavailable/);
  f.restart();
  const [result] = await f.resume();
  assert.equal(result.status, "confirmed");
  assert.equal(f.counts.publish, 1);
  assert.equal(f.counts.pin, 2);
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.broadcast, 1);
});

test("ordered ticker deployment chooses before publication and persists its selection", async (t) => {
  const f = await fixture(t, { tickers: ["TAKEN", "QVXL", "LATER"], taken: ["TAKEN"] });
  const result = await f.deploy();
  assert.equal(result.status, "confirmed");
  assert.equal(result.selectedTicker, "QVXL");
  assert.deepEqual(f.checkedTickers, ["TAKEN", "QVXL"]);
  assert.deepEqual(f.preparedTickers, ["QVXL"]);
  f.restart();
  assert.deepEqual(await f.deploy(), result);
  assert.deepEqual(f.checkedTickers, ["TAKEN", "QVXL"]);
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.broadcast, 1);
});

test("a ticker taken during preparation falls back with fresh metadata and one signature", async (t) => {
  const f = await fixture(t, { tickers: ["RACED", "QVXL", "LATER"], raceTicker: "RACED", grok: true });
  const result = await f.deploy();
  assert.equal(result.status, "confirmed");
  assert.equal(result.selectedTicker, "QVXL");
  assert.deepEqual(f.checkedTickers, ["RACED", "QVXL"]);
  assert.deepEqual(f.preparedTickers, ["RACED", "QVXL"]);
  assert.equal(f.counts.publish, 2);
  assert.equal(f.imageGenerations(), 1);
  assert.equal(f.counts.reserve, 1);
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.broadcast, 1);
  f.assertNoSignedBytes();
});

test("ticker exhaustion does not publish or sign, and unsigned race exhaustion releases budget", async (t) => {
  const unavailable = await fixture(t, { tickers: ["TAKEN", "BUSY"], taken: ["TAKEN", "BUSY"] });
  await assert.rejects(unavailable.deploy(), /tickers_unavailable/);
  assert.equal(unavailable.counts.publish, 0);
  assert.equal(unavailable.counts.sign, 0);
  const raced = await fixture(t, { tickers: ["RACED", "BUSY"], taken: ["BUSY"], raceTicker: "RACED" });
  const result = await raced.deploy();
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "tickers_unavailable");
  assert.equal(raced.counts.sign, 0);
  assert.equal(raced.counts.reserve, 0);
  assert.equal(raced.journal().intents["stable-intent"].reservedWei, "0");
});

test("uncertain broadcast with ticker options recovers without selecting or signing again", async (t) => {
  const f = await fixture(t, { tickers: ["QVXL", "LATER"], loseBroadcast: true });
  await assert.rejects(f.deploy(), /agent_failed/);
  f.restart();
  const [result] = await f.resume();
  assert.equal(result.status, "confirmed");
  assert.equal(result.selectedTicker, "QVXL");
  assert.deepEqual(f.checkedTickers, ["QVXL"]);
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.broadcast, 1);
});

test("an unavailable fallback check resumes after restart without reusing old metadata", async (t) => {
  const f = await fixture(t, { tickers: ["RACED", "QVXL"], raceTicker: "RACED", loseTickerLookup: true });
  await assert.rejects(f.deploy(), /unavailable/);
  assert.equal(f.journal().intents["stable-intent"].state, "ticker_retry");
  assert.equal(f.counts.sign, 0);
  f.restart();
  const [result] = await f.resume();
  assert.equal(result.selectedTicker, "QVXL");
  assert.equal(result.status, "confirmed");
  assert.deepEqual(f.preparedTickers, ["RACED", "QVXL"]);
  assert.equal(f.counts.sign, 1);
});


test("Stonx deploy signs on Base through authenticated API and shared IPFS publication", async t => {
  const f = await fixture(t, { stonxMode: true, tickers: ["QVXL", "QVX"] });
  const result = await f.deploy();
  assert.equal(result.status, "confirmed");
  assert.equal(result.selectedTicker, "QVXL");
  assert.equal(result.asset, f.expected());
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.broadcast, 1);
  assert.equal(f.counts.reserve, 1);
  assert.equal(f.counts.publish, 1);
  assert.deepEqual(f.checkedTickers, []);
  assert.ok(f.paths.includes("/v1/agent/stonx/ticker"));
  assert.ok(f.paths.every(path => path.startsWith("/v1/agent/stonx/")));
  f.assertNoSignedBytes();
  f.restart();
  assert.equal((await f.deploy()).hash, result.hash);
  assert.equal(f.counts.sign, 1);
});

test("Stonx uncertain broadcast recovers its Base transaction without signing again", async t => {
  const f = await fixture(t, { stonxMode: true, loseBroadcast: true, tickers: ["QVXL", "QVX"] });
  await assert.rejects(f.deploy());
  f.restart();
  const [result] = await f.resume();
  assert.equal(result.status, "confirmed");
  assert.equal(result.selectedTicker, "QVXL");
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.broadcast, 1);
  f.assertNoSignedBytes();
});

test("Stonx interrupted artwork acknowledgment reuses the paid image and publication", async t => {
  const f = await fixture(t, { stonxMode: true, losePublication: true, grok: true });
  await assert.rejects(f.deploy());
  f.restart();
  const [result] = await f.resume();
  assert.equal(result.status, "confirmed");
  assert.equal(f.imageGenerations(), 1);
  assert.equal(f.counts.publish, 1);
  assert.equal(f.counts.sign, 1);
});

test("Stonx wrong-chain RPC fails before reservation or signing", async t => {
  const f = await fixture(t, { stonxMode: true, wrongChain: true });
  await assert.rejects(f.deploy(), /wrong_chain/);
  assert.equal(f.counts.reserve, 0);
  assert.equal(f.counts.sign, 0);
  assert.equal(f.counts.broadcast, 0);
});

for (const [platform, targetChain] of [["o1", 4663], ["o1", 8453]]) {
  const route = platform === "o1" && targetChain === 8453 ? "o1-base" : platform;
  test(`${platform} chain ${targetChain} deploy traverses authenticated HTTP, IPFS and signing once`, async t => {
    const f = await fixture(t, { platform, targetChain, tickers: ["QVXL", "LATER"] });
    const result = await f.deploy();
    assert.equal(result.status, "confirmed");
    assert.equal(result.asset, f.expected());
    assert.equal(result.selectedTicker, "QVXL");
    assert.deepEqual(f.counts, { sign: 1, broadcast: 1, publish: 1, pin: 2, reserve: 1, prepare: 1, status: 1 });
    assert.ok(f.paths.includes(`/v1/agent/${route}/ticker`));
    assert.ok(f.paths.every(path => path.startsWith(`/v1/agent/${route}/`)));
    assert.deepEqual(f.checkedTickers, platform === "longbow" ? ["QVXL"] : []);
    f.restart();
    assert.deepEqual(await f.deploy(), result);
    assert.deepEqual(await f.resume(), []);
    assert.equal(f.counts.sign, 1);
    assert.equal(f.counts.broadcast, 1);
    f.assertNoSignedBytes();
  });
  test(`${platform} chain ${targetChain} recovers lost broadcast without re-signing`, async t => {
    const f = await fixture(t, { platform, targetChain, loseBroadcast: true, tickers: ["QVXL", "LATER"] });
    await assert.rejects(f.deploy(), /agent_failed/);
    f.restart();
    const [result] = await f.resume();
    assert.equal(result.status, "confirmed");
    assert.equal(result.asset, f.expected());
    assert.equal(result.selectedTicker, "QVXL");
    assert.deepEqual(await f.deploy(), result);
    assert.equal(f.counts.sign, 1);
    assert.equal(f.counts.broadcast, 1);
    assert.equal(f.counts.reserve, 1);
    assert.equal(f.counts.publish, 1);
    f.assertNoSignedBytes();
  });
}
