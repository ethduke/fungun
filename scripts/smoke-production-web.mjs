import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';

// Executed inside the built production container with --network none. No keys,
// providers, browser wallets, or blockchain requests are needed for these routes.
const port = Number(process.env.PORT || 3000);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Valid production server port required');
const origin = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 45_000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${origin}/healthz`, {
      signal: AbortSignal.timeout(2_000),
      redirect: 'error',
    });
    if (response.status === 200) {
      assert.deepEqual(await response.json(), { status: 'ok' });
      ready = true;
      break;
    }
    await response.body?.cancel();
  } catch {
    // Allow startup to finish; the bounded deadline also catches a crashed server.
  }
  await pause(250);
}
assert.ok(ready, 'Packaged production server did not become healthy within 45 seconds');

for (const [path, contentType] of [
  ['/', 'text/html'],
  ['/fees', 'text/html'],
  ['/llms.txt', 'text/plain'],
]) {
  const response = await fetch(`${origin}${path}`, {
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  assert.equal(response.status, 200, `${path} must be served by the production image`);
  assert.ok(response.headers.get('content-type')?.startsWith(contentType), `${path} content type`);
  const body = await response.text();
  assert.ok(body.length > 0, `${path} must not be empty`);
  if (contentType === 'text/html') assert.match(body, /<html[\s>]/i, `${path} must contain rendered HTML`);
  else assert.match(body, /Fungun/i, '/llms.txt must contain the agent discovery document');
  console.log(`Production smoke passed: ${path}`);
}
