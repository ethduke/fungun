import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  encodeFunctionData,
  encodeEventTopics,
  encodeAbiParameters,
  toHex,
  type EIP1193Provider,
  type Hash,
} from 'viem';
import { base, robinhood } from 'viem/chains';
import {
  claimAbi,
  legacyClaimAbi,
  validateClaim,
  type ClaimQuote,
} from './fee-service.ts';
import {
  acknowledgeClaim,
  checkWalletClaim,
  getClaims,
  ensureClaimChain,
  receiptPayouts,
  sendWalletClaim,
  watchWalletClaim,
} from './claim-wallet.ts';

const addr = (digit: string) => `0x${digit.repeat(40)}` as `0x${string}`;
const owner = addr('a');
const target = addr('2');
const currency = addr('1');
const hash = `0x${'c'.repeat(64)}` as Hash;
const quote = (id = 'a'): ClaimQuote => ({
  positionId: id.repeat(64),
  kind: 'o1',
  chainId: 8453,
  address: owner,
  target,
  data: encodeFunctionData({
    abi: claimAbi,
    functionName: 'claimFor',
    args: [owner, currency],
  }),
  payouts: [
    { asset: currency, symbol: 'TEST', decimals: 6, claimableRaw: '100' },
  ],
  value: '0',
  gas: '120000',
  gasPrice: '1000',
  estimatedWei: '100000000',
  budgetWei: '120000000',
  l1FeeWei: '0',
  operatorFeeWei: '0',
  expiresAt: performance.now() + 20_000,
});
const receipt = (destination = owner) => ({
  transactionHash: hash,
  status: '0x1',
  from: owner,
  to: target,
  logs: [
    {
      address: target,
      topics: encodeEventTopics({
        abi: claimAbi,
        eventName: 'Claimed',
        args: { recipient: owner, currency, destination },
      }) as Hash[],
      data: encodeAbiParameters([{ type: 'uint256' }], [125n]),
    },
  ],
});

await test('receipt proof requires exact beneficiary, destination, currency, emitter and positive actual payout', () => {
  assert.equal(receiptPayouts(receipt(), quote())?.[0].claimableRaw, '125');
  assert.equal(receiptPayouts(receipt(addr('b')), quote()), null);
  assert.equal(receiptPayouts({ ...receipt(), logs: [] }, quote()), null);
  assert.equal(receiptPayouts({ ...receipt(), status: '0x0' }, quote()), null);
  assert.equal(
    receiptPayouts({ ...receipt(), from: addr('b') }, quote()),
    null,
  );
  assert.equal(
    receiptPayouts(
      { ...receipt(), logs: [{ ...receipt().logs[0], address: addr('9') }] },
      quote(),
    ),
    null,
  );
});

await test('Long and Longbow require a matching beneficiary Release to confirm payouts', () => {
  const poolId = `0x${'d'.repeat(64)}` as Hash;
  const input: ClaimQuote = {
    ...quote(),
    kind: 'long',
    chainId: 4663,
    poolId,
    data: encodeFunctionData({
      abi: claimAbi,
      functionName: 'collectFees',
      args: [poolId],
    }),
    payouts: [
      ...quote().payouts,
      { asset: addr('3'), symbol: 'PAIR', decimals: 18, claimableRaw: '200' },
    ],
  };
  const log = {
    address: target,
    topics: encodeEventTopics({
      abi: claimAbi,
      eventName: 'Release',
      args: { poolId, beneficiary: owner },
    }) as Hash[],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [55n, 60n],
    ),
  };
  assert.deepEqual(
    receiptPayouts({ ...receipt(), logs: [log] }, input)?.map(
      (payout) => payout.claimableRaw,
    ),
    ['55', '60'],
  );
  assert.equal(receiptPayouts({ ...receipt(), logs: [] }, input), null);
  const longbow: ClaimQuote = { ...input, kind: 'longbow' };
  assert.equal(validateClaim(longbow).kind, 'longbow');
  assert.deepEqual(
    receiptPayouts({ ...receipt(), logs: [log] }, longbow)?.map(
      (p) => p.claimableRaw,
    ),
    ['55', '60'],
  );
  assert.equal(receiptPayouts({ ...receipt(), logs: [] }, longbow), null);
  assert.equal(
    receiptPayouts(
      { ...receipt(), logs: [log] },
      { ...longbow, poolId: `0x${'e'.repeat(64)}` },
    ),
    null,
  );
  assert.equal(
    receiptPayouts(
      {
        ...receipt(),
        logs: [
          {
            ...log,
            topics: encodeEventTopics({
              abi: claimAbi,
              eventName: 'Release',
              args: { poolId, beneficiary: addr('b') },
            }) as Hash[],
          },
        ],
      },
      longbow,
    ),
    null,
  );
});

