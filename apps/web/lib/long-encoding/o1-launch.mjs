import { encodeAbiParameters, encodeFunctionData, getCreate2Address, isAddress, keccak256, parseAbi, sha256, toBytes, toHex, zeroAddress } from 'viem';
import { ServiceError } from './errors.mjs';
import { normalizeLaunchDetails, validatePublishedUri } from './launch-metadata.mjs';

export const O1_PARAMS = '(string tokenName,string tokenSymbol,string tokenContractURI,bytes32 creatorSalt,address quoteToken,uint64 expectedConfigVersion,uint64 deadline,bool metadataEditable,string[] metadataKeys,string[] metadataValues)';
export const O1_LAUNCH_ABI = parseAbi([
  `function createLaunch(${O1_PARAMS} launchParams) payable returns (address token,bytes32 poolId)`,
  `function launchTokenBytecodeHash(${O1_PARAMS} launchParams) view returns (bytes32)`,
  'function configVersion() view returns (uint64)', 'function launchSupply() view returns (uint256)',
  'function nativeLaunchFee() view returns (uint256)', 'function launchCreationEnabled() view returns (bool)',
  'function quoteConfig(address) view returns (bool registered,uint8 quoteDecimals,int24 startTickToken0Frame)',
  'function TOKEN_ADDRESS_SUFFIX() view returns (uint8)', 'function tokenDeployer() view returns (address)',
  'function hook() view returns (address)', 'function announcementRegistry() view returns (address)',
  'function factory() view returns (address)', 'function feeEscrow() view returns (address)',
  'function tickSpacing() view returns (int24)',
  'function creatorRights(address) view returns ((address originalCreator,address currentCreator,address pendingCreator,address creatorFeeRecipient,bytes32 poolId,bool metadataEditable))',
  'function contractURI() view returns (string)', 'function name() view returns (string)',
  'function symbol() view returns (string)', 'function totalSupply() view returns (uint256)',
  'function metadataAuthority() view returns (address)',
  'event Launched(address indexed token,bytes32 indexed poolId,address indexed originalCreator,address quoteToken,uint256 launchSupply,int24 tickSpacing)',
]);
const roles = ['launcher', 'tokenDeployer', 'hook', 'feeEscrow', 'announcementRegistry'];
const baseRoles = ['launcher', 'launchTokenValidator', 'hook', 'feeEscrow', 'announcementRegistry'];
// Base protocol precompiles, not launchpad deployment addresses.
export const B20_FACTORY = toHex(0xb20fn << 144n, { size: 20 });
export const B20_ACTIVATION = toHex((0x8453n << 144n) | 1n, { size: 20 });
export const O1_BASE_ABI = parseAbi([
  'function launchTokenValidator() view returns (address)',
  'function getB20Address(uint8 variant,address sender,bytes32 salt) view returns (address)',
  'function isB20Initialized(address token) view returns (bool)',
  'function isActivated(bytes32 feature) view returns (bool)',
  'function validate(address token,address creator,address factory,address hook,uint256 supply,bool metadataEditable) view',
]);
export const o1LaunchRoles = chainId => chainId === 8453 ? baseRoles : roles;
export const isB20Asset = address => typeof address === 'string' && /^0xb200000000000000000000[a-f0-9]{18}$/i.test(address);
export function predictO1B20Address(factory, scopedSalt) {
  const digest = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [factory, scopedSalt]));
  return `0xb200000000000000000000${digest.slice(2, 20)}`;
}
const hash = value => typeof value === 'string' && /^0x[a-f0-9]{64}$/i.test(value) && !/^0x0+$/.test(value);
const contract = value => value && Object.keys(value).sort().join(',') === 'address,codeHash'
  && isAddress(value.address) && value.address.toLowerCase() !== zeroAddress && hash(value.codeHash);
