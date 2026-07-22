import { NextResponse } from 'next/server';
import { getRiskNowcast } from '@/lib/risk-service';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const nowcast = await getRiskNowcast();
    // Individual source caches control freshness: FRED/CBOE 5m, GDELT 15m, bridge sample 7d.
    return NextResponse.json(nowcast);
  } catch (error) {
    console.error('[api/risk/nowcast]', error);
    return NextResponse.json({ error: 'Real-time risk pulse is temporarily unavailable.' }, { status: 502 });
  }
}