await test('legacy escrow requires its explicit version and proves recipient-bound payouts using the legacy event', () => {
  const legacy: ClaimQuote = {
    ...quote(),
    escrowVersion: 'legacy',
    data: encodeFunctionData({
      abi: legacyClaimAbi,
      functionName: 'claim',
      args: [owner, currency],
    }),
  };
  assert.equal(validateClaim(legacy).escrowVersion, 'legacy');
  for (const escrowVersion of [undefined, 'current', 'unknown'])
    assert.throws(() => validateClaim({ ...legacy, escrowVersion }));
  assert.throws(() => validateClaim({ ...quote(), escrowVersion: 'legacy' }));
  assert.throws(() =>
    validateClaim({
      ...legacy,
      data: encodeFunctionData({
        abi: legacyClaimAbi,
        functionName: 'claim',
        args: [addr('b'), currency],
      }),
    }),
  );
  const log = {
    address: target,
    topics: encodeEventTopics({
      abi: legacyClaimAbi,
      eventName: 'Claimed',
      args: { recipient: owner, currency },
    }) as Hash[],
    data: encodeAbiParameters([{ type: 'uint256' }], [125n]),
  };
  const proof = { ...receipt(), logs: [log] };
  assert.equal(receiptPayouts(proof, legacy)?.[0].claimableRaw, '125');
  assert.equal(receiptPayouts(proof, quote()), null);
  assert.equal(receiptPayouts(receipt(), legacy), null);
  assert.equal(
    receiptPayouts(
      {
        ...proof,
        logs: [
          {
            ...log,
            topics: encodeEventTopics({
              abi: legacyClaimAbi,
              eventName: 'Claimed',
              args: { recipient: addr('b'), currency },
            }) as Hash[],
          },
        ],
      },
      legacy,
    ),
    null,
  );
});

await test('wallet operations are explicit, never retried, identity-bound and retain ambiguous activity', async () => {
  let mode = 'reject';
  let sends = 0;
  let currentOwner = owner;
  let currentChain = 8453;
  const provider = {
    request: async ({
      method,
      params,
    }: {
      method: string;
      params?: unknown[];
    }) => {
      if (method === 'eth_accounts') return [currentOwner];
      if (method === 'eth_chainId') return toHex(currentChain);
      if (method === 'eth_getTransactionReceipt') return receipt();
      assert.equal(method, 'eth_sendTransaction');
      sends++;
      const transaction = params?.[0] as {
        from: string;
        to: string;
        value: string;
        gas: string;
        chainId: string;
      };
      assert.equal(transaction.from, owner);
      assert.equal(transaction.to, target);
      assert.equal(transaction.value, '0x0');
      assert.equal(transaction.gas, toHex(120000));
      assert.equal(transaction.chainId, toHex(8453));
      if (mode === 'reject')
        throw { name: 'TransactionExecutionError', cause: { code: 4001 } };
      if (mode === 'uncertain') throw { code: -32602 };
      return hash;
    },
  } as EIP1193Provider;
  await assert.rejects(sendWalletClaim(provider, quote()));
  assert.equal(sends, 1);
  assert.equal(getClaims().length, 0);
  currentOwner = addr('b');
  await assert.rejects(sendWalletClaim(provider, quote()), {
    code: 'wrong_account',
  });
  currentOwner = owner;
  currentChain = 4663;
  await assert.rejects(sendWalletClaim(provider, quote()), {
    code: 'wrong_chain',
  });
  currentChain = 8453;
  await assert.rejects(
    sendWalletClaim(provider, { ...quote(), expiresAt: -1 }),
    {
      code: 'quote_expired',
    },
  );
  assert.equal(sends, 1);
  mode = 'success';
  await sendWalletClaim(provider, quote());
  assert.equal(sends, 2);
  await assert.rejects(sendWalletClaim(provider, quote('b')), {
    code: 'pending',
  });
  await checkWalletClaim(provider, quote().positionId);
  assert.equal(getClaims()[0].status, 'confirmed');
  assert.equal(getClaims()[0].payouts?.[0].claimableRaw, '125');
  mode = 'uncertain';
  await assert.rejects(sendWalletClaim(provider, quote('b')));
  assert.equal(sends, 3);
  assert.equal(getClaims()[1].status, 'uncertain');
  await assert.rejects(sendWalletClaim(provider, quote('c')), {
    code: 'pending',
  });
  acknowledgeClaim(quote('b').positionId);
  assert.equal(getClaims()[1].status, 'reviewed');
  await assert.rejects(sendWalletClaim(provider, quote('b')), {
    code: 'pending',
  });
  assert.equal(sends, 3);
});

