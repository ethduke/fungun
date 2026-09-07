const operations = new Set([
  'fomo',
  'stonks-feed',
  'catalog',
  'ticker',
  'fees',
  'claim-prepare',
  'tracked-prices',
  'launch-prepare',
  'launch-reserve',
  'launch-status',
  'launch-estimate',
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ operation: string }> },
) {
  const { operation } = await params;
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  const unavailable = (retryAfter = '5') =>
    Response.json(
      { error: 'read_service_unavailable' },
      {
        status: 503,
        headers: { ...headers, 'retry-after': retryAfter },
      },
    );
  const timedOut = (retryAfter = '5') =>
    Response.json(
      { error: 'timeout' },
      {
        status: 504,
        headers: { ...headers, 'retry-after': retryAfter },
      },
    );
  if (!operations.has(operation))
    return Response.json({ error: 'not_found' }, { status: 404, headers });
  const origin = process.env.APP_ORIGIN;
  const backendOrigin = process.env.READ_SERVICE_ORIGIN;
  if (!origin || !backendOrigin) return unavailable();
  if (
    request.headers.get('origin') !== origin ||
    request.headers.get('x-fungun-intent') !== operation ||
    request.headers.get('content-type')?.split(';')[0].trim() !==
      'application/json' ||
    request.headers.has('content-encoding')
  )
    return Response.json(
      { error: 'invalid_request' },
      { status: 403, headers },
    );
  const bodyLimit = operation.startsWith('launch-') ? 4096 : 2048;
  try {
    const backend = new URL(backendOrigin);
    if (
      backend.origin !== backendOrigin ||
      backend.protocol !== 'https:' ||
      backend.username ||
      backend.password
    )
      return unavailable();
    if (Number(request.headers.get('content-length')) > bodyLimit)
      return Response.json(
        { error: 'request_too_large' },
        { status: 413, headers },
      );
    const reader = request.body?.getReader();
    if (!reader)
      return Response.json(
        { error: 'invalid_request' },
        { status: 400, headers },
      );
    const chunks: Uint8Array[] = [];
    let size = 0;
    let bodyTimedOut = false;
    const bodyDeadline = setTimeout(() => {
      bodyTimedOut = true;
      void reader.cancel();
    }, 3000);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > bodyLimit)
          return Response.json(
            { error: 'request_too_large' },
            { status: 413, headers },
          );
        chunks.push(value);
      }
    } finally {
      clearTimeout(bodyDeadline);
      await reader.cancel();
    }
    if (bodyTimedOut)
      return Response.json(
        { error: 'request_timeout' },
        { status: 408, headers },
      );
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    const response = await fetch(new URL(`/v1/${operation}`, backend), {
      method: 'POST',
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(23_000),
      headers: {
        origin,
        'content-type': 'application/json',
        'x-fungun-intent': operation,
      },
    });
    const output = new Headers(headers);
    output.set('content-type', 'application/json');
    const retry = response.headers.get('retry-after');
    if (retry && /^\d{1,5}$/.test(retry)) output.set('retry-after', retry);
    if (response.status === 502) {
      await response.body?.cancel();
      return unavailable(retry && /^\d{1,5}$/.test(retry) ? retry : undefined);
    }
    if (response.status === 504) {
      await response.body?.cancel();
      return timedOut(retry && /^\d{1,5}$/.test(retry) ? retry : undefined);
    }
    if (response.headers.get('x-fungun-retry-scope') === 'operation')
      output.set('x-fungun-retry-scope', 'operation');
    return new Response(response.body, {
      status: response.status,
      headers: output,
    });
  } catch {
    return unavailable();
  }
}
