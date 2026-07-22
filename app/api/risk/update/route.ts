import { NextRequest, NextResponse } from 'next/server';
import { runDailyRiskUpdate } from '@/lib/risk-service';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const configuredSecret = process.env.CRON_SECRET;
  const suppliedSecret = request.headers.get('x-cron-secret') ?? request.headers.get('authorization')?.replace('Bearer ', '');
  if (configuredSecret && suppliedSecret !== configuredSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const result = await runDailyRiskUpdate();
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error('[api/risk/update] daily update failed', error);
    return NextResponse.json({ error: 'Daily risk update failed. Inspect server logs for source errors.' }, { status: 502 });
  }
}