await test('claim chain selection leaves the matching wallet alone and switches mismatched wallets once', async () => {
  for (const chain of [robinhood, base]) {
    for (const startsOnTarget of [true, false]) {
      let chainId = startsOnTarget ? chain.id : 1;
      const methods: string[] = [];
      const provider = {
        request: async ({
          method,
          params,
        }: {
          method: string;
          params?: unknown[];
        }) => {
          methods.push(method);
          if (method === 'eth_accounts') return [owner.toUpperCase()];
          if (method === 'eth_chainId') return toHex(chainId);
          assert.equal(method, 'wallet_switchEthereumChain');
          assert.deepEqual(params, [{ chainId: toHex(chain.id) }]);
          chainId = chain.id;
          return null;
        },
      } as EIP1193Provider;
      await ensureClaimChain(provider, owner, chain.id);
      assert.deepEqual(
        methods,
        startsOnTarget
          ? ['eth_accounts', 'eth_chainId']
          : [
              'eth_accounts',
              'eth_chainId',
              'wallet_switchEthereumChain',
              'eth_accounts',
              'eth_chainId',
            ],
      );
    }
  }
});

await test('claim chain selection rejects wrong accounts, unsupported chains and ineffective switches', async () => {
  let currentOwner = addr('b');
  const methods: string[] = [];
  const provider = {
    request: async ({ method }: { method: string }) => {
      methods.push(method);
      if (method === 'eth_accounts') return [currentOwner];
      if (method === 'eth_chainId') return toHex(1);
      assert.equal(method, 'wallet_switchEthereumChain');
      return null;
    },
  } as EIP1193Provider;
  await assert.rejects(ensureClaimChain(provider, owner, 1), {
    code: 'invalid_request',
  });
  assert.deepEqual(methods, []);
  await assert.rejects(ensureClaimChain(provider, owner, robinhood.id), {
    code: 'wrong_account',
  });
  assert.deepEqual(methods, ['eth_accounts']);
  methods.length = 0;
  currentOwner = owner;
  await assert.rejects(ensureClaimChain(provider, owner, robinhood.id), {
    code: 'wrong_chain',
  });
  assert.deepEqual(methods, [
    'eth_accounts',
    'eth_chainId',
    'wallet_switchEthereumChain',
    'eth_accounts',
    'eth_chainId',
  ]);
});

await test('claim chain selection propagates wallet rejection without retrying or adding a network', async () => {
  for (const error of [
    { code: 4001 },
    { cause: { code: 4001 } },
    { code: -32002 },
    { code: -32603 },
  ]) {
    const methods: string[] = [];
    const provider = {
      request: async ({ method }: { method: string }) => {
        methods.push(method);
        if (method === 'eth_accounts') return [owner];
        if (method === 'eth_chainId') return toHex(1);
        assert.equal(method, 'wallet_switchEthereumChain');
        throw error;
      },
    } as EIP1193Provider;
    await assert.rejects(
      ensureClaimChain(provider, owner, robinhood.id),
      (caught) => caught === error,
    );
    assert.deepEqual(methods, [
      'eth_accounts',
      'eth_chainId',
      'wallet_switchEthereumChain',
    ]);
  }
});

