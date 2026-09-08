import { StonksFees } from './stonks-fees.mjs';
import { PonsFees } from "./pons-fees.mjs";
import { createHmac, randomBytes } from "node:crypto";
import { encodeFunctionData, serializeTransaction, zeroAddress } from "viem";
import { ServiceError } from "./errors.mjs";
import { ReadCache, withinReadDeadline } from "./upstream.mjs";
import { FeeRpc, rpcNumber } from "./fee-rpc.mjs";
import { FeeUsd } from "./fee-usd.mjs";
import { discoverLongFeePools } from "./long-fee-discovery.mjs";
import {
  beneficiaryFees,
  escrowAbi,
  legacyEscrowAbi,
  isLockedPoolPad,
  managerAbi,
  oracleAbi,
  poolId,
  sameAddress,
  uint,
  validAddress,
} from "./fee-contracts.mjs";

const O1_ORIGIN = "https://api.launch.o1.exchange";
const TTL = 45_000;
const HANDLE_TTL = 30 * 60_000;
const O1_PAGE_SIZE = 8;
const LONG_PAGE_SIZE = 2;
const view = (address, abi, functionName, args, from) => ({
  address,
  abi,
  functionName,
  args,
  from,
});

const profileKey = (config, padId) =>
  padId === "pons" ? JSON.stringify(config.ponsFees) :
  padId === 'stonks' ? JSON.stringify(config.stonksLaunch?.profile) : isLockedPoolPad(padId) ? JSON.stringify(config.feeContracts[padId]) : "";

function lockedProfile(config, position) {
  const profile = config.feeContracts[position.kind];
  if (
    !isLockedPoolPad(position.kind) ||
    !profile ||
    position.chainId !== 4663 ||
    position.profileKey !== profileKey(config, position.kind) ||
    !sameAddress(position.target, profile.manager) ||
    (!profile.discovery &&
      !profile.pools.some((pool) => JSON.stringify(pool) === JSON.stringify(position.pool)))
  )
    throw new ServiceError("contract_unverified", 409);
  return profile;
}

export function parseO1Positions(body, address, chainId, limit = 25) {
  if (
    !Array.isArray(body?.data) ||
    body.data.length > limit ||
    typeof body?.pagination?.has_more !== "boolean" ||
    (body.pagination.has_more
      ? typeof body.pagination.next_cursor !== "string" ||
        !body.pagination.next_cursor.length ||
        body.pagination.next_cursor.length > 4096
      : body.pagination.next_cursor !== null)
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
      claimDisabledReason: "contract_unverified",
    };
    const key = `${position.target}:${currency}`;
    const previous = positions.get(key);
    if (previous && JSON.stringify(previous.payouts) !== JSON.stringify(position.payouts))
      throw new ServiceError("invalid_response");
    positions.set(key, position);
  }
  return {
    positions: [...positions.values()],
    partial: body.pagination.has_more,
    nextCursor: body.pagination.next_cursor,
  };
}

export class Fees {
  constructor(
    config,
    upstream,
    now = Date.now,
    rpc = new FeeRpc(config, upstream, now, { queue: true, retry: true, parallel: true }),
  ) {
    this.config = config;
    this.upstream = upstream;
    this.now = now;
    this.rpc = rpc;
    this.pons = new PonsFees(config, rpc);
    this.usd = new FeeUsd(upstream, now);
    this.cache = new ReadCache(now, 64);
    this.stonks = new StonksFees(config, rpc, upstream, this.cache);
    this.preflights = new ReadCache(now, 32);
    this.handles = new Map();
    this.cursors = new Map();
    this.key = randomBytes(32);
  }

  remember(position) {
    const identity = [
      position.address,
      position.chainId,
      position.kind,
      position.target,
      position.poolId ?? position.payouts[0].asset,
      position.escrowVersion,
      position.profileKey,
    ];
    const id = createHmac("sha256", this.key).update(JSON.stringify(identity)).digest("hex");
    this.handles.delete(id);
    while (this.handles.size >= 4096) this.handles.delete(this.handles.keys().next().value);
    // A position handle is discovery identity, never an executable quote. Every
    // prepare still reads live balances, checks code and simulates its exact call.
    this.handles.set(id, { position, expires: this.now() + HANDLE_TTL });
    return {
      id,
      target: position.target,
      ...(position.escrowVersion ? { escrowVersion: position.escrowVersion } : {}),
      ...(position.kind === 'stonks' ? { collectionToken: position.collectionToken, claimMode: position.claimMode } : {}),
      payouts: position.payouts,
      verification: position.verification,
      claimable: position.claimable,
      ...(position.claimDisabledReason
        ? { claimDisabledReason: position.claimDisabledReason }
        : {}),
    };
  }