const reject = () => { throw new ServiceError('invalid_o1_launch', 400); };
export function readO1LaunchProfile(value) {
  const selectedRoles = o1LaunchRoles(value?.chainId);
  const base = value?.chainId === 8453;
  const quoteToken = token => base ? token && Object.keys(token).join(',') === 'address' && isB20Asset(token.address) : contract(token);
  if (!value || ![4663, 8453].includes(value.chainId) || value.launchpad !== 'o1'
    || Object.keys(value).sort().join(',') !== ['chainId', 'launchpad', ...selectedRoles, 'quotes'].sort().join(',')
    || selectedRoles.some(role => !contract(value[role])) || !Array.isArray(value.quotes) || !value.quotes.length || value.quotes.length > 513
    || value.quotes.some(q => !q || Object.keys(q).sort().join(',') !== 'decimals,id,token' || !(base ? [8, 18] : [6, 18]).includes(q.decimals)
      || (q.id === 'native' ? q.token !== null || q.decimals !== 18 : !(base ? /^rwa-[a-f0-9]{24}$/ : /^(?:rwa-[a-f0-9]{24}|crypto-USDG)$/).test(q.id) || !quoteToken(q.token)))
    || (base && value.quotes.some(q => q.token && q.id !== `rwa-${sha256(toBytes(`8453:${q.token.address.toLowerCase()}`)).slice(2, 26)}`))
    || new Set(value.quotes.map(q => q.id)).size !== value.quotes.length) reject();
  return { chainId: value.chainId, launchpad: 'o1',
    ...Object.fromEntries(selectedRoles.map(role => [role, { address: value[role].address.toLowerCase(), codeHash: value[role].codeHash.toLowerCase() }])),
    quotes: value.quotes.map(q => ({ id: q.id, decimals: q.decimals, token: q.token ? { address: q.token.address.toLowerCase(), ...(!base ? { codeHash: q.token.codeHash.toLowerCase() } : {}) } : null })) };
}
export function o1Params(input, quote, creatorSalt = toHex(0n, { size: 32 })) {
  const draft = normalizeLaunchDetails(input.draft);
  if (draft.launchpad || typeof input.editableMetadata !== 'boolean') reject();
  return { tokenName: draft.name, tokenSymbol: draft.ticker,
    tokenContractURI: validatePublishedUri(input.metadataUri, 'metadata'), creatorSalt,
    quoteToken: quote.token?.address ?? zeroAddress, expectedConfigVersion: BigInt(input.configVersion),
    deadline: BigInt(input.chainDeadline), metadataEditable: input.editableMetadata, metadataKeys: [], metadataValues: [] };
}
export function buildUnsignedO1Launch(input, configuredProfile, saltAttempt) {
  const profile = readO1LaunchProfile(configuredProfile), quote = profile.quotes.find(q => q.id === input.pairId);
  if (!quote || !isAddress(input.wallet) || input.wallet.toLowerCase() === zeroAddress || (profile.chainId === 4663 && !hash(input.initCodeHash))
    || !/^[a-f0-9]{64}$/.test(input.intentId) || !/^\d{1,20}$/.test(input.configVersion)
    || BigInt(input.configVersion) < 1n || !Number.isSafeInteger(input.chainDeadline) || input.chainDeadline < 1
    || !/^\d{1,31}$/.test(input.totalSupply) || BigInt(input.totalSupply) < 10n ** 24n || BigInt(input.totalSupply) > 10n ** 30n
    || !/^\d{1,17}$/.test(input.launchpadFeeWei) || BigInt(input.launchpadFeeWei) > 5n * 10n ** 16n) reject();
  const params = o1Params(input, quote);
  const binding = sha256(toBytes(JSON.stringify(['fungun:o1:1', profile, input.wallet.toLowerCase(), normalizeLaunchDetails(input.draft), input.pairId, input.metadataUri, input.editableMetadata, input.configVersion, input.chainDeadline, input.totalSupply, input.launchpadFeeWei, input.intentId, input.initCodeHash]))).slice(2);
  const first = saltAttempt === undefined ? 0 : saltAttempt, last = saltAttempt === undefined ? 65536 : first + 1;
  if (!Number.isSafeInteger(first) || first < 0 || first >= 65536) reject();
  for (let attempt = first; attempt < last; attempt++) {
    const creatorSalt = `0x${binding.slice(0, 56)}${attempt.toString(16).padStart(8, '0')}`;
    const salt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [input.wallet, creatorSalt]));
    const predictedAsset = profile.chainId === 8453 ? predictO1B20Address(profile.launcher.address, salt)
      : getCreate2Address({ from: profile.tokenDeployer.address, salt, bytecodeHash: input.initCodeHash }).toLowerCase();
    if (!predictedAsset.endsWith('01')) continue;
    return { binding, predictedAsset, saltAttempt: attempt, profile,
      transaction: { from: input.wallet.toLowerCase(), to: profile.launcher.address,
        data: encodeFunctionData({ abi: O1_LAUNCH_ABI, functionName: 'createLaunch', args: [{ ...params, creatorSalt }] }), value: toHex(BigInt(input.launchpadFeeWei)) },
      review: { name: params.tokenName, ticker: params.tokenSymbol, pairId: input.pairId, metadataUri: params.tokenContractURI,
        totalSupply: input.totalSupply, tokensForSale: input.totalSupply, creatorAllocation: '0',
        metadataMutable: params.metadataEditable, launchpadValueWei: input.launchpadFeeWei } };
  }
  reject();
}
