import { after } from 'next/server';
import { handleTrackedFeed } from '../../../lib/tracked-feed-handler.mjs';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const response = handleTrackedFeed(request);
  // Keep the bounded shared refresh alive if its initiating viewer leaves.
  after(response.then(() => undefined));
  return response;
}
