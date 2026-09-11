import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { toHex } from 'viem';
import { Budget } from './budget.mjs';
import { createAgentHandler, readAgentConfig } from './agent-api.mjs';
const wallet = toHex(101n, { size: 20 });
const token = 'EXAMPLE_LAUNCHPADS_TEST_CREDENTIAL';
const artworkId = 'a'.repeat(48), launchId = 'b'.repeat(64), hash = 'c'.repeat(64);
const routes = [
  { id: 'o1', chainId: 4663, config: 'o1Launch', scope: 'o1:deploy', pairId: 'native' },
  { id: 'o1-base', chainId: 8453, config: 'o1BaseLaunch', scope: 'o1:deploy', pairId: 'native' },
  { id: 'longbow', chainId: 4663, config: 'longbowLaunch', scope: 'longbow:deploy', pairId: 'longbow-EXAMPLE' },
  { id: 'pons', chainId: 4663, config: 'ponsLaunch', scope: 'pons:deploy', pairId: 'pons-native' },
];
const draftFor = r => ({ name: 'Coin', ticker: 'COIN', description: '', ...(r.id === 'longbow' ? { launchpad: 'longbow' } : {}) });
const artworkFor = r => ({ chainId: r.chainId, wallet, draft: draftFor(r), imageBase64: 'aGk=' });
const prepareFor = r => ({ chainId: r.chainId, wallet, draft: draftFor(r), pairId: r.pairId,
  publication: { id: artworkId, imageHash: hash, metadataHash: hash } });
