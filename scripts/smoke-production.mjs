import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';

export const productionOrigins = Object.freeze({ web: 'https://farmgun.fun', api: 'https://farmgun-api.fly.dev' });

// Only public, read-only routes. Never prepare, pay, claim, sign, or submit a
// transaction against production as a deployment probe.
export async function smokeProduction({ request = fetch, sleep = pause, attempts = 20, timeoutMs = 120_000, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      for (const kind of ['api', 'web']) {
        const response = await get(`${productionOrigins[kind]}/healthz`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-fungun-staging'), null);
        assert.deepEqual(await response.json(), { status: 'ok' });
      }
      for (const path of ['/', '/fees', '/llms.txt']) {
        const response = await get(`${productionOrigins.web}${path}`);
        assert.equal(response.status, 200);
        const html = path !== '/llms.txt';
        assert.ok(response.headers.get('content-type')?.startsWith(html ? 'text/html' : 'text/plain'));
        assert.match(await response.text(), html ? /<html[\s>]/i : /Fungun/i);
      }
      return;
    } catch {
      if (attempt === attempts - 1 || now() >= deadline) throw new Error('Production health or page check failed.');
      await sleep(Math.min(3000, deadline - now()));
    }
  }
  async function get(url) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('Production probe deadline exceeded.');
    return request(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(Math.min(10_000, remaining)) });
  }
}
