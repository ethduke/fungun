import assert from 'node:assert/strict';
import test from 'node:test';
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
