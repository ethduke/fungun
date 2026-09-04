import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  toHex,
} from "viem";
import {
  TrackedPrices,
  parsePriceRegistry,
  poolPrice,
  poolStateSlot,
  validatePriceInput,
  verifiedPoolKey,
} from "./tracked-prices.mjs";
import { validateInput } from "./service.mjs";

const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const manager = address(900);
const quote = address(1);
const stable = address(800);
const abi = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "function extsload(bytes32[] slots) view returns (bytes32[] values)",
]);
const types = (names) => names.map((type) => ({ type }));
const word = (sqrt = 1n << 96n, tick = 0) =>
  toHex(sqrt | (BigInt.asUintN(24, BigInt(tick)) << 160n), { size: 32 });
const pool = (n) => {
  const token = address(n + 10);
  const key = [quote, token, 0x800000, 8, address(0)];
  const id = keccak256(
    encodeAbiParameters(types(["address", "address", "uint24", "int24", "address"]), key),
  );
  const log = {
    address: manager,
    removed: false,
    topics: encodeEventTopics({
      abi,
      eventName: "Initialize",
      args: { id, currency0: quote, currency1: token },
    }),
    data: encodeAbiParameters(types(["uint24", "int24", "address", "uint160", "int24"]), [
      key[2],
      key[3],
      key[4],
      1n << 96n,
      0,
    ]),
  };
  return {
    row: { pool: id, meme: token, sym: `T${n}`, version: "v4", total_in: 11, quote_kind: "eth" },
    input: { pool: id, token, version: "v4" },
    log,
  };
};
const registry = {
  schemaVersion: 4,
  project: "o1 Launchpad",
  environment: "production",
  chains: [
    {
      chainId: 4663,
      uniswapV4: { poolManager: manager },
      quotes: [{ address: stable, symbol: "USDG" }],
    },
  ],
};

function fixture() {
  let now = 1000;
  const pools = Array.from({ length: 10 }, (_, n) => pool(n));
  const state = {
    rows: pools.map((item) => item.row),
    word: word(),
    logsFail: false,
    wrongChain: false,
    methods: [],
    market: [],
    units: 0,
  };
  const upstream = {
    async json(provider, url, options, _maxBytes, units = 1) {
      if (provider === "market") {
        state.market.push(url);
        return url.endsWith("production-deployments.json") ? registry : { pools: state.rows };
      }
      assert.equal(provider, "rpc");
      state.units += units;
      const calls = JSON.parse(options.body);
      return calls.map((call) => {
        state.methods.push(call.method);
        let result;
        if (call.method === "eth_chainId") result = toHex(state.wrongChain ? 1 : 4663);
        else if (call.method === "eth_getCode") result = `0x${"60".repeat(200)}`;
        else if (call.method === "eth_getLogs") {
          if (state.logsFail) throw new Error("synthetic private provider error");
          const filter = call.params[0];
          assert.equal(filter.address, manager);
          assert.equal(filter.fromBlock, "0x0");
          assert.equal(filter.toBlock, "latest");
          result = pools
            .filter((item) => filter.topics[1].includes(item.input.pool))
            .map((item) => item.log);
        } else if (call.method === "eth_call") {
          assert.equal(call.params[0].to, manager);
          const decoded = decodeFunctionData({ abi, data: call.params[0].data });
          assert.equal(decoded.functionName, "extsload");
          assert.ok(decoded.args[0].length <= 10);
          result = encodeFunctionResult({
            abi,
            functionName: "extsload",
            result: decoded.args[0].map(() => state.word),
          });
        } else assert.fail(`unexpected method ${call.method}`);
        return { jsonrpc: "2.0", id: call.id, result };
      });
    },
  };
  const testUrl = "https://rpc.example.invalid";
  const prices = new TrackedPrices({ readsEnabled: true, rpcUrl: testUrl }, upstream, () => now);
  return {
    prices,
    state,
    pools,
    upstream,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("price input is limited to ten exact V4 tuples with no RPC targets or calldata", () => {
  const input = { pools: [pool(1).input] };
  assert.deepEqual(validateInput("tracked-prices", input), input);
  for (const bad of [
    null,
    {},
    { pools: [] },
    { ...input, url: "https://other.invalid" },
    { pools: [input.pools[0], input.pools[0]] },
    { pools: Array(11).fill(input.pools[0]) },
    { pools: [{ ...input.pools[0], data: "0x" }] },
    { pools: [{ ...input.pools[0], version: "v3" }] },
  ])
    assert.throws(() => validatePriceInput(bad));
});

test("verified Initialize keys and raw slot0 prices preserve token orientation", () => {
  const item = pool(1);
  const key = verifiedPoolKey(item.log, manager, item.input.pool);
  assert.deepEqual(key, { currency0: quote, currency1: item.input.token });
  assert.equal(verifiedPoolKey({ ...item.log, removed: true }, manager, item.input.pool), null);
  assert.equal(
    verifiedPoolKey({ ...item.log, address: address(901) }, manager, item.input.pool),
    null,
  );
  assert.equal(verifiedPoolKey(item.log, manager, pool(2).input.pool), null);
  assert.equal(poolPrice(word(2n << 96n), key, quote).value, 4);
  assert.equal(poolPrice(word(2n << 96n), key, item.input.token).value, 0.25);
  assert.equal(poolPrice(word(0n), key, item.input.token), null);
  assert.equal(poolPrice(word(1n << 96n, -887273), key, item.input.token), null);
  assert.equal(poolPrice(word(), key, address(999)), null);
  assert.equal(
    poolStateSlot(item.input.pool),
    keccak256(encodeAbiParameters(types(["bytes32", "uint256"]), [item.input.pool, 6n])),
  );
  assert.equal(parsePriceRegistry(registry).manager, manager);
  assert.throws(() => parsePriceRegistry({ ...registry, schemaVersion: 3 }));
});

test("concurrent and reordered viewers share one slot batch and preserve cached timestamps", async () => {
  const { prices, state, pools, advance } = fixture();
  const input = { pools: pools.map((item) => item.input) };
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, n) =>
      prices.list({ pools: n % 2 ? [...input.pools].reverse() : input.pools }),
    ),
  );
  assert.ok(responses.every((response) => response.prices.length === 10));
  assert.deepEqual(state.methods, ["eth_chainId", "eth_getCode", "eth_getLogs", "eth_call"]);
  assert.equal(state.units, 4);
  assert.equal(state.market.length, 2);
  const baseline = responses[0].prices[0];
  advance(119999);
  assert.deepEqual((await prices.list(input)).prices[0], baseline);
  advance(1);
  state.word = word(2n << 96n);
  const fresh = await prices.list(input);
  assert.equal(fresh.prices[0].value, 0.25);
  assert.equal(fresh.prices[0].observedAt - baseline.observedAt, 120000);
  assert.equal(state.methods.filter((method) => method === "eth_call").length, 2);
  assert.equal(state.methods.filter((method) => method === "eth_getLogs").length, 1);
  assert.equal(state.market.length, 2, "cached admission needs no repeat public feed lookup");
});

