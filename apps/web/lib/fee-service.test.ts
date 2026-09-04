import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionData } from 'viem';
import {
  claimAbi,
  legacyClaimAbi,
  loadFees,
  loadFeeSources,
  mergeFeePages,
  parseFees,
  prepareClaim,
  validateClaim,
  type ClaimQuote,
  type FeeLookupResult,
} from './fee-service.ts';
import { disabledClaimMessage, unavailableFeeMessage } from './fee-status.ts';

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
    { ...source, status: 'ready', coverage: 'configured_pools' },
    {
      ...source,
      status: 'ready',
      positions: [{ ...position, verification: 'indexed', claimable: false }],
    },
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

await test('fee availability reasons are safe codes and never report a disconnected wallet', () => {
  for (const reason of [
    'fees_disabled',
    'provider_not_configured',
    'contracts_not_configured',
    'not_configured',
  ]) {
    const parsed = parseFees(
      { ...source, status: 'unavailable', positions: [], reason },
      owner,
      8453,
      'o1',
    );
    assert.equal(parsed.reason, reason);
    assert.match(unavailableFeeMessage(parsed), /balance unknown/);
    assert.doesNotMatch(unavailableFeeMessage(parsed), /not connected/i);
  }
  for (const changes of [
    { reason: 'synthetic confidential provider detail' },
    { reason: { message: 'not_configured' } },
    { reason: 'not_configured', status: 'ready' },
  ])
    assert.throws(() =>
      parseFees(
        { ...source, status: 'unavailable', positions: [], ...changes },
        owner,
        8453,
        'o1',
      ),
    );
});

await test('disabled claims explain unverified balances and feature setup without enabling claims', () => {
  for (const claimDisabledReason of [
    'claims_disabled',
    'contract_unverified',
    'gas_oracle_not_configured',
    'nothing_to_claim',
  ]) {
    const parsed = parseFees(
      {
        ...source,
        positions: [{ ...position, claimable: false, claimDisabledReason }],
      },
      owner,
      8453,
      'o1',
    );
    assert.equal(parsed.positions[0].claimable, false);
    assert.equal(parsed.positions[0].claimDisabledReason, claimDisabledReason);
    assert.ok(disabledClaimMessage(parsed.positions[0]));
  }
  for (const invalidPosition of [
    { ...position, claimDisabledReason: 'claims_disabled' },
    { ...position, claimable: false, claimDisabledReason: 'upstream detail' },
  ])
    assert.throws(() =>
      parseFees({ ...source, positions: [invalidPosition] }, owner, 8453, 'o1'),
    );
  assert.equal(disabledClaimMessage(position), null);
  assert.match(
    disabledClaimMessage({
      ...position,
      claimable: false,
      verification: 'indexed',
    })!,
    /Contract verification/,
  );
  assert.equal(
    disabledClaimMessage({
      ...position,
      claimable: false,
      claimDisabledReason: 'claims_disabled',
    }),
    'Claims are not enabled yet.',
  );
});

await test('escrow versions stay bound across fee pages and fresh claim preparation', async () => {
  const legacyPosition = { ...position, escrowVersion: 'legacy' as const };
  const legacySource = { ...source, positions: [legacyPosition] };
  assert.equal(
    parseFees(legacySource, owner, 8453, 'o1').positions[0].escrowVersion,
    'legacy',
  );
  assert.throws(() =>
    parseFees(
      { ...source, positions: [{ ...position, escrowVersion: 'unknown' }] },
      owner,
      8453,
      'o1',
    ),
  );
  assert.throws(() =>
    parseFees(
      { ...legacySource, chainId: 4663, padId: 'long' },
      owner,
      4663,
      'long',
    ),
  );
  assert.throws(() => mergeFeePages(legacySource, source));
  assert.throws(() => mergeFeePages(source, legacySource));

  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      ...quote(),
      escrowVersion: 'legacy',
      data: encodeFunctionData({
        abi: legacyClaimAbi,
        functionName: 'claim',
        args: [owner, payout.asset],
      }),
      serverTime: Date.now(),
      expiresAt: Date.now() + 20_000,
    });
  try {
    assert.equal(
      (await prepareClaim(owner, legacySource, legacyPosition)).escrowVersion,
      'legacy',
    );
    await assert.rejects(prepareClaim(owner, source, position), {
      code: 'invalid_response',
    });
  } finally {
    globalThis.fetch = original;
  }
});

