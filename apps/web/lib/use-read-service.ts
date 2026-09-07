'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChainId, PadId } from './launch-model';
import { isWebviewChain } from './launch-model';
import { watchTicker, canCheckTicker } from './auto-ticker';
import { describeError } from './user-error';
import {
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
  const tickerPads: PadId[] = pads.includes('long') ? ['long'] : [];
  const key = tickerKey(chainId, ticker, tickerPads);
  const checker = useRef<ReturnType<typeof watchTicker> | null>(null);
  const padsKey = tickerPads.join(',');
  const catalogSequence = useRef(0);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogSettled, setCatalogSettled] = useState('');
  const [catalogRequest, setCatalogRequest] = useState<{
    chainId: ChainId;
    sequence: number;
  } | null>(null);
  const [catalogError, setCatalogError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [check, setCheck] = useState<{ key: string; data: TickerCheck } | null>(
    null,
  );
  const [pendingKey, setPendingKey] = useState('');
  const [checkError, setCheckError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [now, setNow] = useState(() => performance.now());
  const catalogRequestKey =
    catalogRequest?.chainId === chainId
      ? `${chainId}:${catalogRequest.sequence}`
      : '';
  const needsCatalog = pads.includes('o1');

  useEffect(() => {
    if (
      !needsCatalog ||
      !isWebviewChain(chainId) ||
      catalogRequestKey ||
      (catalog?.chainId === chainId && catalog.expiresAt > performance.now())
    )
      return;
    catalogSequence.current += 1;
    setCatalogRequest({ chainId, sequence: catalogSequence.current });
  }, [
    catalog?.chainId,
    catalog?.expiresAt,
    catalogRequestKey,
    chainId,
    needsCatalog,
  ]);

  useEffect(() => {
    if (!isWebviewChain(chainId) || catalogRequest?.chainId !== chainId) return;
    const requestKey = `${chainId}:${catalogRequest.sequence}`;
    let ignore = false;
    void loadCatalog(chainId)
      .then((value) => {
        if (!ignore) {
          setCatalog(value);
          setCatalogError(null);
        }
      })
      .catch((error: unknown) => {
        if (!ignore) {
          setCatalog(null);
          setCatalogError({
            key: requestKey,
            message: describeError(error, 'catalog'),
          });
        }
      })
      .finally(() => {
        if (!ignore) {
          setCatalogSettled(requestKey);
          setNow(performance.now());
        }
      });
    return () => {
      ignore = true;
    };
  }, [chainId, catalogRequest]);

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

  useEffect(() => {
    const selectedPads = padsKey ? (padsKey.split(',') as PadId[]) : [];
    const watcher = watchTicker({
      chainId,
      ticker,
      pads: selectedPads,
      onPending: () => {
        setPendingKey(key);
        setCheckError(null);
      },
      onResult: (data) => {
        setCheck(previous => data.results.long?.status === 'unverified' && previous?.key === key && previous.data.results.long?.status === 'reserved'
          ? previous : { key, data });
        setPendingKey('');
        setNow(performance.now());
      },
      onError: (error) => {
        setCheck(previous => previous?.key === key && previous.data.results.long?.status === 'reserved' ? previous : null);
        setCheckError({ key, message: describeError(error, 'ticker') });
        setPendingKey('');
      },
    });
    checker.current = watcher;
    return () => {
      watcher.stop();
      if (checker.current === watcher) checker.current = null;
    };
  }, [chainId, ticker, padsKey, key]);
  function runCheck() {
    return checker.current?.flush();
  }

  function ensureCatalog() {
    if (
      (catalog?.chainId === chainId && catalog.expiresAt > performance.now()) ||
      (catalogRequestKey && catalogSettled !== catalogRequestKey)
    )
      return;
    catalogSequence.current += 1;
    setCatalogRequest({ chainId, sequence: catalogSequence.current });
  }

  return {
    catalog:
      catalog?.chainId === chainId && catalog.expiresAt > now ? catalog : null,
    catalogLoading:
      Boolean(catalogRequestKey) && catalogSettled !== catalogRequestKey,
    catalogError:
      catalogError?.key === catalogRequestKey ? catalogError.message : null,
    now,
    ensureCatalog,
    check: check?.key === key ? check.data : null,
    checking:
      canCheckTicker(chainId, ticker, pads) &&
      (pendingKey === key || (check?.key !== key && checkError?.key !== key)),
    checkError: checkError?.key === key ? checkError.message : null,
    runCheck,
  };
}
