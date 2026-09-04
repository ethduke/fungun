'use client';

import { useEffect, useState } from 'react';
import { getConnection } from 'wagmi/actions';
import type { EIP1193Provider } from 'viem';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  WagmiProvider,
  useConnect,
  useConnection,
  useConnectors,
  useDisconnect,
} from 'wagmi';
import { ArrowUpRight, Wallet, ShieldCheck, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { createPreviewConfig, previewQueryDefaults } from '@/lib/preview-web3';
import type { ConnectedAccount } from '@/lib/account-context';
import { AppError, describeError } from '@/lib/user-error';
import { sendWalletClaim, checkWalletClaim, ensureClaimChain as ensureWalletClaimChain } from '@/lib/claim-wallet';
import type { ClaimQuote } from '@/lib/fee-service';
import { signWalletAsset } from '@/lib/asset-wallet';
import type { AssetApproval } from '@/lib/asset-protocol';

let configuration: ReturnType<typeof createPreviewConfig> | undefined;
async function walletProvider() {
  if (!configuration) throw new AppError('disconnected');
  const connection = getConnection(configuration);
  if (!connection.isConnected || !connection.connector)
    throw new AppError('disconnected');
  const provider =
    (await connection.connector.getProvider()) as EIP1193Provider;
  return {
    request: (args) => {
      const current = getConnection(configuration!);
      if (
        !current.isConnected ||
        current.connector?.uid !== connection.connector?.uid ||
        current.address !== connection.address
      )
        throw new AppError('wrong_account');
      return provider.request(
        args as Parameters<EIP1193Provider['request']>[0],
      );
    },
  } as EIP1193Provider;
}
const sendClaim = async (quote: ClaimQuote) =>
  sendWalletClaim(await walletProvider(), quote);
const checkClaim = async (positionId: string) =>
  checkWalletClaim(await walletProvider(), positionId);
const ensureClaimChain = async (address: string, chainId: number, isCurrent: () => boolean) =>
  ensureWalletClaimChain(await walletProvider(), address, chainId, isCurrent);
const signAsset = async (approval: AssetApproval, isCurrent: () => boolean) =>
  signWalletAsset(await walletProvider(), approval, isCurrent);

function ConnectionControl({
  onAccountChange,
}: {
  onAccountChange: (account: ConnectedAccount) => void;
}) {
  const [open, setOpen] = useState(true);
  const connection = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const address = connection.address;
  useEffect(() => {
    onAccountChange(
      connection.isConnected
        ? { address, chainId: connection.chainId, sendClaim, checkClaim, ensureClaimChain, signAsset }
        : {},
    );
  }, [address, connection.chainId, connection.isConnected, onAccountChange]);
  return (
    <>
      <Button className="wallet-button" onClick={() => setOpen(true)}>
        <Wallet size={16} />
        {address
          ? `${address.slice(0, 6)}…${address.slice(-4)}`
          : 'Connect wallet'}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="app-dialog">
          <DialogHeader>
            <span className="dialog-icon">
              <Wallet />
            </span>
            <DialogTitle>
              {connection.isConnected ? 'Your wallet' : 'Connect your wallet'}
            </DialogTitle>
            <DialogDescription>
              Connect your account. No signature, payment or network switch is
              requested.
            </DialogDescription>
          </DialogHeader>
          {connection.isConnected ? (
            <div className="connection-details">
              <strong>{connection.connector?.name}</strong>
              <span>
                {address
                  ? `${address.slice(0, 6)}…${address.slice(-4)}`
                  : 'Connected'}
              </span>
              <p>
                Network:{' '}
                {connection.chain?.name ?? `Chain ${connection.chainId}`}
              </p>
              <Button variant="outline" onClick={() => disconnect.mutate({})}>
                Disconnect
              </Button>
              {disconnect.isError && (
                <p role="alert" className="field-error">
                  {describeError(disconnect.error, 'disconnect')}
                </p>
              )}
            </div>
          ) : (
            <div className="wallet-list">
              {connectors.map((connector) => (
                <Button
                  key={connector.uid}
                  variant="outline"
                  className="wallet-choice"
                  disabled={connect.isPending}
                  onClick={() =>
                    connect.mutate(
                      { connector },
                      { onSuccess: () => setOpen(false) },
                    )
                  }
                >
                  <span className="wallet-symbol">
                    <Wallet size={18} />
                  </span>
                  {connector.name}
                  <ArrowUpRight size={16} />
                </Button>
              ))}
              {!connectors.length && (
                <div className="empty-wallet">
                  <Wallet size={25} />
                  <strong>No browser wallet found</strong>
                  <p>
                    Open this preview in a browser with Rabby, MetaMask, or
                    another EIP-6963 wallet installed.
                  </p>
                </div>
              )}
              <div className="mobile-wallet">
                <Smartphone size={19} />
                <span>
                  WalletConnect <small>QR connection · next milestone</small>
                </span>
                <span className="sample-tag">Not configured</span>
              </div>
              {connect.isPending && (
                <output className="notice">
                  Confirm the connection in your wallet.
                </output>
              )}
              {connect.isError && (
                <p role="alert" className="field-error">
                  {describeError(connect.error, 'connect')}
                </p>
              )}
            </div>
          )}
          <div className="dialog-safety">
            <ShieldCheck size={16} />
            <span>Never enter a seed phrase or private key here.</span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function WalletConnection({
  onAccountChange,
}: {
  onAccountChange: (account: ConnectedAccount) => void;
}) {
  const [config] = useState(() => (configuration ??= createPreviewConfig()));
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: previewQueryDefaults }),
  );
  return (
    <WagmiProvider config={config} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>
        <ConnectionControl onAccountChange={onAccountChange} />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
