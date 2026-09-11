import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters, keccak256, toHex, zeroAddress } from 'viem';
import { Budget } from './budget.mjs';
import { PonsLive, readPonsLiveConfig } from './pons-live.mjs';
import { PONS_ABI, PONS_ROLES, buildUnsignedPonsLaunch, readPonsLaunchProfile } from '../../web/lib/long-encoding/pons-launch.mjs';
import { validateLongInput } from './long-live.mjs';
import { launchpadForPair } from './launch-catalog.mjs';
import { ipfsContentId } from './ipfs-content.mjs';
import { ServiceError } from './errors.mjs';
import { sendLongWallet, validateLongPlan } from '../../web/lib/long-wallet.ts';

const addr = n => toHex(BigInt(n), { size: 20 });
const hash = n => toHex(BigInt(n), { size: 32 });
async function fixture(t, links = {}) {
  let now = 1800000000000;
  const root = mkdtempSync(join(tmpdir(), 'pons-live-'));
  const budget = new Budget(join(root, 'budget.sqlite'), () => now);
  t.after(() => { budget.close(); rmSync(root, { recursive: true, force: true }); });
  const profile = readPonsLaunchProfile({ chainId: 4663, launchpad: 'pons', launchConfigId: '0',
    ...Object.fromEntries(PONS_ROLES.map((role, i) => [role, { address: addr(i + 1), codeHash: keccak256('0x01') }])) });
  const config = { readsEnabled: true, origin: 'https://example.invalid',
    ponsLaunch: { profile, assetOrigin: 'https://assets.example.invalid' } };
  const draft = { name: 'Sample', ticker: 'SAMPLE', description: 'Synthetic artwork.', ...links };
  const imageCid = await ipfsContentId(Buffer.from('synthetic image'));
  const imageUri = `ipfs://${imageCid}`;
  const metadata = Buffer.from(JSON.stringify({ name: draft.name, symbol: draft.ticker, description: draft.description, image: imageUri, image_hash: imageUri, ...links }));
  const publication = { id: 'a'.repeat(48), imageHash: 'b'.repeat(64), metadataHash: createHash('sha256').update(metadata).digest('hex') };
  const published = { ...publication, status: 'published', ipfs: { profile: 'pinata-v1-256k', schema: 'long-ipfs-v1', imageCid, metadataCid: await ipfsContentId(metadata) } };
  const input = { chainId: 4663, wallet: addr(1001), pairId: 'pons-native', draft, publication };
  const changes = {}, seen = [];
  const launchConfig = { supply: 10n ** 27n, curveFeeBps: 100n, phantomQuote: 10n ** 18n, graduationThreshold: 4n * 10n ** 18n, poolFee: 0, tickSpacing: 200, enabled: true };
  const rpc = {
    block: async () => '0x64',
    verify: async (...args) => { seen.push(['verify', args]); if (changes.code) throw new ServiceError('contract_unverified'); },
    calls: async (_chain, entries) => entries.map(e => {
      seen.push(e.functionName);
      if (PONS_ROLES.slice(1).includes(e.functionName)) return changes.dependency ?? profile[e.functionName].address;
      switch (e.functionName) {
        case 'getLaunchConfig': return { ...launchConfig, enabled: !changes.disabled };
        case 'previewLaunchEconomics': return changes.economics ?? hash(42);
        case 'launchFee': return changes.fee ?? 5n * 10n ** 14n;
        case 'canLaunch': return !changes.restricted;
        case 'name': return draft.name;
        case 'symbol': return draft.ticker;
        case 'totalSupply': return launchConfig.supply;
        case 'getTokenInfo': return [input.wallet, changes.logo ?? imageUri, draft.description, { twitter: draft.twitter ?? '', telegram: '', discord: '', website: draft.website ?? '', farcaster: '', ...changes.socials }];
        case 'getLaunchedToken': return { token: addr(200), curve: addr(201), deployer: input.wallet, creatorFeeRecipient: changes.recipient ?? input.wallet,
          pairToken: zeroAddress, creatorTaxBps: 0, buybackEnabled: false, exists: true };
        default: throw new Error(`Unexpected call ${e.functionName}`);
      }
    }),
    batch: async (_chain, entries) => entries.map(e => {
      seen.push(e.method);
      switch (e.method) {
        case 'eth_getCode': return changes.accountCode ?? '0x';
        case 'eth_gasPrice': return toHex(10000000n);
        case 'eth_getBalance': return toHex(changes.balance ?? 10n ** 18n);
        case 'eth_getTransactionCount': return toHex(changes.nonce ?? 1n);
        case 'eth_call':
          if (changes.simulationError) throw new ServiceError(changes.simulationError);
          return encodeFunctionResult({ abi: PONS_ABI, functionName: 'launchToken', result: [changes.asset ?? addr(200), addr(201)] });
        case 'eth_estimateGas': return toHex(changes.gas ?? 3000000n);
        default: throw new Error(`Unexpected RPC ${e.method}`);
      }
    }),
  };
  const upstream = { json: async () => ({ data: { base: 'ETH', currency: 'USD', amount: '2500' } }) };
  const service = new PonsLive(config, upstream, budget, { rpc, now: () => now,
    fetcher: async () => { seen.push('publication'); return Response.json(published); } });
  const receipt = { logs: [{ address: profile.launcher.address,
    topics: encodeEventTopics({ abi: PONS_ABI, eventName: 'TokenLaunched', args: { token: addr(200), curve: addr(201), deployer: input.wallet } }),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [zeroAddress, 0n, launchConfig.graduationThreshold]) }] };
  return { service, profile, input, published, changes, seen, receipt, now: () => now, advance: () => { now += 31000; } };
}

