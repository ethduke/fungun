import {
  encodeAbiParameters,
  encodeFunctionData,
  getCreate2Address,
  isAddress,
  keccak256,
  sha256,
  parseAbi,
  parseAbiParameters,
  toBytes,
  zeroAddress,
} from "viem";
import { ServiceError } from "./errors.mjs";
import { normalizeLaunchDetails, validatePublishedUri } from "./launch-metadata.mjs";

export const LONG_CREATE_ABI = parseAbi([
  "function create((uint256 initialSupply,uint256 numTokensToSell,address numeraire,address tokenFactory,bytes tokenFactoryData,address governanceFactory,bytes governanceFactoryData,address poolInitializer,bytes poolInitializerData,address liquidityMigrator,bytes liquidityMigratorData,address integrator,bytes32 salt) createData) returns (address asset,address pool,address governance,address timelock,address migrationPool)",
]);
export const LONG_TOKEN_PARAMETERS = parseAbiParameters(
  "string name,string symbol,(uint64 cliff,uint64 duration)[] schedules,address[] beneficiaries,uint256[] scheduleIds,uint256[] amounts,string tokenURI,uint256 maxBalanceLimit,uint48 balanceLimitEnd,address controller,address[] excludedFromBalanceLimit",
);
export const LONG_POOL_PARAMETERS = parseAbiParameters(
  "(uint24 fee,int24 tickSpacing,int24 farTick,(int24 tickLower,int24 tickUpper,uint16 numPositions,uint256 shares)[] curves,(address beneficiary,uint96 shares)[] beneficiaries,address dopplerHook,bytes onInitializationDopplerHookCalldata,bytes graduationDopplerHookCalldata)",
);
export const LONG_HOOK_PARAMETERS = parseAbiParameters(
  "address numeraire,address buybackDestination,uint256 startFee,uint256 endFee,uint256 duration,uint256 startingTime,uint256 routingMode,uint256 assetFeesToAssetBuybackWad,uint256 assetFeesToNumeraireBuybackWad,uint256 assetFeesToBeneficiaryWad,uint256 assetFeesToLpWad,uint256 numeraireFeesToAssetBuybackWad,uint256 numeraireFeesToNumeraireBuybackWad,uint256 numeraireFeesToBeneficiaryWad,uint256 numeraireFeesToLpWad",
);

const roles = [
  "launcher",
  "airlock",
  "tokenFactory",
  "governanceFactory",
  "poolInitializer",
  "liquidityMigrator",
  "dopplerHook",
];
const supply = 10n ** 27n;
const width = 110432;

