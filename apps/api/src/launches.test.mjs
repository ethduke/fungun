import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Launches } from './launches.mjs';

test('saved Long, Longbow and O1 results route to read-only status while their live profiles are disabled', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const budget = { db, key: 'a'.repeat(64) };
  const config = { readsEnabled: true, longLaunch: null, longbowLaunch: null, o1Launch: null,
    o1Key: '', rpcUrl: '', baseRpcUrl: '', rpcBatchRequests: true };
  const launches = new Launches(config, {}, budget);
  const rows = [
    ['a'.repeat(64), 'long-NVDA'],
    ['b'.repeat(64), 'longbow-NVDA'],
    ['c'.repeat(64), 'native'],
  ];
  for (const [id, pairId] of rows) {
    const result = { id, status: 'confirmed', hash: `0x${id}`, paidGasWei: '1', asset: `0x${id.slice(0, 40)}` };
    db.prepare("INSERT INTO long_launches(id,context,state,plan,expires,tx_hash,result) VALUES (?,?, 'confirmed','{}',0,?,?)")
      .run(id, JSON.stringify({ pairId }), result.hash, JSON.stringify(result));
    assert.deepEqual(await launches.run('launch-status', { id, hash: null }), result);
    await assert.rejects(launches.run('launch-reserve', { id, binding: 'd'.repeat(64) }), {
      code: 'long_launch_disabled',
    });
    await assert.rejects(launches.run('launch-estimate', { chainId: 4663, pairId }), {
      code: 'long_launch_disabled',
    });
  }
});
