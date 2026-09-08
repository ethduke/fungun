import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toHex } from 'viem';
import { o1Metadata } from './long-encoding/o1-metadata.mjs';
import { buildUnsignedO1Launch } from './long-encoding/o1-launch.mjs';
import { validateLongPlan, type LaunchInput } from './long-wallet.ts';
import type { PublishedAsset } from './asset-protocol.ts';

void test('wallet derives O1 metadata from approved artwork and rejects a fully rebuilt substituted document', () => {
  const contract = (n: number) => ({ address: toHex(n, { size: 20 }), codeHash: keccak256('0x01') });
  const profile = { chainId: 4663, launchpad: 'o1', launcher: contract(1), tokenDeployer: contract(2),
    hook: contract(3), feeEscrow: contract(4), announcementRegistry: contract(5),
    quotes: [{ id: 'native', token: null, decimals: 18 }] };
  const input: LaunchInput = { chainId: 4663, wallet: contract(100).address, pairId: 'native', editableMetadata: true,
    draft: { name: 'Sample', ticker: 'SAMPLE', description: '' },
    publication: { id: 'a'.repeat(48), imageHash: 'b'.repeat(64), metadataHash: 'c'.repeat(64) } };
  const cid = 'bafkreierecltpddskr3iszd23i47lb5rp36sxtporgatj3mmayqcyfynb4';
  const published: PublishedAsset = { ...input.publication, status: 'published', launchReady: false, imageUrl: '', metadataUrl: '',
    ipfs: { profile: 'pinata-v1-256k', schema: 'long-ipfs-v1', imageCid: cid, metadataCid: cid } };
  const now = Date.now(), id = 'd'.repeat(64);
  const buildInput = { wallet: input.wallet, draft: input.draft, pairId: 'native', editableMetadata: true,
    metadataUri: o1Metadata(input.draft, cid).uri, intentId: id, configVersion: '1', chainDeadline: Math.floor(now / 1000) + 1799,
    totalSupply: '1000000000000000000000000000', launchpadFeeWei: '1000000000000000', initCodeHash: keccak256('0x01') };
  const response = (metadataUri: string) => {
    const changedInput = { ...buildInput, metadataUri }, plan = buildUnsignedO1Launch(changedInput, profile);
    assert.ok(plan);
    return { ...plan, id, buildInput: changedInput, chainId: 4663, quotedAt: now, expiresAt: now + 30000, serverTime: now,
      transaction: { ...plan.transaction, chainId: '0x1237', nonce: '0x1', gas: toHex(6000000), gasPrice: toHex(1000000) },
      estimatedGas: '5000000', maximumGasWei: String(6000000n * 1000000n), launchpadFeeWei: buildInput.launchpadFeeWei,
      launchFeeSource: { amountWei: buildInput.launchpadFeeWei, kind: 'verified-contract', contract: profile.launcher.address, blockNumber: '100' },
      usd: { sourceLabel: 'Coinbase ETH/USD spot', quotedAt: now, microUsdPerEth: '2500000000' } };
  };
  const valid = response(buildInput.metadataUri);
  assert.equal(validateLongPlan(valid, input, published, performance.now()).review.metadataUri, buildInput.metadataUri);
  for (const uri of [`ipfs://${cid}`, o1Metadata({ ...input.draft, name: 'Changed' }, cid).uri]) {
    assert.throws(() => validateLongPlan(response(uri), input, published, performance.now()));
  }
  assert.throws(() => validateLongPlan(valid, { ...input, editableMetadata: false }, published, performance.now()));
});
