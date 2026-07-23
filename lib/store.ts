import { createRequire } from 'node:module';
import type { RiskRecord } from '@/lib/types';

type DatabasePool = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

const require = createRequire(import.meta.url);
let pool: DatabasePool | null | undefined;

function getPool(): DatabasePool | null {
  if (pool !== undefined) return pool;
  if (!process.env.DATABASE_URL) {
    pool = null;
    return pool;
  }
  // Runtime loading keeps the server-only adapter isolated from client bundles.
  const { Pool } = require('pg') as { Pool: new (options: { connectionString: string; max: number }) => DatabasePool };
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  return pool;
}

const isoDate = (value: Date | string) => new Date(value).toISOString().slice(0, 10);

let memoryHistory: RiskRecord[] = [];

export function replaceMemoryHistory(records: RiskRecord[]): void {
  memoryHistory = records;
}

function mapRow(row: Record<string, unknown>): RiskRecord {
  const number = (name: string) => Number(row[name]);
  return {
    date: isoDate(row.date as Date),
    brent: number('brent'), oilSpread: number('oil_spread'), oilIv: number('oil_iv'), goldOilRatio: number('gold_oil_ratio'), gpr: number('gpr'), correlation: number('correlation'), vix: number('vix'), liquidity: number('liquidity'), sentiment: number('sentiment'),
    brentZ: number('brent_z'), oilSpreadZ: number('oil_spread_z'), oilIvZ: number('oil_iv_z'), goldOilZ: number('gold_oil_z'), marketTransmissionZ: number('market_transmission_z'), gprZ: number('gpr_z'), correlationZ: number('correlation_z'), vixZ: number('vix_z'), liquidityZ: number('liquidity_z'), sentimentZ: number('sentiment_z'),
    compositeScore: number('composite_score'), riskLevel: String(row.risk_level) as RiskRecord['riskLevel'],
  };
}

export async function getRiskHistory(days = 365): Promise<{ records: RiskRecord[]; source: 'live' | 'unavailable' }> {
  // A freshly rebuilt in-process history has the current model version and takes precedence
  // over pre-migration PostgreSQL rows for the lifetime of this serverless instance.
  if (memoryHistory.length) return { records: memoryHistory.slice(-days), source: 'live' };
  const database = getPool();
  if (!database) return { records: memoryHistory.slice(-days), source: memoryHistory.length ? 'live' : 'unavailable' };
  try {
    const result = await database.query(
      `SELECT date, brent, "oilSpread" AS oil_spread, "oilIv" AS oil_iv, "goldOilRatio" AS gold_oil_ratio, gpr, correlation, vix, liquidity, sentiment,
       "brentZ" AS brent_z, "oilSpreadZ" AS oil_spread_z, "oilIvZ" AS oil_iv_z, "goldOilZ" AS gold_oil_z, "marketTransmissionZ" AS market_transmission_z, "gprZ" AS gpr_z, "correlationZ" AS correlation_z, "vixZ" AS vix_z,
       "liquidityZ" AS liquidity_z, "sentimentZ" AS sentiment_z,
       "compositeScore" AS composite_score, "riskLevel" AS risk_level
       FROM "DailyRiskData" ORDER BY date DESC LIMIT $1`,
      [days],
    );
    if (!result.rows.length) return { records: memoryHistory.slice(-days), source: memoryHistory.length ? 'live' : 'unavailable' };
    return { records: result.rows.reverse().map(mapRow), source: 'live' };
  } catch (error) {
    console.error('[store] PostgreSQL read failed', error instanceof Error ? error.message : error);
    return { records: memoryHistory.slice(-days), source: memoryHistory.length ? 'live' : 'unavailable' };
  }
}

export async function upsertRiskRecord(record: RiskRecord): Promise<'live'> {
  const database = getPool();
  if (!database) {
    const position = memoryHistory.findIndex((item) => item.date === record.date);
    if (position >= 0) memoryHistory[position] = record;
    else memoryHistory = [...memoryHistory, record].sort((left, right) => left.date.localeCompare(right.date));
    return 'live';
  }
  try {
    await database.query(
      `INSERT INTO "DailyRiskData" (id, date, brent, "oilSpread", "oilIv", "goldOilRatio", gpr, correlation, vix, liquidity, sentiment, "brentZ", "oilSpreadZ", "oilIvZ", "goldOilZ", "marketTransmissionZ", "gprZ", "correlationZ", "vixZ", "liquidityZ", "sentimentZ", "compositeScore", "riskLevel", "createdAt", "updatedAt")
       VALUES (concat('risk_', md5(random()::text || clock_timestamp()::text)), $1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, NOW(), NOW())
       ON CONFLICT (date) DO UPDATE SET
         brent = EXCLUDED.brent, "oilSpread" = EXCLUDED."oilSpread", "oilIv" = EXCLUDED."oilIv", "goldOilRatio" = EXCLUDED."goldOilRatio", gpr = EXCLUDED.gpr, correlation = EXCLUDED.correlation, vix = EXCLUDED.vix, liquidity = EXCLUDED.liquidity, sentiment = EXCLUDED.sentiment,
         "brentZ" = EXCLUDED."brentZ", "oilSpreadZ" = EXCLUDED."oilSpreadZ", "oilIvZ" = EXCLUDED."oilIvZ", "goldOilZ" = EXCLUDED."goldOilZ", "marketTransmissionZ" = EXCLUDED."marketTransmissionZ", "gprZ" = EXCLUDED."gprZ", "correlationZ" = EXCLUDED."correlationZ", "vixZ" = EXCLUDED."vixZ", "liquidityZ" = EXCLUDED."liquidityZ", "sentimentZ" = EXCLUDED."sentimentZ",
         "compositeScore" = EXCLUDED."compositeScore", "riskLevel" = EXCLUDED."riskLevel", "updatedAt" = NOW()`,
      [record.date, record.brent, record.oilSpread, record.oilIv, record.goldOilRatio, record.gpr, record.correlation, record.vix, record.liquidity, record.sentiment, record.brentZ, record.oilSpreadZ, record.oilIvZ, record.goldOilZ, record.marketTransmissionZ, record.gprZ, record.correlationZ, record.vixZ, record.liquidityZ, record.sentimentZ, record.compositeScore, record.riskLevel],
    );
    const position = memoryHistory.findIndex((item) => item.date === record.date);
    if (position >= 0) memoryHistory[position] = record;
    else memoryHistory = [...memoryHistory, record].sort((left, right) => left.date.localeCompare(right.date));
    return 'live';
  } catch (error) {
    console.error('[store] PostgreSQL write failed', error instanceof Error ? error.message : error);
    throw error;
  }
}
