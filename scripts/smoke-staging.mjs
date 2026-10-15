import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const stagingOrigins = Object.freeze({
  web: 'https://farmgun-staging-web.fly.dev',
  api: 'https://farmgun-staging-api.fly.dev',
});

export const samplePreparation = Object.freeze({
  chainId: 4663,
  wallet: `0x${'1'.repeat(40)}`,
  pairId: 'long-NVDA',
  draft: { name: 'Staging sample', ticker: 'SAMPLE', description: 'Mock deployment check' },
  publication: { id: 'a'.repeat(48), imageHash: 'b'.repeat(64), metadataHash: 'c'.repeat(64) },
});

export async function smokeStaging({ request = fetch, sleep = pause, origins = stagingOrigins, attempts = 24 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      for (const kind of ['api', 'web']) {
        const response = await request(`${origins[kind]}/healthz`, {
          redirect: 'error', signal: AbortSignal.timeout(10_000),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: 'ok' });
        if (kind === 'api') assert.equal(response.headers.get('x-fungun-staging'), 'mock');
      }
      const page = await request(origins.web, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<html[\s>]/i);
      // Send only synthetic input through the deployed web-to-API boundary.
      const prepared = await request(`${origins.web}/api/launch-prepare`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { origin: origins.web, 'content-type': 'application/json', 'x-fungun-intent': 'launch-prepare' },
        body: JSON.stringify(samplePreparation),
      });
      assert.equal(prepared.status, 200);
      const body = await prepared.json();
      assert.equal(body.mode, 'mock');
      assert.equal(body.status, 'staging_only');
      assert.deepEqual(body.transactions, []);
      assert.match(body.id, /^[a-f0-9]{64}$/);
      return;
    } catch {
      if (attempt === attempts - 1) throw new Error('Staging health or mocked preparation check failed.');
      await sleep(3000);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await smokeStaging();
  console.log('Staging health, page and mocked launch preparation passed.');
}
