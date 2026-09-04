const operations = new Set([
  'catalog',
  'ticker',
  'fees',
  'claim-prepare',
  'tracked-prices',
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
  const unavailable = () =>
    Response.json({ error: 'unavailable' }, { status: 503, headers });
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
  try {
    const backend = new URL(backendOrigin);
    if (
      backend.origin !== backendOrigin ||
      backend.protocol !== 'https:' ||
      backend.username ||
      backend.password
    )
      return unavailable();
    if (Number(request.headers.get('content-length')) > 2048)
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
        if (size > 2048)
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
    return new Response(response.body, {
      status: response.status,
      headers: output,
    });
  } catch {
    return unavailable();
  }
}
