import {
  ASSET_BODY_LIMIT,
  AssetError,
  assetDraft,
  assetOrigin,
  assetWallet,
  imageBytes,
  objectFields,
  readAssetJson,
  validateAssetPreview,
  validatePublishedAsset,
  validateProcessingAsset,
  validateExpiredAsset,
  type AssetApproval,
} from './asset-protocol.ts';

type Config = {
  appOrigin?: string;
  serviceOrigin?: string;
  publicOrigin?: string;
  enabled: boolean;
  production: boolean;
};
export function createAssetProxy(
  configure: () => Config,
  fetcher: typeof fetch = fetch,
) {
  let active = 0;
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  const fail = (error: string, status = 503, retryAfter = 0) =>
    Response.json(
      { error },
      {
        status,
        headers: {
          ...headers,
          ...(retryAfter ? { 'retry-after': String(retryAfter) } : {}),
        },
      },
    );
  return async (request: Request, operation: string) => {
    if (
      !['prepare', 'publish', 'status', 'launch-prepare', 'launch-publish'].includes(operation) ||
      new URL(request.url).search
    )
      return fail('not_found', 404);
    const launch = operation.startsWith('launch-');
    const kind = launch ? operation.slice(7) : operation;
    if (active >= 4) return fail('asset_busy', 429, 2);
    active++;
    try {
      const config = configure();
      if (kind !== 'status' && !config.enabled)
        return fail('asset_uploads_disabled');
      const origin = assetOrigin(config.appOrigin, !config.production);
      const publicOrigin = assetOrigin(config.publicOrigin);
      if (!config.serviceOrigin) return fail('unavailable');
      const backend = new URL(config.serviceOrigin);
      const privateService =
        /^http:\/\/[a-z][a-z0-9-]{0,62}\.internal:8790$/.test(
          config.serviceOrigin,
        );
      const localService =
        !config.production && config.serviceOrigin === 'http://127.0.0.1:8790';
      if (
        backend.origin !== config.serviceOrigin ||
        backend.username ||
        backend.password ||
        (backend.protocol !== 'https:' && !privateService && !localService)
      )
        return fail('unavailable');
      if (
        request.method !== 'POST' ||
        request.headers.get('origin') !== origin ||
        request.headers.get('sec-fetch-site') === 'cross-site' ||
        request.headers.get('x-fungun-intent') !== `asset-${operation}` ||
        request.headers.get('content-type')?.split(';')[0].trim() !==
          'application/json' ||
        request.headers.has('content-encoding')
      )
        return fail('invalid_request', 403);
      const limit = kind === 'status' ? 2048 : ASSET_BODY_LIMIT;
      if (Number(request.headers.get('content-length')) > limit)
        return fail('image_size', 413);
      const value = await readAssetJson(request.body, limit);
      const fields =
        kind === 'status'
          ? ['chainId', 'wallet', 'id', 'imageHash', 'metadataHash']
          : [
              'chainId',
              'wallet',
              'draft',
              'imageBase64',
              ...(kind === 'publish' ? ['id', launch ? 'uploadToken' : 'signature'] : []),
            ];
      if (!objectFields(value, fields) || value.chainId !== 4663)
        return fail('invalid_request', 400);
      const wallet = assetWallet(value.wallet);
      if (kind !== 'status') {
        assetDraft(value.draft);
        imageBytes(value.imageBase64);
      }
      if (
        kind !== 'prepare' &&
        (typeof value.id !== 'string' || !/^[a-f0-9]{48}$/.test(value.id))
      )
        return fail('invalid_request', 400);
      if (
        kind === 'publish' &&
        (launch ? typeof value.uploadToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.uploadToken)
          : typeof value.signature !== 'string' || !/^0x[a-f0-9]{130}$/i.test(value.signature))
      )
        return fail('invalid_request', 400);
      if (
        kind === 'status' &&
        [value.imageHash, value.metadataHash].some(
          (hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash),
        )
      )
        return fail('invalid_request', 400);
      const startedAt = performance.now();
      const response = await fetcher(
        new URL(`/v1/asset-${operation}`, backend),
        {
          method: 'POST',
          body: JSON.stringify(value),
          redirect: 'error',
          signal: AbortSignal.timeout(16000),
          headers: {
            origin,
            'content-type': 'application/json',
            'x-fungun-intent': `asset-${operation}`,
          },
        },
      );
      if (
        response.headers.get('content-type')?.split(';')[0].trim() !==
        'application/json'
      ) {
        await response.body?.cancel();
        return fail('unavailable');
      }
      const raw = await readAssetJson(
        response.body,
        kind === 'prepare' ? ASSET_BODY_LIMIT : 4096,
      );
      if (!response.ok) {
        const code =
          raw &&
          typeof raw === 'object' &&
          'error' in raw &&
          typeof raw.error === 'string' &&
          /^[a-z_]{1,40}$/.test(raw.error)
            ? raw.error
            : 'unavailable';
        const allowed = [
          'asset_uploads_disabled',
          'asset_approval_changed',
          'asset_approval_expired',
          'invalid_asset_approval',
          'asset_publication_uncertain',
          'ipfs_approval_pending',
          'ipfs_publication_disabled',
          'ipfs_configuration',
          'ipfs_verification_unavailable',
          'asset_storage_full',
          'asset_history_full',
          'asset_integrity_failed',
          'rate_limited',
          'artwork_daily_limit',
          'artwork_service_limit',
          'asset_busy',
          'image_size',
          'image_dimensions',
          'image_animated',
          'image_format',
          'image_decode',
          'image_timeout',
          'image_output_size',
          'invalid_launch_details',
        ];
        const retry = Number(response.headers.get('retry-after'));
        return fail(
          allowed.includes(code) ? code : 'unavailable',
          [400, 403, 404, 409, 413, 415, 429, 503, 507].includes(
            response.status,
          )
            ? response.status
            : 503,
          Number.isInteger(retry) && retry > 0 ? Math.min(retry, 86400) : 0,
        );
      }
      if (kind === 'prepare') {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
          return fail('invalid_asset_response');
        const payload = { ...raw, assetOrigin: publicOrigin };
        await validateAssetPreview(payload, {
          wallet,
          draft: assetDraft(value.draft),
          appOrigin: origin,
          startedAt,
          launch,
        });
        return Response.json(payload, { headers });
      }
      if (
        kind === 'status' &&
        objectFields(raw, ['id', 'status']) &&
        raw.id === value.id &&
        ['pending', 'uncertain'].includes(raw.status as string)
      )
        return Response.json(raw, { headers });
      const ipfs = raw && typeof raw === 'object' && 'ipfs' in raw ? raw.ipfs : undefined;
      const expected = {
        id: String(value.id),
        imageHash: String(value.imageHash),
        metadataHash: String(value.metadataHash),
        imageUrl: `${publicOrigin}/launch-assets/${String(value.imageHash)}.webp`,
        metadataUrl: `${publicOrigin}/launch-assets/${String(value.metadataHash)}.json`,
        ...(ipfs ? { ipfs } : {}),
      };
      if (ipfs) {
        if (!objectFields(ipfs, ['profile','schema','imageCid','metadataCid'])
          || ipfs.profile !== 'pinata-v1-256k' || ipfs.schema !== 'long-ipfs-v1'
          || !/^b[a-z2-7]{58}$/.test(String(ipfs.imageCid))
          || !/^b[a-z2-7]{58}$/.test(String(ipfs.metadataCid)))
          return fail('invalid_asset_response');
        expected.imageUrl = `${publicOrigin}/ipfs/${String(ipfs.imageCid)}`;
        expected.metadataUrl = `${publicOrigin}/ipfs/${String(ipfs.metadataCid)}`;
      }
      if (
        kind === 'status' &&
        raw &&
        typeof raw === 'object' &&
        'status' in raw &&
        raw.status === 'expired'
      )
        return Response.json(validateExpiredAsset(raw, expected), { headers });
      if (kind === 'publish') {
        const { assetHash } = await import('./asset-protocol.ts');
        const draft = assetDraft(value.draft);
        const image = imageBytes(value.imageBase64);
        expected.imageHash = await assetHash(image);
        if (ipfs) {
          const { IPFS_PROFILE, IPFS_SCHEMA, ipfsContentId, ipfsMetadata } = await import('./ipfs-content.ts');
          const imageCid = await ipfsContentId(image);
          const metadata = ipfsMetadata(draft, imageCid);
          const metadataCid = await ipfsContentId(metadata);
          expected.metadataHash = await assetHash(metadata);
          expected.imageUrl = `${publicOrigin}/ipfs/${imageCid}`;
          expected.metadataUrl = `${publicOrigin}/ipfs/${metadataCid}`;
          expected.ipfs = { profile: IPFS_PROFILE, schema: IPFS_SCHEMA, imageCid, metadataCid };
        } else {
          expected.imageUrl = `${publicOrigin}/launch-assets/${expected.imageHash}.webp`;
          expected.metadataHash = await assetHash(new TextEncoder().encode(JSON.stringify({
            name: draft.name, symbol: draft.ticker, description: draft.description, image: expected.imageUrl,
          })));
          expected.metadataUrl = `${publicOrigin}/launch-assets/${expected.metadataHash}.json`;
        }
      }
      return Response.json(
        raw && typeof raw === 'object' && 'status' in raw && raw.status === 'processing'
          ? validateProcessingAsset(raw, expected as AssetApproval)
          : validatePublishedAsset(raw, expected as AssetApproval),
        { headers },
      );
    } catch (error) {
      return fail(
        error instanceof AssetError &&
          ['image_size', 'invalid_launch_details', 'disconnected'].includes(
            error.code,
          )
          ? error.code
          : 'unavailable',
        error instanceof AssetError && error.code === 'image_size' ? 413 : 503,
      );
    } finally {
      active--;
    }
  };
}
