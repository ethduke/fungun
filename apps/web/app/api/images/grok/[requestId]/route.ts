import { createImageProxy } from '../../../../../lib/image-proxy';
const proxy = createImageProxy(() => ({
  appOrigin: process.env.APP_ORIGIN,
  serviceOrigin: process.env.ASSET_SERVICE_ORIGIN,
  paymentAsset: process.env.IMAGE_USDG_ADDRESS,
  production: process.env.NODE_ENV === 'production',
}));
export async function GET(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
  return proxy(request, (await params).requestId);
}
