import { createHmac, randomBytes } from "node:crypto";
import { encodeFunctionData, serializeTransaction, zeroAddress } from "viem";
import { ServiceError } from "./errors.mjs";
import { ReadCache } from "./upstream.mjs";
import { FeeRpc, rpcNumber } from "./fee-rpc.mjs";
import {
  beneficiaryFees,
  escrowAbi,
  managerAbi,
  oracleAbi,
  poolId,
  sameAddress,
  uint,
  validAddress,
} from "./fee-contracts.mjs";

const O1_ORIGIN = "https://api.launch.o1.exchange";
const TTL = 45_000;
const view = (address, abi, functionName, args, from) => ({
  address,
  abi,
  functionName,
  args,
  from,
});

export function parseO1Positions(body, address, chainId) {
  if (
    !Array.isArray(body?.data) ||
    body.data.length > 25 ||
    typeof body?.pagination?.has_more !== "boolean"
  )
    throw new ServiceError("invalid_response");
  const positions = new Map();
  for (const item of body.data) {
    if (
      !item ||
      item.chain_id !== chainId ||
      !sameAddress(item.recipient, address) ||
      !validAddress(item.fee_escrow_address) ||
      !validAddress(item.currency?.address, true) ||
      !["confirmed", "pending", "unavailable"].includes(item.reconciliation)
    )
      throw new ServiceError("invalid_response");
    const currency = item.currency.address.toLowerCase();
    const native = sameAddress(currency, zeroAddress);
    const matches = [item.currency.quote, item.currency.token].filter(
      (entry) => entry && sameAddress(entry.address, currency),
    );
    const metadata = matches[0];
    if (
      matches.some(
        (entry) =>
          entry.symbol !== metadata.symbol ||
          entry.decimals !== metadata.decimals ||
          (entry.chain_id !== undefined && entry.chain_id !== chainId),
      )
    )
      throw new ServiceError("invalid_response");
    if (
      !native &&
      (!metadata ||
        !sameAddress(metadata.address, currency) ||
        !Number.isInteger(metadata.decimals) ||
        metadata.decimals < 0 ||
        metadata.decimals > 36 ||
        !/^[A-Za-z0-9._-]{1,24}$/.test(metadata.symbol))
    )
      throw new ServiceError("invalid_response");
    const position = {
      kind: "o1",
      address,
      chainId,
      target: item.fee_escrow_address.toLowerCase(),
      payouts: [
        {
          asset: currency,
          symbol: native ? "ETH" : metadata.symbol,
          decimals: native ? 18 : metadata.decimals,
          claimableRaw: uint(item.claimable_raw).toString(),
        },
      ],
      verification: "indexed",
      claimable: false,
    };
    const key = `${position.target}:${currency}`;
    const previous = positions.get(key);
    if (previous && JSON.stringify(previous.payouts) !== JSON.stringify(position.payouts))
      throw new ServiceError("invalid_response");
    positions.set(key, position);
  }
  return { positions: [...positions.values()], partial: body.pagination.has_more };
}

export class Fees {
  constructor(config, upstream, now = Date.now, rpc = new FeeRpc(config, upstream, now)) {
    this.config = config;
    this.upstream = upstream;
    this.now = now;
    this.rpc = rpc;
    this.cache = new ReadCache(now, 64);
    this.preflights = new ReadCache(now, 32);
    this.handles = new Map();
    this.key = randomBytes(32);
  }

  remember(position) {
    const identity = [
      position.address,
      position.chainId,
      position.kind,
      position.target,
      position.poolId ?? position.payouts[0].asset,
    ];
    const id = createHmac("sha256", this.key).update(JSON.stringify(identity)).digest("hex");
    this.handles.delete(id);
    while (this.handles.size >= 256) this.handles.delete(this.handles.keys().next().value);
    this.handles.set(id, { position, expires: this.now() + 120_000 });
    return {
      id,
      target: position.target,
      payouts: position.payouts,
      verification: position.verification,
      claimable: position.claimable,
    };
  }

  async list(input) {
    const { address, chainId, padId } = input;
    const unavailable = {
      ...input,
      status: "unavailable",
      reason: "not_configured",
      positions: [],
      expiresAt: this.now() + TTL,
    };
    if (!this.config.feesEnabled) return unavailable;
    if (
      (padId === "o1" && !this.config.o1Key) ||
      (padId === "long" && (!this.config.rpcUrl || !this.config.feeContracts.long?.pools.length))
    )
      return unavailable;
    return this.cache.get(`fees:${JSON.stringify(input)}`, TTL, async () => {
      const result = padId === "o1" ? await this.o1(address, chainId) : await this.long(address);
      return {
        ...input,
        status: result.partial ? "partial" : "ready",
        checkedAt: this.now(),
        expiresAt: this.now() + TTL,
        positions: result.positions.map((position) => this.remember(position)),
      };
    });
  }

