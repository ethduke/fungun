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
  toHex,
  parseTransaction,
  recoverTransactionAddress,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { FungunAgent } from "./index.mjs";
import { Budget } from "../api/src/budget.mjs";
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

async function fixture(t, { loseBroadcast = false, losePublication = false } = {}) {
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
        assert.equal(input.wallet, account.address.toLowerCase());
        assert.equal(input.publication.id, publication.id);
        assert.equal(input.publication.metadataHash, publication.metadataHash);
        const metadata = JSON.parse(contents.get(publication.ipfs.metadataCid));
        assert.equal(metadata.website, input.draft.website);
        assert.equal(metadata.twitter, input.draft.twitter);
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
  const config = { origin, longLaunch: { assetOrigin, profile } };
  const server = createServer(
    createAgentHandler(
      {
        config,
        budget,
        launches,
        adapters: {},
        fetcher: assetFetcher,
        agent: {
          enabled: true,
          publicAssetOrigin: assetOrigin,
          clients: [
            {
              id: "integration",
              wallet: account.address.toLowerCase(),
              scopes: ["long:deploy"],
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
        assert.equal(tx.chainId, 4663);
        assert.equal(tx.data, plan.transaction.data);
        assert.equal(tx.to.toLowerCase(), profile.launcher.address.toLowerCase());
        assert.equal(tx.nonce, 0);
        submittedHash = keccak256(params[0]);
        if (loseBroadcast) throw Error("synthetic dropped broadcast acknowledgment");
        return submittedHash;
      }
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
    profile,
    journalPath: join(root, "agent-journal.json"),
  };
  let agent = new FungunAgent(settings);
  const input = {
    name: "Quorvix Lantern",
    ticker: "QVXL",
    description: "A test coin",
    website: "https://example.com",
    twitter: "https://x.com/example",
    pairId: "long-EXAMPLE",
    image: image.toString("base64"),
  };
  return {
    counts,
    input,
    deploy: () => agent.deploy(input, { intentKey: "stable-intent" }),
    resume: () => agent.resume(),
    restart: () => {
      agent = new FungunAgent(settings);
    },
    expected: () => plan.predictedAsset,
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
