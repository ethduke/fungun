const retrySeconds = 5;
const unavailableBody = JSON.stringify({ error: 'read_service_unavailable' });

export function sendReadServiceUnavailable(response) {
  if (
    !response ||
    typeof response.writeHead !== 'function' ||
    typeof response.end !== 'function' ||
    response.headersSent ||
    response.writableEnded
  )
    return false;
  response.writeHead(503, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'retry-after': String(retrySeconds),
    'x-content-type-options': 'nosniff',
  });
  response.end(unavailableBody);
  return true;
}

export function configureReadServiceProxy(proxy) {
  proxy.on('error', (_error, _request, response) => {
    sendReadServiceUnavailable(response);
  });
}
