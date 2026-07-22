import { NextRequest, NextResponse } from 'next/server';
import { getCache, setCache } from '@/lib/cache';
import { forecastScores } from '@/lib/calculation';
import { ensureRiskHistory } from '@/lib/risk-service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const requestedDays = Number(request.nextUrl.searchParams.get('days') ?? 365);
  const days = Number.isFinite(requestedDays) ? Math.max(30, Math.min(366, Math.floor(requestedDays))) : 365;
  const key = `risk:history:${days}`;
  try {
    const cached = await getCache<unknown>(key);
    if (cached) return NextResponse.json(cached);
    const { records, source } = await ensureRiskHistory();
    const requestedRecords = records.slice(-days);
    const response = { records: requestedRecords, forecast: forecastScores(requestedRecords), source };
    await setCache(key, response, 300);
    return NextResponse.json(response);
  } catch (error) {
    console.error('[api/risk/history]', error);
    return NextResponse.json({ error: 'Unable to load risk history.' }, { status: 500 });
  }
}
