'use client';

import { createElement, useEffect } from 'react';

export function MarketFeed() {
  useEffect(() => {
    // Register only in the browser; the server handler is a separate module.
    void import('./tracked-market-feed.mjs');
  }, []);

  return createElement('tracked-market-feed', { src: '/api/tracked-feed' });
}