test("client-selected unknown, subthreshold or stable tokens cannot trigger RPC", async () => {
  const { prices, state, pools } = fixture();
  state.rows = [
    { ...pools[0].row, total_in: 10 },
    { ...pools[1].row, meme: stable },
    { ...pools[2].row, chain_id: 1 },
  ];
  const input = {
    pools: [pools[0].input, { ...pools[1].input, token: stable }, pools[2].input, pools[3].input],
  };
  assert.deepEqual(await prices.list(input), { prices: [] });
  assert.deepEqual(state.methods, []);
});

test("metadata failure is negatively cached without log-range splitting or frequent retries", async () => {
  const { prices, state, pools, advance } = fixture();
  state.logsFail = true;
  const input = { pools: [pools[0].input] };
  await assert.rejects(prices.list(input));
  for (let n = 0; n < 5; n++) {
    advance(120000);
    assert.deepEqual(await prices.list(input), { prices: [] });
  }
  assert.equal(state.methods.filter((method) => method === "eth_getLogs").length, 1);
  assert.equal(state.methods.filter((method) => method === "eth_call").length, 0);
});

test("wrong chain and disabled upstream reads cannot produce prices", async () => {
  const { prices, state, pools, upstream } = fixture();
  const input = { pools: [pools[0].input] };
  state.wrongChain = true;
  await assert.rejects(prices.list(input), { code: "contract_unverified" });
  assert.deepEqual(state.methods, ["eth_chainId", "eth_getCode"]);
  const disabled = new TrackedPrices({ readsEnabled: false }, upstream);
  assert.deepEqual(await disabled.list(input), { prices: [] });
  assert.deepEqual(state.methods, ["eth_chainId", "eth_getCode"]);
});

test("a departed viewer cannot start later RPC stages", async () => {
  const { prices, state, pools, upstream } = fixture();
  const original = upstream.json.bind(upstream);
  let active = true;
  upstream.json = async (...args) => {
    const result = await original(...args);
    if (args[1].endsWith("/api")) active = false;
    return result;
  };
  await assert.rejects(prices.list({ pools: [pools[0].input] }, { shouldContinue: () => active }), {
    code: "busy",
  });
  assert.deepEqual(state.methods, []);
  assert.equal(prices.demands.size, 0);
});

test("slow cold setup stops before starting RPC stages beyond the overall deadline", async (t) => {
  const { prices, state, pools, upstream } = fixture();
  let elapsed = 0;
  t.mock.method(performance, "now", () => elapsed);
  const original = upstream.json.bind(upstream);
  upstream.json = async (...args) => {
    const result = await original(...args);
    elapsed += 5000;
    return result;
  };
  await assert.rejects(prices.list({ pools: [pools[0].input] }), { code: "busy" });
  assert.deepEqual(state.methods, ["eth_chainId", "eth_getCode"]);
  assert.equal(prices.pending, null);
  assert.equal(prices.metadata.size, 0, "a skipped log query is not a metadata failure");
});