await test('an unknown claim network is added from the bundled chain metadata then verified', async () => {
  for (const chain of [robinhood, base]) {
    for (const addAlsoSwitches of [true, false]) {
      let chainId = 1;
      let added = false;
      const methods: string[] = [];
      const provider = {
        request: async ({
          method,
          params,
        }: {
          method: string;
          params?: unknown[];
        }) => {
          methods.push(method);
          if (method === 'eth_accounts') return [owner];
          if (method === 'eth_chainId') return toHex(chainId);
          if (method === 'wallet_switchEthereumChain') {
            assert.deepEqual(params, [{ chainId: toHex(chain.id) }]);
            if (!added) throw { cause: { code: 4902 } };
            chainId = chain.id;
            return null;
          }
          assert.equal(method, 'wallet_addEthereumChain');
          assert.deepEqual(params, [
            {
              chainId: toHex(chain.id),
              chainName: chain.name,
              nativeCurrency: chain.nativeCurrency,
              rpcUrls: [...chain.rpcUrls.default.http],
              blockExplorerUrls: [chain.blockExplorers.default.url],
            },
          ]);
          added = true;
          if (addAlsoSwitches) chainId = chain.id;
          return null;
        },
      } as EIP1193Provider;
      await ensureClaimChain(provider, owner, chain.id);
      assert.equal(
        methods.filter((method) => method === 'wallet_addEthereumChain').length,
        1,
      );
      assert.equal(
        methods.filter((method) => method === 'wallet_switchEthereumChain')
          .length,
        addAlsoSwitches ? 1 : 2,
      );
      assert.deepEqual(methods.slice(-2), ['eth_accounts', 'eth_chainId']);
    }
  }
});

await test('claim chain selection stops if the account changes while switching or adding', async () => {
  for (const changedDuring of ['switch', 'unknown', 'add']) {
    let currentOwner = owner;
    const methods: string[] = [];
    const provider = {
      request: async ({ method }: { method: string }) => {
        methods.push(method);
        if (method === 'eth_accounts') return [currentOwner];
        if (method === 'eth_chainId') return toHex(1);
        if (method === 'wallet_switchEthereumChain') {
          if (changedDuring !== 'add') currentOwner = addr('b');
          if (changedDuring !== 'switch') throw { code: 4902 };
          return null;
        }
        assert.equal(method, 'wallet_addEthereumChain');
        currentOwner = addr('b');
        return null;
      },
    } as EIP1193Provider;
    await assert.rejects(ensureClaimChain(provider, owner, robinhood.id), {
      code: 'wrong_account',
    });
    assert.equal(
      methods.filter((method) => method === 'wallet_switchEthereumChain')
        .length,
      1,
    );
    assert.equal(
      methods.filter((method) => method === 'wallet_addEthereumChain').length,
      changedDuring === 'add' ? 1 : 0,
    );
    assert.equal(methods.at(-1), 'eth_accounts');
  }
});

await test('cancelled claim chain selection never issues a subsequent wallet request', async () => {
  for (const cancelAfterRequest of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    let current = cancelAfterRequest !== 0;
    let added = false;
    let chainId = 1;
    const methods: string[] = [];
    const provider = {
      request: async ({ method }: { method: string }) => {
        methods.push(method);
        if (methods.length === cancelAfterRequest) current = false;
        if (method === 'eth_accounts') return [owner];
        if (method === 'eth_chainId') return toHex(chainId);
        if (method === 'wallet_switchEthereumChain') {
          if (!added) throw { code: 4902 };
          chainId = robinhood.id;
          return null;
        }
        assert.equal(method, 'wallet_addEthereumChain');
        added = true;
        return null;
      },
    } as EIP1193Provider;
    await assert.rejects(
      ensureClaimChain(provider, owner, robinhood.id, () => current),
      { code: 'cancelled' },
    );
    assert.equal(methods.length, cancelAfterRequest);
  }
});

