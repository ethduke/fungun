'use client';

import { createContext, useContext } from 'react';
import type { ClaimQuote } from './fee-service';
import type { AssetApproval } from './asset-protocol';

export type ConnectedAccount = {
  openWallet?: () => void;
  address?: string;
  chainId?: number;
  ensureClaimChain?: (address: string, chainId: number, isCurrent: () => boolean) => Promise<void>;
  sendClaim?: (quote: ClaimQuote) => Promise<string>;
  checkClaim?: (positionId: string) => Promise<void>;
  signAsset?: (approval: AssetApproval, isCurrent: () => boolean) => Promise<`0x${string}`>;
};
export const AccountContext = createContext<ConnectedAccount>({});

export function useConnectedAccount() {
  return useContext(AccountContext);
}