async function fixture(t, scopes = ['o1:deploy', 'longbow:deploy', 'pons:deploy']) {
  const budget = new Budget(':memory:'), calls = [], tickerCalls = [];
  const client = { id: 'launchpads', wallet, tokenHash: createHash('sha256').update(token).digest('hex'), scopes };
  const agent = { enabled: true, publicAssetOrigin: 'https://assets.example', clients: [client] };
  const config = { origin: 'https://app.example', ...Object.fromEntries(routes.map(r => [r.config, {
    assetOrigin: `https://${r.id}-assets.example`, profile: { chainId: r.chainId,
      ...(r.id === 'pons' ? { launchpad: 'pons' } : { quotes: [{ id: r.pairId, token: null, decimals: 18 }] }) },
  }])) };
  const handler = createAgentHandler({ config, budget, agent,
    adapters: { ticker: async (...args) => { tickerCalls.push(args); return { chainId: args[0], ticker: args[1], results: { long: { status: args[1] === 'TAKEN' ? 'reserved' : 'unreserved' } } }; } },
    launches: { run: async (kind, input) => { calls.push({ kind, input }); return { id: launchId, status: 'prepared' }; } },
    fetcher: async (url, options) => { calls.push({ url, input: JSON.parse(options.body), options }); return Response.json({ id: artworkId,
      status: 'prepared', imageUrl: 'https://assets.example/ipfs/image', metadataUrl: 'https://assets.example/ipfs/metadata' }); },
  }, (_, response) => { response.statusCode = 404; response.end(); });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); budget.close(); });
  const request = (path, body) => fetch(`http://127.0.0.1:${server.address().port}/v1/agent/${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: ['Bearer', token].join(' '), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { request, calls, tickerCalls, client, budget };
}
test('new deploy scopes parse and discovery binds scope to each configured chain', async t => {
  for (const scope of ['o1:deploy', 'longbow:deploy', 'pons:deploy']) {
    const f = await fixture(t, [scope]);
    assert.equal(readAgentConfig({ AGENT_API_ENABLED: 'true', AGENT_API_CLIENTS_JSON: JSON.stringify([f.client]) }).clients[0].scopes[0], scope);
    const response = await f.request('launchpads');
    assert.equal(response.status, 200);
    const discovered = (await response.json()).launchpads;
    assert.deepEqual(discovered.map(r => [r.id, r.chainId, r.pairs.map(p => p.id)]), routes.filter(r => r.scope === scope).map(r => [r.id, r.chainId, [r.pairId]]));
    for (const r of routes.filter(r => r.scope !== scope)) assert.equal((await f.request(`${r.id}/ticker`, { ticker: 'COIN' })).status, 403);
  }
});
for (const r of routes) {
  test(`${r.id} ticker uses its own result namespace and policy`, async t => {
    const f = await fixture(t);
    const response = await f.request(`${r.id}/ticker`, { ticker: 'COIN' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.chainId, r.chainId);
    assert.deepEqual(result.results, { [r.id]: { status: 'unreserved' } });
    if (r.id !== 'longbow') {
      assert.equal(result.tickerPolicy, 'duplicates_allowed');
      assert.equal(f.tickerCalls.length, 0);
    } else assert.deepEqual(f.tickerCalls, [[4663, 'COIN', ['long']]]);
    const selection = await (await f.request(`${r.id}/ticker`, { tickers: ['TAKEN', 'FREE'] })).json();
    assert.equal(selection.selectedTicker, r.id === 'longbow' ? 'FREE' : 'TAKEN');
    assert.deepEqual(selection.checked, r.id === 'longbow' ? [{ ticker: 'TAKEN', status: 'reserved' }, { ticker: 'FREE', status: 'unreserved' }] : [{ ticker: 'TAKEN', status: 'unreserved' }]);
    assert.equal((await f.request(`${r.id}/ticker`, { tickers: ['COIN', 'COIN'] })).status, 400);
  });
  test(`${r.id} forwards artwork to its service with shared chain and preserves launch route`, async t => {
    const f = await fixture(t), artwork = artworkFor(r);
    artwork.draft.website = 'https://coin.example';
    assert.equal((await f.request(`${r.id}/artwork-prepare`, artwork)).status, 200);
    assert.equal(f.calls[0].url, `https://${r.id}-assets.example/v1/asset-launch-prepare`);
    assert.deepEqual(f.calls[0].input, { ...artwork, chainId: 4663 });
    assert.equal(f.calls[0].options.headers.authorization, undefined);
    assert.equal(f.calls[0].options.headers['x-fungun-intent'], 'asset-launch-prepare');
    const publish = { ...artwork, id: artworkId, uploadToken: 'EXAMPLE_UPLOAD_CAPABILITY' };
    assert.equal((await f.request(`${r.id}/artwork-publish`, publish)).status, 200);
    assert.deepEqual(f.calls[1].input, { ...publish, chainId: 4663 });
    const prepare = { ...prepareFor(r), draft: artwork.draft };
    assert.equal((await f.request(`${r.id}/prepare`, prepare)).status, 200);
    assert.deepEqual(f.calls[2], { kind: 'launch-prepare', input: prepare });
    assert.equal((await f.request(`${r.id}/reserve`, { id: launchId, binding: hash })).status, 200);
    assert.equal((await f.request(`${r.id}/status`, { id: launchId, hash: null })).status, 200);
    assert.deepEqual({ ...f.budget.db.prepare('SELECT launchpad,chain_id FROM agent_resource_routes WHERE kind=? AND id=?').get('launch', launchId) }, { launchpad: r.id, chain_id: r.chainId });
  });
  test(`${r.id} rejects chain, pair and artwork marker substitution before upstream`, async t => {
    const f = await fixture(t), wrongChain = r.chainId === 4663 ? 8453 : 4663;
    assert.equal((await f.request(`${r.id}/artwork-prepare`, { ...artworkFor(r), chainId: wrongChain })).status, 400);
    assert.notEqual((await f.request(`${r.id}/prepare`, { ...prepareFor(r), chainId: wrongChain })).status, 200);
    assert.notEqual((await f.request(`${r.id}/prepare`, { ...prepareFor(r), pairId: 'long-OTHER' })).status, 200);
    const wrongDraft = { ...draftFor(r) };
    if (r.id === 'longbow') delete wrongDraft.launchpad; else wrongDraft.launchpad = 'longbow';
    assert.notEqual((await f.request(`${r.id}/artwork-prepare`, { ...artworkFor(r), draft: wrongDraft })).status, 200);
    assert.equal(f.calls.length, 0);
  });
  test(`${r.id} capabilities cannot be reused through another route`, async t => {
    const f = await fixture(t);
    assert.equal((await f.request(`${r.id}/artwork-prepare`, artworkFor(r))).status, 200);
    assert.equal((await f.request(`${r.id}/prepare`, prepareFor(r))).status, 200);
    const before = f.calls.length;
    for (const other of routes.filter(candidate => candidate.id !== r.id)) {
      assert.equal((await f.request(`${other.id}/prepare`, prepareFor(other))).status, 404);
      assert.equal((await f.request(`${other.id}/reserve`, { id: launchId, binding: hash })).status, 404);
      assert.equal((await f.request(`${other.id}/status`, { id: launchId, hash: null })).status, 404);
      assert.equal((await f.request(`${other.id}/artwork-status`, { chainId: other.chainId, wallet, id: artworkId, imageHash: hash, metadataHash: hash })).status, 404);
    }
    assert.equal(f.calls.length, before);
  });
}