  continuation(input, state) {
    if (!state) return null;
    const id = randomBytes(32).toString("hex");
    while (this.cursors.size >= 512) this.cursors.delete(this.cursors.keys().next().value);
    this.cursors.set(id, {
      address: input.address,
      chainId: input.chainId,
      padId: input.padId,
      profileKey: profileKey(this.config, input.padId),
      state,
      expires: this.now() + HANDLE_TTL,
    });
    return id;
  }

  cursor(input) {
    if (!input.cursor) return undefined;
    const cursor = this.cursors.get(input.cursor);
    if (
      !cursor ||
      cursor.expires <= this.now() ||
      !sameAddress(cursor.address, input.address) ||
      cursor.chainId !== input.chainId ||
      cursor.padId !== input.padId ||
      cursor.profileKey !== profileKey(this.config, input.padId)
    )
      throw new ServiceError("cursor_expired", 409);
    return cursor.state;
  }

  async list(input) {
    const { address, chainId, padId } = input;
    if (!["o1", "long", "longbow", "pons", "stonks"].includes(padId) || (padId === 'stonks' && chainId !== 8453) || ((isLockedPoolPad(padId) || padId === "pons") && chainId !== 4663))
      throw new ServiceError("invalid_request", 400);
    const coverage = padId === "pons" ? "configured_escrow" :
      ['o1', 'stonks'].includes(padId)
        ? "wallet_index"
        : this.config.feeContracts[padId]?.discovery
          ? "beneficiary_events"
          : "configured_pools";
    const unavailable = {
      address,
      chainId,
      padId,
      coverage,
      nextCursor: null,
      status: "unavailable",
      reason: "not_configured",
      positions: [],
      expiresAt: this.now() + TTL,
    };
    if (padId === 'stonks' && (!this.config.stonksLaunch || !this.config.baseRpcUrl)) return unavailable;
    if (!this.config.feesEnabled) return { ...unavailable, reason: "fees_disabled" };
    if (padId === "pons" && !this.config.ponsFees) return { ...unavailable, reason: "contracts_not_configured" };
    if (padId === "pons" && !this.config.rpcUrl) return { ...unavailable, reason: "provider_not_configured" };
    if ((padId === "o1" && !this.config.o1Key) || (isLockedPoolPad(padId) && !this.config.rpcUrl))
      return { ...unavailable, reason: "provider_not_configured" };
    if (
      isLockedPoolPad(padId) &&
      !this.config.feeContracts[padId]?.pools.length &&
      !this.config.feeContracts[padId]?.discovery
    )
      return { ...unavailable, reason: "contracts_not_configured" };
    return this.cache.get(
      `fees:${JSON.stringify(input)}:${profileKey(this.config, padId)}`,
      TTL,
      () =>
        withinReadDeadline(async () => {
          const state = this.cursor(input);
          const result =
            padId === "pons" ? await this.pons.list(address) : padId === "o1"
              ? await this.o1(address, chainId, state)
              : padId === 'stonks' ? await this.stonks.list(address, state) : await this.long(address, state, padId);
          return {
            address,
            chainId,
            padId,
            coverage,
            nextCursor: this.continuation(input, result.nextState),
            status: result.partial ? "partial" : "ready",
            checkedAt: this.now(),
            expiresAt: this.now() + TTL,
            positions: result.positions.map((position) => this.remember(position)),
            ...(result.progress ? { progress: result.progress } : {}),
          };
        }),
    );
  }

