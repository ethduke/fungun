'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import type { PublishedAsset } from '@/lib/asset-protocol';
import {
  createDraftWriteQueue,
  draftArtworkKey,
  draftImageBlob,
  DRAFT_CACHE_ERROR,
  emptyLaunchDraft,
  readCachedLaunchDraft,
  sameDraftArtwork,
  updateDraftField,
  validateDraftPublication,
  type LaunchDraft,
} from '@/lib/launch-draft-cache';

export type { DraftImage, LaunchDraft } from '@/lib/launch-draft-cache';
type CacheState = 'loading' | 'saving' | 'saved' | 'unavailable';
type DraftContextValue = {
  draft: LaunchDraft;
  setDraft: Dispatch<SetStateAction<LaunchDraft>>;
  hydrated: boolean;
  cacheState: CacheState;
  cacheError: string;
  retryCache: () => Promise<void>;
};
const DraftContext = createContext<DraftContextValue | null>(null);

export function LaunchDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraftState] = useState<LaunchDraft>(emptyLaunchDraft);
  const [hydrated, setHydrated] = useState(false);
  const [cacheState, setCacheState] = useState<CacheState>('loading');
  const [cacheError, setCacheError] = useState('');
  const hydratedRef = useRef(false);
  const mounted = useRef(false);
  const lastQueued = useRef(draft);
  const writeRevision = useRef(0);
  const [write] = useState(() => createDraftWriteQueue());

  useEffect(() => {
    let active = true;
    mounted.current = true;
    void (async () => {
      try {
        const cached = await readCachedLaunchDraft();
        if (!active) return;
        if (cached) {
          const restored: LaunchDraft = {
            selection: cached.selection,
            name: cached.name,
            ticker: cached.ticker,
            description: cached.description,
            prompt: cached.prompt,
            image: cached.image
              ? {
                  url: URL.createObjectURL(cached.image),
                  size: cached.image.size,
                  blob: cached.image,
                }
              : null,
            published: cached.published,
          };
          lastQueued.current = restored;
          setDraftState(restored);
        }
        setCacheState('saved');
      } catch {
        if (!active) return;
        setCacheState('unavailable');
        setCacheError(DRAFT_CACHE_ERROR);
      } finally {
        if (active) {
          hydratedRef.current = true;
          setHydrated(true);
        }
      }
    })();
    return () => {
      active = false;
      mounted.current = false;
    };
  }, []);

  const setDraft = useCallback<Dispatch<SetStateAction<LaunchDraft>>>(
    (value) => {
      // Hydration owns the draft until the read finishes; early UI events must not
      // overwrite a previous session or pay using the empty server-rendered draft.
      if (!hydratedRef.current) return;
      setDraftState(value);
    },
    [],
  );

  const persist = useCallback(
    async (snapshot: LaunchDraft) => {
      const revision = ++writeRevision.current;
      setCacheState('saving');
      try {
        await write(snapshot);
        if (mounted.current && revision === writeRevision.current) {
          setCacheState('saved');
          setCacheError('');
        }
      } catch {
        if (mounted.current && revision === writeRevision.current) {
          setCacheState('unavailable');
          setCacheError(DRAFT_CACHE_ERROR);
        }
      }
    },
    [write],
  );

  useEffect(() => {
    if (!hydrated || lastQueued.current === draft) return;
    lastQueued.current = draft;
    void persist(draft);
  }, [draft, hydrated, persist]);

  useEffect(() => {
    const url = draft.image?.url;
    return () => {
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    };
  }, [draft.image?.url]);

  const retryCache = useCallback(async () => {
    if (!hydratedRef.current) return;
    await persist(draft);
  }, [draft, persist]);

  return (
    <DraftContext
      value={{ draft, setDraft, hydrated, cacheState, cacheError, retryCache }}
    >
      {children}
    </DraftContext>
  );
}

function useDraftContext() {
  const context = useContext(DraftContext);
  if (!context) throw new Error('Launch draft provider is missing.');
  return context;
}

export function useDraftField<K extends keyof LaunchDraft>(
  key: K,
): [LaunchDraft[K], Dispatch<SetStateAction<LaunchDraft[K]>>] {
  const { draft, setDraft } = useDraftContext();
  const setValue = useCallback(
    (value: SetStateAction<LaunchDraft[K]>) => {
      setDraft((current) =>
        updateDraftField(
          current,
          key,
          typeof value === 'function' ? value(current[key]) : value,
        ),
      );
    },
    [key, setDraft],
  );
  return [draft[key], setValue];
}

export function useDraftCache() {
  const { draft, setDraft, hydrated, cacheState, cacheError, retryCache } =
    useDraftContext();
  const cachePublication = useCallback(
    async (result: PublishedAsset) => {
      if (!hydrated || !draft.image) return;
      const blob = await draftImageBlob(draft.image);
      const publication = validateDraftPublication({
        sourceKey: await draftArtworkKey(draft, blob),
        result,
      });
      if (!publication)
        throw new Error('The published artwork could not be verified.');
      // A completion from an earlier render cannot attach an old URI to edited
      // fields or replacement artwork.
      setDraft((current) =>
        sameDraftArtwork(current, draft)
          ? { ...current, published: publication }
          : current,
      );
    },
    [draft, hydrated, setDraft],
  );
  return {
    hydrated,
    cacheState,
    cacheError,
    retryCache,
    published: draft.published?.result ?? null,
    cachePublication,
  };
}
