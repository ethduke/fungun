import { encodeAbiParameters, encodeFunctionData, getCreate2Address, isAddress, keccak256, parseAbi, parseAbiParameters, sha256, toBytes, zeroAddress } from 'viem';
import { LONG_CREATE_ABI, LONG_POOL_PARAMETERS, LONG_TOKEN_PARAMETERS } from './long-launch.mjs';
import { normalizeLaunchDetails, validatePublishedUri } from './launch-metadata.mjs';
import { getMaxLiquiditySafeMulticurveTickUpper } from './stonx-math.mjs';
import { ServiceError } from './errors.mjs';

export const STONX_SUPPLY = 10n ** 27n;
export const STONX_ROLES = ['launcher', 'tokenFactory', 'tokenImplementation', 'governanceFactory', 'poolInitializer', 'liquidityMigrator', 'dopplerHook', 'poolManager'];
export const STONX_TICKERS = Object.freeze('NKE MCD GRND MSTR TSLA COIN SPYM SIVR CRCL NVDA IAU PPLT AMZN BMNR SGOV QQQM VWO ARKK SPCX CEG DRAM TSM SKHY ASML MU AMD AVGO AMAT LRCX TTWO RKLB GOOGL AAPL MSFT LLY INTC HOOD ORCL SMCI BABA TQQQ DNUT PLBY TR WEN'.split(' '));
export const STONX_BANDS = Object.freeze([[1, 2, 6, 2873], [2, 4, 6, 2032], [4, 8, 6, 1437], [8, 16, 6, 1016], [16, 32, 6, 718], [32, 1000, 12, 1424], [1000, 'max', 4, 500]]);
export const STONX_HOOK_PARAMETERS = parseAbiParameters('(address numeraire,address buybackDst,uint24 startFee,uint24 endFee,uint32 durationSeconds,uint32 startingTime,uint8 feeRoutingMode,(uint256 assetFeesToAssetBuybackWad,uint256 assetFeesToNumeraireBuybackWad,uint256 assetFeesToBeneficiaryWad,uint256 assetFeesToLpWad,uint256 numeraireFeesToAssetBuybackWad,uint256 numeraireFeesToNumeraireBuybackWad,uint256 numeraireFeesToBeneficiaryWad,uint256 numeraireFeesToLpWad) feeDistributionInfo,(address beneficiary,uint96 shares)[] feeBeneficiaries)');
export const STONX_ABI = [...LONG_CREATE_ABI, ...parseAbi([
  'function owner() view returns (address)',
  'function airlock() view returns (address)',
  'function poolManager() view returns (address)',
  'function implementation() view returns (address)',
  'function getModuleState(address) view returns (uint8)',
  'function getAssetData(address) view returns (address numeraire,address timelock,address governance,address liquidityMigrator,address poolInitializer,address pool,address migrationPool,uint256 numTokensToSell,uint256 totalSupply,address integrator)',
  'function getState(address) view returns (address numeraire,uint256 totalTokensOnBondingCurve,address dopplerHook,bytes graduationDopplerHookCalldata,uint8 status,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,int24 farTick)',
  'function getShares(bytes32,address) view returns (uint256)',
  'function name() view returns (string)', 'function symbol() view returns (string)',
  'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)',
  'function tokenURI() view returns (string)',
  'event Create(address asset,address indexed numeraire,address initializer,address poolOrHook)',
])];
const fail = () => { throw new ServiceError('invalid_stonx_launch', 400); };
const address = v => typeof v === 'string' && isAddress(v) && v.toLowerCase() !== zeroAddress;
const hash = v => typeof v === 'string' && /^0x[a-f0-9]{64}$/i.test(v) && !/^0x0+$/i.test(v);
const exact = (v, keys) => v && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys.sort().join(',');
export const stonxPairId = token => `stonx-${sha256(toBytes(`8453:${token.toLowerCase()}`)).slice(2, 26)}`;
// The stock wrapper is an immutable-beacon proxy. Its bytecode binds the beacon;
// the beacon's current implementation is checked separately at preparation.
export function stonxWrapperBytecode(beacon) {
  if (!address(beacon)) fail();
  return '0x' + `608060405261000c61000e565b005b61001e610019610020565b6100b3565b565b5f7f${beacon.toLowerCase().slice(2).padStart(64, '0')}73ffffffffffffffffffffffffffffffffffffffff16635c60da1b6040518163ffffffff1660e01b8152600401602060405180830381865afa15801561008a573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906100ae91906100d1565b905090565b365f80375f80365f845af43d5f803e8080156100cd573d5ff35b3d5ffd5b5f602082840312156100e1575f80fd5b815173ffffffffffffffffffffffffffffffffffffffff81168114610104575f80fd5b939250505056`;
}
export const stonxWrapperCodeHash = beacon => keccak256(stonxWrapperBytecode(beacon));
export function readStonxProfile(p) {
  if (!exact(p, ['chainId', 'launchpad', ...STONX_ROLES, 'integrator', 'protocolBeneficiary', 'quotes'])
    || p.chainId !== 8453 || p.launchpad !== 'stonx' || !address(p.integrator) || !address(p.protocolBeneficiary)
    || STONX_ROLES.some(r => !exact(p[r], ['address', 'codeHash']) || !address(p[r].address) || !hash(p[r].codeHash))
    || !Array.isArray(p.quotes) || !p.quotes.length || p.quotes.length > 128) fail();
  const quotes = p.quotes.map(q => {
    if (!exact(q, ['id', 'token', 'symbol', 'decimals', 'beacon', 'implementation'])
      || ['token', 'beacon', 'implementation'].some(r => !exact(q[r], ['address', 'codeHash']) || !address(q[r].address) || !hash(q[r].codeHash))
      || q.token.codeHash.toLowerCase() !== stonxWrapperCodeHash(q.beacon.address) || q.id !== stonxPairId(q.token.address)
      || !STONX_TICKERS.some(t => q.symbol === `wt${t}`) || q.decimals !== 18) fail();
    return { ...q, ...Object.fromEntries(['token', 'beacon', 'implementation'].map(r => [r, { address: q[r].address.toLowerCase(), codeHash: q[r].codeHash.toLowerCase() }])) };
  });
  if (new Set(quotes.map(q => q.id)).size !== quotes.length || new Set(quotes.map(q => q.symbol)).size !== quotes.length) fail();
  return { chainId: 8453, launchpad: 'stonx', launcher: p.launcher, tokenFactory: p.tokenFactory, tokenImplementation: p.tokenImplementation, governanceFactory: p.governanceFactory, poolInitializer: p.poolInitializer, liquidityMigrator: p.liquidityMigrator, dopplerHook: p.dopplerHook, poolManager: p.poolManager, ...Object.fromEntries(STONX_ROLES.map(r => [r, { address: p[r].address.toLowerCase(), codeHash: p[r].codeHash.toLowerCase() }])),
    integrator: p.integrator.toLowerCase(), protocolBeneficiary: p.protocolBeneficiary.toLowerCase(), quotes };
}
export function stonxTick(cap, price) {
  if (!Number.isFinite(price) || price < 0.000001 || price > 10000000) fail();
  const tick = -Math.floor(Math.log(price / (cap / 1e9)) / Math.log(1.0001) / 10) * 10;
  if (tick < -887270 || tick > 887270) fail();
  return tick === 0 ? 0 : tick;
}
export function stonxCurves(price) {
  return STONX_BANDS.map(([start, end, numPositions, bps]) => {
    const tickLower = stonxTick(5000 * start, price), shares = BigInt(bps) * 10n ** 14n;
    const tickUpper = end === 'max' ? getMaxLiquiditySafeMulticurveTickUpper({ tickLower, tickUpper: 887270, tickSpacing: 10,
      numPositions, curveSupply: STONX_SUPPLY * shares / 10n ** 18n }) : stonxTick(5000 * end, price);
    return { tickLower, tickUpper, numPositions, shares };
  });
}
export function stonxBeneficiaries(entries) {
  const merged = new Map();
  for (const [recipient, shares] of entries) merged.set(recipient.toLowerCase(), (merged.get(recipient.toLowerCase()) ?? 0n) + shares);
  return [...merged].sort(([a], [b]) => a < b ? -1 : 1).map(([beneficiary, shares]) => ({ beneficiary, shares }));
}
export function stonxSalt(profile, quote, intentId, attempt = 0) {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= 200000) fail();
  const bytecodeHash = keccak256('0x' + `602c3d8160093d39f33d3d3d3d363d3d37363d73${profile.tokenImplementation.address.slice(2)}5af43d3d93803e602a57fd5bf3`);
  for (let i = attempt; i < 200000; i++) {
    const salt = keccak256(toBytes(`fungun:stonx:8453:${intentId}:${i}`));
    const predictedAsset = getCreate2Address({ from: profile.tokenFactory.address, salt, bytecodeHash }).toLowerCase();
    if (BigInt(predictedAsset) < BigInt(quote.token.address)) return { salt, predictedAsset, saltAttempt: i };
  }
  fail();
}
export function buildUnsignedStonxLaunch(input, rawProfile, saltAttempt) {
  const p = readStonxProfile(rawProfile), draft = normalizeLaunchDetails(input.draft), q = p.quotes.find(q => q.id === input.pairId);
  if (!q || !address(input.wallet) || draft.launchpad || !/^[a-f0-9]{64}$/.test(input.intentId)
    || typeof input.quotePriceUsd !== 'string' || !/^(?:0|[1-9]\d{0,7})(?:\.\d{1,12})?$/.test(input.quotePriceUsd)) fail();
  const wallet = input.wallet.toLowerCase(), metadataUri = validatePublishedUri(input.metadataUri, 'metadata');
  const price = Number(input.quotePriceUsd), curves = stonxCurves(price), mined = stonxSalt(p, q, input.intentId, saltAttempt);
  const WAD = 10n ** 18n;
  const beneficiaries = stonxBeneficiaries([[p.protocolBeneficiary, WAD * 5n / 100n], [p.integrator, WAD * 285n / 1000n], [wallet, WAD * 665n / 1000n]]);
  const feeBeneficiaries = stonxBeneficiaries([[p.integrator, WAD * 3n / 10n], [wallet, WAD * 7n / 10n]]);
  const hook = encodeAbiParameters(STONX_HOOK_PARAMETERS, [{ numeraire: q.token.address, buybackDst: p.integrator,
    startFee: 800000, endFee: 10000, durationSeconds: 10, startingTime: 0, feeRoutingMode: 1,
    feeDistributionInfo: { assetFeesToAssetBuybackWad: 0n, assetFeesToNumeraireBuybackWad: WAD, assetFeesToBeneficiaryWad: 0n, assetFeesToLpWad: 0n,
      numeraireFeesToAssetBuybackWad: 0n, numeraireFeesToNumeraireBuybackWad: 0n, numeraireFeesToBeneficiaryWad: WAD, numeraireFeesToLpWad: 0n }, feeBeneficiaries }]);
  const params = { initialSupply: STONX_SUPPLY, numTokensToSell: STONX_SUPPLY, numeraire: q.token.address,
    tokenFactory: p.tokenFactory.address, tokenFactoryData: encodeAbiParameters(LONG_TOKEN_PARAMETERS, [draft.name, draft.ticker, [], [], [], [], metadataUri, 0n, 0, zeroAddress, []]),
    governanceFactory: p.governanceFactory.address, governanceFactoryData: '0x', poolInitializer: p.poolInitializer.address,
    poolInitializerData: encodeAbiParameters(LONG_POOL_PARAMETERS, [{ fee: 500, tickSpacing: 10, farTick: stonxTick(100000, price), curves, beneficiaries,
      dopplerHook: p.dopplerHook.address, onInitializationDopplerHookCalldata: hook, graduationDopplerHookCalldata: '0x' }]),
    liquidityMigrator: p.liquidityMigrator.address, liquidityMigratorData: '0x', integrator: p.integrator, salt: mined.salt };
  const transaction = { from: wallet, to: p.launcher.address, data: encodeFunctionData({ abi: LONG_CREATE_ABI, functionName: 'create', args: [params] }), value: '0x0' };
  const review = { name: draft.name, ticker: draft.ticker, pairId: q.id, metadataUri, totalSupply: STONX_SUPPLY.toString(), tokensForSale: STONX_SUPPLY.toString(),
    creatorAllocation: '0', metadataMutable: false, launchpadValueWei: '0', creator: wallet, feeRecipient: wallet, quotePriceUsd: input.quotePriceUsd,
    openingMarketCapUsd: 5000, tradingFeeBps: 105, creatorShareBps: 6650, liquidityLocked: true };
  const poolKey = { currency0: mined.predictedAsset, currency1: q.token.address, fee: 500, tickSpacing: 10, hooks: p.poolInitializer.address };
  const predictedPool = keccak256(encodeAbiParameters(parseAbiParameters('(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'), [poolKey]));
  const binding = sha256(toBytes(JSON.stringify(['fungun:stonx:1', p, transaction, review, mined.predictedAsset, predictedPool]))).slice(2);
  return { binding, profile: p, transaction, review, ...mined, predictedPool };
}