  async o1(address, chainId, state) {
    const url = new URL(`/v1/wallets/${address}/fee-claims`, O1_ORIGIN);
    url.search = new URLSearchParams({
      chain_id: String(chainId),
      market: "all",
      state: "all",
      limit: String(O1_PAGE_SIZE),
      ...(state?.cursor ? { cursor: state.cursor } : {}),
    }).toString();
    const result = parseO1Positions(
      await this.upstream.json(
        "o1",
        url,
        { headers: { "x-api-key": this.config.o1Key } },
        256 * 1024,
        3,
        { queue: true, retry: true },
      ),
      address,
      chainId,
      O1_PAGE_SIZE,
    );
    const cursorHash = result.nextCursor
      ? createHmac("sha256", this.key).update(result.nextCursor).digest("hex")
      : null;
    if (cursorHash && (state?.seen ?? []).includes(cursorHash))
      throw new ServiceError("cursor_expired", 409);
    if (cursorHash && (state?.seen.length ?? 0) >= 511) throw new ServiceError("scan_limit", 409);
    const verified = result.positions.filter(
      (position) =>
        (chainId === 8453 ? this.config.baseRpcUrl : this.config.rpcUrl) &&
        this.config.feeContracts.o1.some(
          (profile) => profile.chainId === chainId && sameAddress(profile.escrow, position.target),
        ),
    );
    if (verified.length) {
      const profiles = [...new Set(verified.map((position) => position.target))].map((target) => {
        const profile = this.config.feeContracts.o1.find(
          (entry) => entry.chainId === chainId && sameAddress(entry.escrow, target),
        );
        return { address: target, codeHash: profile.codeHash };
      });
      const block = await this.rpc.block(chainId);
      const available = await this.rpc.verifiedContracts(chainId, profiles, block);
      const group = verified.filter((position) =>
        available.some((profile) => sameAddress(position.target, profile.address)),
      );
      if (group.length) {
        try {
          const amounts = await this.rpc.calls(
            chainId,
            group.map((position) =>
              view(position.target, escrowAbi, "owed", [address, position.payouts[0].asset]),
            ),
            block,
          );
          group.forEach((position, index) => {
            const profile = this.config.feeContracts.o1.find(
              (entry) => entry.chainId === chainId && sameAddress(entry.escrow, position.target),
            );
            position.escrowVersion = profile.version ?? "current";
            position.payouts[0].claimableRaw = amounts[index].toString();
            position.verification = "live";
            position.claimable =
              this.config.claimsEnabled &&
              (chainId !== 8453 || !!this.config.feeContracts.baseOracle) &&
              amounts[index] > 0n;
            position.claimDisabledReason =
              amounts[index] === 0n
                ? "nothing_to_claim"
                : !this.config.claimsEnabled
                  ? "claims_disabled"
                  : chainId === 8453 && !this.config.feeContracts.baseOracle
                    ? "gas_oracle_not_configured"
                    : undefined;
          });
        } catch (error) {
          // An incompatible owed method remains visible as indexed-only;
          // quota/network failures stop the page so its continuation can be retried.
          if (!(error instanceof ServiceError) || error.code !== "reverted") throw error;
        }
      }
    }
    return {
      ...result,
      nextState: result.nextCursor
        ? { cursor: result.nextCursor, seen: [...(state?.seen ?? []), cursorHash] }
        : null,
      partial:
        result.partial || result.positions.some((position) => position.verification !== "live"),
    };
  }

  async long(address, state, padId = "long") {
    const profile = this.config.feeContracts[padId];
    const block = state?.block ?? (await this.rpc.block(4663));
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
    if (profile.discovery) {
      const result = await discoverLongFeePools(
        this.rpc,
        profile,
        address,
        block,
        state?.discovery,
      );
      for (const pool of result.pools) {
        const position = await this.longPosition(address, pool, block, padId);
        if (position.beneficiary) positions.push(position);
      }
      return {
        positions,
        progress: result.progress,
        partial: !!result.nextState || !!result.partial,
        nextState: result.nextState ? { block, discovery: result.nextState } : null,
      };
    }
    const offset = state?.offset ?? 0;
    for (const pool of profile.pools.slice(offset, offset + LONG_PAGE_SIZE)) {
      const position = await this.longPosition(address, pool, block, padId);
      if (position.beneficiary) positions.push(position);
    }
    return {
      positions,
      partial: true,
      nextState:
        offset + LONG_PAGE_SIZE < profile.pools.length
          ? { block, offset: offset + LONG_PAGE_SIZE }
          : null,
    };
  }

