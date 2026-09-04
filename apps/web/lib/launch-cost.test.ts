import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DESTINATIONS } from './launch-model.ts';
import {
  calculateLaunchCosts,
  costRefreshDelay,
  estimateNetworkFee,
  formatEth,
  formatUsd,
  highGasNotice,
  HIGH_NETWORK_FEE_WEI,
  launchCostKey,
  type CostStep,
  type LaunchCostQuote,
  type NetworkEstimate,
  type UsdRate,
} from './launch-cost.ts';

const selection = {
  contextKey: 'synthetic-draft',
  chainId: 4663 as const,
  pads: ['long', 'o1'] as ('long' | 'o1')[],
};
const step = (fee = 0n): CostStep => ({
  kind: 'launch',
  network: { chainId: 4663, gasUnits: 100n, gasPriceWei: 2n },
  launchpadFeeWei: fee,
  valueWei: fee,
});
function quote(): LaunchCostQuote {
  return {
    contextKey: selection.contextKey,
    chainId: 4663,
    quotedAt: 100,
    expiresAt: 200,
    nativeOnly: true,
    pads: [
      { id: 'long', steps: [step()] },
      { id: 'o1', steps: [step(500n)] },
    ],
  };
}

await test('native launch fees are counted once, including RWA fees paid in ETH', () => {
  const result = calculateLaunchCosts(quote(), selection, 150);
  assert.deepEqual(result.total, {
    launchpadWei: 500n,
    networkWei: 400n,
    otherValueWei: 0n,
    totalWei: 900n,
    transactions: 2,
  });
  assert.equal(result.pads.long?.launchpadWei, 0n);
  assert.equal(result.pads.o1?.totalWei, 700n);
});
await test('all approval and setup steps are counted; other value is not hidden as a fee', () => {
  const input = quote();
  input.pads[1].steps.unshift(
    { ...step(), kind: 'approval' },
    { ...step(), kind: 'setup', valueWei: 20n },
  );
  assert.deepEqual(calculateLaunchCosts(input, selection, 150).total, {
    launchpadWei: 500n,
    networkWei: 800n,
    otherValueWei: 20n,
    totalWei: 1320n,
    transactions: 4,
  });
});
await test('Robinhood gas includes L1 posting without adding a second data fee', () => {
  const bundled = {
    chainId: 4663 as const,
    gasUnits: 100n,
    gasPriceWei: 2n,
    l1DataFeeWei: 10000n,
  };
  assert.equal(estimateNetworkFee(bundled), 200n);
});
const base = {
  chainId: 8453 as const,
  gasUnits: 100n,
  baseFeePerGasWei: 3n,
  priorityFeePerGasWei: 2n,
  maxFeePerGasWei: 10n,
  l1DataFeeWei: 7n,
  operatorFeeWei: 11n,
};
await test('Base adds both oracle components and uses estimated price rather than fee cap', () => {
  assert.equal(estimateNetworkFee(base), 518n);
  assert.equal(estimateNetworkFee({ ...base, maxFeePerGasWei: 4n }), 418n);
  assert.equal(estimateNetworkFee({ ...base, maxFeePerGasWei: 2n }), null);
  assert.equal(
    estimateNetworkFee({ ...base, priorityFeePerGasWei: 11n }),
    null,
  );
  assert.equal(estimateNetworkFee({ ...base, operatorFeeWei: 0n }), 507n);
});
await test('missing or failed Base components never default to zero', () => {
  for (const key of ['operatorFeeWei', 'l1DataFeeWei', 'gasUnits'])
    assert.equal(
      estimateNetworkFee({
        ...base,
        [key]: undefined,
      } as unknown as NetworkEstimate),
      null,
    );
  const input = quote();
  input.chainId = 8453;
  input.pads = [
    {
      id: 'o1',
      steps: [
        {
          ...step(500n),
          network: {
            ...base,
            operatorFeeWei: undefined,
          } as unknown as NetworkEstimate,
        },
      ],
    },
  ];
  assert.equal(
    calculateLaunchCosts(
      input,
      { ...selection, chainId: 8453, pads: ['o1'] },
      150,
    ).total,
    null,
  );
});
await test('known pad amounts may be shown without presenting a partial grand total', () => {
  const input = quote();
  input.pads.pop();
  const result = calculateLaunchCosts(input, selection, 150);
  assert.equal(result.reason, 'incomplete');
  assert.equal(result.total, null);
  assert.equal(result.pads.long?.totalWei, 200n);
  assert.equal(result.pads.o1, undefined);
});
await test('unknown, expired, future and overlong quotes cannot be used', () => {
  assert.equal(calculateLaunchCosts(null, selection, 150).reason, 'not_ready');
  for (const now of [99, 200, NaN, Infinity])
    assert.equal(calculateLaunchCosts(quote(), selection, now).total, null);
  assert.equal(
    calculateLaunchCosts({ ...quote(), expiresAt: 30101 }, selection, 150)
      .total,
    null,
  );
  assert.equal(
    calculateLaunchCosts(quote(), { ...selection, contextKey: 'edited' }, 150)
      .reason,
    'changed',
  );
  assert.equal(
    calculateLaunchCosts(quote(), { ...selection, chainId: 8453 }, 150).reason,
    'changed',
  );
});
await test('mixed chains, duplicates, missing launches and token payments fail closed', () => {
  const variations = [
    { ...quote(), nativeOnly: false },
    { ...quote(), pads: [quote().pads[0], quote().pads[0]] },
    { ...quote(), pads: [{ id: 'long' as const, steps: [] }] },
    { ...quote(), pads: [{ id: 'long' as const, steps: [step(), step()] }] },
    {
      ...quote(),
      pads: [{ id: 'long' as const, steps: [{ ...step(), network: base }] }],
    },
    {
      ...quote(),
      pads: [
        { id: 'long' as const, steps: [{ ...step(), launchpadFeeWei: 1n }] },
      ],
    },
  ];
  for (const input of variations)
    assert.equal(calculateLaunchCosts(input, selection, 150).total, null);
});
await test('malformed entries, negative amounts and overflow do not crash or become totals', () => {
  for (const pads of [[null], [{ id: 'long', steps: [null] }]])
    assert.equal(
      calculateLaunchCosts(
        { ...quote(), pads } as unknown as LaunchCostQuote,
        selection,
        150,
      ).reason,
      'invalid',
    );
  assert.equal(
    estimateNetworkFee({ chainId: 4663, gasUnits: -1n, gasPriceWei: 2n }),
    null,
  );
  assert.equal(
    estimateNetworkFee({
      chainId: 4663,
      gasUnits: 1n << 255n,
      gasPriceWei: 3n,
    }),
    null,
  );
  assert.equal(
    estimateNetworkFee({
      ...base,
      baseFeePerGasWei: 0n,
      priorityFeePerGasWei: 0n,
    }),
    null,
  );
});
await test('quote identity follows all relevant edits and wallet/network changes', () => {
  const draft = {
    name: 'Moon',
    ticker: 'MOON',
    description: '',
    imageRevision: 'memory-image-1',
    account: 'synthetic-account',
    walletChainId: 4663,
    destinations: DEFAULT_DESTINATIONS.map((pad) => ({
      ...pad,
      selected: true,
    })),
  };
  const key = launchCostKey(draft);
  for (const field of [
    'name',
    'ticker',
    'description',
    'imageRevision',
    'account',
  ])
    assert.notEqual(launchCostKey({ ...draft, [field]: 'changed' }), key);
  assert.notEqual(launchCostKey({ ...draft, walletChainId: 8453 }), key);
  assert.equal(
    launchCostKey({
      ...draft,
      destinations: [...draft.destinations].reverse(),
    }),
    key,
  );
  for (const change of [
    { selected: false },
    { editableMetadata: true },
    { pairId: 'native' as const },
    { chainId: 8453 as const },
  ])
    assert.notEqual(
      launchCostKey({
        ...draft,
        destinations: [
          { ...draft.destinations[0], ...change },
          draft.destinations[1],
        ],
      }),
      key,
    );
});
const rate: UsdRate = {
  microUsdPerEth: 2000n * 1_000_000n,
  sourceLabel: 'Synthetic price',
  quotedAt: 100,
  expiresAt: 200,
};
await test('ETH/USD formatting preserves precision and distinguishes unknown from zero', () => {
  assert.equal(formatEth(null), '— ETH');
  assert.equal(formatEth(0n), '0 ETH');
  assert.equal(formatEth(1n), '<0.00000001 ETH');
  assert.equal(formatEth(12345000000000000n), '0.012345 ETH');
  assert.equal(formatUsd(10n ** 16n, rate, 150), '≈ $20.00');
  assert.equal(formatUsd(0n, rate, 150), '≈ $0.00');
  assert.equal(formatUsd(1n, rate, 150), '≈ <$0.01');
  assert.equal(formatUsd(null, rate, 150), 'USD unavailable');
  assert.equal(formatUsd(10n ** 18n, null, 150), 'USD unavailable');
});
await test('invalid or stale USD references leave valid ETH totals intact', () => {
  for (const invalid of [
    { ...rate, expiresAt: 150 },
    { ...rate, quotedAt: 151 },
    { ...rate, microUsdPerEth: 0n },
    { ...rate, sourceLabel: '' },
    { ...rate, expiresAt: 60101 },
  ])
    assert.equal(formatUsd(1n, invalid, 150), 'USD unavailable');
  assert.equal(
    calculateLaunchCosts(quote(), selection, 150).total?.totalWei,
    900n,
  );
});
await test('high gas warning uses an explicit network-only threshold', () => {
  assert.equal(highGasNotice(HIGH_NETWORK_FEE_WEI - 1n), null);
  assert.match(highGasNotice(HIGH_NETWORK_FEE_WEI)!, /0.01 ETH warning level/);
  assert.match(highGasNotice(HIGH_NETWORK_FEE_WEI)!, /waiting/);
});

