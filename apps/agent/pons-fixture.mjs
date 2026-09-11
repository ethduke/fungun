import { toHex, keccak256, decodeFunctionData, encodeFunctionResult } from 'viem';
import { PONS_ABI, PONS_ROLES, buildUnsignedPonsLaunch } from '../web/lib/long-encoding/pons-launch.mjs';
export const syntheticAddress = n => toHex(BigInt(n), { size: 20 });
const code = '0x6001';
export function ponsFixture() {
  const profile = { chainId: 4663, launchpad: 'pons', launchConfigId: '1',
    ...Object.fromEntries(PONS_ROLES.map((role, i) => [role, { address: syntheticAddress(i + 1), codeHash: keccak256(code) }])) };
  const published = { ipfs: { imageCid: 'bafkreigh2akiscaildc5c5eqkhg5lgfzjuojautmsnb47nbqtwnhx4qyhi', metadataCid: 'bafkreigh2akiscaildc5c5eqkhg5lgfzjuojautmsnb47nbqtwnhx4qyhi' } };
  const input = { chainId: 4663, wallet: syntheticAddress(700), draft: { name: 'Sample', ticker: 'SAMPLE', description: '' }, pairId: 'pons-native' };
  const economics = keccak256(toHex('fixture economics'));
  const config = { supply: 10n ** 27n, curveFeeBps: 100n, phantomQuote: 1n, graduationThreshold: 10n ** 18n, poolFee: 3000, tickSpacing: 60, enabled: true };
  const predictedAsset = syntheticAddress(800), predictedPool = syntheticAddress(801), fee = 1000n;
  function planFor(nextInput = input, publication = published, id = 'a'.repeat(64)) {
    const ponsBuildInput = { wallet: nextInput.wallet, draft: nextInput.draft, pairId: nextInput.pairId,
      imageUri: `ipfs://${publication.ipfs.imageCid}`, metadataUri: `ipfs://${publication.ipfs.metadataCid}`,
      expectedEconomics: economics, totalSupply: config.supply.toString(), launchpadFeeWei: fee.toString(), intentId: id };
    const built = buildUnsignedPonsLaunch(ponsBuildInput, profile), now = Date.now();
    return { ...built, id, chainId: 4663, ponsBuildInput, quotedAt: now, expiresAt: now + 30000,
      transaction: { ...built.transaction, chainId: '0x1237', gas: toHex(30000n), gasPrice: toHex(1n), nonce: toHex(0n) },
      predictedAsset, predictedPool, saltAttempt: 0, graduationThreshold: config.graduationThreshold.toString(),
      estimatedGas: '25000', launchpadFeeWei: fee.toString(), maximumGasWei: '30000' };
  }
  const plan = planFor(), changes = {}, calls = [];
  const rpc = { request: async ({ method, params = [] }) => {
    calls.push({ method, params });
    if (Object.hasOwn(changes, method)) return changes[method];
    if (method === 'eth_chainId') return toHex(4663);
    if (method === 'eth_getTransactionCount') return toHex(0);
    if (method === 'eth_getBalance') return toHex(10n ** 18n);
    if (method === 'eth_getCode') return PONS_ROLES.some(r => profile[r].address === params[0].toLowerCase()) ? code : (changes.walletCode ?? '0x');
    if (method === 'eth_call') {
      const { functionName } = decodeFunctionData({ abi: PONS_ABI, data: params[0].data });
      const result = Object.hasOwn(changes, functionName) ? changes[functionName] :
        ({ getLaunchConfig: config, previewLaunchEconomics: economics, launchFee: fee, canLaunch: true,
          launchToken: [predictedAsset, predictedPool], ...Object.fromEntries(PONS_ROLES.slice(1).map(r => [r, profile[r].address])) })[functionName];
      return encodeFunctionResult({ abi: PONS_ABI, functionName, result });
    }
    throw new Error(`Unexpected fixture RPC: ${method}`);
  } };
  return { profile, published, input, plan, planFor, rpc, changes, calls, config };
}
