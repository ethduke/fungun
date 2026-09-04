import assert from 'node:assert/strict';
import test from 'node:test';
import { POST } from '../app/api/[operation]/route.ts';

await test('production proxy allowlists operations and origin without forwarding user credentials', async () => {
  const previousOrigin = process.env.APP_ORIGIN;
  const previousBackend = process.env.READ_SERVICE_ORIGIN;
  const originalFetch = globalThis.fetch;
  const origin = 'https://app.example.invalid';
  const request = (value = { chainId: 4663 }, extra = {}) =>
    new Request(`${origin}/api/catalog`, {
      method: 'POST',
      body: JSON.stringify(value),
      headers: {
        origin,
        'content-type': 'application/json',
        'x-fungun-intent': 'catalog',
        ...extra,
      },
    });
  const params = Promise.resolve({ operation: 'catalog' });
  let calls = 0;
  try {
    delete process.env.READ_SERVICE_ORIGIN;
    assert.equal((await POST(request(), { params })).status, 503);
    process.env.APP_ORIGIN = origin;
    process.env.READ_SERVICE_ORIGIN = 'https://backend.example.invalid';
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.ok(url instanceof URL);
      assert.equal(url.href, 'https://backend.example.invalid/v1/catalog');
      assert.equal(options?.redirect, 'error');
      assert.deepEqual(options?.headers, {
        origin,
        'content-type': 'application/json',
        'x-fungun-intent': 'catalog',
      });
      assert.equal(
        new TextDecoder().decode(options?.body as Uint8Array),
        '{"chainId":4663}',
      );
      return Response.json(
        { error: 'rate_limited' },
        {
          status: 429,
          headers: {
            'retry-after': '30',
            'x-fungun-retry-scope': 'operation',
            'set-cookie': 'private=EXAMPLE',
          },
        },
      );
    };
    const response = await POST(
      request(undefined, {
        cookie: 'private=EXAMPLE',
        'x-forwarded-for': '192.0.2.1',
      }),
      { params },
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '30');
    assert.equal(response.headers.get('x-fungun-retry-scope'), 'operation');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(
      (
        await POST(request(undefined, { origin: 'https://attacker.invalid' }), {
          params,
        })
      ).status,
      403,
    );
    assert.equal(
      (await POST(request(), { params: Promise.resolve({ operation: 'rpc' }) }))
        .status,
      404,
    );
    assert.equal(
      (
        await POST(
          request({ chainId: 4663, extra: 'a'.repeat(2100) } as {
            chainId: number;
          }),
          { params },
        )
      ).status,
      413,
    );
    process.env.READ_SERVICE_ORIGIN = 'http://backend.example.invalid';
    assert.equal((await POST(request(), { params })).status, 503);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousOrigin;
    if (previousBackend === undefined) delete process.env.READ_SERVICE_ORIGIN;
    else process.env.READ_SERVICE_ORIGIN = previousBackend;
  }
});

await test('proxy cancels an unfinished body before contacting the backend', async () => {
  const previousOrigin = process.env.APP_ORIGIN;
  const previousBackend = process.env.READ_SERVICE_ORIGIN;
  const originalFetch = globalThis.fetch;
  let canceled = false;
  try {
    process.env.APP_ORIGIN = 'https://app.example.invalid';
    process.env.READ_SERVICE_ORIGIN = 'https://backend.example.invalid';
    globalThis.fetch = async () => {
      assert.fail('No backend fetch before a complete body');
    };
    const request = new Request('https://app.example.invalid/api/catalog', {
      method: 'POST',
      duplex: 'half',
      headers: {
        origin: process.env.APP_ORIGIN,
        'content-type': 'application/json',
        'x-fungun-intent': 'catalog',
      },
      body: new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
    } as RequestInit);
    const response = await POST(request, {
      params: Promise.resolve({ operation: 'catalog' }),
    });
    assert.equal(response.status, 408);
    assert.equal(canceled, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousOrigin;
    if (previousBackend === undefined) delete process.env.READ_SERVICE_ORIGIN;
    else process.env.READ_SERVICE_ORIGIN = previousBackend;
  }
});

await test('fee and claim preparation use fixed backend routes without forwarded credentials', async () => {
  const previousOrigin = process.env.APP_ORIGIN;
  const previousBackend = process.env.READ_SERVICE_ORIGIN;
  const originalFetch = globalThis.fetch;
  const origin = 'https://app.example.invalid';
  try {
    process.env.APP_ORIGIN = origin;
    process.env.READ_SERVICE_ORIGIN = 'https://backend.example.invalid';
    for (const operation of ['fees', 'claim-prepare']) {
      const body =
        operation === 'fees'
          ? { address: `0x${'a'.repeat(40)}`, chainId: 4663, padId: 'long' }
          : { address: `0x${'a'.repeat(40)}`, positionId: 'a'.repeat(64) };
      globalThis.fetch = async (url, options) => {
        assert.equal(
          (url as URL).href,
          `https://backend.example.invalid/v1/${operation}`,
        );
        assert.equal(new Headers(options?.headers).get('cookie'), null);
        assert.equal(
          new Headers(options?.headers).get('x-fungun-intent'),
          operation,
        );
        return Response.json({ status: 'unavailable' });
      };
      const response = await POST(
        new Request(`${origin}/api/${operation}`, {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            'x-fungun-intent': operation,
            cookie: 'private=EXAMPLE',
          },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ operation }) },
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousOrigin;
    if (previousBackend === undefined) delete process.env.READ_SERVICE_ORIGIN;
    else process.env.READ_SERVICE_ORIGIN = previousBackend;
  }
});
