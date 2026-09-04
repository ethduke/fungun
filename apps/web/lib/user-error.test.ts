import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AppError,
  describeError,
  retrySeconds,
  type ErrorContext,
} from './user-error.ts';

await test('wallet failures distinguish rejection, permissions, wrong networks and pending requests', () => {
  for (const [code, phrase] of [
    [4001, 'cancelled'],
    [4100, 'Allow this site'],
    [4900, 'disconnected'],
    [4901, 'different network'],
    [4200, 'does not support'],
    [-32002, 'wallet is busy'],
  ] as const)
    assert.ok(describeError({ code }, 'connect').includes(phrase));
});
await test('nested gas errors distinguish changed fees, invalid settings and insufficient ETH', () => {
  for (const [name, phrase] of [
    ['FeeCapTooLowError', 'Network fees changed'],
    ['FeeCapTooHighError', 'fee settings'],
    ['InsufficientFundsError', 'enough ETH'],
    ['ContractFunctionRevertedError', 'paying more gas won’t fix'],
    ['IntrinsicGasTooHighError', 'Do not increase it blindly'],
    ['IntrinsicGasTooLowError', 'gas limit is too low'],
  ] as const)
    assert.ok(
      describeError(
        { name: 'EstimateGasExecutionError', cause: { name } },
        'estimate',
      ).includes(phrase),
    );
});
await test('timeouts on uncertain writes never claim that no funds were spent', () => {
  const error = { name: 'TimeoutError', message: 'private diagnostic' };
  assert.match(describeError(error, 'estimate'), /too long/);
  for (const context of ['launch', 'claim'] as const)
    assert.match(
      describeError(error, context),
      /transaction may already have been sent/,
    );
});
await test('retry guidance is bounded and honors the service cooldown', () => {
  assert.equal(retrySeconds(null), 30);
  assert.equal(retrySeconds('garbage'), 30);
  assert.equal(retrySeconds('Infinity'), 30);
  assert.equal(retrySeconds('-30'), 5);
  assert.equal(retrySeconds('9999999'), 86400);
  assert.equal(retrySeconds('10.5'), 11);
  assert.match(
    describeError(new AppError('rate_limited', 45), 'ticker'),
    /45 seconds/,
  );
  assert.match(
    describeError(new AppError('rate_limited', 80), 'catalog'),
    /2 minutes/,
  );
});
await test('raw messages, payloads and stacks never reach the user', () => {
  const diagnostic = ['private', 'provider', 'diagnostic'].join('-');
  const error = {
    message: diagnostic,
    details: diagnostic,
    data: diagnostic,
    stack: diagnostic,
    cause: { message: diagnostic },
  };
  for (const context of [
    'connect',
    'disconnect',
    'catalog',
    'ticker',
    'estimate',
    'launch',
    'claim',
  ] as ErrorContext[]) {
    assert.ok(describeError(error, context).length > 20);
    assert.ok(!describeError(error, context).includes(diagnostic));
    assert.ok(
      !describeError(new AppError(diagnostic), context).includes(diagnostic),
    );
  }
});
await test('cyclic and deep causes cannot loop or expose diagnostics', () => {
  assert.match(
    describeError({ name: 'toString' }, 'connect'),
    /connection did not finish/,
  );
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  assert.match(describeError(cycle, 'connect'), /connection did not finish/);
  let deep: unknown = { code: 4001 };
  for (let i = 0; i < 20; i++) deep = { cause: deep };
  assert.match(describeError(deep, 'connect'), /connection did not finish/);
});
