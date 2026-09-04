import assert from "node:assert/strict";
import test from "node:test";
import {
  createCappedContractWriter,
  MAX_ESTIMATED_GAS_UNITS,
  MAX_FEE_PER_GAS_WEI,
} from "./gas-policy.mjs";

const account = { address: `0x${"11".repeat(20)}` };
const asset = `0x${"22".repeat(20)}`;
const payTo = `0x${"33".repeat(20)}`;
const args = {
  address: asset,
  abi: [],
  functionName: "transferWithAuthorization",
  args: [account.address, payTo, 25_000n, 1n, 2n, `0x${"44".repeat(32)}`, 27, "0x1", "0x2"],
};

function clients(overrides = {}) {
  const writes = [];
  const publicClient = {
    getBalance: async () => 1_000_000_000_000_000n,
    estimateContractGas: async () => 100_000n,
    getBlock: async () => ({ baseFeePerGas: 1n }),
    estimateFeesPerGas: async () => ({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }),
    getGasPrice: async () => 1_000_000_000n,
    ...overrides,
  };
  const walletClient = {
    async writeContract(value) {
      writes.push(value);
      return `0x${"55".repeat(32)}`;
    },
  };
  return { publicClient, walletClient, writes };
}

test("submits only USDG authorization transfers with explicit gas and fee ceilings", async () => {
  const state = clients();
  const write = createCappedContractWriter({
    ...state,
    account,
    asset,
    payTo,
    maxAmount: 100_000n,
  });
  await write(args);
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].gas, 120_000n);
  assert.equal(state.writes[0].maxFeePerGas, 1_000_000_000n);
  assert.equal(state.writes[0].account, account);
});

test("fails before broadcast for another target, excessive gas, or excessive fee", async () => {
  const cases = [
    {
      args: { ...args, address: account.address },
      clients: clients(),
      reason: "settlement_call_not_allowed",
    },
    {
      args,
      clients: clients({ estimateContractGas: async () => MAX_ESTIMATED_GAS_UNITS + 1n }),
      reason: "settlement_gas_limit_exceeded",
    },
    {
      args,
      clients: clients({
        estimateFeesPerGas: async () => ({
          maxFeePerGas: MAX_FEE_PER_GAS_WEI + 1n,
          maxPriorityFeePerGas: 1n,
        }),
      }),
      reason: "settlement_fee_cap_exceeded",
    },
  ];
  for (const item of cases) {
    const write = createCappedContractWriter({
      ...item.clients,
      account,
      asset,
      payTo,
      maxAmount: 100_000n,
    });
    await assert.rejects(write(item.args), error => error.message === item.reason);
    assert.equal(item.clients.writes.length, 0);
  }
});
