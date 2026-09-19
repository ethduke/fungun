export const dynamic = 'force-dynamic';

// Older open tabs must not keep the retired market feed alive.
export function GET() {
  return Response.json(
    { error: 'market_feed_removed' },
    { status: 410, headers: { 'cache-control': 'no-store' } },
  );
}
