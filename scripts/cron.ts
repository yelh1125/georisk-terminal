import 'dotenv/config';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import cron from 'node-cron';
import { refreshPublishedAnchor, runDailyRiskUpdate, warmRealtimeRiskCache } from '../lib/risk-service';

const logDirectory = path.join(process.cwd(), 'logs');
const logFile = path.join(logDirectory, 'risk-cron.log');

async function log(level: 'INFO' | 'ERROR', message: string) {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  console[level === 'ERROR' ? 'error' : 'log'](line);
  try {
    await mkdir(logDirectory, { recursive: true });
    await appendFile(logFile, `${line}\n`);
  } catch (error) {
    console.error('[cron] failed to write file log', error);
  }
}

async function executeUpdate() {
  try {
    const result = await runDailyRiskUpdate();
    await log('INFO', `Updated ${result.latest.date}: score=${result.latest.compositeScore}, level=${result.latest.riskLevel}, source=${result.source}`);
  } catch (error) {
    await log('ERROR', `Daily update failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

async function refreshRealtime() {
  try {
    const snapshot = await warmRealtimeRiskCache();
    await log('INFO', `Realtime ${snapshot.calc_date}: score=${snapshot.risk_score}, source=${snapshot.market_factors.gpr_source}`);
  } catch (error) {
    await log('ERROR', `Realtime refresh failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

async function refreshAnchor() {
  try {
    const snapshot = await refreshPublishedAnchor();
    await log('INFO', `Published anchor refreshed: release=${snapshot.gpr_release_date}, source=${snapshot.market_factors.gpr_source}`);
  } catch (error) {
    await log('ERROR', `Published anchor refresh failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

// Every five minutes checks daily market sources. Internal TTLs refresh high-frequency news only every 15 minutes.
cron.schedule('*/5 * * * *', refreshRealtime, { timezone: 'UTC' });
// AI-GPR is a low-frequency anchor: refresh every Monday and on the first calendar day of each month.
cron.schedule('5 1 * * 1', refreshAnchor, { timezone: 'UTC' });
cron.schedule('5 1 1 * *', refreshAnchor, { timezone: 'UTC' });
// Runs at 20:00 UTC daily after the regular US cash-session close; node-cron timezone avoids host clock ambiguity.
cron.schedule('0 20 * * *', executeUpdate, { timezone: 'UTC' });
void log('INFO', 'GeoRisk scheduler started; market checks every 5m, GDELT every 15m via cache, AI-GPR anchor Mondays/month starts, final daily update at 20:00 UTC.');

// Keep this Node process alive as the dedicated scheduler container/service.
