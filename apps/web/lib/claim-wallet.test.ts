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
import { claimAbi, type ClaimQuote } from './fee-service.ts';
import {
  acknowledgeClaim,
  checkWalletClaim,
  getClaims,
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

await test('Long Release confirms beneficiary payout; pool-wide Collect or successful empty receipts do not', () => {
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
    { code: 'quote_expired' },
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
