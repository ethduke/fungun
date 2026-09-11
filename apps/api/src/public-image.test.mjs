import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { PublicImageReader, publicImageAddress, publicImageUrl } from './public-image.mjs';
import { ServiceError } from './errors.mjs';

const credentialUrl = new URL('https://images.example.com/a');
credentialUrl.username = 'EXAMPLE';
credentialUrl.password = 'EXAMPLE';
const publicIP = { address: '8.8.8.8', family: 4 };
function fixture({ records = [publicIP], respond = () => ({ chunks: [Buffer.from('image')] }), lookup } = {}) {
  const requests = [], lookups = [], charges = [];
  let active = 0;
  const reader = new PublicImageReader({
    acquire: async () => { active++; return () => { active--; }; },
    budget: { upstream: provider => charges.push(provider) },
  }, {
    lookup: async (...args) => { lookups.push(args); return lookup ? lookup(...args) : records; },
    request(url, options, callback) {
      const req = new EventEmitter();
      req.end = () => queueMicrotask(() => {
        requests.push({ url: url.href, options });
        options.lookup(url.hostname, {}, (error, address, family) => {
          const expected = records.find(record => record.family === 4) ?? records[0];
          assert.equal(error, null); assert.equal(address, expected.address); assert.equal(family, expected.family);
        });
        options.lookup(url.hostname, { all: true }, (error, addresses) => {
          assert.equal(error, null); assert.deepEqual(addresses, [records.find(record => record.family === 4) ?? records[0]]);
        });
        const output = respond(url, requests.length);
        const response = Readable.from(output.chunks ?? []);
        response.statusCode = output.status ?? 200;
        response.headers = output.headers ?? {};
        callback(response);
      });
      return req;
    },
  });
  return { reader, requests, lookups, charges, active: () => active };
}
const signal = () => new AbortController().signal;

test('public HTTPS images accept any host, query strings and extensionless paths', async () => {
  for (const url of ['https://files.catbox.moe/abc123.png', 'https://images.example.com/art/123',
    'https://other.example.org/image?width=500&format=png', 'https://pbs.twimg.com/media/photo?format=jpg']) {
    const f = fixture();
    assert.equal((await f.reader.get(url, signal())).toString(), 'image');
    assert.equal(f.lookups.length, 1);
    const request = f.requests[0];
    assert.equal(request.url, url);
    assert.equal(request.options.agent, false);
    assert.equal(request.options.rejectUnauthorized, true);
    assert.equal(request.options.headers.authorization, undefined);
    assert.equal(request.options.headers.cookie, undefined);
    assert.deepEqual(f.charges, ['token-image']);
    assert.equal(f.active(), 0);
  }
});

test('non-public address forms and unsafe URLs are rejected', () => {
  for (const ip of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.0.1', '192.0.0.8', '198.18.0.1', '203.0.113.1', '224.0.0.1',
    '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::808:808',
    'fc00::1', 'fe80::1', '2001:db8::1', '2001::1', '2002:7f00:1::', '3fff::1'])
    assert.equal(publicImageAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(publicImageAddress(ip), true);
  for (const url of ['http://images.example.com/a', 'file:///etc/passwd', 'https://localhost/a',
    'https://private.internal/a', 'https://127.0.0.1/a', 'https://2130706433/a', 'https://0x7f000001/a',
    'https://[::ffff:127.0.0.1]/a', credentialUrl.href,
    'https://images.example.com:8443/a', 'https://images.example.com/a#x', 'https://images.example.com/a\nb'])
    assert.throws(() => publicImageUrl(url), { code: 'image_unavailable' });
});

test('private and mixed DNS responses never start a connection', async () => {
  for (const records of [[], [{ address: '127.0.0.1', family: 4 }],
    [publicIP, { address: '10.0.0.1', family: 4 }], [{ address: '::ffff:127.0.0.1', family: 6 }]]) {
    const f = fixture({ records });
    await assert.rejects(f.reader.get('https://images.example.com/a', signal()));
    assert.equal(f.requests.length, 0); assert.equal(f.active(), 0);
  }
});

test('relative and cross-host redirects revalidate DNS and keep credentials absent', async () => {
  const f = fixture({ respond: (_url, n) => n < 3 ? { status: 302,
    headers: { location: n === 1 ? '/next?format=png' : 'https://cdn.example.org/final' } }
    : { chunks: [Buffer.from('image')] } });
  assert.equal((await f.reader.get('https://images.example.com/a', signal())).toString(), 'image');
  assert.deepEqual(f.lookups.map(([host]) => host), ['images.example.com', 'images.example.com', 'cdn.example.org']);
  assert.equal(f.requests.length, 3); assert.equal(f.active(), 0);
});

test('redirects cannot reach private networks or bypass DNS rebinding checks', async () => {
  for (const location of ['http://example.com/a', 'https://127.0.0.1/a', 'https://service.internal/a']) {
    const f = fixture({ respond: () => ({ status: 302, headers: { location } }) });
    await assert.rejects(f.reader.get('https://images.example.com/a', signal()));
    assert.equal(f.requests.length, 1); assert.equal(f.active(), 0);
  }
  let queries = 0;
  const rebound = fixture({ lookup: async () => ++queries === 1 ? [publicIP] : [{ address: '10.0.0.1', family: 4 }],
    respond: () => ({ status: 302, headers: { location: '/second' } }) });
  await assert.rejects(rebound.reader.get('https://images.example.com/a', signal()));
  assert.equal(rebound.requests.length, 1);
});

test('loops, too many redirects, oversize bodies, encodings and HTTP errors are bounded', async () => {
  for (const respond of [() => ({ status: 302, headers: { location: '/a' } }),
    (_url, n) => ({ status: 302, headers: { location: `/next${n}` } }),
    () => ({ chunks: [Buffer.alloc(2 * 1024 * 1024 + 1)] }),
    () => ({ headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
    () => ({ headers: { 'content-encoding': 'gzip' }, chunks: [Buffer.from('compressed')] }),
    () => ({ status: 404 }), () => ({ chunks: [] })]) {
    const f = fixture({ respond });
    await assert.rejects(f.reader.get('https://images.example.com/a', signal()));
    assert.ok(f.requests.length <= 4); assert.equal(f.active(), 0);
  }
});

test('aborts release admission even while DNS is stalled; budgets still apply', async () => {
  const f = fixture({ lookup: () => new Promise(() => {}) });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5);
  try { await assert.rejects(f.reader.get('https://images.example.com/a', controller.signal)); }
  finally { clearTimeout(timer); }
  assert.equal(f.requests.length, 0); assert.equal(f.active(), 0);
  const limited = fixture();
  limited.reader.upstream.budget.upstream = () => { throw new ServiceError('rate_limited', 429); };
  await assert.rejects(limited.reader.get('https://images.example.com/a', signal()), { code: 'rate_limited' });
  assert.equal(limited.active(), 0);
});

test('public IPv6-only hosts retain pinned address and TLS validation', async () => {
  const f = fixture({ records: [{ address: '2606:4700:4700::1111', family: 6 }] });
  assert.equal((await f.reader.get('https://images.example.com/a', signal())).toString(), 'image');
  assert.equal(f.requests[0].options.family, 6);
  assert.equal(f.requests[0].options.rejectUnauthorized, true);
});
