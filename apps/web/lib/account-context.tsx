'use client';

import type { LongPlan } from './long-wallet';

import { createContext, useContext } from 'react';
import type { ClaimQuote } from './fee-service';
import type { AssetApproval } from './asset-protocol';
import type { ImageOperation, ImageQuote, ImageProof } from './image-generation';

export type ConnectedAccount = {
  sendLong?: (plan: LongPlan, isCurrent: () => boolean, reserve: () => Promise<void>) => Promise<string>;
  signImage?: (quote: ImageQuote, input: ImageOperation, isCurrent: () => boolean) => Promise<ImageProof>;
  openWallet?: () => void;
  address?: string;
  checkAccount?: (address: string) => Promise<void>;
  chainId?: number;
  ensureChain?: (
    address: string,
    chainId: number,
    isCurrent: () => boolean,
  ) => Promise<void>;
  ensureClaimChain?: (
    address: string,
    chainId: number,
    isCurrent: () => boolean,
  ) => Promise<void>;
  sendClaim?: (quote: ClaimQuote) => Promise<string>;
  watchClaim?: (
    positionId: string,
    isCurrent: () => boolean,
    onError: (error: unknown) => void,
  ) => Promise<() => void>;
  signAsset?: (
    approval: AssetApproval,
    isCurrent: () => boolean,
  ) => Promise<`0x${string}`>;
};
export const AccountContext = createContext<ConnectedAccount>({});

export function useConnectedAccount() {
  return useContext(AccountContext);
}
