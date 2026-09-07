import { encodeFunctionData, isAddress, keccak256, parseAbi, sha256, toBytes, toHex, zeroAddress } from 'viem';
import { normalizeLaunchDetails, validatePublishedUri } from './launch-metadata.mjs';
import { ServiceError } from './errors.mjs';

export const STONKS_SUPPLY = 10n ** 27n;
export const STONKS_ROLES = ['launcher', 'locker', 'registry', 'positionManager', 'factory', 'tokenDeployer'];
const params = '(string name,string symbol,uint256 totalSupply,address quote,uint256 devBuyQuote,uint256 minDevBuyTokens,bytes32 userSalt,uint256 maxLaunchFeeWei,address feeRecipient)';
const meta = '(string image,string banner,string description,string website,string twitter,string telegram)';
export const STONKS_ABI = parseAbi([
  `function launchWithMeta(${params} p,${meta} meta) payable returns (address token,uint256 tokenId)`,
  'function predictTokenAddress(string name,string symbol,uint256 supply,address creator,bytes32 userSalt) view returns (address)',
  'function feeLocker() view returns (address)', 'function quoteRegistry() view returns (address)',
  'function npm() view returns (address)', 'function factory() view returns (address)',
  'function launcher() view returns (address)', 'function launchFeeWei() view returns (uint256)',
  'function enforcedSupply() view returns (uint256)', 'function LAUNCH_FEE_TIER() view returns (uint24)',
  'function platformFeeBps() view returns (uint256)', 'function lpFeeBps() view returns (uint256)',
  'function pendingFeeSplit() view returns (uint16 platformBps,uint16 lpBps,uint64 executeAfter)',
  'function allQuotes() view returns (address[])',
  'function quotes(address) view returns (bool enabled,uint8 decimals,int24 launchTickMagnitude,bool isB20,string symbol)',
  'function previewSync(address) view returns (bool fresh,int24 derived,int24 anchor,bool wouldUpdate,uint256 priceUsd1e18)',
  'function targetMcapUsd() view returns (uint256)',
  'function name() view returns (string)', 'function symbol() view returns (string)',
  'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allTokensLength() view returns (uint256)', 'function allTokens(uint256) view returns (address)',
  'function tokenInfo(address) view returns (address token,address creator,address pool,address quote,uint256 tokenId,uint24 fee,uint256 createdAt)',
  'function getPool(address,address,uint24) view returns (address)',
  'function positionsOf(address) view returns (uint256[])',
  'function positionsInfo(uint256) view returns (address creator,bool active,address quote)',
  'function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)',
  'function ownerOf(uint256) view returns (address)',
  'function tokenCreator(address) view returns (address)', 'function tokenQuote(address) view returns (address)',
  'function splitsOf(address) view returns ((address to,uint256 bps)[])',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) returns (uint256 amount0,uint256 amount1)',
  'function collectAll(address token)', 'function claim(address token)',
  'function claimable(address payee,address token) view returns (uint256)',
  'function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)',
  'function getOperatorFee(uint256 gasUsed) view returns (uint256)',
  'event TokenLaunched(address indexed token,uint256 indexed tokenId,address indexed creator,address quote,address pool,uint24 fee,int24 launchTick,uint256 totalSupply,address feeLocker)',
  'event TokenMetaSet(address indexed token,address indexed creator,string image,string banner,string description,string website,string twitter,string telegram)',
  'event PayoutClaimed(address indexed to,address indexed token,uint256 amount)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
export const stonksPairId = address => `stonks-${sha256(toBytes(`8453:${address.toLowerCase()}`)).slice(2, 26)}`;
const address = value => typeof value === 'string' && isAddress(value) && value.toLowerCase() !== zeroAddress;
const hash = value => typeof value === 'string' && /^0x[a-f0-9]{64}$/i.test(value) && !/^0x0+$/.test(value);
const fail = () => { throw new ServiceError('invalid_stonks_launch', 400); };
export function readStonksProfile(value) {
  if (!value || value.chainId !== 8453 || value.launchpad !== 'stonks'
    || Object.keys(value).sort().join(',') !== ['chainId', 'launchpad', ...STONKS_ROLES, 'quotes'].sort().join(',')) fail();
  for (const role of STONKS_ROLES) {
    const p = value[role], proxy = ['launcher', 'locker'].includes(role);
    if (!p || Object.keys(p).sort().join(',') !== (proxy ? 'address,codeHash,implementation,implementationCodeHash' : 'address,codeHash')
      || !address(p.address) || !hash(p.codeHash) || (proxy && (!address(p.implementation) || !hash(p.implementationCodeHash)))) fail();
  }
  if (!Array.isArray(value.quotes) || !value.quotes.length || value.quotes.length > 128
    || value.quotes.some(q => !q || Object.keys(q).sort().join(',') !== 'decimals,id,symbol,token'
      || !address(q.token) || q.id !== stonksPairId(q.token) || !/^[A-Za-z0-9._-]{1,24}$/.test(q.symbol)
      || !Number.isInteger(q.decimals) || q.decimals < 0 || q.decimals > 18)
    || new Set(value.quotes.map(q => q.id)).size !== value.quotes.length) fail();
  return { chainId: 8453, launchpad: 'stonks', launcher: value.launcher, locker: value.locker, registry: value.registry, positionManager: value.positionManager, factory: value.factory, tokenDeployer: value.tokenDeployer, ...Object.fromEntries(STONKS_ROLES.map(role => [role,
    Object.fromEntries(Object.entries(value[role]).map(([k, v]) => [k, v.toLowerCase()]))])),
    quotes: value.quotes.map(q => ({ ...q, token: q.token.toLowerCase() })) };
}

export function stonksSalt(intentId) {
  if (typeof intentId !== 'string' || !/^[a-f0-9]{64}$/.test(intentId)) fail();
  return keccak256(toBytes(`fungun:stonks:8453:${intentId}`));
}
export function buildUnsignedStonksLaunch(input, rawProfile) {
  const profile = readStonksProfile(rawProfile), draft = normalizeLaunchDetails(input.draft);
  const quote = profile.quotes.find(q => q.id === input.pairId);
  if (!quote || draft.launchpad || !address(input.wallet) || !address(input.predictedAsset)
    || typeof input.launchpadFeeWei !== 'string' || !/^(0|[1-9][0-9]{0,16})$/.test(input.launchpadFeeWei)
    || BigInt(input.launchpadFeeWei) > 5n * 10n ** 16n) fail();
  const image = validatePublishedUri(input.imageUri, 'image');
  const metadataUri = validatePublishedUri(input.metadataUri, 'metadata');
  const p = { name: draft.name, symbol: draft.ticker, totalSupply: STONKS_SUPPLY, quote: quote.token,
    devBuyQuote: 0n, minDevBuyTokens: 0n, userSalt: stonksSalt(input.intentId),
    maxLaunchFeeWei: BigInt(input.launchpadFeeWei), feeRecipient: input.wallet };
  const metadata = { image, banner: '', description: draft.description, website: '', twitter: '', telegram: '' };
  const transaction = { from: input.wallet.toLowerCase(), to: profile.launcher.address,
    data: encodeFunctionData({ abi: STONKS_ABI, functionName: 'launchWithMeta', args: [p, metadata] }), value: toHex(p.maxLaunchFeeWei) };
  const review = { name: draft.name, ticker: draft.ticker, pairId: quote.id, metadataUri, imageUri: image,
    totalSupply: STONKS_SUPPLY.toString(), tokensForSale: STONKS_SUPPLY.toString(), metadataMutable: false,
    creator: transaction.from, feeRecipient: transaction.from, devBuyQuote: '0', liquidityLocked: true, tradingFeeBps: 100 };
  const predictedAsset = input.predictedAsset.toLowerCase();
  const binding = sha256(toBytes(JSON.stringify(['fungun:stonks:1', profile, transaction, review, predictedAsset]))).slice(2);
  return { binding, profile, transaction, predictedAsset, saltAttempt: 0, review };
}
