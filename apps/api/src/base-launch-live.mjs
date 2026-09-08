import { serializeTransaction } from 'viem';
import { LongLive } from './long-live.mjs';
import { oracleAbi } from './fee-contracts.mjs';
import { rpcNumber } from './fee-rpc.mjs';
import { ServiceError } from './errors.mjs';
const fail = code => { throw new ServiceError(code, 409); };

// Shared OP Stack execution, L1 data and operator fee accounting.
export class BaseLaunchLive extends LongLive {
  async baseFees(transaction, gas, gasPrice, nonce, block) {
    const oracle = this.config.feeContracts?.baseOracle;
    if (!oracle) fail('contract_unverified');
    await this.rpc.verify(8453, [oracle], true, block);
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) fail('launch_gas_limit');
    const encoded = serializeTransaction({ chainId: 8453, type: 'legacy', nonce: Number(nonce),
      to: transaction.to, data: transaction.data, value: BigInt(transaction.value), gas, gasPrice });
    const [l1, operator] = await this.rpc.calls(8453, [
      { address: oracle.address, abi: oracleAbi, functionName: 'getL1Fee', args: [encoded] },
      { address: oracle.address, abi: oracleAbi, functionName: 'getOperatorFee', args: [gas] },
    ], block);
    if (l1 < 0n || operator < 0n || l1 + operator > 5n * 10n ** 16n) fail('launch_gas_limit');
    return { l1DataFeeWei: ((l1 * 120n + 99n) / 100n).toString(), operatorFeeWei: operator.toString() };
  }
  async paidGas(receipt, block) {
    const execution = await super.paidGas(receipt, block);
    if (this.chainId !== 8453) return execution;
    const oracle = this.config.feeContracts?.baseOracle;
    if (!oracle) fail('contract_unverified');
    await this.rpc.verify(8453, [oracle], true, block);
    const [operator] = await this.rpc.calls(8453, [{ address: oracle.address, abi: oracleAbi,
      functionName: 'getOperatorFee', args: [rpcNumber(receipt.gasUsed)] }], block);
    return execution + rpcNumber(receipt.l1Fee) + operator;
  }
}
