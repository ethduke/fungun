import { decodeEventLog, encodeAbiParameters, keccak256, parseAbi, parseAbiParameters } from 'viem';
import { ServiceError } from './errors.mjs';

export const LONGBOW_STATE_ABI = parseAbi([
  'function airlock() view returns (address)',
  'function owner() view returns (address)',
  'function getModuleState(address) view returns (uint8)',
  'function isDopplerHookEnabled(address) view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function tokenURI() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function getAssetData(address) view returns (address,address,address,address,address,address,address,uint256,uint256,address)',
  'function getState(address) view returns (address,uint256,address,bytes,uint8,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),int24)',
  'function getShares(bytes32,address) view returns (uint256)',
  'function getFeeRoutingMode(bytes32) view returns (uint8)',
  'function getIntegratorFeeShare(bytes32) view returns (uint24)',
  'function getFeeDistributionInfo(bytes32) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)',
  'function getFeeSchedule(bytes32) view returns (uint32,uint24,uint24,uint24,uint32)',
  'event LongbowLaunch(address indexed asset,address indexed creator,address indexed numeraire,address pool,string symbol)',
]);
const call = (address, functionName, args = []) => ({ address, abi: LONGBOW_STATE_ABI, functionName, args });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const fail = code => { throw new ServiceError(code, 409); };
export async function verifyLongbowLauncher(rpc, p, block) {
  const [airlock, owner, flags, ...modules] = await rpc.calls(4663, [
    call(p.launcher.address, 'airlock'), call(p.airlock.address, 'owner'),
    call(p.poolInitializer.address, 'isDopplerHookEnabled', [p.dopplerHook.address]),
    ...['tokenFactory', 'governanceFactory', 'poolInitializer', 'liquidityMigrator']
      .map(role => call(p.airlock.address, 'getModuleState', [p[role].address])),
  ], block);
  if (!same(airlock, p.airlock.address) || !same(owner, p.protocolBeneficiary)
    || flags !== 3n || modules.some((value, i) => value !== i + 1)) fail('contract_unverified');
}
export async function confirmLongbow(rpc, plan, context, receipt, block) {
  const p = plan.profile, q = p.quotes.find(q => q.id === context.pairId);
  const recipient = context.feeRecipient ?? context.wallet;
  await rpc.verify(4663, [p.launcher, p.airlock, p.poolInitializer, p.dopplerHook], true, block);
  const events = receipt.logs.filter(log => same(log.address, p.launcher.address)).flatMap(log => {
    try { return [decodeEventLog({ abi: LONGBOW_STATE_ABI, eventName: 'LongbowLaunch', data: log.data, topics: log.topics, strict: true }).args]; }
    catch { return []; }
  });
  const event = events[0];
  if (events.length !== 1 || !same(event.asset, plan.predictedAsset) || !same(event.creator, context.wallet)
    || !same(event.numeraire, q.token.address) || !same(event.pool, plan.predictedPool)
    || event.symbol !== context.draft.ticker || !same(plan.review.feeRecipient, recipient)) fail('launch_receipt_unverified');
  const [name, symbol, uri, supply, asset, state] = await rpc.calls(4663, [
    ...['name', 'symbol', 'tokenURI', 'totalSupply'].map(method => call(plan.predictedAsset, method)),
    call(p.airlock.address, 'getAssetData', [plan.predictedAsset]),
    call(p.poolInitializer.address, 'getState', [plan.predictedAsset]),
  ], block);
  if (name !== context.draft.name || symbol !== context.draft.ticker || uri !== plan.review.metadataUri
    || supply !== 10n ** 27n || !same(asset[0], q.token.address) || !same(asset[3], p.liquidityMigrator.address)
    || !same(asset[4], p.poolInitializer.address) || !same(asset[5], plan.predictedPool)
    || asset[7] !== supply || asset[8] !== supply || !same(asset[9], p.integrator)
    || !same(state[0], q.token.address) || state[1] !== supply || !same(state[2], p.dopplerHook.address)
    || state[3] !== '0x' || state[4] !== 2) fail('launch_receipt_unverified');
  const key = state[5];
  if (!same(key.currency0, plan.predictedAsset) || !same(key.currency1, q.token.address)
    || key.fee !== 8388608 || key.tickSpacing !== 8 || !same(key.hooks, p.poolInitializer.address)) fail('launch_receipt_unverified');
  const poolId = keccak256(encodeAbiParameters(parseAbiParameters('(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'), [key]));
  const [lpShares, protocolShares, hookShares, mode, integratorShare, distribution, schedule] = await rpc.calls(4663, [
    call(p.poolInitializer.address, 'getShares', [poolId, recipient]),
    call(p.poolInitializer.address, 'getShares', [poolId, p.protocolBeneficiary]),
    call(p.dopplerHook.address, 'getShares', [poolId, recipient]),
    call(p.dopplerHook.address, 'getFeeRoutingMode', [poolId]),
    call(p.dopplerHook.address, 'getIntegratorFeeShare', [poolId]),
    call(p.dopplerHook.address, 'getFeeDistributionInfo', [poolId]),
    call(p.dopplerHook.address, 'getFeeSchedule', [poolId]),
  ], block);
  const expected = [0n, 0n, 10n ** 18n, 0n, 0n, 0n, 10n ** 18n, 0n];
  if (lpShares !== 95n * 10n ** 16n || protocolShares !== 5n * 10n ** 16n || hookShares !== 10n ** 18n
    || mode !== 1 || integratorShare !== 300000 || distribution.some((v, i) => v !== expected[i])
    || schedule[1] !== 800000 || schedule[2] !== 10000 || schedule[4] !== 10) fail('launch_receipt_unverified');
}
