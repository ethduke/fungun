import { encodeFunctionData, parseAbi, zeroAddress } from "viem";
import { ServiceError } from "./errors.mjs";
import { sameAddress, validAddress } from "./fee-contracts.mjs";

// Verified PonsV2FeeEscrow overloads. Amounts are explicit so the wallet
// authorizes the reviewed balance, even if another credit arrives meanwhile.
export const ponsEscrowAbi = parseAbi([
  "function balanceOf(address recipient) view returns (uint256)",
  "function balanceOfToken(address recipient, address token) view returns (uint256)",
  "function claim(uint256 amount) returns (uint256)",
  "function claimToken(address token, uint256 amount) returns (uint256)",
]);
const nativeAsset = { address: zeroAddress, symbol: "ETH", decimals: 18 };

export function readPonsFeeProfile(raw) {
  if (!raw) return null;
  try {
    const profile = JSON.parse(raw);
    if (!profile || Array.isArray(profile) || profile.chainId !== 4663 ||
      Object.keys(profile).some(key => !["chainId", "escrow", "assets"].includes(key)) ||
      !validAddress(profile.escrow?.address) ||
      !/^0x[\da-f]{64}$/i.test(profile.escrow?.codeHash ?? "") ||
      Object.keys(profile.escrow).some(key => !["address", "codeHash"].includes(key)) ||
      !Array.isArray(profile.assets ?? []) || (profile.assets ?? []).length > 8 ||
      (profile.assets ?? []).some(asset => !asset || !validAddress(asset.address) ||
        Object.keys(asset).some(key => !["address", "symbol", "decimals"].includes(key)) ||
        !/^[A-Za-z0-9._-]{1,24}$/.test(asset.symbol ?? "") ||
        !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36) ||
      new Set((profile.assets ?? []).map(asset => asset.address.toLowerCase())).size !== (profile.assets ?? []).length)
      throw new Error();
    return { ...profile, assets: [nativeAsset, ...(profile.assets ?? [])] };
  } catch {
    throw new ServiceError("invalid_fee_configuration");
  }
}

export class PonsFees {
  constructor(config, rpc) { this.config = config; this.rpc = rpc; }

  async positions(address, assets, block) {
    const profile = this.config.ponsFees;
    const balances = await this.rpc.calls(4663, assets.map(asset => ({
      address: profile.escrow.address,
      abi: ponsEscrowAbi,
      functionName: sameAddress(asset.address, zeroAddress) ? "balanceOf" : "balanceOfToken",
      args: sameAddress(asset.address, zeroAddress) ? [address] : [address, asset.address],
    })), block);
    return assets.map((asset, index) => ({
      kind: "pons", address, chainId: 4663, target: profile.escrow.address,
      profileKey: JSON.stringify(profile), verification: "live",
      claimable: this.config.claimsEnabled && balances[index] > 0n,
      claimDisabledReason: balances[index] === 0n ? "nothing_to_claim" :
        !this.config.claimsEnabled ? "claims_disabled" : undefined,
      payouts: [{ asset: asset.address, symbol: asset.symbol, decimals: asset.decimals,
        claimableRaw: balances[index].toString() }],
    }));
  }

  async list(address) {
    const profile = this.config.ponsFees;
    const block = await this.rpc.block(4663);
    await this.rpc.verify(4663, [profile.escrow], false, block);
    // This is escrow coverage, not lifetime earnings: unswept fees, unreleased
    // buybacks, unconfigured currencies and historical escrows remain unknown.
    return { positions: await this.positions(address, profile.assets, block), partial: true };
  }

  validatePosition(position) {
    const profile = this.config.ponsFees;
    const asset = profile?.assets.find(asset => sameAddress(asset.address, position.payouts[0]?.asset));
    if (!profile || position.chainId !== 4663 || !sameAddress(profile.escrow.address, position.target) ||
      position.profileKey !== JSON.stringify(profile) || !asset || position.payouts.length !== 1)
      throw new ServiceError("contract_unverified", 409);
    return { profile, asset };
  }

  async prepare(position, block) {
    const { profile, asset } = this.validatePosition(position);
    await this.rpc.verify(4663, [profile.escrow], true, block);
    const [fresh] = await this.positions(position.address, [asset], block);
    const native = sameAddress(asset.address, zeroAddress);
    return { position: fresh, data: encodeFunctionData({ abi: ponsEscrowAbi,
      functionName: native ? "claim" : "claimToken",
      args: native ? [BigInt(fresh.payouts[0].claimableRaw)] : [asset.address, BigInt(fresh.payouts[0].claimableRaw)],
    }) };
  }
}
