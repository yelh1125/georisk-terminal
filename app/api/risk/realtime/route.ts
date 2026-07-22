import { NextResponse } from 'next/server';
import { getRealtimeRiskSnapshot } from '@/lib/risk-service';

export const dynamic = 'force-dynamic';

/** Returns only the documented risk JSON contract; no cache/debug envelope is added. */
export async function GET() {
  try {
    return NextResponse.json(await getRealtimeRiskSnapshot());
  } catch (error) {
    console.error('[api/risk/realtime]', error);
    return NextResponse.json({ error: 'Real-time risk calculation is temporarily unavailable.' }, { status: 502 });
  }
}
