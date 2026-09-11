import { toHex, keccak256, encodeAbiParameters, getCreate2Address, sha256, toBytes, parseAbi, decodeFunctionData, encodeFunctionResult } from 'viem';
import { O1_LAUNCH_ABI, O1_BASE_ABI, o1LaunchRoles, buildUnsignedO1Launch, predictO1B20Address } from '../web/lib/long-encoding/o1-launch.mjs';
import { o1Metadata } from '../web/lib/long-encoding/o1-metadata.mjs';
const address = n => toHex(BigInt(n), { size: 20 }), code = '0x6001', pin = n => ({ address: address(n), codeHash: keccak256(code) });
export function o1Fixture(chainId = 4663, stock = false) {
  const base = chainId === 8453, profile = { chainId, launchpad: 'o1', ...Object.fromEntries(o1LaunchRoles(chainId).map((r, i) => [r, pin(i + 1)])), quotes: [{ id: 'native', token: null, decimals: 18 }] };
  if (stock) {
    const token = base ? { address: `0xb2${'00'.repeat(10)}${'1'.padStart(18, '0')}` } : pin(99);
    profile.quotes = [{ id: base ? `rwa-${sha256(toBytes(`8453:${token.address}`)).slice(2, 26)}` : 'crypto-USDG', token, decimals: base ? 8 : 6 }];
  }
  const baseFeeOracle = pin(125), published = { ipfs: { imageCid: 'bafkreigh2akiscaildc5c5eqkhg5lgfzjuojautmsnb47nbqtwnhx4qyhi' } };
  const input = { chainId, wallet: address(700), draft: { name: 'Sample', ticker: 'SAMPLE', description: '' }, pairId: profile.quotes[0].id };
  const initCodeHash = keccak256('0x6002');
  function planFor(nextInput = input, publication = published, id = 'a'.repeat(64)) {
    const buildInput = { wallet: nextInput.wallet, draft: nextInput.draft, pairId: nextInput.pairId, metadataUri: o1Metadata(nextInput.draft, publication.ipfs.imageCid).uri,
      editableMetadata: nextInput.editableMetadata ?? false, configVersion: '1', totalSupply: String(10n ** 27n), launchpadFeeWei: '100', intentId: id,
      chainDeadline: Math.floor(Date.now() / 1000) + 1800, ...(!base ? { initCodeHash } : {}) };
    const built = buildUnsignedO1Launch(buildInput, profile), now = Date.now();
    return { ...built, buildInput, id, chainId, o1MetadataVersion: 1, tickSpacing: 60, predictedPool: toHex(10n, { size: 32 }), quotedAt: now, expiresAt: now + 30000,
      transaction: { ...built.transaction, chainId: toHex(chainId), gas: toHex(30000n), gasPrice: toHex(1n), nonce: toHex(0n) }, estimatedGas: '25000', launchpadFeeWei: '100', maximumGasWei: base ? '31400' : '30000',
      ...(base ? { baseFees: { l1DataFeeWei: '1200', operatorFeeWei: '200' } } : {}) };
  }
  const plan = planFor(), changes = {}, calls = [];
  const abi = [...O1_LAUNCH_ABI, ...O1_BASE_ABI, ...parseAbi(['function getL1Fee(bytes) view returns (uint256)', 'function getOperatorFee(uint256) view returns (uint256)'])];
  const rpc = { request: async ({ method, params = [] }) => {
    calls.push({ method, params });
    if (Object.hasOwn(changes, method)) return changes[method];
    if (method === 'eth_chainId') return toHex(chainId);
    if (method === 'eth_getBlockByNumber') return { timestamp: toHex(Math.floor(Date.now() / 1000)) };
    if (method === 'eth_getTransactionCount') return toHex(0);
    if (method === 'eth_getBalance') return toHex(10n ** 18n);
    if (method === 'eth_getCode') return [...o1LaunchRoles(chainId).map(r => profile[r].address), baseFeeOracle.address, ...(!base && stock ? [profile.quotes[0].token.address] : [])].includes(params[0].toLowerCase()) ? code : '0x';
    if (method === 'eth_call') {
      const { functionName, args } = decodeFunctionData({ abi, data: params[0].data });
      let result;
      if (Object.hasOwn(changes, functionName)) result = changes[functionName];
      else if (functionName === 'createLaunch') {
        const salt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [params[0].from, args[0].creatorSalt]));
        result = [base ? predictO1B20Address(profile.launcher.address, salt) : getCreate2Address({ from: profile.tokenDeployer.address, salt, bytecodeHash: initCodeHash }), plan.predictedPool];
      } else if (functionName === 'isB20Initialized') result = stock && args[0] === profile.quotes[0].token.address;
      else if (functionName === 'getB20Address') result = predictO1B20Address(args[1], args[2]);
      else result = { configVersion: 1n, launchSupply: 10n ** 27n, nativeLaunchFee: 100n, launchCreationEnabled: true, quoteConfig: [true, profile.quotes[0].decimals, 0], TOKEN_ADDRESS_SUFFIX: 1,
        hook: profile.hook.address, announcementRegistry: profile.announcementRegistry.address, feeEscrow: profile.feeEscrow.address, tickSpacing: 60,
        tokenDeployer: profile.tokenDeployer?.address, factory: profile.launcher.address, launchTokenValidator: profile.launchTokenValidator?.address,
        launchTokenBytecodeHash: initCodeHash, isActivated: true, isB20Initialized: false, getL1Fee: 1000n, getOperatorFee: 200n }[functionName];
      return encodeFunctionResult({ abi, functionName, result });
    }
    throw new Error(`Unexpected fixture RPC: ${method}`);
  } };
  return { profile, baseFeeOracle, published, input, plan, planFor, rpc, changes, calls };
}