await test('declining an unknown claim network stops after its single add request', async () => {
  const methods: string[] = [];
  const rejection = { code: 4001 };
  const provider = {
    request: async ({ method }: { method: string }) => {
      methods.push(method);
      if (method === 'eth_accounts') return [owner];
      if (method === 'eth_chainId') return toHex(1);
      if (method === 'wallet_switchEthereumChain') throw { code: 4902 };
      assert.equal(method, 'wallet_addEthereumChain');
      throw rejection;
    },
  } as EIP1193Provider;
  await assert.rejects(
    ensureClaimChain(provider, owner, robinhood.id),
    (caught) => caught === rejection,
  );
  assert.deepEqual(methods, [
    'eth_accounts',
    'eth_chainId',
    'wallet_switchEthereumChain',
    'eth_accounts',
    'wallet_addEthereumChain',
  ]);
});

let receiptTestId = 0;
let receiptTestClock = 1_000_000;
const drainReceiptWork = () =>
  new Promise<void>((resolve) => setImmediate(resolve));
async function receiptWatcherFixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = (receiptTestClock += 1_000_000);
  t.mock.method(performance, 'now', () => now);
  const input: ClaimQuote = {
    ...quote(),
    positionId: (++receiptTestId).toString(16).padStart(64, '0'),
  };
  const transactionHash =
    `0x${receiptTestId.toString(16).padStart(64, '0')}` as Hash;
  const success = { ...receipt(), transactionHash };
  const state = {
    account: owner,
    chain: input.chainId as number,
    response: null as unknown,
    failure: undefined as unknown,
    onRequest: undefined as ((method: string) => void) | undefined,
    gate: undefined as Promise<unknown> | undefined,
    gateMethod: 'eth_getTransactionReceipt',
  };
  const requests: string[] = [];
  let sends = 0;
  const provider = {
    request: async ({
      method,
      params,
    }: {
      method: string;
      params?: unknown[];
    }) => {
      requests.push(method);
      state.onRequest?.(method);
      if (state.gate && method === state.gateMethod) return await state.gate;
      if (method === 'eth_accounts') return [state.account];
      if (method === 'eth_chainId') return toHex(state.chain);
      if (method === 'eth_sendTransaction') {
        sends++;
        return transactionHash;
      }
      assert.equal(method, 'eth_getTransactionReceipt');
      assert.deepEqual(params, [transactionHash]);
      if (state.failure) throw state.failure;
      return state.response;
    },
  } as EIP1193Provider;
  await sendWalletClaim(provider, input);
  requests.length = 0;
  const cleanups: (() => void)[] = [];
  const watch = (options: Parameters<typeof watchWalletClaim>[2] = {}) => {
    const cleanup = watchWalletClaim(provider, input.positionId, options);
    cleanups.push(cleanup);
    return cleanup;
  };
  const tick = async (ms: number) => {
    now += ms;
    t.mock.timers.tick(ms);
    await drainReceiptWork();
  };
  t.after(async () => {
    for (const cleanup of cleanups) cleanup();
    state.account = owner;
    state.chain = input.chainId;
    state.response = success;
    state.failure = undefined;
    state.onRequest = undefined;
    state.gate = undefined;
    now += 20_000;
    if (
      getClaims().find((entry) => entry.quote === input)?.status === 'submitted'
    )
      await checkWalletClaim(provider, input.positionId);
  });
  return {
    input,
    success,
    state,
    requests,
    provider,
    watch,
    tick,
    sends: () => sends,
    receiptReads: () =>
      requests.filter((method) => method === 'eth_getTransactionReceipt')
        .length,
    status: () => getClaims().find((entry) => entry.quote === input)?.status,
  };
}

