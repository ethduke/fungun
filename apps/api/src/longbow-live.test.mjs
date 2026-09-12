import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, toHex } from 'viem';
import { confirmLongbow, LONGBOW_STATE_ABI } from './longbow-live.mjs';
const addr = n => toHex(BigInt(n), { size: 20 });
function fixture() {
  const p = { launcher: { address: addr(1) }, airlock: { address: addr(2) }, poolInitializer: { address: addr(3) },
    dopplerHook: { address: addr(4) }, liquidityMigrator: { address: addr(5) }, integrator: addr(6), protocolBeneficiary: addr(7),
    quotes: [{ id: 'longbow-EXAMPLE', token: { address: addr(100) } }] };
  const asset = addr(10), wallet = addr(20), recipient = addr(30), supply = 10n ** 27n;
  const context = { wallet, feeRecipient: recipient, pairId: 'longbow-EXAMPLE', draft: { name: 'Example', ticker: 'EXAMPLE' } };
  const plan = { profile: p, predictedAsset: asset, predictedPool: asset, review: { metadataUri: 'ipfs://example', feeRecipient: recipient } };
  const receipt = { logs: [{ address: p.launcher.address, topics: encodeEventTopics({ abi: LONGBOW_STATE_ABI, eventName: 'LongbowLaunch',
    args: { asset, creator: wallet, numeraire: addr(100) } }), data: encodeAbiParameters(parseAbiParameters('address,string'), [asset, 'EXAMPLE']) }] };
  const values = { name: 'Example', symbol: 'EXAMPLE', tokenURI: 'ipfs://example', totalSupply: supply,
    getAssetData: [addr(100), addr(0), addr(0), addr(5), addr(3), asset, addr(0), supply, supply, addr(6)],
    getState: [addr(100), supply, addr(4), '0x', 2, { currency0: asset, currency1: addr(100), fee: 8388608, tickSpacing: 8, hooks: addr(3) }, 887256],
    getFeeRoutingMode: 1, getIntegratorFeeShare: 300000, getFeeDistributionInfo: [0n,0n,10n**18n,0n,0n,0n,10n**18n,0n],
    getFeeSchedule: [123,800000,10000,10000,10] };
  const changes = {};
  const rpc = { verify: async () => {}, calls: async (_chain, calls) => calls.map(c => {
    if (c.functionName === 'getShares') {
      if (c.address === p.dopplerHook.address) return changes.hookShares ?? 10n**18n;
      return c.args[1] === recipient ? (changes.lpShares ?? 95n*10n**16n) : 5n*10n**16n;
    }
    return values[c.functionName];
  }) };
  return { rpc, plan, context, receipt, values, changes };
}
test('independent confirmation requires matching creator, beneficiary, full supply and both fee streams', async () => {
  const f = fixture();
  await confirmLongbow(f.rpc, f.plan, f.context, f.receipt, '0x64');
  for (const change of [{ hookShares: 0n }, { lpShares: 0n }]) {
    Object.assign(f.changes, change);
    await assert.rejects(confirmLongbow(f.rpc, f.plan, f.context, f.receipt, '0x64'), /launch_receipt_unverified/);
    delete f.changes.hookShares; delete f.changes.lpShares;
  }
  for (const context of [{ ...f.context, wallet: addr(99) }, { ...f.context, feeRecipient: addr(99) }])
    await assert.rejects(confirmLongbow(f.rpc, f.plan, context, f.receipt, '0x64'), /launch_receipt_unverified/);
  f.values.getAssetData[7] -= 1n;
  await assert.rejects(confirmLongbow(f.rpc, f.plan, f.context, f.receipt, '0x64'), /launch_receipt_unverified/);
});