await test('timer scheduling rejects epoch, future, invalid and oversized time windows', () => {
  assert.equal(costRefreshDelay(quote(), null, 50, 150), 0);
  assert.equal(costRefreshDelay(quote(), null, 150, 150), 50);
  assert.equal(costRefreshDelay(quote(), null, 150, 201), 0);
  assert.equal(costRefreshDelay(quote(), null, 201, 201), null);
  assert.equal(
    costRefreshDelay(
      { ...quote(), quotedAt: Date.now(), expiresAt: Date.now() + 10000 },
      null,
      100,
      100,
    ),
    null,
  );
  assert.equal(
    costRefreshDelay({ ...quote(), expiresAt: Infinity }, null, 100, 100),
    null,
  );
  assert.equal(
    costRefreshDelay({ ...quote(), expiresAt: 40000 }, null, 100, 100),
    null,
  );
});

await test('an incomplete network estimate preserves fully checked sibling launch amounts', () => {
  const input = quote();
  input.pads[1].steps[0].network = {
    chainId: 4663,
    gasUnits: 100n,
  } as NetworkEstimate;
  const result = calculateLaunchCosts(input, selection, 150);
  assert.equal(result.pads.long?.totalWei, 200n);
  assert.equal(result.pads.o1, undefined);
  assert.equal(result.total, null);
});
