'use client';

import { createContext, useContext } from 'react';

export type ConnectedAccount = { address?: string; chainId?: number };
export const AccountContext = createContext<ConnectedAccount>({});

export function useConnectedAccount() {
  return useContext(AccountContext);
}
