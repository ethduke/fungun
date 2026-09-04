import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  configureReadServiceProxy,
  sendReadServiceUnavailable,
} from '../apps/web/lib/dev-read-proxy.mjs';

function response() {
  return {
    body: '',
    headers: null,
    headersSent: false,
    status: null,
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
      return this;
    },
    end(body) {
      this.body = body;
      this.writableEnded = true;
      return this;
    },
  };
}

test('dev read proxy returns a truthful retryable 503 when its API is offline', () => {
  const proxy = new EventEmitter();
  const output = response();
  configureReadServiceProxy(proxy);
  proxy.emit('error', new Error('synthetic connection failure'), {}, output);
  assert.equal(output.status, 503);
  assert.equal(output.headers['retry-after'], '5');
  assert.equal(output.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(output.body), {
    error: 'read_service_unavailable',
  });
});

test('dev read proxy never overwrites a response already in progress', () => {
  const output = response();
  output.headersSent = true;
  assert.equal(sendReadServiceUnavailable(output), false);
  assert.equal(output.status, null);
  assert.equal(sendReadServiceUnavailable({ end() {} }), false);
});
