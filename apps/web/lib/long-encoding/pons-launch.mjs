import { encodeFunctionData, isAddress, parseAbi, sha256, toBytes, toHex, zeroAddress } from 'viem';
import { ServiceError } from './errors.mjs';
import { normalizeLaunchDetails, validatePublishedUri } from './launch-metadata.mjs';

// https://docs.ponsfamily.com/v2#launching — direct factory launch, no opening buy.
export const PONS_ROLES = ['launcher', 'launchDeployer', 'memeHook', 'feeEscrow', 'buybackVault', 'graduationExecutor', 'graduationGuard'];
export const PONS_ABI = parseAbi([
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }',
  'struct LaunchConfig { uint256 supply; uint256 curveFeeBps; uint256 phantomQuote; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; bool enabled; }',
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  'function launchToken(TokenParams params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)',
  'function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)',
  'function launchFee() view returns (uint256)',
  'function canLaunch(address) view returns (bool)',
  'function getLaunchConfig(uint256 id) view returns (LaunchConfig)',
  'function getLaunchedToken(address token) view returns (LaunchedToken)',
  'function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, Socials tokenSocials)',
  'function name() view returns (string)', 'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  ...PONS_ROLES.slice(1).map(role => `function ${role}() view returns (address)`),
  'event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)',
]);
const address = value => typeof value === 'string' && isAddress(value) && value.toLowerCase() !== zeroAddress;
const hash = value => typeof value === 'string' && /^0x[a-f0-9]{64}$/i.test(value) && !/^0x0+$/i.test(value);
const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n;
const reject = () => { throw new ServiceError('invalid_pons_launch', 400); };
export function readPonsLaunchProfile(value) {
  if (!value || value.chainId !== 4663 || value.launchpad !== 'pons' || !uint(value.launchConfigId)
    || Object.keys(value).sort().join(',') !== ['chainId', 'launchpad', 'launchConfigId', ...PONS_ROLES].sort().join(',')
    || PONS_ROLES.some(role => !value[role] || Object.keys(value[role]).sort().join(',') !== 'address,codeHash'
      || !address(value[role].address) || !hash(value[role].codeHash))) reject();
  return { chainId: 4663, launchpad: 'pons', launchConfigId: value.launchConfigId,
    ...Object.fromEntries(PONS_ROLES.map(role => [role, { address: value[role].address.toLowerCase(), codeHash: value[role].codeHash.toLowerCase() }])) };
}
export function buildUnsignedPonsLaunch(input, configuredProfile) {
  const profile = readPonsLaunchProfile(configuredProfile), draft = normalizeLaunchDetails(input.draft);
  if (!address(input.wallet) || draft.launchpad || input.pairId !== 'pons-native' || input.editableMetadata
    || !hash(input.expectedEconomics) || !/^[a-f0-9]{64}$/.test(input.intentId)
    || !uint(input.totalSupply) || BigInt(input.totalSupply) === 0n
    || !uint(input.launchpadFeeWei) || BigInt(input.launchpadFeeWei) > 5n * 10n ** 16n) reject();
  const imageUri = validatePublishedUri(input.imageUri, 'image');
  const metadataUri = validatePublishedUri(input.metadataUri, 'metadata');
  const wallet = input.wallet.toLowerCase();
  const binding = sha256(toBytes(JSON.stringify(['fungun:pons:1', profile, wallet, draft, imageUri, metadataUri,
    input.expectedEconomics, input.totalSupply, input.launchpadFeeWei, input.intentId]))).slice(2);
  const params = { name: draft.name, symbol: draft.ticker, logo: imageUri, description: draft.description,
    socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' }, creatorFeeRecipient: wallet,
    creatorTaxBps: 0, buybackEnabled: false, expectedEconomics: input.expectedEconomics, salt: `0x${input.intentId}` };
  return { binding, profile, transaction: { from: wallet, to: profile.launcher.address,
    data: encodeFunctionData({ abi: PONS_ABI, functionName: 'launchToken', args: [params, BigInt(profile.launchConfigId), zeroAddress] }),
    value: toHex(BigInt(input.launchpadFeeWei)) },
    review: { name: draft.name, ticker: draft.ticker, pairId: input.pairId, metadataUri,
      totalSupply: input.totalSupply, creatorAllocation: '0',
      metadataMutable: false, launchpadValueWei: input.launchpadFeeWei } };
}
