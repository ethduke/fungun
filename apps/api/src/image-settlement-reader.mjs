import { Buffer } from "node:buffer";
import { ServiceError } from "./errors.mjs";
import { keccak256, toHex } from "viem";
import {
  IMAGE_PAYMENT_CHAIN_ID,
  IMAGE_PAYMENT_NETWORK,
  USDG_DECIMALS,
  imagePaymentDomainSeparator,
  validateImagePaymentPayload,
} from "./x402-payments.mjs";

// Confirmed on canonical USDG using cast logs, 2026-09-04.
export const AUTHORIZATION_USED_TOPIC = keccak256(toHex("AuthorizationUsed(address,bytes32)"));
const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));
const MAX_SCAN_BLOCKS = 20_000n;
const SCAN_CHUNK_BLOCKS = 2_000n;
const MIN_CONFIRMATIONS = 2n;
const RESPONSE_LIMIT = 1024 * 1024;
const HASH = /^0x[0-9a-f]{64}$/i;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const same = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const hex = (value) => `0x${value.toString(16)}`;
const topicAddress = (value) => `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
const unavailable = () => new ServiceError("image_payment_unavailable", 503);
const reviewRequired = () => new ServiceError("image_settlement_review_required", 409);
function quantity(value) {
  if (typeof value !== "string" || !QUANTITY.test(value)) throw unavailable();
  return BigInt(value);
}
function fromBlockValue(value) {
  if (typeof value !== "string" || (!QUANTITY.test(value) && !/^(0|[1-9][0-9]*)$/.test(value))) {
    throw new ServiceError("invalid_image_payment_quote", 400);
  }
  return BigInt(value);
}
async function boundedJson(response) {
  if (!response.body) throw unavailable();
  const declared = response.headers.get("content-length");
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > RESPONSE_LIMIT)) {
    await response.body.cancel();
    throw unavailable();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_LIMIT) throw unavailable();
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Fixed-chain read-only reconciliation. No transaction broadcasts, nonce-state
 * shortcut, unbounded log scans, or arbitrary request-provided RPC endpoint.
 * anchor() returns a hex height to persist in requirements.extra.fromBlock.
 * recover() returns a standard x402 receipt, null if not yet proven settled,
 * or image_settlement_review_required if the bounded scan cannot cover history.
 * expired() checks a confirmed block timestamp before declaring that the saved
 * authorization can no longer be settled.
 * Persist the returned transaction so later recovery uses the direct receipt.
 */
export function createImageSettlementReader({ rpcUrl, asset, fetcher = fetch } = {}) {
  const expectedDomain = imagePaymentDomainSeparator(asset);
  let endpoint;
  try {
    endpoint = new URL(rpcUrl);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash)
      throw new Error();
  } catch {
    throw new ServiceError("image_payment_rpc_not_configured", 503);
  }
  let nextId = 0;
  async function rpc(method, params = [], signal = AbortSignal.timeout(15_000)) {
    const id = ++nextId;
    try {
      const response = await fetcher(endpoint.href, {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw unavailable();
      }
      const body = await boundedJson(response);
      if (
        !object(body) ||
        body.jsonrpc !== "2.0" ||
        body.id !== id ||
        body.error ||
        !Object.hasOwn(body, "result")
      )
        throw unavailable();
      return body.result;
    } catch {
      throw unavailable();
    }
  }
  async function chainAndHead(signal) {
    const [chain, head] = await Promise.all([
      rpc("eth_chainId", [], signal),
      rpc("eth_blockNumber", [], signal),
    ]);
    if (quantity(chain) !== BigInt(IMAGE_PAYMENT_CHAIN_ID)) throw unavailable();
    return quantity(head);
  }

  return {
    async anchor() {
      const signal = AbortSignal.timeout(15_000);
      const [head, code, decimals, domain] = await Promise.all([
        chainAndHead(signal),
        rpc("eth_getCode", [asset, "latest"], signal),
        rpc("eth_call", [{ to: asset, data: "0x313ce567" }, "latest"], signal),
        rpc("eth_call", [{ to: asset, data: "0x3644e515" }, "latest"], signal),
      ]);
      if (
        typeof code !== "string" ||
        !/^0x[0-9a-f]+$/i.test(code) ||
        code.length <= 2 ||
        typeof decimals !== "string" ||
        !HASH.test(decimals) ||
        BigInt(decimals) !== BigInt(USDG_DECIMALS) ||
        !same(domain, expectedDomain)
      )
        throw unavailable();
      return hex(head);
    },

    async recover(proof, requirements, transactionHint = "") {
      const payment = validateImagePaymentPayload(proof, requirements, asset);
      const fromBlock = fromBlockValue(requirements.extra.fromBlock);
      const nonce = proof.payload.authorization.nonce;
      const fromTopic = topicAddress(payment.payer);
      const toTopic = topicAddress(requirements.payTo);
      const signal = AbortSignal.timeout(45_000);
      const head = await chainAndHead(signal);
      if (fromBlock > head) return null;
      if (transactionHint && (typeof transactionHint !== "string" || !HASH.test(transactionHint))) {
        throw new ServiceError("invalid_image_payment", 400);
      }

      async function receiptFor(hash) {
        const receipt = await rpc("eth_getTransactionReceipt", [hash], signal);
        if (!receipt) return null;
        if (
          !object(receipt) ||
          !same(receipt.transactionHash, hash) ||
          !HASH.test(receipt.blockHash) ||
          quantity(receipt.status) !== 1n ||
          !Array.isArray(receipt.logs)
        )
          return null;
        const number = quantity(receipt.blockNumber);
        if (number < fromBlock || number > head || head - number + 1n < MIN_CONFIRMATIONS)
          return null;
        const canonical = await rpc("eth_getBlockByNumber", [hex(number), false], signal);
        if (
          !canonical ||
          !same(canonical.hash, receipt.blockHash) ||
          quantity(canonical.number) !== number
        )
          return null;

        const tokenEvents = receipt.logs.filter((log) => object(log) && same(log.address, asset));
        const eventContext = (log) =>
          !log.removed &&
          same(log.transactionHash, hash) &&
          same(log.blockHash, receipt.blockHash) &&
          quantity(log.blockNumber) === number;
        const payerAuthorizations = tokenEvents.filter(
          (log) =>
            Array.isArray(log.topics) &&
            log.topics.length === 3 &&
            same(log.topics[0], AUTHORIZATION_USED_TOPIC) &&
            same(log.topics[1], fromTopic),
        );
        const used = payerAuthorizations.filter((log) => same(log.topics[2], nonce));
        const transfers = tokenEvents.filter(
          (log) =>
            Array.isArray(log.topics) &&
            log.topics.length === 3 &&
            same(log.topics[0], TRANSFER_TOPIC) &&
            same(log.topics[1], fromTopic) &&
            same(log.topics[2], toTopic) &&
            typeof log.data === "string" &&
            HASH.test(log.data) &&
            BigInt(log.data) === BigInt(requirements.amount),
        );
        // Without a call trace, multiple authorizations by the same payer in
        // one transaction cannot be paired unambiguously with transfer logs.
        // Do not let two job nonces claim the same single merchant transfer.
        if (payerAuthorizations.length > 1) throw reviewRequired();
        if (
          used.length !== 1 ||
          used[0].data !== "0x" ||
          transfers.length !== 1 ||
          !eventContext(used[0]) ||
          !eventContext(transfers[0])
        )
          return null;
        return {
          success: true,
          transaction: hash.toLowerCase(),
          network: IMAGE_PAYMENT_NETWORK,
          payer: payment.payer,
          amount: requirements.amount,
        };
      }

      if (transactionHint) {
        const receipt = await receiptFor(transactionHint);
        if (receipt) return receipt;
      }
      // Do not claim a partial scan is a negative result. Old jobs require an
      // operator-supplied transaction hint or a separate audited history scan.
      if (head - fromBlock + 1n > MAX_SCAN_BLOCKS) throw reviewRequired();
      const candidates = new Set();
      for (let start = fromBlock; start <= head; start += SCAN_CHUNK_BLOCKS) {
        const end = start + SCAN_CHUNK_BLOCKS - 1n > head ? head : start + SCAN_CHUNK_BLOCKS - 1n;
        const logs = await rpc(
          "eth_getLogs",
          [
            {
              address: asset,
              topics: [AUTHORIZATION_USED_TOPIC, fromTopic, nonce],
              fromBlock: hex(start),
              toBlock: hex(end),
            },
          ],
          signal,
        );
        if (!Array.isArray(logs) || logs.length > 32) throw unavailable();
        for (const log of logs) {
          if (!object(log) || log.removed === true) continue;
          if (
            !same(log.address, asset) ||
            !Array.isArray(log.topics) ||
            log.topics.length !== 3 ||
            !same(log.topics[0], AUTHORIZATION_USED_TOPIC) ||
            !same(log.topics[1], fromTopic) ||
            !same(log.topics[2], nonce) ||
            log.data !== "0x" ||
            !HASH.test(log.transactionHash) ||
            quantity(log.blockNumber) < start ||
            quantity(log.blockNumber) > end
          )
            throw unavailable();
          candidates.add(log.transactionHash.toLowerCase());
          if (candidates.size > 4) throw reviewRequired();
        }
      }
      let found = null;
      for (const candidate of candidates) {
        const receipt = await receiptFor(candidate);
        if (!receipt) continue;
        if (found) throw reviewRequired();
        found = receipt;
      }
      return found;
    },

    async expired(proof, requirements) {
      validateImagePaymentPayload(proof, requirements, asset);
      const validBefore = BigInt(proof.payload.authorization.validBefore);
      const signal = AbortSignal.timeout(15_000);
      const head = await chainAndHead(signal);
      if (head + 1n < MIN_CONFIRMATIONS) return false;
      const number = head - (MIN_CONFIRMATIONS - 1n);
      const confirmed = await rpc("eth_getBlockByNumber", [hex(number), false], signal);
      if (!object(confirmed) || !HASH.test(confirmed.hash) || quantity(confirmed.number) !== number)
        throw unavailable();
      return quantity(confirmed.timestamp) >= validBefore;
    },
  };
}