await test('receipt watching backs off to one read per minute, keeps long-pending claims, and never sends', async (t) => {
  const f = await receiptWatcherFixture(t);
  f.watch();
  assert.equal(f.receiptReads(), 0);
  for (const [delay, reads] of [
    [10_000, 1],
    [20_000, 2],
    [30_000, 3],
    [60_000, 4],
    [60_000, 5],
  ]) {
    await f.tick(delay - 1);
    assert.equal(f.receiptReads(), reads - 1);
    await f.tick(1);
    assert.equal(f.receiptReads(), reads);
  }
  for (let index = 0; index < 12; index++) await f.tick(60_000);
  assert.equal(f.receiptReads(), 17);
  assert.equal(f.status(), 'submitted');
  assert.equal(f.sends(), 1);
  f.state.response = f.success;
  await f.tick(60_000);
  assert.equal(f.status(), 'confirmed');
  assert.equal(
    getClaims().find((entry) => entry.quote === f.input)?.payouts?.[0]
      .claimableRaw,
    '125',
  );
  const reads = f.receiptReads();
  await f.tick(600_000);
  assert.equal(f.receiptReads(), reads);
  assert.equal(f.sends(), 1);
});

await test('receipt watchers deduplicate the same hash and one subscriber cleanup preserves the other', async (t) => {
  const f = await receiptWatcherFixture(t);
  const first = f.watch();
  const second = f.watch();
  await f.tick(10_000);
  assert.equal(f.receiptReads(), 1);
  first();
  first();
  await f.tick(20_000);
  assert.equal(f.receiptReads(), 2);
  second();
  await f.tick(600_000);
  assert.equal(f.receiptReads(), 2);
  assert.equal(f.sends(), 1);
});

await test('receipt watching stays idle without a submitted hash and stops for reverted or unproven receipts', async (t) => {
  for (const status of ['failed', 'no_payout']) {
    await t.test(status, async (t) => {
      const f = await receiptWatcherFixture(t);
      watchWalletClaim(f.provider, 'f'.repeat(64));
      await f.tick(20_000);
      assert.equal(f.requests.length, 0);
      f.state.response =
        status === 'failed'
          ? { ...f.success, status: '0x0' }
          : { ...f.success, logs: [] };
      f.watch();
      await f.tick(10_000);
      assert.equal(f.status(), status);
      f.watch();
      await f.tick(600_000);
      assert.equal(f.receiptReads(), 1);
      if (status === 'no_payout') acknowledgeClaim(f.input.positionId);
    });
  }
});

await test('receipt watching retries read failures with backoff but reports each error streak once', async (t) => {
  const f = await receiptWatcherFixture(t);
  const errors: unknown[] = [];
  f.state.failure = { code: -32005 };
  f.watch({ onError: (error) => errors.push(error) });
  await f.tick(10_000);
  await f.tick(20_000);
  await f.tick(30_000);
  assert.equal(f.receiptReads(), 3);
  assert.equal(errors.length, 1);
  f.state.failure = undefined;
  await f.tick(60_000);
  f.state.failure = { code: -32603 };
  await f.tick(60_000);
  assert.equal(errors.length, 2);
  f.state.failure = undefined;
  f.state.response = f.success;
  await f.tick(60_000);
  assert.equal(f.status(), 'confirmed');
  assert.equal(f.sends(), 1);
});

await test('receipt watching stops on rejection, wrong account or wrong network without changing networks', async (t) => {
  for (const stopReason of ['rejected', 'account', 'chain', 'disconnected']) {
    await t.test(stopReason, async (t) => {
      const f = await receiptWatcherFixture(t);
      const errors: unknown[] = [];
      f.watch({ onError: (error) => errors.push(error) });
      if (stopReason === 'rejected') f.state.failure = { code: 4001 };
      if (stopReason === 'disconnected') f.state.failure = { code: 4900 };
      if (stopReason === 'account') f.state.account = addr('b');
      if (stopReason === 'chain') f.state.chain = 1;
      await f.tick(10_000);
      const requests = f.requests.length;
      assert.equal(errors.length, 1);
      await f.tick(600_000);
      assert.equal(f.requests.length, requests);
      assert.equal(
        f.receiptReads(),
        ['rejected', 'disconnected'].includes(stopReason) ? 1 : 0,
      );
      assert.equal(f.sends(), 1);
    });
  }
});

