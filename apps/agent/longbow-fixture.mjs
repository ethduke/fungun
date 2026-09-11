import { toHex, keccak256, decodeFunctionData, encodeFunctionResult, zeroAddress } from 'viem';
import { LONG_CREATE_ABI, buildUnsignedLongLaunch } from '../web/lib/long-encoding/long-launch.mjs';
import { LONGBOW_ROLES, LONGBOW_STATE_ABI } from './longbow-preflight.mjs';
export const syntheticAddress = n => toHex(BigInt(n), { size: 20 });
const code = '0x6001';
const pin = n => ({ address: syntheticAddress(n), codeHash: keccak256(code) });
export function longbowFixture() {
  const profile = { chainId: 4663, launchpad: 'longbow', ...Object.fromEntries(LONGBOW_ROLES.map((r, i) => [r, pin(i + 1)])),
    integrator: syntheticAddress(500), protocolBeneficiary: syntheticAddress(600), platformAllocation: syntheticAddress(800),
    quotes: [{ id: 'longbow-EXAMPLE', token: pin(2n ** 160n - 1n), oracle: pin(100), decimals: 18, oracleDecimals: 8 }] };
  profile.tokenFactory.initCodeHash = keccak256('0x6002');
  const published = { ipfs: { metadataCid: 'bafkreigh2akiscaildc5c5eqkhg5lgfzjuojautmsnb47nbqtwnhx4qyhi' } };
  const input = { chainId: 4663, wallet: syntheticAddress(700), draft: { name: 'Sample', ticker: 'SAMPLE', description: '', launchpad: 'longbow' }, pairId: profile.quotes[0].id };
  const plans = new Map();
  function planFor(nextInput = input, publication = published, id = 'a'.repeat(64)) {
    const intentId = `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20,32)}`;
    const built = buildUnsignedLongLaunch({ chainId: 4663, wallet: nextInput.wallet, draft: nextInput.draft, pairId: nextInput.pairId,
      metadataUri: `ipfs://${publication.ipfs.metadataCid}`, startingTick: -120000, intentId }, profile), now = Date.now();
    const result = { ...built, id, chainId: 4663, profile, intentId, startingTick: -120000, predictedPool: syntheticAddress(900), quotedAt: now, expiresAt: now + 30000,
      transaction: { ...built.transaction, chainId: toHex(4663), value: toHex(0), gas: toHex(30000), gasPrice: toHex(1), nonce: toHex(0) },
      estimatedGas: '25000', launchpadFeeWei: '0', maximumGasWei: '30000' };
    plans.set(result.transaction.data, result);
    return result;
  }
  const plan = planFor(), changes = {}, calls = [];
  const abi = [...LONG_CREATE_ABI, ...LONGBOW_STATE_ABI];
  const rpc = { request: async ({ method, params = [] }) => {
    calls.push({ method, params });
    if (Object.hasOwn(changes, method)) return changes[method];
    if (method === 'eth_chainId') return toHex(4663);
    if (method === 'eth_getTransactionCount') return toHex(0);
    if (method === 'eth_getBalance') return toHex(10n ** 18n);
    if (method === 'eth_getCode') return [...LONGBOW_ROLES.map(r => profile[r].address), profile.quotes[0].token.address, profile.quotes[0].oracle.address].includes(params[0].toLowerCase()) ? code : '0x';
    if (method === 'eth_call') {
      const { functionName, args } = decodeFunctionData({ abi, data: params[0].data });
      const active = plans.get(params[0].data) ?? plan;
      const result = Object.hasOwn(changes, functionName) ? changes[functionName] : {
        create: [active.predictedAsset, active.predictedPool, zeroAddress, zeroAddress, zeroAddress], AIRLOCK: profile.airlock.address, TRUSTED_TOKEN_FACTORY: profile.tokenFactory.address,
        RESERVATION_DURATION: 86400, paused: false, isTickerAvailable: true, decimals: params[0].to.toLowerCase() === profile.quotes[0].oracle.address ? 8 : 18,
        getModuleState: ['tokenFactory', 'governanceFactory', 'poolInitializer', 'liquidityMigrator'].findIndex(r => profile[r].address === args?.[0]) + 1,
      }[functionName];
      return encodeFunctionResult({ abi, functionName, result });
    }
    throw new Error(`Unexpected fixture RPC: ${method}`);
  } };
  return { profile, published, input, plan, planFor, rpc, changes, calls };
}
