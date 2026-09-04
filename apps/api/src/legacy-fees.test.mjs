import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex } from "viem";
import { readConfig } from "./config.mjs";
import { escrowAbi, legacyEscrowAbi, readFeeContracts } from "./fee-contracts.mjs";
import { Fees } from "./fees.mjs";

const address = (digit) => `0x${digit.repeat(40)}`;
const owner = address("a");
const escrow = address("b");
const currency = address("c");
const bytecode = "0x60016000";
const profile = { chainId: 4663, escrow, codeHash: keccak256(bytecode) };
const abi = [...escrowAbi, ...legacyEscrowAbi];

function runtime(options = {}) {
  const calls = [];
  const configured = { ...profile, ...(options.version ? { version: options.version } : {}) };
  const config = {
    ...readConfig({}),
    feesEnabled: true,
    claimsEnabled: true,
    o1Key: "EXAMPLE",
    rpcUrl: "EXAMPLE",
    feeContracts: readFeeContracts(JSON.stringify({ o1: [configured] })),
  };
  const service = new Fees(config, {
    async json(provider, _url, request) {
      if (provider === "o1") return {
        data: [{
          chain_id: 4663,
          recipient: owner,
          fee_escrow_address: escrow,
          currency: { address: currency, quote: { address: currency, symbol: "TEST", decimals: 18 } },
          claimable_raw: "10",
          reconciliation: "confirmed",
        }],
        pagination: { has_more: false, next_cursor: null },
      };
      return JSON.parse(request.body).map((call) => {
        calls.push(call);
        let result;
        if (call.method === "eth_chainId") result = toHex(4663);
        else if (call.method === "eth_getCode") result = options.changedCode ? "0x6000" : bytecode;
        else if (call.method === "eth_blockNumber") result = "0x123";
        else if (call.method === "eth_estimateGas") result = toHex(100_000);
        else if (call.method === "eth_gasPrice") result = toHex(1000);
        else if (call.method === "eth_getBalance") result = toHex(10n ** 18n);
        else if (call.method === "eth_call") {
          const { functionName, args } = decodeFunctionData({ abi, data: call.params[0].data });
          assert.equal(call.params[1], "0x123");
          assert.equal(args[0].toLowerCase(), owner);
          assert.equal(args[1].toLowerCase(), currency);
          if (functionName !== "owed") {
            assert.equal(call.params[0].from, owner);
            assert.equal(call.params[0].value, "0x0");
            if (options.revert) return {
              jsonrpc: "2.0", id: call.id,
              error: { code: 3, message: "execution reverted" },
            };
          }
          result = encodeFunctionResult({ abi, functionName, result: functionName === "owed" ? 20n : undefined });
        } else throw new Error("Unexpected RPC method");
        return { jsonrpc: "2.0", id: call.id, result };
      });
    },
  }, () => 1000);
  return { service, calls };
}

test("only an explicit reviewed legacy profile selects owner-bound claim calldata", async () => {
  for (const version of [undefined, "current", "legacy"]) {
    const { service, calls } = runtime({ version });
    const page = await service.list({ address: owner, chainId: 4663, padId: "o1" });
    assert.equal(page.positions[0].verification, "live");
    assert.equal(page.positions[0].escrowVersion, version ?? "current");
    assert.equal(page.positions[0].payouts[0].claimableRaw, "20");
    const prepared = await service.prepare({ address: owner, positionId: page.positions[0].id });
    const method = version === "legacy" ? "claim" : "claimFor";
    assert.equal(prepared.escrowVersion, version ?? "current");
    assert.equal(decodeFunctionData({ abi, data: prepared.data }).functionName, method);
    assert.equal(prepared.target, escrow);
    assert.equal(prepared.value, "0");
    assert.ok(calls.some((call) => call.method === "eth_call" && call.params[0].data === prepared.data));
    assert.ok(calls.some((call) => call.method === "eth_estimateGas" && call.params[0].data === prepared.data));
    await assert.rejects(service.prepare({ address: address("d"), positionId: page.positions[0].id }), { code: "quote_expired" });
  }
});

test("legacy review rejects changed bytecode and does not try a second method after a revert", async () => {
  for (const options of [{ changedCode: true }, { revert: true }]) {
    const { service, calls } = runtime({ version: "legacy", ...options });
    const page = await service.list({ address: owner, chainId: 4663, padId: "o1" });
    await assert.rejects(service.prepare({ address: owner, positionId: page.positions[0].id }), {
      code: options.changedCode ? "contract_unverified" : "reverted",
    });
    const methods = calls.filter((call) => call.method === "eth_call")
      .map((call) => decodeFunctionData({ abi, data: call.params[0].data }).functionName);
    assert.ok(!methods.includes("claimFor"));
    assert.equal(methods.filter((method) => method === "claim").length, options.changedCode ? 0 : 1);
  }
  for (const version of [null, "auto", "claimTo", 1])
    assert.throws(() => readFeeContracts(JSON.stringify({ o1: [{ ...profile, version }] })), {
      code: "invalid_fee_configuration",
    });
});
