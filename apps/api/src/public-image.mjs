import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { ServiceError } from './errors.mjs';
import { IMAGE_BYTE_LIMIT } from './launch-image.mjs';

const unavailable = () => { throw new ServiceError('image_unavailable', 404); };
const blocked = new BlockList();
for (const [network, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(network, bits, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [network, bits] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
]) blocked.addSubnet(network, bits, 'ipv6');

export function publicImageAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && !address.includes('%') && globalV6.check(address, 'ipv6')
      && !blocked.check(address, 'ipv6');
}

export function publicImageUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || (/\s/.test(value) || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) unavailable();
  let url;
  try { url = new URL(value); } catch { unavailable(); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !host || host.endsWith('.')
    || (isIP(host) ? !publicImageAddress(host)
      : !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|invalid|test|onion)$/.test(host))) unavailable();
  return url.href;
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class PublicImageReader {
  constructor(upstream, transport = {}) {
    this.upstream = upstream;
    this.lookup = transport.lookup ?? lookup;
    this.request = transport.request ?? request;
  }

  async get(value, outerSignal) {
    let url = publicImageUrl(value);
    const visited = new Set();
    for (let hop = 0; hop <= 3; hop++) {
      outerSignal.throwIfAborted();
      if (visited.has(url)) unavailable();
      visited.add(url);
      const release = await this.upstream.acquire('token-image', false);
      try {
        this.upstream.budget.upstream('token-image');
        const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(4000)]);
        const parsed = new URL(url), host = parsed.hostname.replace(/^\[|\]$/g, '');
        const records = isIP(host) ? [{ address: host, family: isIP(host) }]
          : await abortable(this.lookup(host, { all: true, verbatim: true }), signal);
        // Reject mixed public/private answers, including IPv4-mapped IPv6.
        if (!Array.isArray(records) || !records.length || records.some(record =>
          !publicImageAddress(record.address) || isIP(record.address) !== record.family)) unavailable();
        const address = records.find(record => record.family === 4) ?? records[0];
        signal.throwIfAborted();
        const result = await this.read(parsed, address, signal);
        if (result.bytes) return result.bytes;
        if (hop === 3 || !result.location) unavailable();
        // Each destination gets a new DNS check and its own pinned connection.
        url = publicImageUrl(new URL(result.location, parsed).href);
      } finally { release(); }
    }
    unavailable();
  }

  read(url, address, signal) {
    return new Promise((resolve, reject) => {
      const req = this.request(url, {
        method: 'GET', agent: false, family: address.family, autoSelectFamily: false,
        rejectUnauthorized: true, maxHeaderSize: 16 * 1024, signal,
        // Keep the original hostname for HTTP Host and TLS verification, but
        // never let the socket perform a second, potentially rebound lookup.
        lookup: (_host, options, callback) => options.all
          ? callback(null, [address]) : callback(null, address.address, address.family),
        headers: { accept: 'image/png,image/jpeg,image/webp,image/gif,application/octet-stream',
          'accept-encoding': 'identity', 'user-agent': 'Fungun-Image-Copy/1.0' },
      }, response => {
        (async () => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode))
            return { location: response.headers.location };
          if (response.statusCode !== 200
            || Number(response.headers['content-length']) > IMAGE_BYTE_LIMIT
            || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) unavailable();
          const chunks = [];
          let size = 0;
          for await (const chunk of response) {
            signal.throwIfAborted();
            size += chunk.length;
            if (size > IMAGE_BYTE_LIMIT) unavailable();
            chunks.push(chunk);
          }
          if (!size) unavailable();
          return { bytes: Buffer.concat(chunks) };
        })().then(resolve, reject).finally(() => response.destroy());
      });
      req.on('error', reject);
      req.end();
    });
  }
}
