import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const fixtureHash = label => '0x' + createHash('sha256').update('synthetic-fixture:' + label).digest('hex');
const fixtureAddress = label => fixtureHash(label).slice(0, 42);

export function loadFixture() {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/recovery.json', import.meta.url), 'utf8'));
  if (fixture.encoding !== 'symbolic-synthetic-identifiers') throw new Error('INVALID_FIXTURE_ENCODING');
  fixture.chain.tokens = fixture.chain.tokens.map(token => ({ ...token, address: fixtureAddress(token.address) }));
  for (const branch of ['original', 'replacement']) fixture[branch] = fixture[branch].map(block => ({ ...block,
    hash: fixtureHash(block.hash), parentHash: fixtureHash(block.parentHash),
    transactions: block.transactions.map(tx => ({ ...tx, hash: fixtureHash(tx.hash) })),
    events: block.events.map(event => ({ ...event, txHash: fixtureHash(event.txHash), token: fixtureAddress(event.token),
      sender: fixtureAddress(event.sender), recipient: fixtureAddress(event.recipient) })) }));
  return fixture;
}

export class FixtureSource {
  constructor(fixture, { branch = 'original', duplicate = false, missing = [] } = {}) {
    if (!['original', 'replacement'].includes(branch)) throw new Error('INVALID_FIXTURE_BRANCH');
    this.fixture = fixture; this.branch = branch; this.duplicate = duplicate;
    this.missing = new Set(missing); this.reads = [];
  }
  async getHead() { return Math.max(...this.fixture[this.branch].map(block => block.height)); }
  async getBlock(height) {
    this.reads.push(height);
    if (this.missing.has(height)) throw new Error('Synthetic source block unavailable');
    const block = this.fixture[this.branch].find(row => row.height === height);
    if (!block) return null;
    const copy = structuredClone(block);
    if (this.duplicate) copy.events.push(...structuredClone(copy.events));
    return copy;
  }
}
