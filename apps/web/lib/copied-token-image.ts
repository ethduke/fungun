import { IMAGE_LIMIT, imageFileError, imageKind } from './launch-model.ts';

export const COPIED_IMAGE_ERROR = 'Image unavailable—upload one.';
export type TokenImageSource =
  | { chainId: 4663; address: string; provider?: undefined }
  | { chainId: 4663 | 8453; address: string; provider: 'doppler' }
  | { chainId: 4663; address: string; provider: 'pons-v2' };
export type ImageRequest = { signal: AbortSignal; isCurrent: () => boolean };

export class ImageRequests {
  private controller: AbortController | null = null;

  cancel() {
    this.controller?.abort();
    this.controller = null;
  }

  begin(): ImageRequest {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    return {
      signal: controller.signal,
      isCurrent: () => this.controller === controller,
    };
  }
}

export function tokenImageSource(value: unknown): TokenImageSource | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  if (typeof source.address !== 'string' || !/^0x[\da-f]{40}$/i.test(source.address))
    return null;
  const address = source.address.toLowerCase();
  if (source.provider === 'doppler' && (source.chainId === 4663 || source.chainId === 8453))
    return { chainId: source.chainId, address, provider: 'doppler' };
  if (source.provider === 'pons-v2' && source.chainId === 4663)
    return { chainId: 4663, address, provider: 'pons-v2' };
  return source.provider === undefined && source.chainId === 4663
    ? { chainId: 4663, address }
    : null;
}

export async function copiedTokenImage(
  source: TokenImageSource,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Blob> {
  const operation = source.provider ? 'token-image' : 'o1-token-image';
  const response = await fetcher(`/api/${operation}`, {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      'x-fungun-intent': operation,
    },
    body: JSON.stringify(source),
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (
    !response.ok ||
    response.headers.get('content-type')?.split(';')[0] !==
      'application/json' ||
    Number(response.headers.get('content-length')) > 3 * 1024 * 1024 ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error(COPIED_IMAGE_ERROR);
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 3 * 1024 * 1024) throw new Error(COPIED_IMAGE_ERROR);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const payload = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.length;
  }
  const data = JSON.parse(new TextDecoder().decode(payload));
  if (
    data.chainId !== source.chainId ||
    data.address !== source.address ||
    !Number.isInteger(data.size) ||
    data.size <= 0 ||
    data.size > IMAGE_LIMIT ||
    !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
      data.mime,
    ) ||
    typeof data.base64 !== 'string' ||
    data.base64.length !== 4 * Math.ceil(data.size / 3)
  )
    throw new Error(COPIED_IMAGE_ERROR);
  const bytes = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
  if (
    bytes.length !== data.size ||
    imageFileError(bytes.length, data.mime, bytes.subarray(0, 32))
  )
    throw new Error(COPIED_IMAGE_ERROR);
  return new Blob([bytes], { type: data.mime });
}

// Use the same decode and dimensions check for uploads and copied artwork.
export async function validateDraftImage(file: Blob): Promise<Blob> {
  if (!file.size || file.size > IMAGE_LIMIT)
    throw new Error('Choose an image smaller than 2 MiB.');
  const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const error = imageFileError(file.size, file.type, header);
  if (error) throw new Error(error);
  const source = file.slice(0, file.size, imageKind(header) ?? '');
  const bitmap = await createImageBitmap(source);
  const oversized = bitmap.width > 4096 || bitmap.height > 4096;
  bitmap.close();
  if (oversized)
    throw new Error('Use an image no larger than 4096 × 4096 pixels.');
  return source;
}
