const fakeSignedHex = `0x${"ab".repeat(65)}`;
const exampleEndpoint = "https://rpc.example/private-key";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createImageSettlementReader,
  AUTHORIZATION_USED_TOPIC,
} from "./image-settlement-reader.mjs";
import { imagePaymentDomainSeparator } from "./x402-payments.mjs";
import { keccak256, toHex } from "viem";
const USDG_ADDRESS = `0x${"ef".repeat(20)}`;
const USDG_DOMAIN_SEPARATOR = imagePaymentDomainSeparator(USDG_ADDRESS);

const payer = `0x${"12".repeat(20)}`;
const payTo = `0x${"34".repeat(20)}`;
const nonce = `0x${"56".repeat(32)}`;
const transactionHash = `0x${"78".repeat(32)}`;
const blockHash = `0x${"9a".repeat(32)}`;
const addressTopic = (value) => `0x${value.slice(2).padStart(64, "0")}`;
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
function fixture() {
  const requirements = {
    scheme: "exact",
    network: "eip155:4663",
    asset: USDG_ADDRESS,
    amount: "250000",
    payTo,
    maxTimeoutSeconds: 600,
    extra: {
      name: "Global Dollar",
      version: "1",
      assetTransferMethod: "eip3009",
      paymentFlow: "authorization",
      payer,
      nonce,
      issuedAt: 1700000060000,
      expiresAt: 1700000600000,
      fromBlock: "0x3e8",
    },
  };
  const proof = {
    x402Version: 2,
    accepted: requirements,
    payload: {
      signature: fakeSignedHex,
      authorization: {
        from: payer,
        to: payTo,
        value: "250000",
        validAfter: "1700000000",
        validBefore: "1700000600",
        nonce,
      },
    },
  };
  const log = {
    address: USDG_ADDRESS,
    transactionHash,
    blockHash,
    blockNumber: "0x3e8",
    removed: false,
    topics: [AUTHORIZATION_USED_TOPIC, addressTopic(payer), nonce],
    data: "0x",
  };
  const transfer = {
    ...log,
    topics: [
      keccak256(toHex("Transfer(address,address,uint256)")),
      addressTopic(payer),
      addressTopic(payTo),
    ],
    data: word(250000),
  };
  const receipt = {
    transactionHash,
    blockHash,
    blockNumber: "0x3e8",
    status: "0x1",
    logs: [log, transfer],
  };
  const state = {
    chainId: "0x1237",
    head: "0x3e9",
    code: "0x6000",
    decimals: word(6),
    domain: USDG_DOMAIN_SEPARATOR,
    block: { hash: blockHash, number: "0x3e8", timestamp: "0x6553f357" },
    logs: [log],
    receipt,
  };
  const calls = [];
  const reader = createImageSettlementReader({
    asset: USDG_ADDRESS,
    rpcUrl: exampleEndpoint,
    fetcher: async (_url, options) => {
      const request = JSON.parse(options.body);
      calls.push(request);
      let result;
      switch (request.method) {
        case "eth_chainId":
          result = state.chainId;
          break;
        case "eth_blockNumber":
          result = state.head;
          break;
        case "eth_getCode":
          result = state.code;
          break;
        case "eth_call":
          result = request.params[0].data === "0x313ce567" ? state.decimals : state.domain;
          break;
        case "eth_getTransactionReceipt":
          result = state.receipt;
          break;
        case "eth_getBlockByNumber":
          result = state.block;
          break;
        case "eth_getLogs":
          result = state.logs.filter(
            (item) =>
              BigInt(item.blockNumber) >= BigInt(request.params[0].fromBlock) &&
              BigInt(item.blockNumber) <= BigInt(request.params[0].toBlock),
          );
          break;
        default:
          throw new Error(`unexpected_method_${request.method}`);
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    },
  });
  return { reader, requirements, proof, state, receipt, log, transfer, calls };
}
const recover = (f) => f.reader.recover(f.proof, f.requirements);
test("anchor verifies configured chain, USDG code, decimals and signing domain", async () => {
  assert.equal(await fixture().reader.anchor(), "0x3e9");
  for (const [key, value] of [
    ["chainId", "0x1"],
    ["code", "0x"],
    ["decimals", word(18)],
    ["domain", word(1)],
  ]) {
    const f = fixture();
    f.state[key] = value;
    await assert.rejects(f.reader.anchor(), (error) => error.code === "image_payment_unavailable");
  }
});
test("a lost settlement response recovers by payer and nonce without re-settling", async () => {
  const f = fixture();
  assert.deepEqual(await recover(f), {
    success: true,
    transaction: transactionHash,
    network: "eip155:4663",
    payer,
    amount: "250000",
  });
  const query = f.calls.find((call) => call.method === "eth_getLogs").params[0];
  assert.deepEqual(query, {
    address: USDG_ADDRESS,
    topics: [AUTHORIZATION_USED_TOPIC, addressTopic(payer), nonce],
    fromBlock: "0x3e8",
    toBlock: "0x3e9",
  });
  assert.ok(f.calls.every((call) => !/send|sign|estimate/i.test(call.method)));
});
test("a known receipt recovers old jobs without an unbounded historical scan", async () => {
  const f = fixture();
  f.state.head = "0x10000";
  assert.equal(
    (await f.reader.recover(f.proof, f.requirements, transactionHash)).transaction,
    transactionHash,
  );
  assert.equal(f.calls.filter((call) => call.method === "eth_getLogs").length, 0);
});
test("old jobs without a known receipt require review instead of partial scans", async () => {
  const f = fixture();
  f.state.head = `0x${(1000 + 20000).toString(16)}`;
  await assert.rejects(recover(f), (error) => error.code === "image_settlement_review_required");
  assert.equal(f.calls.filter((call) => call.method === "eth_getLogs").length, 0);
});
test("authorization expiry uses a confirmed chain timestamp", async () => {
  const f = fixture();
  assert.equal(await f.reader.expired(f.proof, f.requirements), false);
  f.state.block.timestamp = "0x6553f358";
  assert.equal(await f.reader.expired(f.proof, f.requirements), true);
  assert.equal(
    f.calls.filter((call) => call.method === "eth_getBlockByNumber").at(-1).params[0],
    "0x3e8",
  );
});
test("scan chunks are explicit, bounded, complete and nonoverlapping", async () => {
  const f = fixture();
  f.state.head = `0x${(1000 + 4500).toString(16)}`;
  f.state.logs = [];
  assert.equal(await recover(f), null);
  assert.deepEqual(
    f.calls
      .filter((call) => call.method === "eth_getLogs")
      .map((call) => [call.params[0].fromBlock, call.params[0].toBlock]),
    [
      ["0x3e8", "0xbb7"],
      ["0xbb8", "0x1387"],
      ["0x1388", "0x157c"],
    ],
  );
});
test("pending, reverted and reorged receipts cannot release the image", async () => {
  for (const mutate of [
    (f) => {
      f.state.receipt = null;
    },
    (f) => {
      f.receipt.status = "0x0";
    },
    (f) => {
      f.state.head = "0x3e8";
    },
    (f) => {
      f.state.block.hash = transactionHash;
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.equal(await recover(f), null);
  }
});
test("a transfer alone, consumed nonce alone, wrong recipient, amount, token or nonce are insufficient", async () => {
  for (const mutate of [
    (f) => {
      f.receipt.logs = [f.transfer];
    },
    (f) => {
      f.receipt.logs = [f.log];
    },
    (f) => {
      f.transfer.topics[2] = addressTopic(payer);
    },
    (f) => {
      f.transfer.data = word(1);
    },
    (f) => {
      f.transfer.address = payTo;
    },
    (f) => {
      f.receipt.logs[0] = {
        ...f.log,
        topics: [AUTHORIZATION_USED_TOPIC, addressTopic(payer), transactionHash],
      };
    },
    (f) => {
      f.transfer.blockHash = transactionHash;
    },
    (f) => {
      f.transfer.removed = true;
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.equal(await recover(f), null);
  }
});
test("multiple payer authorizations cannot claim the same single transfer for separate jobs", async () => {
  const f = fixture();
  f.receipt.logs.push({
    ...f.log,
    topics: [AUTHORIZATION_USED_TOPIC, addressTopic(payer), transactionHash],
  });
  await assert.rejects(recover(f), (error) => error.code === "image_settlement_review_required");
});
test("wrong chain, malformed RPC, transport errors, and missing anchor fail closed without exposing URL", async () => {
  const f = fixture();
  f.state.chainId = "0x1";
  await assert.rejects(recover(f), (error) => error.code === "image_payment_unavailable");
  const missing = fixture();
  delete missing.requirements.extra.fromBlock;
  await assert.rejects(recover(missing), (error) => error.code === "invalid_image_payment_quote");
  for (const fetcher of [
    async () => {
      throw new Error("private-key");
    },
    async () => Response.json({ id: -1, result: "0x1237" }),
    async () => new Response("x".repeat(1024 * 1024 + 1)),
  ]) {
    const reader = createImageSettlementReader({
      asset: USDG_ADDRESS,
      rpcUrl: exampleEndpoint,
      fetcher,
    });
    await assert.rejects(
      reader.anchor(),
      (error) =>
        error.code === "image_payment_unavailable" && !error.message.includes("private-key"),
    );
  }
});