  async longPosition(address, pool, block, padId = "long") {
    const profile = this.config.feeContracts[padId];
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
      kind: padId,
      profileKey: profileKey(this.config, padId),
      beneficiary: shares > 0n,
      address,
      chainId: 4663,
      target: profile.manager,
      poolId: id,
      pool,
      verification: "live",
      claimable: this.config.claimsEnabled && shares > 0n && amounts.some((amount) => amount > 0n),
      claimDisabledReason:
        shares === 0n || !amounts.some((amount) => amount > 0n)
          ? "nothing_to_claim"
          : !this.config.claimsEnabled
            ? "claims_disabled"
            : undefined,
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
    if (isLockedPoolPad(handle.position.kind)) lockedProfile(this.config, handle.position);
    if (handle.position.kind === "pons") this.pons.validatePosition(handle.position);
    return this.preflights.get(`claim:${address}:${positionId}`, 10_000, () =>
      withinReadDeadline(async () => {
        let position = handle.position;
        const chainId = position.chainId;
        const block = await this.rpc.block(chainId);
        let data;
        let escrowVersion;
        if (position.kind === "pons") {
          ({ position, data } = await this.pons.prepare(position, block));
        } else         if (position.kind === 'stonks') {
          ({ position, data } = await this.stonks.prepare(position, block));
        } else if (isLockedPoolPad(position.kind)) {
          const profile = lockedProfile(this.config, position);
          await this.rpc.verify(
            chainId,
            [
              { address: profile.manager, codeHash: profile.managerCodeHash },
              { address: profile.hook, codeHash: profile.hookCodeHash },
            ],
            true,
            block,
          );
          position = await this.longPosition(address, position.pool, block, position.kind);
          data = encodeFunctionData({
            abi: managerAbi,
            functionName: "collectFees",
            args: [position.poolId],
          });
        } else {
          const profile = this.config.feeContracts.o1.find(
            (entry) => entry.chainId === chainId && sameAddress(entry.escrow, position.target),
          );
          const oracle = this.config.feeContracts.baseOracle;
          if (!profile || (chainId === 8453 && !oracle))
            throw new ServiceError("contract_unverified", 409);
          escrowVersion = profile.version ?? "current";
          if ((position.escrowVersion ?? "current") !== escrowVersion)
            throw new ServiceError("contract_unverified", 409);
          await this.rpc.verify(
            chainId,
            [
              { address: profile.escrow, codeHash: profile.codeHash },
              ...(chainId === 8453 ? [oracle] : []),
            ],
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
            abi: escrowVersion === "legacy" ? legacyEscrowAbi : escrowAbi,
            functionName: escrowVersion === "legacy" ? "claim" : "claimFor",
            args: [address, position.payouts[0].asset],
          });
        }
        if (
          !position.payouts.some((payout) => uint(payout.claimableRaw) > 0n) ||
          !position.claimable
        )
          throw new ServiceError("nothing_to_claim", 409);
        const transaction = { from: address, to: position.target, data, value: "0x0" };
        const [gasHex, priceHex, balanceHex, simulation, nonceHex] = await this.rpc.batch(chainId, [
          { method: "eth_estimateGas", params: [transaction, block] },
          { method: "eth_gasPrice", params: [] },
          { method: "eth_getBalance", params: [address, "pending"] },
          { method: "eth_call", params: [transaction, block] },
          ...(chainId === 8453
            ? [{ method: "eth_getTransactionCount", params: [address, "pending"] }]
            : []),
        ]);
        if (typeof simulation !== "string" || !/^0x(?:[\da-f]{2})*$/i.test(simulation))
          throw new ServiceError("invalid_response");
        if (position.kind === "pons" && (!/^0x[\da-f]{64}$/i.test(simulation) || BigInt(simulation) !== BigInt(position.payouts[0].claimableRaw)))
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
        const gasUsd = await this.usd.estimate(estimatedWei);
        return {
          positionId,
          kind: position.kind,
          ...(escrowVersion ? { escrowVersion } : {}),
          chainId,
          address,
          target: position.target,
          data,
          ...(position.kind !== 'stonks' ? { poolId: position.poolId } : {}),
          ...(position.kind === 'stonks' ? { collectionToken: position.collectionToken, claimMode: position.claimMode } : {}),
          payouts: position.payouts,
          value: "0",
          gas: gasLimit.toString(),
          gasPrice: gasPrice.toString(),
          estimatedWei: estimatedWei.toString(),
          gasUsd,
          budgetWei: budgetWei.toString(),
          l1FeeWei: l1.toString(),
          operatorFeeWei: operator.toString(),
          expiresAt: this.now() + 20_000,
        };
      }),
    );
  }
}
