import { createConfig, custom } from 'wagmi';
import { base, robinhood } from 'viem/chains';

export function createPreviewConfig() {
  const offline = custom(
    {
      async request() {
        throw new Error('Application RPC is disabled in this preview.');
      },
    },
    { key: 'preview-disabled', retryCount: 0 },
  );

  return createConfig({
    chains: [robinhood, base],
    connectors: [],
    multiInjectedProviderDiscovery: true,
    storage: null,
    ssr: false,
    transports: { [robinhood.id]: offline, [base.id]: offline },
  });
}

export const previewQueryDefaults = {
  queries: {
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  },
  mutations: { retry: false },
} as const;
