import { toHex, keccak256, parseAbi, decodeFunctionData, encodeFunctionResult, zeroAddress } from 'viem';
import { STONX_ABI, STONX_ROLES, stonxPairId, stonxWrapperCodeHash, stonxWrapperBytecode, buildUnsignedStonxLaunch } from '../web/lib/long-encoding/stonx-launch.mjs';
export const syntheticAddress = n => toHex(BigInt(n), { size: 20 });
const code = '0x6001';
const pin = n => ({ address: syntheticAddress(n), codeHash: keccak256(code) });
export function stonxFixture() {
  const beacon = pin(123), token = { ...pin(2n ** 159n), codeHash: stonxWrapperCodeHash(beacon.address) };
  const quote = { id: stonxPairId(token.address), token, beacon, implementation: pin(124), symbol: 'wtNVDA', decimals: 18 };
  const profile = { chainId: 8453, launchpad: 'stonx', ...Object.fromEntries(STONX_ROLES.map((r, i) => [r, pin(i + 1)])),
    integrator: syntheticAddress(500), protocolBeneficiary: syntheticAddress(600), quotes: [quote] };
  const baseFeeOracle = pin(125);
  const published = { ipfs: { metadataCid: 'bafkreigh2akiscaildc5c5eqkhg5lgfzjuojautmsnb47nbqtwnhx4qyhi' } };
  const input = { chainId: 8453, wallet: syntheticAddress(700), draft: { name: 'Sample', ticker: 'SAMPLE', description: '' }, pairId: quote.id };
  function planFor(nextInput = input, publication = published, id = 'a'.repeat(64)) {
    const stonxBuildInput = { wallet: nextInput.wallet, draft: nextInput.draft, pairId: nextInput.pairId,
      metadataUri: `ipfs://${publication.ipfs.metadataCid}`, quotePriceUsd: '226.65000000', intentId: id };
    const built = buildUnsignedStonxLaunch(stonxBuildInput, profile), now = Date.now();
    return { ...built, id, chainId: 8453, stonxBuildInput, quotedAt: now, expiresAt: now + 30000,
      transaction: { ...built.transaction, chainId: '0x2105', gas: toHex(30000n), gasPrice: toHex(1n), nonce: toHex(0n) },
      estimatedGas: '25000', launchpadFeeWei: '0', maximumGasWei: '31400', baseFees: { l1DataFeeWei: '1200', operatorFeeWei: '200' } };
  }
  const plan = planFor(), changes = {}, calls = [];
  const abi = [...STONX_ABI, ...parseAbi(['function getL1Fee(bytes) view returns (uint256)', 'function getOperatorFee(uint256) view returns (uint256)'])];
  const rpc = { request: async ({ method, params = [] }) => {
    calls.push({ method, params });
    if (Object.hasOwn(changes, method)) return changes[method];
    if (method === 'eth_chainId') return toHex(8453);
    if (method === 'eth_getTransactionCount') return toHex(0);
    if (method === 'eth_getBalance') return toHex(10n ** 18n);
    if (method === 'eth_getCode') return params[0].toLowerCase() === token.address ? stonxWrapperBytecode(beacon.address) : code;
    if (method === 'eth_call') {
      const { functionName, args } = decodeFunctionData({ abi, data: params[0].data });
      let result;
      if (Object.hasOwn(changes, functionName)) result = changes[functionName];
      else if (functionName === 'create') result = [plan.predictedAsset, plan.predictedAsset, zeroAddress, zeroAddress, zeroAddress];
      else result = { implementation: quote.implementation.address, owner: profile.protocolBeneficiary, airlock: profile.launcher.address,
        poolManager: profile.poolManager.address, symbol: quote.symbol, decimals: 18, getL1Fee: 1000n, getOperatorFee: 200n,
        getModuleState: ['tokenFactory', 'governanceFactory', 'poolInitializer', 'liquidityMigrator'].findIndex(r => profile[r].address === args?.[0]) + 1 }[functionName];
      return encodeFunctionResult({ abi, functionName, result });
    }
    throw new Error(`Unexpected fixture RPC: ${method}`);
  } };
  return { profile, baseFeeOracle, published, input, plan, planFor, rpc, changes, calls };
}
