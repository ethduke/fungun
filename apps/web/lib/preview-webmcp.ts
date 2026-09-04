import { useEffect, useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';

type Context = {
  registerTool: (
    tool: {
      name: string;
      description: string;
      inputSchema: object;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute: (input: unknown) => unknown;
    },
    options: { signal: AbortSignal },
  ) => void | Promise<void>;
};

export function usePreviewTools(
  read: () => unknown,
  stage: (value: { name: string; ticker: string }) => void,
) {
  const current = useRef({ read, stage });
  useLayoutEffect(() => {
    current.current = { read, stage };
  });
  useEffect(() => {
    const context = (document as Document & { modelContext?: Context })
      .modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const tools = [
      {
        name: 'read_launch_preview',
        description:
          'Read the current local draft and validation state. Never includes wallet data, image bytes, or signatures.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: () => current.current.read(),
      },
      {
        name: 'stage_coin_identity',
        description:
          'Set name and ticker in the local draft only. Does not connect a wallet, check availability, sign, pay, or deploy.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 50 },
            ticker: { type: 'string', minLength: 1, maxLength: 11 },
          },
          required: ['name', 'ticker'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: (input: unknown) => {
          if (!input || typeof input !== 'object')
            throw new Error('Expected a name and ticker.');
          const values = input as Record<string, unknown>;
          if (
            Object.keys(values).some(
              (key) => key !== 'name' && key !== 'ticker',
            ) ||
            typeof values.name !== 'string' ||
            !values.name.trim() ||
            Array.from(values.name).length > 50 ||
            typeof values.ticker !== 'string' ||
            !/^[A-Z]{1,11}$/.test(values.ticker.toUpperCase())
          )
            throw new Error(
              'Use a name of 1–50 characters and a ticker of 1–11 letters.',
            );
          const value = {
            name: values.name,
            ticker: values.ticker.toUpperCase(),
          };
          flushSync(() => current.current.stage(value));
          return current.current.read();
        },
      },
    ];
    // Browser extensions may implement only part of the proposed API.
    try {
      for (const tool of tools)
        void Promise.resolve(
          context.registerTool(tool, { signal: lifecycle.signal }),
        ).catch(() => lifecycle.abort());
    } catch {
      lifecycle.abort();
    }
    return () => lifecycle.abort();
  }, []);
}
