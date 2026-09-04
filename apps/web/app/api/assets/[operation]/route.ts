import { createAssetProxy } from '../../../../lib/asset-proxy';

const proxy = createAssetProxy(() => ({
  appOrigin: process.env.APP_ORIGIN,
  serviceOrigin: process.env.ASSET_SERVICE_ORIGIN,
  publicOrigin: process.env.ASSET_PUBLIC_ORIGIN,
  enabled: process.env.ASSET_UPLOADS === 'true',
  production: process.env.NODE_ENV === 'production',
}));

export async function POST(
  request: Request,
  { params }: { params: Promise<{ operation: string }> },
) {
  return proxy(request, (await params).operation);
}