await test('receipt watching stops stale subscribers before every wallet request and can restart after visibility returns', async (t) => {
  const f = await receiptWatcherFixture(t);
  let current = false;
  const errors: unknown[] = [];
  f.watch({ isCurrent: () => current, onError: (error) => errors.push(error) });
  await f.tick(10_000);
  assert.equal(f.requests.length, 0);
  current = true;
  f.watch({ isCurrent: () => current, onError: (error) => errors.push(error) });
  f.state.onRequest = (method) => {
    if (method === 'eth_accounts') current = false;
  };
  await f.tick(10_000);
  assert.deepEqual(f.requests, ['eth_accounts']);
  current = true;
  f.state.onRequest = undefined;
  await f.tick(600_000);
  assert.deepEqual(f.requests, ['eth_accounts']);
  f.state.response = f.success;
  f.watch({ isCurrent: () => current });
  await f.tick(10_000);
  assert.equal(f.status(), 'confirmed');
  assert.equal(errors.length, 0);
});

await test('cleanup during a receipt request ignores its late result and prevents further reads', async (t) => {
  const f = await receiptWatcherFixture(t);
  let resolveReceipt!: (receipt: unknown) => void;
  f.state.gate = new Promise((resolve) => {
    resolveReceipt = resolve;
  });
  const stop = f.watch();
  await f.tick(10_000);
  assert.equal(f.receiptReads(), 1);
  stop();
  resolveReceipt(f.success);
  await drainReceiptWork();
  assert.equal(f.status(), 'submitted');
  await f.tick(600_000);
  assert.equal(f.receiptReads(), 1);
  f.state.gate = undefined;
});

await test('disposing an unresolved read frees the lock for a deduplicated restart and ignores the old result', async (t) => {
  const f = await receiptWatcherFixture(t);
  let resolveOld!: (receipt: unknown) => void;
  f.state.gate = new Promise((resolve) => {
    resolveOld = resolve;
  });
  const stop = f.watch();
  await f.tick(10_000);
  assert.equal(f.receiptReads(), 1);
  stop();
  f.state.gate = undefined;
  f.watch();
  f.watch();
  await f.tick(10_000);
  assert.equal(f.receiptReads(), 2);
  assert.equal(f.status(), 'submitted');
  resolveOld(f.success);
  await drainReceiptWork();
  assert.equal(f.status(), 'submitted');
  assert.equal(f.receiptReads(), 2);
  await f.tick(19_999);
  assert.equal(f.receiptReads(), 2);
  f.state.response = f.success;
  await f.tick(1);
  assert.equal(f.receiptReads(), 3);
  assert.equal(f.status(), 'confirmed');
  await f.tick(600_000);
  assert.equal(f.receiptReads(), 3);
  assert.equal(f.sends(), 1);
});

await test('a hung wallet read times out after 15 seconds and retries once with the existing backoff', async (t) => {
  for (const method of ['eth_accounts', 'eth_getTransactionReceipt']) {
    await t.test(method, async (t) => {
      const f = await receiptWatcherFixture(t);
      let resolveOld!: (value: unknown) => void;
      const errors: unknown[] = [];
      f.state.gateMethod = method;
      f.state.gate = new Promise((resolve) => {
        resolveOld = resolve;
      });
      f.watch({ onError: (error) => errors.push(error) });
      await f.tick(10_000);
      const beforeTimeout = f.requests.length;
      await f.tick(14_999);
      assert.equal(errors.length, 0);
      assert.equal(f.requests.length, beforeTimeout);
      await f.tick(1);
      assert.equal(errors.length, 1);
      assert.equal((errors[0] as { code: string }).code, 'timeout');
      f.state.gate = undefined;
      await f.tick(19_999);
      assert.equal(f.requests.length, beforeTimeout);
      await f.tick(1);
      assert.equal(f.receiptReads(), method === 'eth_accounts' ? 1 : 2);
      const afterRetry = f.requests.length;
      resolveOld(method === 'eth_accounts' ? [owner] : f.success);
      await drainReceiptWork();
      assert.equal(f.requests.length, afterRetry);
      assert.equal(f.status(), 'submitted');
      f.state.response = f.success;
      await f.tick(30_000);
      assert.equal(f.status(), 'confirmed');
      const afterConfirmation = f.requests.length;
      await f.tick(600_000);
      assert.equal(f.requests.length, afterConfirmation);
      assert.equal(f.sends(), 1);
    });
  }
});

