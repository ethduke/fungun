'use client';

import { Button } from '@/components/ui/button';

export default function PageError({ reset }: { reset: () => void }) {
  return (
    <main className="workspace">
      <h1>This page couldn’t finish loading.</h1>
      <p className="notice" role="alert">
        Try again. If you reload the page, your local draft will be cleared.
        Check your wallet activity before repeating any transaction.
      </p>
      <Button type="button" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
