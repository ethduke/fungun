import { readAssetJson } from './asset-protocol.ts';

export function createImageProxy(
  configure: () => {
    appOrigin?: string;
    serviceOrigin?: string;
    paymentAsset?: string;
    production: boolean;
  },
  fetcher: typeof fetch = fetch,
) {
  let active = 0;
  const fail = (error: string, status = 503) =>
    Response.json(
      { error },
      { status, headers: { 'cache-control': 'no-store' } },
    );
  return async (request: Request, requestId?: string) => {
    if (active >= 4) return fail('image_busy', 429);
    active++;
    try {
      const config = configure();
      const app = new URL(config.appOrigin || '');
      const backend = new URL(config.serviceOrigin || '');
      if (
        app.origin !== config.appOrigin ||
        app.username ||
        app.password ||
        backend.origin !== config.serviceOrigin ||
        backend.username ||
        backend.password ||
        (app.protocol !== 'https:' &&
          (config.production ||
            !['http://127.0.0.1:3000', 'http://localhost:3000'].includes(
              app.origin,
            ))) ||
        (backend.protocol !== 'https:' &&
          !/^http:\/\/[a-z][a-z0-9-]{0,62}\.internal:8790$/.test(
            backend.origin,
          ) &&
          (config.production || backend.origin !== 'http://127.0.0.1:8790'))
      )
        return fail('image_service_not_configured');
      if (
        new URL(request.url).search ||
        (requestId && !/^[a-f0-9-]{36}$/.test(requestId))
      )
        return fail('not_found', 404);
      if (
        request.method !== (requestId ? 'GET' : 'POST') ||
        request.headers.get('sec-fetch-site') === 'cross-site' ||
        (request.method === 'POST' &&
          request.headers.get('origin') !== app.origin) ||
        request.headers.get('x-fungun-intent') !== 'image-generation'
      )
        return fail('origin_denied', 403);
      const authorization = request.headers.get('authorization') || '';
      if (!/^Bearer [a-f0-9]{64}$/.test(authorization))
        return fail('image_auth_required', 401);
      const signature = request.headers.get('payment-signature');
      if (
        signature &&
        (signature.length > 12000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature))
      )
        return fail('invalid_image_payment', 400);
      let body: unknown;
      if (request.method === 'POST') {
        if (
          request.headers.get('content-type')?.split(';')[0].trim() !==
            'application/json' ||
          request.headers.has('content-encoding')
        )
          return fail('invalid_image_request', 415);
        body = await readAssetJson(request.body, 8192);
      }
      const response = await fetcher(
        `${backend.origin}/v1/images/grok${requestId ? `/${requestId}` : ''}`,
        {
          method: request.method,
          redirect: 'error',
          signal: AbortSignal.timeout(35000),
          headers: {
            origin: app.origin,
            authorization,
            'content-type': 'application/json',
            'x-fungun-intent': 'image-generation',
            ...(signature ? { 'payment-signature': signature } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      const raw = await readAssetJson(response.body);
      if (
        response.status === 402 ||
        (raw && typeof raw === 'object' && 'quote' in raw)
      ) {
        const quote = (
          response.status === 402 ? raw : (raw as { quote: unknown }).quote
        ) as { accepts?: Array<{ asset?: string }> };
        if (
          !config.paymentAsset ||
          quote?.accepts?.length !== 1 ||
          quote.accepts[0].asset?.toLowerCase() !==
            config.paymentAsset.toLowerCase()
        )
          return fail('image_service_not_configured');
      }
      const headers: Record<string, string> = {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      };
      for (const name of ['payment-required', 'payment-response']) {
        const value = response.headers.get(name);
        if (
          value &&
          value.length <= 12000 &&
          /^[A-Za-z0-9+/]+={0,2}$/.test(value)
        )
          headers[name] = value;
      }
      return Response.json(raw, { status: response.status, headers });
    } catch {
      return fail('image_service_not_configured');
    } finally {
      active--;
    }
  };
}
