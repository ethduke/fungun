'use client';

import { useState } from 'react';
import Image from 'next/image';
import { ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';

// The parent is keyed by the wallet + draft + artwork recovery scope, so a
// pending launch cannot inherit the name or picture from an edited draft.
export function LaunchSuccessDialog({ name, ticker, imageUrl, tokenUrl, transactionUrl, longCompatible }: {
  name: string;
  ticker: string;
  imageUrl: string;
  tokenUrl: string;
  transactionUrl: string;
  longCompatible: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" />}>
        View launch details
      </DialogTrigger>
      <DialogContent className="launch-success-dialog">
        <Image className="launch-success-image" src={imageUrl} alt={`${name} token artwork`} width={176} height={176} unoptimized />
        <p className="launch-success-ticker">${ticker}</p>
        <DialogTitle className="launch-success-title">{name} {longCompatible ? 'is deployed' : 'was deployed'}</DialogTitle>
        <DialogDescription className="launch-success-description">
          {longCompatible
            ? 'Deployment confirmed on Robinhood Chain. Open Long to view your coin.'
            : 'This token was deployed, but its address does not meet Long’s requirements. Its address cannot be changed; a new deployment is required.'}
        </DialogDescription>
        <a className="launch-success-link" href={tokenUrl} target="_blank" rel="noopener noreferrer">
          {longCompatible ? 'View on Long' : 'View token on explorer'} <ArrowUpRight size={20} aria-hidden="true" />
        </a>
        <a className="launch-success-transaction" href={transactionUrl} target="_blank" rel="noopener noreferrer">
          View transaction
        </a>
      </DialogContent>
    </Dialog>
  );
}
