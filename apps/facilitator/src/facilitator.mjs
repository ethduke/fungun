import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  hashDomain,
  http,
  keccak256,
  toHex,
} from "viem";
import { createCappedContractWriter } from "./gas-policy.mjs";
import { USDG_DECIMALS, USDG_NAME, USDG_VERSION, X402_NETWORK } from "./policy.mjs";

const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://invalid.local"] } },
});

const tokenAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "getFacet", stateMutability: "view", inputs: [{ name: "selector", type: "bytes4" }], outputs: [{ type: "address" }] },
];

const joinedHex = (...parts) => `0x${parts.join("")}`;
const IMPLEMENTATION_SLOT = toHex(
  BigInt(keccak256(toHex("eip1967.proxy.implementation"))) - 1n,
  { size: 32 },
);
const EXPECTED_PROXY_CODE_HASH = joinedHex(
  "864cc9ad53b338b82da1f7cab85ab0b3",
  "d5c8861acb422b6fec63cf36234f36a6",
);
const EXPECTED_IMPLEMENTATION = getAddress(
  joinedHex("68184c449e1a8f34fa18", "d289737129fd27b66f8f"),
);
const EXPECTED_IMPLEMENTATION_CODE_HASH = joinedHex(
  "3a551ac5c744af57e68a1d1431ac403c",
  "0f516ffd7d224a75746aee11fc4f3baf",
);
const EXPECTED_AUTH_FACET = getAddress(
  joinedHex("780d30b6a89bc9eef953", "a543aa288c3b05b01309"),
);
const EXPECTED_AUTH_FACET_CODE_HASH = joinedHex(
  "2512bf74f82939b5f4ac8f48057e4903",
  "fc53c894c7415228c3f4d5c8685a9f06",
);
const AUTHORIZATION_SELECTORS = ["0xe3ee160e", "0xcf092995", "0xe94a0102"];

async function assertPinnedUsdG(publicClient, asset) {
  const [chainId, bytecode, name, decimals, domainSeparator, implementationWord, ...facets] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBytecode({ address: asset }),
    publicClient.readContract({ address: asset, abi: tokenAbi, functionName: "name" }),
    publicClient.readContract({ address: asset, abi: tokenAbi, functionName: "decimals" }),
    publicClient.readContract({ address: asset, abi: tokenAbi, functionName: "DOMAIN_SEPARATOR" }),
    publicClient.getStorageAt({ address: asset, slot: IMPLEMENTATION_SLOT }),
    ...AUTHORIZATION_SELECTORS.map(selector =>
      publicClient.readContract({
        address: asset,
        abi: tokenAbi,
        functionName: "getFacet",
        args: [selector],
      }),
    ),
  ]);
  const expectedDomain = hashDomain({
    domain: {
      name: USDG_NAME,
      version: USDG_VERSION,
      chainId: robinhood.id,
      verifyingContract: asset,
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
  });
  if (!implementationWord || !/^0x[0-9a-f]{64}$/i.test(implementationWord))
    throw new Error("robinhood_usdg_configuration_mismatch");
  const implementation = getAddress(`0x${implementationWord.slice(-40)}`);
  if (
    chainId !== robinhood.id ||
    !bytecode ||
    bytecode === "0x" ||
    keccak256(bytecode).toLowerCase() !== EXPECTED_PROXY_CODE_HASH ||
    name !== USDG_NAME ||
    decimals !== USDG_DECIMALS ||
    domainSeparator.toLowerCase() !== expectedDomain.toLowerCase() ||
    implementation !== EXPECTED_IMPLEMENTATION ||
    facets.some(facet => getAddress(facet) !== EXPECTED_AUTH_FACET)
  )
    throw new Error("robinhood_usdg_configuration_mismatch");
  const [implementationCode, facetCode] = await Promise.all([
    publicClient.getBytecode({ address: implementation }),
    publicClient.getBytecode({ address: EXPECTED_AUTH_FACET }),
  ]);
  if (
    !implementationCode ||
    !facetCode ||
    keccak256(implementationCode).toLowerCase() !== EXPECTED_IMPLEMENTATION_CODE_HASH ||
    keccak256(facetCode).toLowerCase() !== EXPECTED_AUTH_FACET_CODE_HASH
  )
    throw new Error("robinhood_usdg_configuration_mismatch");
}

export async function createPrivateFacilitator(config) {
  const transport = http(config.rpcUrl, { retryCount: 0, timeout: 15_000 });
  const publicClient = createPublicClient({ chain: robinhood, transport });
  const walletClient = createWalletClient({ account: config.account, chain: robinhood, transport });
  await assertPinnedUsdG(publicClient, config.asset);

  const writeContract = createCappedContractWriter({
    publicClient,
    walletClient,
    account: config.account,
    asset: config.asset,
    payTo: config.payTo,
    maxAmount: config.maxAmount,
    beforeWrite: () => assertPinnedUsdG(publicClient, config.asset),
  });
  const signer = toFacilitatorEvmSigner(
    {
      address: config.account.address,
      getCode: args => publicClient.getCode(args),
      readContract: args => publicClient.readContract({ ...args, args: args.args || [] }),
      verifyTypedData: args => publicClient.verifyTypedData(args),
      writeContract,
      sendTransaction: async () => {
        throw new Error("raw_transaction_disabled");
      },
      waitForTransactionReceipt: args => publicClient.waitForTransactionReceipt(args),
    },
    { confirmationTimeoutMs: 20_000 },
  );
  const facilitator = new x402Facilitator().register(
    X402_NETWORK,
    new ExactEvmScheme(signer, {
      eip6492AllowedFactories: [],
      simulateInSettle: true,
    }),
  );
  return Object.freeze({
    facilitator,
    publicClient,
    relayerAddress: getAddress(config.account.address),
  });
}
