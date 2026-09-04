export const MAX_ESTIMATED_GAS_UNITS = 160_000n;
export const MAX_GAS_UNITS = 200_000n;
export const MAX_FEE_PER_GAS_WEI = 5_000_000_000n;
export const MAX_PRIORITY_FEE_PER_GAS_WEI = 100_000_000n;
export const MAX_SETTLEMENT_FEE_WEI = 1_000_000_000_000_000n;
export const RELAYER_FUNDING_TARGET_WEI = 10_000_000_000_000_000n;

const same = (left, right) =>
  typeof left === "string" &&
  typeof right === "string" &&
  left.toLowerCase() === right.toLowerCase();

/**
 * Makes the only enabled state change an explicitly bounded USDG
 * transferWithAuthorization call. Calls are serialized to protect the relayer nonce.
 */
export function createCappedContractWriter({
  publicClient,
  walletClient,
  account,
  asset,
  payTo,
  maxAmount,
  beforeWrite = async () => {},
}) {
  let tail = Promise.resolve();
  return async args => {
    const run = tail.then(async () => {
      if (
        !same(args.address, asset) ||
        args.functionName !== "transferWithAuthorization" ||
        args.dataSuffix !== undefined ||
        !Array.isArray(args.args) ||
        args.args.length !== 9 ||
        !same(args.args[1], payTo) ||
        typeof args.args[2] !== "bigint" ||
        args.args[2] < 1n ||
        args.args[2] > maxAmount
      )
        throw new Error("settlement_call_not_allowed");

      await beforeWrite();
      const balance = await publicClient.getBalance({ address: account.address });
      const estimate = await publicClient.estimateContractGas({
        ...args,
        account,
        args: args.args,
      });
      if (estimate < 1n || estimate > MAX_ESTIMATED_GAS_UNITS)
        throw new Error("settlement_gas_limit_exceeded");
      const gas = (estimate * 120n + 99n) / 100n;
      if (gas < 1n || gas > MAX_GAS_UNITS) throw new Error("settlement_gas_limit_exceeded");

      const block = await publicClient.getBlock({ blockTag: "pending" });
      let feeFields;
      let feePerGas;
      if (block.baseFeePerGas !== null && block.baseFeePerGas !== undefined) {
        const fees = await publicClient.estimateFeesPerGas({ type: "eip1559" });
        feePerGas = fees.maxFeePerGas;
        if (
          typeof fees.maxPriorityFeePerGas !== "bigint" ||
          fees.maxPriorityFeePerGas < 0n ||
          fees.maxPriorityFeePerGas > fees.maxFeePerGas ||
          fees.maxPriorityFeePerGas > MAX_PRIORITY_FEE_PER_GAS_WEI
        )
          throw new Error("settlement_fee_cap_exceeded");
        feeFields = {
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        };
      } else {
        feePerGas = await publicClient.getGasPrice();
        feeFields = { gasPrice: feePerGas };
      }
      if (
        typeof feePerGas !== "bigint" ||
        feePerGas < 1n ||
        feePerGas > MAX_FEE_PER_GAS_WEI ||
        gas * feePerGas > MAX_SETTLEMENT_FEE_WEI ||
        balance < gas * feePerGas
      )
        throw new Error("settlement_fee_cap_exceeded");

      return walletClient.writeContract({
        ...args,
        account,
        gas,
        ...feeFields,
      });
    });
    tail = run.catch(() => {});
    return run;
  };
}
