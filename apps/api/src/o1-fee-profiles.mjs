import { readFeeContracts } from './fee-contracts.mjs';

// Public, immutable deployments. Review evidence: docs/o1-fee-verification.md.
// Discovery still checks the chain, runtime hash and owed balance at one block;
// claim preparation repeats verification and simulates the owner-bound call.
export const reviewedO1FeeProfiles = Object.freeze([
  { chainId: 4663, escrow: '0xf5681c4c0dc0c2e32c9d127b3cc0fc992b584553',
    codeHash: '0x016bd8362dedaead52326c486679a6812ee98088b98d6195b34d87dfe54128cb', version: 'legacy' },
  { chainId: 4663, escrow: '0x00d5701a92794c3744428b62646e7bc4e77a0a9a',
    codeHash: '0x3402d890c78ca6947a223b7adc8362fd44cc22b322a3a453c344bc27088b143a', version: 'legacy' },
  { chainId: 4663, escrow: '0x32f7a9a05bd62487d085ad494e14ec42543e19d2',
    codeHash: '0x8315a3554c1d17721a46d32491c7f9c4f09ce5b034e38475482cb50e4585ba9c', version: 'legacy' },
  { chainId: 4663, escrow: '0x4f2b1cda8748cd64c56039bf5e2e54bc13d4a3d7',
    codeHash: '0x96df59104ba0c6143bb59f17c4acde6d9ac93e0716df92b62bf4aacb3c3274ae', version: 'legacy' },
  { chainId: 4663, escrow: '0xc5444b417a04a7e1b9c1e327c7d499803c14e5ef',
    codeHash: '0xa470389a90e55bffb8891ab2d30113f55b6a566ca98c6a3e3e6497f5af06a999', version: 'current' },
].map(Object.freeze));

export function readRuntimeFeeContracts(raw) {
  const configured = readFeeContracts(raw);
  const key = (profile) => `${profile.chainId}:${profile.escrow.toLowerCase()}`;
  // Explicit operator pins win; never silently replace a configured identity.
  const profiles = new Map(reviewedO1FeeProfiles.map((profile) => [key(profile), profile]));
  for (const profile of configured.o1) profiles.set(key(profile), profile);
  return readFeeContracts(JSON.stringify({ ...configured, o1: [...profiles.values()] }));
}