  async o1(address, chainId) {
    const url = new URL(`/v1/wallets/${address}/fee-claims`, O1_ORIGIN);
    url.search = new URLSearchParams({
      chain_id: String(chainId),
      market: "all",
      state: "all",
      limit: "25",
    }).toString();
    const result = parseO1Positions(
      await this.upstream.json(
        "o1",
        url,
        { headers: { "x-api-key": this.config.o1Key } },
        256 * 1024,
        3,
      ),
      address,
      chainId,
    );
    const verified = result.positions
      .filter(
        (position) =>
          chainId === 8453 &&
          this.config.baseRpcUrl &&
          this.config.feeContracts.o1.some((profile) =>
            sameAddress(profile.escrow, position.target),
          ),
      )
      .slice(0, 4);
    if (verified.length) {
      const profiles = [...new Set(verified.map((position) => position.target))].map((target) => {
        const profile = this.config.feeContracts.o1.find((entry) =>
          sameAddress(entry.escrow, target),
        );
        return { address: target, codeHash: profile.codeHash };
      });
      const block = await this.rpc.block(chainId);
      await this.rpc.verify(chainId, profiles, false, block);
      const amounts = await this.rpc.calls(
        chainId,
        verified.map((position) =>
          view(position.target, escrowAbi, "owed", [address, position.payouts[0].asset]),
        ),
        block,
      );
      verified.forEach((position, index) => {
        position.payouts[0].claimableRaw = amounts[index].toString();
        position.verification = "live";
        position.claimable =
          this.config.claimsEnabled && !!this.config.feeContracts.baseOracle && amounts[index] > 0n;
      });
    }
    return {
      ...result,
      partial:
        result.partial || result.positions.some((position) => position.verification !== "live"),
    };
  }

  async long(address) {
    const profile = this.config.feeContracts.long;
    const block = await this.rpc.block(4663);
    await this.rpc.verify(
      4663,
      [
        { address: profile.manager, codeHash: profile.managerCodeHash },
        { address: profile.hook, codeHash: profile.hookCodeHash },
      ],
      false,
      block,
    );
    const positions = [];
    for (const pool of profile.pools) positions.push(await this.longPosition(address, pool, block));
    return { positions, partial: true };
  }

  async longPosition(address, pool, block) {
    const profile = this.config.feeContracts.long;
    const id = poolId(pool, profile.manager);
    const stateCall = view(profile.manager, managerAbi, "getState", [pool.asset]);
    const calls = [
      stateCall,
      view(profile.manager, managerAbi, "getShares", [id, address]),
      ...["getCumulatedFees0", "getCumulatedFees1"].map((name) =>
        view(profile.manager, managerAbi, name, [id]),
      ),
      ...["getLastCumulatedFees0", "getLastCumulatedFees1"].map((name) =>
        view(profile.manager, managerAbi, name, [id, address]),
      ),
      view(profile.manager, managerAbi, "collectFees", [id], address),
    ];
    const [state, shares, cumulative0, cumulative1, last0, last1, collected] = await this.rpc.calls(
      4663,
      calls,
      block,
    );
    const [numeraire, , hook, , status, key] = state;
    if (
      status !== 2 ||
      !sameAddress(hook, profile.hook) ||
      !sameAddress(key.hooks, profile.manager) ||
      !sameAddress(key.currency0, pool.currency0.address) ||
      !sameAddress(key.currency1, pool.currency1.address) ||
      key.fee !== pool.fee ||
      key.tickSpacing !== pool.tickSpacing ||
      !sameAddress(
        numeraire,
        sameAddress(pool.asset, key.currency0) ? key.currency1 : key.currency0,
      )
    )
      throw new ServiceError("contract_unverified");
    const amounts = [
      beneficiaryFees(cumulative0, collected[0], last0, shares),
      beneficiaryFees(cumulative1, collected[1], last1, shares),
    ];
    return {
      kind: "long",
      address,
      chainId: 4663,
      target: profile.manager,
      poolId: id,
      pool,
      verification: "live",
      claimable: this.config.claimsEnabled && shares > 0n && amounts.some((amount) => amount > 0n),
      payouts: [pool.currency0, pool.currency1].map((currency, index) => ({
        asset: currency.address,
        symbol: currency.symbol,
        decimals: currency.decimals,
        claimableRaw: amounts[index].toString(),
      })),
    };
  }