await test('claim validation rejects recipient redirects, trailing data, native value, unsupported chains and excessive gas', () => {
  assert.equal(validateClaim(quote()).kind, 'o1');
  assert.equal(validateClaim({ ...quote(), chainId: 4663 }).chainId, 4663);
  for (const change of [
    { value: '1' },
    { chainId: 1 },
    { address: addr('0') },
    { target: addr('0') },
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

await test('Longbow accepts only its Robinhood locked-pool claim and preserves the source in preparation', async () => {
  const poolId = `0x${'b'.repeat(64)}` as `0x${string}`;
  const poolPosition = {
    ...position,
    payouts: [payout, { ...payout, asset: addr('3'), symbol: 'PAIR' }],
  };
  const poolSource = {
    ...source,
    padId: 'longbow' as const,
    chainId: 4663 as const,
    positions: [poolPosition],
  };
  assert.equal(parseFees(poolSource, owner, 4663, 'longbow').padId, 'longbow');
  assert.throws(() =>
    parseFees({ ...poolSource, chainId: 8453 }, owner, 8453, 'longbow'),
  );
  assert.throws(() =>
    parseFees({ ...poolSource, positions: [position] }, owner, 4663, 'longbow'),
  );
  assert.throws(() =>
    parseFees(
      {
        ...poolSource,
        positions: [
          { ...poolPosition, verification: 'indexed', claimable: false },
        ],
      },
      owner,
      4663,
      'longbow',
    ),
  );
  const poolQuote: ClaimQuote = {
    ...quote(),
    kind: 'longbow',
    chainId: 4663,
    poolId,
    payouts: poolPosition.payouts,
    data: encodeFunctionData({
      abi: claimAbi,
      functionName: 'collectFees',
      args: [poolId],
    }),
  };
  assert.equal(validateClaim(poolQuote).kind, 'longbow');
  for (const change of [
    { chainId: 8453 },
    { escrowVersion: 'legacy' },
    { data: quote().data },
    { poolId: `0x${'c'.repeat(64)}` },
  ])
    assert.throws(() => validateClaim({ ...poolQuote, ...change }));
  const original = globalThis.fetch;
  let kind = 'long';
  globalThis.fetch = async () =>
    Response.json({
      ...poolQuote,
      kind,
      serverTime: Date.now(),
      expiresAt: Date.now() + 20_000,
    });
  try {
    await assert.rejects(prepareClaim(owner, poolSource, poolPosition), {
      code: 'invalid_response',
    });
    kind = 'longbow';
    assert.equal(
      (await prepareClaim(owner, poolSource, poolPosition)).kind,
      'longbow',
    );
  } finally {
    globalThis.fetch = original;
  }
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

await test('launchpads load two at a time and a slow or failed source does not block other results', async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  const releases = new Map<string, (response: Response) => void>();
  const results: FeeLookupResult[] = [];
  const lookups = [
    { padId: 'long', chainId: 4663 },
    { padId: 'o1', chainId: 4663 },
    { padId: 'longbow', chainId: 4663 },
  ] as const;
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  globalThis.fetch = async (_url, options) => {
    if (typeof options?.body !== 'string')
      throw new Error('Expected a JSON request body.');
    const input = JSON.parse(options.body);
    requests.push(input.padId);
    return new Promise<Response>((resolve) =>
      releases.set(input.padId, resolve),
    );
  };
  const success = (padId: string) =>
    Response.json({
      ...source,
      chainId: 4663,
      padId,
      positions: [],
      serverTime: Date.now(),
      expiresAt: Date.now() + 45_000,
    });
  try {
    const job = loadFeeSources(
      owner,
      lookups,
      (result) => results.push(result),
      () => true,
    );
    assert.deepEqual(requests, ['long', 'o1']);
    releases.get('o1')!(success('o1'));
    await settle();
    assert.deepEqual(requests, ['long', 'o1', 'longbow']);
    assert.deepEqual(
      results.map((result) => result.padId),
      ['o1'],
    );
    releases.get('long')!(
      Response.json({ error: 'unavailable' }, { status: 503 }),
    );
    releases.get('longbow')!(success('longbow'));
    await job;
    assert.equal(
      results.find((result) => result.padId === 'long')?.source,
      undefined,
    );
    assert.equal(
      results.find((result) => result.padId === 'longbow')?.source?.padId,
      'longbow',
    );
    assert.equal(requests.length, 3, 'no whole-scan retries or polling');
  } finally {
    globalThis.fetch = original;
  }
});

await test('changing wallet or leaving Fees suppresses late results and queued launchpad reads', async () => {
  const original = globalThis.fetch;
  const releases: ((response: Response) => void)[] = [];
  let current = true;
  let results = 0;
  globalThis.fetch = async () =>
    new Promise<Response>((resolve) => releases.push(resolve));
  try {
    const job = loadFeeSources(
      owner,
      [
        { padId: 'long', chainId: 4663 },
        { padId: 'o1', chainId: 4663 },
        { padId: 'longbow', chainId: 4663 },
      ],
      () => results++,
      () => current,
    );
    assert.equal(releases.length, 2);
    current = false;
    for (const release of releases)
      release(Response.json({ error: 'unavailable' }, { status: 503 }));
    await job;
    assert.equal(results, 0);
    assert.equal(releases.length, 2);
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

await test('fee pagination validates opaque cursors and forwards only the selected page', async () => {
  const cursor = 'b'.repeat(64);
  assert.equal(
    parseFees(
      { ...source, nextCursor: cursor, coverage: 'wallet_index' },
      owner,
      8453,
      'o1',
    ).nextCursor,
    cursor,
  );
  for (const changes of [
    { nextCursor: 'https://invalid.example' },
    { nextCursor: cursor, status: 'ready' },
    { coverage: 'all_tokens_guaranteed' },
    { progress: { scannedThroughBlock: '11', toBlock: '10' } },
    { progress: { scannedThroughBlock: '-1', toBlock: '10' } },
    { progress: { scannedThroughBlock: null, toBlock: 'not-a-block' } },
  ])
    assert.throws(() =>
      parseFees({ ...source, ...changes }, owner, 8453, 'o1'),
    );
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const body = options?.body;
    assert.equal(typeof body, 'string');
    if (typeof body !== 'string')
      throw new Error('Expected a JSON request body.');
    assert.deepEqual(JSON.parse(body), {
      address: owner,
      chainId: 8453,
      padId: 'o1',
      cursor,
    });
    return Response.json({
      ...source,
      nextCursor: null,
      serverTime: Date.now(),
      expiresAt: Date.now() + 45_000,
    });
  };
  try {
    await assert.rejects(loadFees(owner, 8453, 'o1', 'invalid'), {
      code: 'invalid_request',
    });
    await loadFees(owner, 8453, 'o1', cursor);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

await test('overlapping pages replace balances without double counting and retain incomplete verification', () => {
  const first = {
    ...source,
    coverage: 'wallet_index' as const,
    nextCursor: 'b'.repeat(64),
  };
  const next = {
    ...first,
    status: 'ready' as const,
    nextCursor: null,
    positions: [
      { ...position, payouts: [{ ...payout, claimableRaw: '200' }] },
      { ...position, id: 'c'.repeat(64), target: addr('3') },
    ],
  };
  const merged = mergeFeePages(first, next);
  assert.equal(merged.positions.length, 2);
  assert.equal(merged.positions[0].payouts[0].claimableRaw, '200');
  assert.equal(merged.status, 'ready');
  assert.equal(merged.nextCursor, null);
  const indexed = {
    ...first,
    positions: [
      { ...position, verification: 'indexed' as const, claimable: false },
    ],
  };
  assert.equal(
    mergeFeePages(indexed, { ...next, positions: [next.positions[1]] }).status,
    'partial',
  );
  for (const changes of [
    { address: addr('b') },
    { chainId: 4663 as const },
    { coverage: 'configured_pools' as const },
    { positions: [{ ...position, target: addr('4') }] },
    { positions: [{ ...position, payouts: [{ ...payout, decimals: 18 }] }] },
  ])
    assert.throws(() => mergeFeePages(first, { ...next, ...changes }));
});
