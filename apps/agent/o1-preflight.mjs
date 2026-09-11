import { decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, isAddress, keccak256, parseAbi, serializeTransaction, toBytes, toHex, zeroAddress } from 'viem';
import { B20_ACTIVATION, B20_FACTORY, O1_BASE_ABI, O1_LAUNCH_ABI, buildUnsignedO1Launch, o1LaunchRoles, o1Params, readO1LaunchProfile } from '../web/lib/long-encoding/o1-launch.mjs';
import { o1Metadata } from '../web/lib/long-encoding/o1-metadata.mjs';
const oracleAbi = parseAbi(['function getL1Fee(bytes) view returns (uint256)', 'function getOperatorFee(uint256) view returns (uint256)']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const check = (ok, code = 'launch_transaction_changed') => { if (!ok) throw new Error(code); };
export async function preflightO1(plan, input, published, trustedProfile, rpc, limits, baseFeeOracle) {
  const trusted = readO1LaunchProfile(trustedProfile), chainId = trusted.chainId, base = chainId === 8453;
  const p = readO1LaunchProfile({ ...trusted, quotes: trusted.quotes.filter(q => q.id === input.pairId) }), q = p.quotes[0];
  check(input.chainId === chainId && plan.chainId === chainId);
  check(JSON.stringify(readO1LaunchProfile(plan.profile)) === JSON.stringify(p), 'contract_unverified');
  check(Number.isSafeInteger(plan.quotedAt) && Number.isSafeInteger(plan.expiresAt) && plan.quotedAt <= Date.now() && Date.now() < plan.expiresAt && plan.expiresAt - plan.quotedAt === 30000, 'quote_expired');
  check(/^[a-f0-9]{64}$/.test(plan.id) && /^[a-f0-9]{64}$/.test(plan.binding) && plan.o1MetadataVersion === 1);
  check(plan.buildInput?.intentId === plan.id && Number.isInteger(plan.saltAttempt) && plan.saltAttempt >= 0 && plan.saltAttempt < 65536);
  const build = { ...plan.buildInput, wallet: input.wallet, draft: input.draft, pairId: input.pairId,
    metadataUri: o1Metadata(input.draft, published.ipfs.imageCid).uri, editableMetadata: input.editableMetadata ?? false };
  const rebuilt = buildUnsignedO1Launch(build, p, plan.saltAttempt), tx = plan.transaction;
  check(rebuilt.binding === plan.binding && same(rebuilt.predictedAsset, plan.predictedAsset) && JSON.stringify(rebuilt.review) === JSON.stringify(plan.review));
  check(tx && Object.keys(tx).sort().join(',') === 'chainId,data,from,gas,gasPrice,nonce,to,value');
  check(tx.chainId === toHex(chainId) && same(tx.from, input.wallet) && same(tx.to, rebuilt.transaction.to) && tx.data === rebuilt.transaction.data &&
    [tx.gas, tx.gasPrice, tx.nonce, tx.value].every(v => typeof v === 'string' && /^0x[0-9a-f]{1,64}$/i.test(v)) && BigInt(tx.value) === BigInt(rebuilt.transaction.value));
  const nonce = BigInt(tx.nonce), gas = BigInt(tx.gas), price = BigInt(tx.gasPrice), value = BigInt(tx.value);
  check(nonce <= BigInt(Number.MAX_SAFE_INTEGER), 'nonce_limit');
  let l1 = 0n, operator = 0n;
  if (base) {
    check(plan.baseFees && Object.keys(plan.baseFees).sort().join(',') === 'l1DataFeeWei,operatorFeeWei' && Object.values(plan.baseFees).every(v => typeof v === 'string' && /^(0|[1-9][0-9]{0,16})$/.test(v)), 'spend_limit');
    l1 = BigInt(plan.baseFees.l1DataFeeWei); operator = BigInt(plan.baseFees.operatorFeeWei);
  } else check(plan.baseFees === undefined, 'spend_limit');
  const maximumGas = gas * price + l1 + operator, cost = maximumGas + value;
  check(BigInt(plan.estimatedGas) >= 21000n && gas === (BigInt(plan.estimatedGas) * 120n + 99n) / 100n && gas <= 8000000n && gas <= BigInt(limits.maxGas) && price > 0n && price <= BigInt(limits.maxGasPriceWei) && price <= 10n ** 12n && cost <= BigInt(limits.maxTransactionWei) && cost <= 5n * 10n ** 16n && plan.maximumGasWei === String(maximumGas) && plan.launchpadFeeWei === String(value), 'spend_limit');
  const request = (method, params = []) => rpc.request({ method, params });
  const call = async (to, functionName, args = [], abi = O1_LAUNCH_ABI) => decodeFunctionResult({ abi, functionName, data: await request('eth_call', [{ to, data: encodeFunctionData({ abi, functionName, args }) }, 'latest']) });
  check(BigInt(await request('eth_chainId')) === BigInt(chainId), 'wrong_chain');
  if (base) check(baseFeeOracle && isAddress(baseFeeOracle.address) && !same(baseFeeOracle.address, zeroAddress) && /^0x[a-f0-9]{64}$/i.test(baseFeeOracle.codeHash), 'contract_unverified');
  for (const contract of [...o1LaunchRoles(chainId).map(r => p[r]), ...(!base && q.token ? [q.token] : []), ...(base ? [baseFeeOracle] : [])]) {
    const code = await request('eth_getCode', [contract.address, 'latest']);
    check(code && code !== '0x' && same(keccak256(code), contract.codeHash), 'contract_unverified');
  }
  for (const [target, method, expected] of [[p.launcher.address, 'hook', p.hook.address], [p.launcher.address, 'announcementRegistry', p.announcementRegistry.address], [p.hook.address, 'feeEscrow', p.feeEscrow.address], ...(base ? [[p.launcher.address, 'launchTokenValidator', p.launchTokenValidator.address]] : [[p.launcher.address, 'tokenDeployer', p.tokenDeployer.address], [p.tokenDeployer.address, 'factory', p.launcher.address]])])
    check(same(await call(target, method, [], method === 'launchTokenValidator' ? O1_BASE_ABI : O1_LAUNCH_ABI), expected), 'contract_unverified');
  check(await call(p.launcher.address, 'launchCreationEnabled') === true, 'o1_launch_disabled');
  const registered = await call(p.launcher.address, 'quoteConfig', [q.token?.address ?? zeroAddress]);
  check(registered[0] === true && Number(registered[1]) === q.decimals, 'contract_unverified');
  check(Number(await call(p.launcher.address, 'TOKEN_ADDRESS_SUFFIX')) === 1 && Number(await call(p.launcher.address, 'tickSpacing')) === plan.tickSpacing, 'contract_unverified');
  check(String(await call(p.launcher.address, 'configVersion')) === build.configVersion && String(await call(p.launcher.address, 'launchSupply')) === build.totalSupply && String(await call(p.launcher.address, 'nativeLaunchFee')) === build.launchpadFeeWei, 'launch_transaction_changed');
  const header = await request('eth_getBlockByNumber', ['latest', false]), timestamp = Number(BigInt(header.timestamp));
  check(Math.abs(Date.now() / 1000 - timestamp) <= 30 && build.chainDeadline > timestamp && build.chainDeadline <= timestamp + 1800, 'quote_expired');
  if (base) {
    check(await call(B20_ACTIVATION, 'isActivated', [keccak256(toBytes('base.b20_asset'))], O1_BASE_ABI) === true, 'contract_unverified');
    if (q.token) check(await call(B20_FACTORY, 'isB20Initialized', [q.token.address], O1_BASE_ABI) === true, 'contract_unverified');
    const params = decodeFunctionData({ abi: O1_LAUNCH_ABI, data: tx.data }).args[0];
    const salt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [input.wallet, params.creatorSalt]));
    check(same(await call(B20_FACTORY, 'getB20Address', [0, p.launcher.address, salt], O1_BASE_ABI), rebuilt.predictedAsset), 'contract_unverified');
    check(await call(B20_FACTORY, 'isB20Initialized', [rebuilt.predictedAsset], O1_BASE_ABI) === false, 'launch_already_exists');
    const encoded = serializeTransaction({ chainId, type: 'legacy', nonce: Number(nonce), to: tx.to, data: tx.data, value, gas, gasPrice: price });
    check(l1 >= (await call(baseFeeOracle.address, 'getL1Fee', [encoded], oracleAbi) * 120n + 99n) / 100n && operator >= await call(baseFeeOracle.address, 'getOperatorFee', [gas], oracleAbi), 'spend_limit');
  } else {
    check(same(await call(p.launcher.address, 'launchTokenBytecodeHash', [o1Params(build, q)]), build.initCodeHash), 'contract_unverified');
    check(await request('eth_getCode', [rebuilt.predictedAsset, 'latest']) === '0x', 'launch_already_exists');
  }
  check(await request('eth_getCode', [input.wallet, 'latest']) === '0x', 'launch_eoa_required');
  check(BigInt(await request('eth_getTransactionCount', [input.wallet, 'pending'])) === nonce, 'nonce_changed');
  check(BigInt(await request('eth_getBalance', [input.wallet, 'pending'])) >= cost, 'insufficient_funds');
  const simulated = decodeFunctionResult({ abi: O1_LAUNCH_ABI, functionName: 'createLaunch', data: await request('eth_call', [tx, 'pending']) });
  check(same(simulated[0], rebuilt.predictedAsset) && same(simulated[1], plan.predictedPool) && !/^0x0+$/.test(simulated[1]), 'launch_simulation_failed');
  check(Date.now() < plan.expiresAt, 'quote_expired');
  return cost;
}
