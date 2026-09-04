'use client';

import { useEffect, useState } from 'react';
import { Wallet, LockKeyhole } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useConnectedAccount } from '@/lib/account-context';
import { chainName } from '@/lib/launch-model';
import {
  FEE_LOOKUP_DELAY,
  FEE_SOURCES,
  createFeePreview,
  feeQueryState,
  groupFeeBalances,
  normalizeFeeAddress,
  type FeePreview,
} from '@/lib/fees-model';

export default function Fees() {
  const account = useConnectedAccount();
  const [manualAddress, setManualAddress] = useState<string | null>(null);
  const [result, setResult] = useState<FeePreview | null>(null);
  const input = manualAddress ?? account.address ?? '';
  const address = normalizeFeeAddress(input);
  const state = feeQueryState(input, result);
  const current = result?.address === address ? result : null;
  const balances = groupFeeBalances(current?.balances ?? []);

  useEffect(() => {
    if (!address) return;
    const timer = setTimeout(
      () => setResult(createFeePreview(address)),
      FEE_LOOKUP_DELAY,
    );
    return () => clearTimeout(timer);
  }, [address]);

  return (
    <main className="workspace fees-workspace">
      <div className="fees-heading">
        <h1>
          FEE<span>.</span>
        </h1>
      </div>
      <div className="fee-address-bar">
        <div className="fee-address-field">
          <label htmlFor="fee-address">Wallet address</label>
          <Input
            id="fee-address"
            value={input}
            placeholder="Connect your wallet or paste an address"
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
            onChange={(event) => setManualAddress(event.target.value)}
            aria-invalid={state === 'invalid'}
            aria-describedby="fee-status"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={!account.address || manualAddress === null}
          onClick={() => setManualAddress(null)}
        >
          <Wallet size={16} />
          Use my wallet
        </Button>
      </div>
      <output
        id="fee-status"
        className={`fee-status ${state === 'invalid' ? 'field-error' : ''}`}
      >
        {state === 'idle' && 'Connect your wallet above or enter an address.'}
        {state === 'invalid' && 'Enter a complete, valid wallet address.'}
        {state === 'loading' && 'Preparing fees view…'}
        {state === 'unavailable' &&
          'Fee readers are not connected in this preview. Balances are unknown, not zero.'}
      </output>
      <section
        className="fees-panel"
        aria-label="Fees by payout coin"
        aria-busy={state === 'loading'}
      >
        <Table className="fees-table">
          <TableHeader>
            <TableRow>
              <TableHead>Coin</TableHead>
              <TableHead>Launchpad</TableHead>
              <TableHead>Network</TableHead>
              <TableHead className="fee-amount">Claimable</TableHead>
              <TableHead>
                <span className="sr-only">Claim fees</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state === 'loading' &&
              FEE_SOURCES.map((source) => (
                <TableRow key={`${source.padId}:${source.chainId}`}>
                  <TableCell>
                    <Skeleton className="fee-skeleton" />
                  </TableCell>
                  <TableCell>
                    {source.padId === 'long' ? 'Long' : 'O1'}
                  </TableCell>
                  <TableCell>{chainName(source.chainId)}</TableCell>
                  <TableCell>
                    <Skeleton className="fee-skeleton" />
                  </TableCell>
                  <TableCell>
                    <Button variant="outline" disabled>
                      Claim
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            {state === 'unavailable' &&
              balances.map((balance) => (
                <TableRow key={balance.key}>
                  <TableCell>{balance.symbol}</TableCell>
                  <TableCell>
                    {balance.launchpads
                      .map((pad) => (pad === 'long' ? 'Long' : 'O1'))
                      .join(' + ')}
                  </TableCell>
                  <TableCell>{chainName(balance.chainId)}</TableCell>
                  <TableCell className="fee-amount">
                    {balance.claimable}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      disabled
                      aria-describedby="fee-claim-notice"
                    >
                      Claim
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            {state === 'unavailable' &&
              current?.unavailableSources.map((source) => (
                <TableRow key={`${source.padId}:${source.chainId}`}>
                  <TableCell className="fee-muted">Not loaded</TableCell>
                  <TableCell>
                    {source.padId === 'long' ? 'Long' : 'O1'}
                  </TableCell>
                  <TableCell>{chainName(source.chainId)}</TableCell>
                  <TableCell className="fee-amount fee-muted">—</TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      disabled
                      aria-describedby="fee-claim-notice"
                    >
                      Claim
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            {(state === 'idle' || state === 'invalid') && (
              <TableRow>
                <TableCell colSpan={5} className="fee-empty">
                  Fees from Long and O1 will appear here, grouped by payout
                  coin.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>
      <p id="fee-claim-notice" className="fee-claim-notice">
        <LockKeyhole size={15} />
        Claims are not connected yet. No address leaves this browser.
      </p>
    </main>
  );
}
