'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChainId, PadId } from './launch-model';
import {
  checkTicker,
  expiryDelay,
  loadCatalog,
  tickerKey,
  type Catalog,
  type TickerCheck,
} from './read-service';

export function useReadService(
  chainId: ChainId,
  ticker: string,
  pads: PadId[],
) {
  const key = tickerKey(chainId, ticker, pads);
  const currentKey = useRef(key);
  useLayoutEffect(() => {
    currentKey.current = key;
  }, [key]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogSettled, setCatalogSettled] = useState('');
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [check, setCheck] = useState<{ key: string; data: TickerCheck } | null>(
    null,
  );
  const [pendingKey, setPendingKey] = useState('');
  const [checkError, setCheckError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    let ignore = false;
    void loadCatalog(chainId)
      .then((value) => {
        if (!ignore) setCatalog(value);
      })
      .catch(() => {
        if (!ignore) setCatalog(null);
      })
      .finally(() => {
        if (!ignore) {
          setCatalogSettled(`${chainId}:${catalogRefresh}`);
          setNow(performance.now());
        }
      });
    return () => {
      ignore = true;
    };
  }, [chainId, catalogRefresh]);

  useEffect(() => {
    const delay = expiryDelay(
      [
        catalog?.expiresAt,
        ...Object.values(check?.data.results ?? {}).map((r) => r?.expiresAt),
      ],
      now,
      performance.now(),
    );
    if (delay === null) return;
    const timer = setTimeout(() => setNow(performance.now()), delay + 1);
    return () => clearTimeout(timer);
  }, [catalog, check, now]);

  async function runCheck() {
    const requestKey = key;
    setPendingKey(requestKey);
    setCheck(null);
    setCheckError(null);
    try {
      const data = await checkTicker(chainId, ticker, pads);
      if (currentKey.current === requestKey)
        setCheck({ key: requestKey, data });
    } catch {
      if (currentKey.current === requestKey)
        setCheckError({
          key: requestKey,
          message: 'Ticker check unavailable. Try again later.',
        });
    } finally {
      setPendingKey((pending) => (pending === requestKey ? '' : pending));
      setNow(performance.now());
    }
  }

  return {
    catalog:
      catalog?.chainId === chainId && catalog.expiresAt > now ? catalog : null,
    catalogLoading: catalogSettled !== `${chainId}:${catalogRefresh}`,
    now,
    refreshCatalog: () => setCatalogRefresh((n) => n + 1),
    check: check?.key === key ? check.data : null,
    checking: pendingKey === key,
    checkError: checkError?.key === key ? checkError.message : null,
    runCheck,
  };
}
