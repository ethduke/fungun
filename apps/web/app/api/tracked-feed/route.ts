import { handleTrackedFeed } from '../../../lib/tracked-feed-handler.mjs';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return handleTrackedFeed(request);
}
