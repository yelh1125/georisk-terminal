import { NextResponse } from 'next/server';
import { getCache, setCache } from '@/lib/cache';
import { getLatestRisk } from '@/lib/risk-service';
import type { RiskResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const cached = await getCache<RiskResponse>('risk:score');
    if (cached) return NextResponse.json({ ...cached, cached: true });
    const result = await getLatestRisk();
    await setCache('risk:score', result, 60);
    return NextResponse.json({ ...result, cached: false });
  } catch (error) {
    console.error('[api/risk/score]', error);
    return NextResponse.json({ error: 'Unable to calculate current risk score.' }, { status: 500 });
  }
}