await test('Pons exact-amount claims reject changed currency, amount, chain and unrelated receipts', async () => {
  const { ponsClaimAbi, parseFees } = await import('./fee-service.ts');
  for (const asset of [addr('0'), currency]) {
    const pons: ClaimQuote = { ...quote(), kind: 'pons', chainId: 4663,
      payouts: [{ asset, symbol: asset === addr('0') ? 'ETH' : 'TEST', decimals: 18, claimableRaw: '100' }],
      data: asset === addr('0')
        ? encodeFunctionData({ abi: ponsClaimAbi, functionName: 'claim', args: [100n] })
        : encodeFunctionData({ abi: ponsClaimAbi, functionName: 'claimToken', args: [asset, 100n] }),
    };
    assert.equal(validateClaim(pons), pons);
    for (const change of [{ chainId: 8453 }, { data: `${pons.data}00` }, { value: '1' }, { poolId: hash }, { payouts: [{ ...pons.payouts[0], claimableRaw: '101' }] }, { payouts: [{ ...pons.payouts[0], asset: addr('3') }] }, { escrowVersion: 'legacy' }])
      assert.throws(() => validateClaim({ ...pons, ...change }), /invalid_response/);
    const eventName = asset === addr('0') ? 'Claimed' : 'ClaimedToken';
    const log = { address: target, topics: encodeEventTopics({ abi: ponsClaimAbi, eventName, args: { recipient: owner, ...(eventName === 'ClaimedToken' ? { token: asset } : {}) } }) as Hash[], data: encodeAbiParameters([{ type: 'uint256' }], [100n]) };
    const transfer = { address: asset, topics: encodeEventTopics({ abi: ponsClaimAbi, eventName: 'Transfer', args: { from: target, to: owner } }) as Hash[], data: encodeAbiParameters([{ type: 'uint256' }], [100n]) };
    const proof = { ...receipt(), logs: asset === addr('0') ? [log] : [log, transfer] };
    if (asset !== addr('0')) {
      assert.equal(receiptPayouts({ ...proof, logs: [log] }, pons), null);
      assert.equal(receiptPayouts({ ...proof, logs: [log, { ...transfer, data: encodeAbiParameters([{ type: 'uint256' }], [90n]) }] }, pons)?.[0].claimableRaw, '90');
    }
    assert.equal(receiptPayouts(proof, pons)?.[0].claimableRaw, '100');
    assert.equal(receiptPayouts({ ...proof, from: addr('b') }, pons), null);
    assert.equal(receiptPayouts({ ...proof, logs: [{ ...log, address: addr('b') }] }, pons), null);
    assert.equal(receiptPayouts({ ...proof, logs: [{ ...log, data: encodeAbiParameters([{ type: 'uint256' }], [101n]) }] }, pons), null);
    assert.equal(receiptPayouts({ ...proof, logs: [log, log] }, pons), null);
    assert.equal(receiptPayouts(receipt(), pons), null);
    const source = { address: owner, chainId: 4663, padId: 'pons', coverage: 'configured_escrow', status: 'partial', nextCursor: null, expiresAt: 100,
      positions: [{ id: pons.positionId, target, payouts: pons.payouts, verification: 'live', claimable: true }] };
    assert.equal(parseFees(source, owner, 4663, 'pons'), source);
    assert.throws(() => parseFees({ ...source, status: 'ready' }, owner, 4663, 'pons'), /invalid_response/);
    assert.throws(() => parseFees({ ...source, coverage: 'wallet_index' }, owner, 4663, 'pons'), /invalid_response/);
  }
});