  async prepare({ address, positionId }) {
    if (!this.config.feesEnabled || !this.config.claimsEnabled)
      throw new ServiceError("not_configured");
    const handle = this.handles.get(positionId);
    if (!handle || handle.expires <= this.now() || !sameAddress(handle.position.address, address))
      throw new ServiceError("quote_expired", 409);
    if (!handle.position.claimable) throw new ServiceError("contract_unverified", 409);
    return this.preflights.get(`claim:${address}:${positionId}`, 10_000, async () => {
      let position = handle.position;
      const chainId = position.chainId;
      const block = await this.rpc.block(chainId);
      let data;
      if (position.kind === "long") {
        const profile = this.config.feeContracts.long;
        await this.rpc.verify(
          chainId,
          [
            { address: profile.manager, codeHash: profile.managerCodeHash },
            { address: profile.hook, codeHash: profile.hookCodeHash },
          ],
          true,
          block,
        );
        position = await this.longPosition(address, position.pool, block);
        data = encodeFunctionData({
          abi: managerAbi,
          functionName: "collectFees",
          args: [position.poolId],
        });
      } else {
        const profile = this.config.feeContracts.o1.find(
          (entry) => chainId === 8453 && sameAddress(entry.escrow, position.target),
        );
        const oracle = this.config.feeContracts.baseOracle;
        if (!profile || !oracle) throw new ServiceError("contract_unverified", 409);
        await this.rpc.verify(
          chainId,
          [{ address: profile.escrow, codeHash: profile.codeHash }, oracle],
          true,
          block,
        );
        const [owed] = await this.rpc.calls(
          chainId,
          [view(profile.escrow, escrowAbi, "owed", [address, position.payouts[0].asset])],
          block,
        );
        position = {
          ...position,
          payouts: [{ ...position.payouts[0], claimableRaw: owed.toString() }],
        };
        data = encodeFunctionData({
          abi: escrowAbi,
          functionName: "claimFor",
          args: [address, position.payouts[0].asset],
        });
      }
      if (!position.payouts.some((payout) => uint(payout.claimableRaw) > 0n) || !position.claimable)
        throw new ServiceError("nothing_to_claim", 409);
      const transaction = { from: address, to: position.target, data, value: "0x0" };
      const [gasHex, priceHex, balanceHex, nonceHex, simulation] = await this.rpc.batch(chainId, [
        { method: "eth_estimateGas", params: [transaction, block] },
        { method: "eth_gasPrice", params: [] },
        { method: "eth_getBalance", params: [address, "pending"] },
        ...(chainId === 8453
          ? [
              { method: "eth_getTransactionCount", params: [address, "pending"] },
              { method: "eth_call", params: [transaction, block] },
            ]
          : []),
      ]);
      if (
        chainId === 8453 &&
        (typeof simulation !== "string" || !/^0x(?:[\da-f]{2})*$/i.test(simulation))
      )
        throw new ServiceError("invalid_response");
      const gas = rpcNumber(gasHex);
      const gasLimit = (gas * 120n + 99n) / 100n;
      const gasPrice = rpcNumber(priceHex);
      if (gas < 21_000n || gasLimit > 3_000_000n || gasPrice === 0n)
        throw new ServiceError("gas_limit", 409);
      let l1 = 0n,
        operator = 0n,
        operatorBudget = 0n;
      if (chainId === 8453) {
        const oracle = this.config.feeContracts.baseOracle;
        const nonce = rpcNumber(nonceHex);
        if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new ServiceError("invalid_response");
        const encoded = serializeTransaction({
          chainId,
          type: "legacy",
          nonce: Number(nonce),
          to: position.target,
          data,
          value: 0n,
          gas: gasLimit,
          gasPrice,
        });
        [l1, operator, operatorBudget] = await this.rpc.calls(
          chainId,
          [
            view(oracle.address, oracleAbi, "getL1Fee", [encoded]),
            view(oracle.address, oracleAbi, "getOperatorFee", [gas]),
            view(oracle.address, oracleAbi, "getOperatorFee", [gasLimit]),
          ],
          block,
        );
      }
      const estimatedWei = gas * gasPrice + l1 + operator;
      const budgetWei = gasLimit * gasPrice + (l1 * 120n + 99n) / 100n + operatorBudget;
      if (rpcNumber(balanceHex) < budgetWei) throw new ServiceError("insufficient_funds", 409);
      return {
        positionId,
        kind: position.kind,
        chainId,
        address,
        target: position.target,
        data,
        poolId: position.poolId,
        payouts: position.payouts,
        value: "0",
        gas: gasLimit.toString(),
        gasPrice: gasPrice.toString(),
        estimatedWei: estimatedWei.toString(),
        budgetWei: budgetWei.toString(),
        l1FeeWei: l1.toString(),
        operatorFeeWei: operator.toString(),
        expiresAt: this.now() + 20_000,
      };
    });
  }
}