test('pons requires a complete pinned profile and valid publication origin; stays off by default', async t => {
  const f = await fixture(t);
  assert.equal(readPonsLiveConfig({}), null);
  assert.deepEqual(readPonsLiveConfig({ PONS_WALLET_LAUNCH: 'true', PONS_LAUNCH_PROFILE_JSON: JSON.stringify(f.profile), LAUNCH_ASSET_SERVICE_ORIGIN: 'https://assets.example.invalid' }).profile, f.profile);
  for (const profile of [{ ...f.profile, chainId: 8453 }, { ...f.profile, launcher: { address: zeroAddress, codeHash: hash(1) } }, { ...f.profile, launchConfigId: '-1' }, { ...f.profile, extra: true }])
    assert.throws(() => readPonsLaunchProfile(profile));
  const credentialOrigin = new URL('https://assets.example.invalid');
  credentialOrigin.username = 'EXAMPLE';
  assert.throws(() => readPonsLiveConfig({ PONS_WALLET_LAUNCH: 'true', PONS_LAUNCH_PROFILE_JSON: JSON.stringify(f.profile), LAUNCH_ASSET_SERVICE_ORIGIN: credentialOrigin.href }));
});

test('pons pair routes separately from O1, rejects Base and editable metadata, and permits wallet eligibility estimates', async t => {
  const f = await fixture(t);
  assert.equal(launchpadForPair('pons-native'), 'pons');
  assert.equal(launchpadForPair('native'), 'o1');
  assert.equal(validateLongInput('launch-prepare', f.input).pairId, 'pons-native');
  assert.throws(() => validateLongInput('launch-prepare', { ...f.input, chainId: 8453 }));
  assert.throws(() => validateLongInput('launch-prepare', { ...f.input, editableMetadata: true }));
  assert.throws(() => validateLongInput('launch-estimate', { chainId: 4663, pairId: 'native', wallet: f.input.wallet }));
  const cost = await f.service.run('launch-estimate', { chainId: 4663, pairId: 'pons-native', wallet: f.input.wallet });
  assert.equal(cost.launchpadFeeWei, '500000000000000');
  assert.ok(f.seen.includes('canLaunch'));
});

