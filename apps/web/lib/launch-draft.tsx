'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  DEFAULT_CHAIN_ID,
  DEFAULT_DESTINATIONS,
  type ChainId,
  type Destination,
} from '@/lib/launch-model';

type LaunchDraft = {
  selection: { chainId: ChainId; destinations: Destination[] };
  name: string;
  ticker: string;
  description: string;
  prompt: string;
  image: { url: string; size: number } | null;
};

const DraftContext = createContext<{
  draft: LaunchDraft;
  setDraft: Dispatch<SetStateAction<LaunchDraft>>;
} | null>(null);

export function LaunchDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<LaunchDraft>({
    selection: {
      chainId: DEFAULT_CHAIN_ID,
      destinations: DEFAULT_DESTINATIONS,
    },
    name: '',
    ticker: '',
    description: '',
    prompt: '',
    image: null,
  });
  useEffect(
    () => () => {
      if (draft.image) URL.revokeObjectURL(draft.image.url);
    },
    [draft.image],
  );
  return <DraftContext value={{ draft, setDraft }}>{children}</DraftContext>;
}

export function useDraftField<K extends keyof LaunchDraft>(
  key: K,
): [LaunchDraft[K], Dispatch<SetStateAction<LaunchDraft[K]>>] {
  const context = useContext(DraftContext);
  if (!context) throw new Error('Launch draft provider is missing.');
  const { draft, setDraft } = context;
  const setValue = useCallback(
    (value: SetStateAction<LaunchDraft[K]>) => {
      setDraft((current) => ({
        ...current,
        [key]: typeof value === 'function' ? value(current[key]) : value,
      }));
    },
    [key, setDraft],
  );
  return [draft[key], setValue];
}
