import { createHash, randomUUID } from 'node:crypto';
import { o1Metadata } from '../../web/lib/long-encoding/o1-metadata.mjs';
import { ipfsContentId } from './ipfs-content.mjs';
import { pinataGatewayUrl } from './pinata-publisher.mjs';
import { rasterFormat, IMAGE_BYTE_LIMIT } from './launch-image.mjs';
import { ServiceError } from './errors.mjs';
import { checkReadDeadline } from './upstream.mjs';

const fail = () => { throw new ServiceError('o1_metadata_unverified', 503); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function gatewayUrl(value, cid) {
  let url;
  try { url = new URL(value); } catch { fail(); }
  if (url.href !== pinataGatewayUrl(url.hostname, cid)) fail();
  return url.href;
}
async function readAsset(fetcher, url, cid, mime, limit) {
  const response = await fetcher(gatewayUrl(url, cid), { redirect: 'error', credentials: 'omit',
    headers: { accept: mime }, signal: AbortSignal.timeout(5000) });
  if (!response.ok || response.redirected || response.headers.get('content-type')?.split(';')[0].trim() !== mime
    || Number(response.headers.get('content-length')) > limit || !response.body) {
    await response.body?.cancel(); fail();
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) fail(); chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = Buffer.concat(chunks);
  if (await ipfsContentId(bytes) !== cid) fail();
  return bytes;
}

export class O1MetadataPublisher {
  constructor(db, upstream, fetcher, apiKey) {
    this.db = db; this.upstream = upstream; this.fetcher = fetcher; this.apiKey = apiKey;
    db.exec(`CREATE TABLE IF NOT EXISTS o1_metadata_publications (
      id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL, result TEXT
    )`);
  }
  async prepare(id, input, publication, quoteAddress) {
    if (!this.apiKey) fail();
    const expected = o1Metadata(input.draft, publication.ipfs.imageCid), metadataCid = expected.uri.slice(7);
    const identity = { chain_id: 4663, creator: input.wallet, market: input.pairId.startsWith('rwa-') ? 'rwa' : 'standard',
      quote_address: quoteAddress, token: { name: input.draft.name, symbol: input.draft.ticker,
        description: input.draft.description, editable_metadata: input.editableMetadata ?? false, image_type: 'image/webp' } };
    const requestHash = hash(JSON.stringify({ identity, imageHash: input.publication.imageHash, metadataUri: expected.uri }));
    let row = this.db.prepare('SELECT * FROM o1_metadata_publications WHERE id=?').get(id);
    if (row && row.request_hash !== requestHash) fail();
    let pinned = row?.result ? JSON.parse(row.result) : null;
    if (!pinned) {
      const image = await readAsset(this.fetcher, publication.imageUrl, publication.ipfs.imageCid, 'image/webp', IMAGE_BYTE_LIMIT);
      if (hash(image) !== input.publication.imageHash || rasterFormat(image) !== 'webp') fail();
      checkReadDeadline();
      if (!row) {
        // Commit before POST. An uncertain request retries the same provider key
        // and exact payload, including after a restart; never rotate it silently.
        this.db.prepare(`INSERT INTO o1_metadata_publications(id,request_hash,idempotency_key)
          SELECT ?,?,? WHERE (SELECT COUNT(*) FROM o1_metadata_publications) < 4096
          ON CONFLICT(id) DO NOTHING`)
          .run(id, requestHash, randomUUID());
        row = this.db.prepare('SELECT * FROM o1_metadata_publications WHERE id=?').get(id);
        if (!row || row.request_hash !== requestHash) fail();
        if (row.result) {
          try { pinned = JSON.parse(row.result); } catch { fail(); }
        }
      }
      const body = JSON.stringify({ ...identity, token: { ...identity.token, image_base64: image.toString('base64') } });
      for (let attempt = 0; !pinned && attempt < 2; attempt++) {
        checkReadDeadline();
        const usedKey = row.idempotency_key;
        let response;
        try {
          response = await this.upstream.json('o1', 'https://api.launch.o1.exchange/v1/launches/prepare', {
            method: 'POST', credentials: 'omit', headers: { 'x-api-key': this.apiKey, 'Idempotency-Key': usedKey,
              'content-type': 'application/json' }, body,
          }, 32768, 20, { problemCodes: ['stale_plan'] });
        } catch (error) {
          if (!(error instanceof ServiceError) || error.code !== 'stale_plan' || attempt !== 0) {
            if (error instanceof ServiceError && error.code === 'stale_plan') fail();
            throw error;
          }
          checkReadDeadline();
          // O1 expires completed preparation records. Rotate only the exact
          // unresolved request which received stale_plan. The conditional update
          // is atomic, so concurrent recovery calls converge on one durable key.
          this.db.prepare(`UPDATE o1_metadata_publications SET idempotency_key=?
            WHERE id=? AND request_hash=? AND idempotency_key=? AND result IS NULL`)
            .run(randomUUID(), id, requestHash, usedKey);
          row = this.db.prepare('SELECT * FROM o1_metadata_publications WHERE id=?').get(id);
          if (!row || row.request_hash !== requestHash) fail();
          if (row.result) {
            try { pinned = JSON.parse(row.result); } catch { fail(); }
          } else if (row.idempotency_key === usedKey) fail();
          continue;
        }
        const data = response?.data;
        if (data?.chain_id !== 4663 || data.actor?.toLowerCase() !== input.wallet.toLowerCase()
          || data.metadata_uri !== expected.uri) fail();
        const next = { metadataUri: expected.uri, imageUrl: gatewayUrl(data.image_url, publication.ipfs.imageCid) };
        const saved = JSON.stringify(next);
        // Use the native pinning result only. Our independent launch builder still
        // controls calldata, fee, salt, nonce and recovery.
        this.db.prepare(`UPDATE o1_metadata_publications SET result=?
          WHERE id=? AND request_hash=? AND idempotency_key=? AND result IS NULL`)
          .run(saved, id, requestHash, usedKey);
        row = this.db.prepare('SELECT * FROM o1_metadata_publications WHERE id=?').get(id);
        if (!row || row.request_hash !== requestHash || !row.result) fail();
        try { pinned = JSON.parse(row.result); } catch { fail(); }
        if (JSON.stringify(pinned) !== saved) fail();
      }
      if (!pinned) fail();
    }
    if (pinned.metadataUri !== expected.uri) fail();
    const metadataUrl = new URL(`/ipfs/${metadataCid}`, gatewayUrl(pinned.imageUrl, publication.ipfs.imageCid)).href;
    const metadata = await readAsset(this.fetcher, metadataUrl, metadataCid, 'application/json', expected.bytes.length);
    if (!metadata.equals(Buffer.from(expected.bytes))) fail();
    const image = await readAsset(this.fetcher, pinned.imageUrl, publication.ipfs.imageCid, 'image/webp', IMAGE_BYTE_LIMIT);
    if (hash(image) !== input.publication.imageHash) fail();
    checkReadDeadline();
    return pinned;
  }
}