test('pons prepares an unsigned exact-fee direct factory launch, pins economics, and validates browser reconstruction', async t => {
  const f = await fixture(t), plan = await f.service.run('launch-prepare', f.input);
  const checked = validateLongPlan({ ...plan, serverTime: f.now() }, f.input, f.published, performance.now());
  const decoded = decodeFunctionData({ abi: PONS_ABI, data: checked.transaction.data });
  assert.equal(decoded.functionName, 'launchToken');
  const [params, config, pair] = decoded.args;
  assert.equal(params.creatorFeeRecipient.toLowerCase(), f.input.wallet);
  assert.equal(params.creatorTaxBps, 0); assert.equal(params.buybackEnabled, false);
  assert.equal(params.expectedEconomics, hash(42)); assert.equal(params.logo, `ipfs://${f.published.ipfs.imageCid}`);
  assert.equal(params.salt, `0x${plan.id}`); assert.equal(config, 0n); assert.equal(pair, zeroAddress);
  assert.equal(BigInt(plan.transaction.value), 5n * 10n ** 14n);
  assert.equal(plan.maximumGasWei, String(3600000n * 10000000n));
  assert.equal(f.seen.some(e => typeof e === 'string' && e.includes('send')), false);
  assert.equal(f.service.row(plan.id).state, 'prepared');
  for (const change of [{ to: addr(999) }, { value: '0x0' }, { data: '0x' }, { from: addr(999) }, { authorizationList: [] }])
    assert.throws(() => validateLongPlan({ ...plan, serverTime: f.now(), transaction: { ...plan.transaction, ...change } }, f.input, f.published, performance.now()));
  for (const change of [{ imageUri: `ipfs://${f.published.ipfs.metadataCid}` }, { draft: { ...f.input.draft, name: 'Changed' } }]) {
    const altered = buildUnsignedPonsLaunch({ ...plan.ponsBuildInput, ...change }, f.profile);
    assert.throws(() => validateLongPlan({ ...plan, ...altered, serverTime: f.now(), transaction: { ...plan.transaction, ...altered.transaction } }, f.input, f.published, performance.now()));
  }
});

for (const [change, error] of [[{ restricted: true }, 'pons_launch_restricted'], [{ disabled: true }, 'pons_launch_disabled'],
  [{ code: true }, 'contract_unverified'], [{ dependency: addr(999) }, 'contract_unverified'],
  [{ accountCode: '0x01' }, 'launch_eoa_required'], [{ balance: 1n }, 'insufficient_funds'],
  [{ gas: 8000000n }, 'launch_gas_limit'], [{ fee: 10n ** 18n }, 'launch_gas_limit'],
  [{ asset: zeroAddress }, 'launch_simulation_failed'], [{ simulationError: 'reverted' }, 'reverted']]) {
  test(`pons fails closed for ${Object.keys(change)[0]}`, async t => {
    const f = await fixture(t); Object.assign(f.changes, change);
    await assert.rejects(f.service.run('launch-prepare', f.input), e => e.code === error);
    assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM long_launches').get().n, 0);
    if (change.restricted) assert.equal(f.seen.includes('publication'), false);
  });
}

test('pons does not accept metadata whose content differs from the published draft', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.run('launch-prepare', { ...f.input, draft: { ...f.input.draft, description: 'Changed' } }), e => e.code === 'launch_assets_unverified');
});

test('pons requotes the same intent and nonce, rechecks a closing gate, and retains every attempted envelope', async t => {
  const f = await fixture(t), first = await f.service.run('launch-prepare', f.input);
  f.changes.restricted = true;
  await assert.rejects(f.service.run('launch-prepare', f.input), e => e.code === 'pons_launch_restricted');
  f.changes.restricted = false;
  await f.service.run('launch-reserve', { id: first.id, binding: first.binding });
  f.service.recovery.find = async () => ({ status: 'retryable' });
  f.advance(); f.changes.economics = hash(43);
  const second = await f.service.run('launch-prepare', f.input);
  assert.equal(second.id, first.id); assert.notEqual(second.binding, first.binding);
  assert.equal(second.transaction.nonce, first.transaction.nonce);
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM long_launch_attempts').get().n, 2);
  f.service.recovery.find = async () => ({ status: 'locating' });
  assert.ok((await f.service.run('launch-prepare', f.input)).recovery);
  f.service.recovery.find = async () => ({ status: 'retryable' }); f.changes.nonce = 2n;
  await assert.rejects(f.service.run('launch-prepare', f.input), e => e.code === 'launch_pending');
});

