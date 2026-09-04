'use client';

import { createContext, useContext } from 'react';
import type { ClaimQuote } from './fee-service';

export type ConnectedAccount = {
  address?: string;
  chainId?: number;
  sendClaim?: (quote: ClaimQuote) => Promise<string>;
  checkClaim?: (positionId: string) => Promise<void>;
};
export const AccountContext = createContext<ConnectedAccount>({});

export function useConnectedAccount() {
  return useContext(AccountContext);
}
