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
import { observeWalletSession, refreshWalletSession } from '@/lib/injected-session';
import type { ConnectedAccount } from '@/lib/account-context';
import { AppError, describeError } from '@/lib/user-error';
import {
  sendWalletClaim,
  watchWalletClaim,
  ensureClaimChain as ensureWalletClaimChain,
} from '@/lib/claim-wallet';
import type { ClaimQuote } from '@/lib/fee-service';
import { LaunchError, sendLongWallet, type LongPlan } from '@/lib/long-wallet';
import { signWalletAsset } from '@/lib/asset-wallet';
import type { AssetApproval } from '@/lib/asset-protocol';
import { signImagePayment } from '@/lib/image-wallet';
import type { ImageQuote, ImageOperation } from '@/lib/image-generation';

let configuration: ReturnType<typeof createPreviewConfig> | undefined;
async function checkAccount(address: string) {
  if (!configuration) throw new LaunchError('wallet_changed');
  await refreshWalletSession(configuration);
  const current = getConnection(configuration);
  if (!current.isConnected || current.address?.toLowerCase() !== address.toLowerCase())
    throw new LaunchError('wallet_changed');
}
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
const sendLong = async (plan: LongPlan, isCurrent: () => boolean, reserve: () => Promise<void>) =>
  sendLongWallet(await walletProvider(), plan, isCurrent, reserve);
const sendClaim = async (quote: ClaimQuote) =>
  sendWalletClaim(await walletProvider(), quote);
const watchClaim = async (
  positionId: string,
  isCurrent: () => boolean,
  onError: (error: unknown) => void,
) =>
  watchWalletClaim(await walletProvider(), positionId, { isCurrent, onError });
const ensureChain = async (
  address: string,
  chainId: number,
  isCurrent: () => boolean,
) =>
  ensureWalletClaimChain(await walletProvider(), address, chainId, isCurrent);
const ensureClaimChain = ensureChain;
const signAsset = async (approval: AssetApproval, isCurrent: () => boolean) =>
  signWalletAsset(await walletProvider(), approval, isCurrent);
const signImage = async (quote: ImageQuote, input: ImageOperation, isCurrent: () => boolean) =>
  signImagePayment(await walletProvider(), quote, input, isCurrent);

function ConnectionControl({
  onAccountChange,
  open,
  onOpenChange,
}: {
  onAccountChange: (account: ConnectedAccount) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const connection = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const address = connection.address;
  useEffect(() => {
    onAccountChange(
      connection.isConnected
        ? {
            address,
            checkAccount,
            chainId: connection.chainId,
            ensureChain,
            sendClaim,
            sendLong,
            watchClaim,
            ensureClaimChain,
            signAsset,
            signImage,
          }
        : {},
    );
  }, [address, connection.chainId, connection.isConnected, onAccountChange]);
  return (
    <>
      <Button className="wallet-button" onClick={() => onOpenChange(true)}>
        <Wallet size={16} />
        {address
          ? `${address.slice(0, 6)}…${address.slice(-4)}`
          : 'Connect wallet'}
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
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
                      { onSuccess: () => onOpenChange(false) },
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
  open,
  onOpenChange,
}: {
  onAccountChange: (account: ConnectedAccount) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [config] = useState(() => (configuration ??= createPreviewConfig()));
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: previewQueryDefaults }),
  );
  useEffect(() => observeWalletSession(config), [config]);
  return (
    <WagmiProvider config={config} reconnectOnMount>
      <QueryClientProvider client={queryClient}>
        <ConnectionControl
          onAccountChange={onAccountChange}
          open={open}
          onOpenChange={onOpenChange}
        />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