test('pons confirms factory events and deployed metadata/fee recipient; rejects substituted records', async t => {
  const f = await fixture(t), plan = await f.service.run('launch-prepare', f.input);
  await f.service.confirm(plan, f.input, f.receipt, '0x64');
  await assert.rejects(f.service.confirm(plan, f.input, { logs: [] }, '0x64'), e => e.code === 'launch_receipt_unverified');
  await assert.rejects(f.service.confirm(plan, f.input, { logs: [...f.receipt.logs, ...f.receipt.logs] }, '0x64'), e => e.code === 'launch_receipt_unverified');
  f.changes.recipient = addr(999);
  await assert.rejects(f.service.confirm(plan, f.input, f.receipt, '0x64'), e => e.code === 'launch_receipt_unverified');
  delete f.changes.recipient; f.changes.logo = 'https://example.invalid/changed';
  await assert.rejects(f.service.confirm(plan, f.input, f.receipt, '0x64'), e => e.code === 'launch_receipt_unverified');
});

test('wallet-side pons simulation must agree before reserving or sending', async t => {
  const f = await fixture(t), raw = await f.service.run('launch-prepare', f.input);
  const plan = validateLongPlan({ ...raw, serverTime: f.now() }, f.input, f.published, performance.now());
  let sent = 0, reserved = 0, mismatch = false, revert = false;
  const provider = { request: async ({ method }) => {
    if (method === 'eth_accounts') return [f.input.wallet];
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_getCode') return '0x01';
    if (method === 'eth_getTransactionCount') return '0x1';
    if (method === 'eth_getBalance') return toHex(10n ** 18n);
    if (method === 'eth_call') {
      if (revert) throw new Error('execution reverted');
      return encodeFunctionResult({ abi: PONS_ABI, functionName: 'launchToken', result: [mismatch ? addr(999) : addr(200), addr(201)] });
    }
    if (method === 'eth_sendTransaction') { sent++; assert.equal(reserved, 1); return hash(500); }
    throw new Error(method);
  } };
  mismatch = true;
  await assert.rejects(sendLongWallet(provider, plan, () => true, async () => { reserved++; }));
  assert.equal(sent, 0); assert.equal(reserved, 0);
  mismatch = false; revert = true;
  await assert.rejects(sendLongWallet(provider, plan, () => true, async () => { reserved++; }));
  assert.equal(sent, 0); assert.equal(reserved, 0);
  revert = false;
  assert.equal(await sendLongWallet(provider, plan, () => true, async () => { reserved++; }), hash(500));
  assert.equal(sent, 1);
});

 test('pons publishes approved website/twitter and confirms exact onchain socials', async t => {
  const f = await fixture(t, { website: 'https://sample.example/', twitter: 'https://x.com/sample' });
  const plan = await f.service.run('launch-prepare', f.input);
  const { args } = decodeFunctionData({ abi: PONS_ABI, data: plan.transaction.data });
  assert.equal(args[0].socials.website, f.input.draft.website);
  assert.equal(args[0].socials.twitter, f.input.draft.twitter);
  await f.service.confirm(plan, f.input, f.receipt, '0x64');
  for (const socials of [{ website: '' }, { twitter: 'https://x.com/changed' }, { telegram: 'unexpected' }]) {
    f.changes.socials = socials;
    await assert.rejects(f.service.confirm(plan, f.input, f.receipt, '0x64'), e => e.code === 'launch_receipt_unverified');
  }
});
test('pons rejects unapproved social metadata before preparing', async t => {
  const f = await fixture(t);
  f.input.draft.website = 'https://sample.example/';
  await assert.rejects(f.service.run('launch-prepare', f.input), e => e.code === 'launch_assets_unverified');
});
