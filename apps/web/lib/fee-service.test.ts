import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionData } from 'viem';
import {
  claimAbi,
  loadFees,
  parseFees,
  prepareClaim,
  validateClaim,
  type ClaimQuote,
} from './fee-service.ts';

const addr = (digit: string) => `0x${digit.repeat(40)}` as `0x${string}`;
const owner = addr('a');
const payout = {
  asset: addr('1'),
  symbol: 'TEST',
  decimals: 6,
  claimableRaw: '123',
};
const position = {
  id: 'a'.repeat(64),
  target: addr('2'),
  payouts: [payout],
  verification: 'live' as const,
  claimable: true,
};
const source = {
  address: owner,
  chainId: 8453 as const,
  padId: 'o1' as const,
  status: 'partial' as const,
  positions: [position],
  expiresAt: 1000,
};
const quote = (): ClaimQuote => ({
  positionId: position.id,
  kind: 'o1',
  chainId: 8453,
  address: owner,
  target: position.target,
  data: encodeFunctionData({
    abi: claimAbi,
    functionName: 'claimFor',
    args: [owner, payout.asset],
  }),
  payouts: [payout],
  value: '0',
  gas: '120000',
  gasPrice: '1000',
  estimatedWei: '100000000',
  budgetWei: '120000000',
  l1FeeWei: '0',
  operatorFeeWei: '0',
  expiresAt: performance.now() + 20_000,
});

await test('fee responses bind owner and chain, reject duplicate positions and impossible amounts', () => {
  assert.equal(parseFees(source, owner, 8453, 'o1').positions.length, 1);
  for (const value of [
    { ...source, address: addr('b') },
    { ...source, positions: [position, position] },
    { ...source, positions: [{ ...position, verification: 'indexed' }] },
    {
      ...source,
      positions: [
        { ...position, payouts: [{ ...payout, claimableRaw: '-1' }] },
      ],
    },
  ])
    assert.throws(() => parseFees(value, owner, 8453, 'o1'));
});

await test('claim validation rejects recipient redirects, trailing data, native value, unsupported chains and excessive gas', () => {
  assert.equal(validateClaim(quote()).kind, 'o1');
  for (const change of [
    { value: '1' },
    { chainId: 4663 },
    {
      data: encodeFunctionData({
        abi: claimAbi,
        functionName: 'claimFor',
        args: [addr('b'), payout.asset],
      }),
    },
    { data: `${quote().data}00` },
    { gas: '3000001' },
    { budgetWei: '1' },
    { payouts: [{ ...payout, claimableRaw: '0' }] },
  ])
    assert.throws(() => validateClaim({ ...quote(), ...change }));
});

await test('fee loading coalesces without polling and preparation rejects a changed target', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.method, 'POST');
    const result =
      url === '/api/fees' ? source : { ...quote(), target: addr('9') };
    return Response.json({
      ...result,
      serverTime: Date.now(),
      expiresAt: Date.now() + 20_000,
    });
  };
  try {
    await Promise.all([
      loadFees(owner, 8453, 'o1'),
      loadFees(owner, 8453, 'o1'),
    ]);
    assert.equal(calls, 1);
    await assert.rejects(prepareClaim(owner, source, position), {
      code: 'invalid_response',
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

await test('provider details are not exposed through the fee client', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { error: 'synthetic confidential upstream detail' },
      { status: 503 },
    );
  try {
    await assert.rejects(loadFees(owner, 8453, 'o1'), {
      code: 'unavailable',
      message: 'unavailable',
    });
  } finally {
    globalThis.fetch = original;
  }
});
