'use client';

import { lazy, Suspense, useState, type ReactNode } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AccountContext, type ConnectedAccount } from '@/lib/account-context';
import { LaunchDraftProvider } from '@/lib/launch-draft';
import { MarketFeed } from '@/components/market-feed';

const WalletConnection = lazy(() => import('@/components/connect-panel'));

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [walletStarted, setWalletStarted] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [account, setAccount] = useState<ConnectedAccount>({});
  const openWallet = () => {
    setWalletStarted(true);
    setWalletOpen(true);
  };

  return (
    <AccountContext value={{ ...account, openWallet }}>
      <div className="site-shell">
        <header className="site-header">
          <Link
            href="/"
            prefetch={false}
            className="brand"
            aria-label="Fungun home"
          >
            <Image
              className="brand-logo"
              src="/brand/fungun-logo.png"
              alt=""
              width={720}
              height={202}
              unoptimized
            />
          </Link>
          <nav className="header-nav" aria-label="Main navigation">
            <Link
              href="/"
              prefetch={false}
              aria-current={pathname === '/' ? 'page' : undefined}
            >
              LAUNCH
            </Link>
            <Link
              href="/fees"
              prefetch={false}
              aria-current={pathname === '/fees' ? 'page' : undefined}
            >
              FEES
            </Link>
          </nav>
          <div className="header-actions">
            <span className="preview-pill">
              <span />
              Local preview
            </span>
            {walletStarted ? (
              <Suspense
                fallback={
                  <Button className="wallet-button" disabled>
                    Loading wallets…
                  </Button>
                }
              >
                <WalletConnection
                  onAccountChange={setAccount}
                  open={walletOpen}
                  onOpenChange={setWalletOpen}
                />
              </Suspense>
            ) : (
              <Button
                className="wallet-button"
                onClick={openWallet}
              >
                <Wallet size={16} />
                Connect wallet
              </Button>
            )}
          </div>
        </header>
        {pathname === '/' && <MarketFeed />}
        <LaunchDraftProvider>{children}</LaunchDraftProvider>
      </div>
    </AccountContext>
  );
}