function exactObject(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function address(value) {
  return typeof value === "string" && isAddress(value) && value.toLowerCase() !== zeroAddress;
}
function hash(value) {
  return typeof value === "string" && /^0x[\da-f]{64}$/i.test(value) && !/^0x0+$/i.test(value);
}
function contract(value, factory = false) {
  return (
    exactObject(
      value,
      factory ? ["address", "codeHash", "initCodeHash"] : ["address", "codeHash"],
    ) &&
    address(value.address) &&
    hash(value.codeHash) &&
    (!factory || hash(value.initCodeHash))
  );
}

export function readLongLaunchProfile(value) {
  if (
    !exactObject(value, ["chainId", ...roles, "integrator", "protocolBeneficiary", "quotes"]) ||
    value.chainId !== 4663 ||
    roles.some((role) => !contract(value[role], role === "tokenFactory")) ||
    !address(value.integrator) ||
    !address(value.protocolBeneficiary) ||
    new Set(roles.map((role) => value[role].address.toLowerCase())).size !== roles.length ||
    !Array.isArray(value.quotes) ||
    value.quotes.length < 1 ||
    value.quotes.length > 100
  )
    throw new ServiceError("invalid_long_launch_profile");
  const quotes = value.quotes.map((quote) => {
    if (
      !exactObject(quote, ["id", "token", "oracle", "decimals", "oracleDecimals"]) ||
      typeof quote.id !== "string" ||
      !/^(?:long-[A-Z0-9._-]{1,24}|rwa-[a-f\d]{24})$/.test(quote.id) ||
      !contract(quote.token) ||
      !contract(quote.oracle) ||
      quote.decimals !== 18 ||
      quote.oracleDecimals !== 8 ||
      quote.token.address.toLowerCase() === quote.oracle.address.toLowerCase()
    )
      throw new ServiceError("invalid_long_launch_profile");
    return Object.freeze({
      id: quote.id,
      token: normalizeContract(quote.token),
      oracle: normalizeContract(quote.oracle),
      decimals: 18,
      oracleDecimals: 8,
    });
  });
  if (
    new Set(quotes.map((quote) => quote.id)).size !== quotes.length ||
    new Set(quotes.map((quote) => quote.token.address)).size !== quotes.length
  )
    throw new ServiceError("invalid_long_launch_profile");
  return Object.freeze({
    chainId: 4663,
    ...Object.fromEntries(roles.map((role) => [role, normalizeContract(value[role])])),
    integrator: value.integrator.toLowerCase(),
    protocolBeneficiary: value.protocolBeneficiary.toLowerCase(),
    quotes: Object.freeze(quotes),
  });
}

function normalizeContract(value) {
  return Object.freeze({
    address: value.address.toLowerCase(),
    codeHash: value.codeHash.toLowerCase(),
    ...(value.initCodeHash ? { initCodeHash: value.initCodeHash.toLowerCase() } : {}),
  });
}

function mineSalt(profile, quote, binding) {
  for (let attempt = 0; attempt < 1024; attempt += 1) {
    const salt = keccak256(toBytes(JSON.stringify(["fungun:long:1", binding, attempt])));
    const predictedAsset = getCreate2Address({
      from: profile.tokenFactory.address,
      salt,
      bytecodeHash: profile.tokenFactory.initCodeHash,
    });
    if (BigInt(predictedAsset) < BigInt(quote.token.address)) return { salt, predictedAsset };
  }
  throw new ServiceError("long_salt_unavailable");
}

export function buildUnsignedLongLaunch(input, configuredProfile, publicOrigin) {
  const profile = readLongLaunchProfile(configuredProfile);
  if (
    !exactObject(input, [
      "chainId",
      "wallet",
      "draft",
      "pairId",
      "metadataUri",
      "startingTick",
      "intentId",
    ]) ||
    input.chainId !== 4663 ||
    !address(input.wallet) ||
    input.wallet.toLowerCase() === profile.protocolBeneficiary ||
    !Number.isInteger(input.startingTick) ||
    input.startingTick % 8 !== 0 ||
    input.startingTick < -887272 ||
    input.startingTick + width >= 887264 ||
    typeof input.intentId !== "string" ||
    !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(input.intentId)
  )
    throw new ServiceError("invalid_long_launch", 400);
  const quote = profile.quotes.find((entry) => entry.id === input.pairId);
  if (!quote) throw new ServiceError("unsupported_pair", 400);
  const draft = normalizeLaunchDetails(input.draft);
  const metadataUri = validatePublishedUri(input.metadataUri, "metadata", publicOrigin);
  const wallet = input.wallet.toLowerCase();
  const binding = sha256(toBytes(
      JSON.stringify([
        profile,
        wallet,
        draft,
        quote.id,
        metadataUri,
        input.startingTick,
        input.intentId,
      ]),
    )).slice(2);
  const { salt, predictedAsset } = mineSalt(profile, quote, binding);
  const tokenFactoryData = encodeAbiParameters(LONG_TOKEN_PARAMETERS, [
    draft.name,
    draft.ticker,
    [{ cliff: 0n, duration: 0n }],
    [],
    [],
    [],
    metadataUri,
    0n,
    0,
    zeroAddress,
    [],
  ]);
  const hook = encodeAbiParameters(LONG_HOOK_PARAMETERS, [
    quote.token.address,
    profile.integrator,
    800000n,
    11200n,
    10n,
    0n,
    0n,
    0n,
    714285714285714286n,
    0n,
    285714285714285714n,
    142857142857142857n,
    714285714285714286n,
    0n,
    142857142857142857n,
  ]);
  const beneficiaries = [
    { beneficiary: profile.protocolBeneficiary, shares: 5n * 10n ** 16n },
    { beneficiary: wallet, shares: 95n * 10n ** 16n },
  ].sort((left, right) => (left.beneficiary < right.beneficiary ? -1 : 1));
  const poolInitializerData = encodeAbiParameters(LONG_POOL_PARAMETERS, [
    {
      fee: 1000,
      tickSpacing: 8,
      farTick: 887256,
      curves: [
        {
          tickLower: input.startingTick,
          tickUpper: input.startingTick + width,
          numPositions: 1,
          shares: 991n * 10n ** 15n,
        },
        {
          tickLower: input.startingTick + width,
          tickUpper: 887264,
          numPositions: 1,
          shares: 9n * 10n ** 15n,
        },
      ],
      beneficiaries,
      dopplerHook: profile.dopplerHook.address,
      onInitializationDopplerHookCalldata: hook,
      graduationDopplerHookCalldata: "0x",
    },
  ]);
  const data = encodeFunctionData({
    abi: LONG_CREATE_ABI,
    functionName: "create",
    args: [
      {
        initialSupply: supply,
        numTokensToSell: supply,
        numeraire: quote.token.address,
        tokenFactory: profile.tokenFactory.address,
        tokenFactoryData,
        governanceFactory: profile.governanceFactory.address,
        governanceFactoryData: "0x",
        poolInitializer: profile.poolInitializer.address,
        poolInitializerData,
        liquidityMigrator: profile.liquidityMigrator.address,
        liquidityMigratorData: "0x",
        integrator: profile.integrator,
        salt,
      },
    ],
  });
  return Object.freeze({
    status: "requires_verification",
    binding,
    predictedAsset,
    transaction: Object.freeze({
      chainId: 4663,
      from: wallet,
      to: profile.launcher.address,
      value: "0",
      data,
    }),
    review: Object.freeze({
      name: draft.name,
      ticker: draft.ticker,
      pairId: quote.id,
      metadataUri,
      totalSupply: supply.toString(),
      tokensForSale: supply.toString(),
      creatorAllocation: "0",
      metadataMutable: false,
      launchpadValueWei: "0",
    }),
  });
}

export function assertUnsignedLongTransaction(transaction, input, configuredProfile, publicOrigin) {
  const expected = buildUnsignedLongLaunch(input, configuredProfile, publicOrigin).transaction;
  if (
    !exactObject(transaction, Object.keys(expected)) ||
    Object.keys(expected).some((key) => transaction[key] !== expected[key])
  )
    throw new ServiceError("long_transaction_changed", 400);
  return true;
}
