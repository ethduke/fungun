const REGISTRY_URL =
  'https://docs.o1.exchange/launchpad/reference/launch-contract-suites.json';
const DAY_MS = 86_400_000;
const RETRY_MS = 300_000;
const MAX_BYTES = 65_536;

export function parseO1Hooks(payload) {
  if (
    payload?.schemaVersion !== 1 ||
    payload.project !== 'o1 Launchpad' ||
    payload.environment !== 'production' ||
    !Array.isArray(payload.chains)
  )
    throw new Error('Invalid O1 registry');
  const hooks = new Map();
  for (const chain of payload.chains) {
    if (chain.chainId !== 4663) continue;
    if (!Array.isArray(chain.suites)) throw new Error('Invalid O1 suites');
    for (const suite of chain.suites) {
      const hook = suite?.contracts?.hook;
      const routes = suite?.creationRoutes;
      if (
        typeof hook !== 'string' ||
        !/^0x[0-9a-f]{40}$/i.test(hook) ||
        /^0x0{40}$/i.test(hook) ||
        !Array.isArray(routes) ||
        !routes.length ||
        routes.some((route) => !['standard', 'rwa'].includes(route))
      )
        throw new Error('Invalid O1 hook');
      const key = `${chain.chainId}:${hook.toLowerCase()}`;
      const existing = hooks.get(key) ?? [];
      hooks.set(key, [...new Set([...existing, ...routes])]);
    }
  }
  if (!hooks.size) throw new Error('Missing Robinhood hooks');
  return hooks;
}

export function createO1HookRegistry({
  fetcher = (url, options) => fetch(url, options),
  now = () => performance.now(),
} = {}) {
  let hooks = null,
    nextReadAt = 0,
    pending = null;
  async function refresh() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetcher(REGISTRY_URL, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Accept: 'application/json' },
      });
      if (
        !response.ok ||
        !response.headers.get('content-type')?.includes('application/json')
      ) {
        await response.body?.cancel();
        throw new Error('Registry unavailable');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0,
        body = '';
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_BYTES) {
            await reader.cancel();
            throw new Error('Registry too large');
          }
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      hooks = parseO1Hooks(JSON.parse(body));
      nextReadAt = now() + DAY_MS;
    } catch {
      // Preserve historical recognition when the documentation host is down.
      nextReadAt = now() + RETRY_MS;
    } finally {
      clearTimeout(timeout);
    }
    return hooks;
  }
  return function getHooks() {
    if (now() < nextReadAt) return Promise.resolve(hooks);
    pending ??= refresh().finally(() => {
      pending = null;
    });
    return pending;
  };
}

export const getO1Hooks = createO1HookRegistry();
