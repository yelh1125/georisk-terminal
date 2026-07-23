import type { RawFactors, RiskLevel, RiskRecord, StrategySignal } from '@/lib/types';

export const FACTOR_WEIGHTS = {
  brent: 0.3,
  correlation: 0.25,
  vix: 0.2,
  liquidity: 0.15,
  sentiment: 0.1,
} as const;

type FactorName = keyof typeof FACTOR_WEIGHTS;
type FactorZ = Record<FactorName | 'gpr', number>;

const round = (value: number, precision = 3) => Number(value.toFixed(precision));

/** Standard Z-score; standard normalization used in quantitative time-series analysis (Chan, 2013). */
export function zScore(value: number, observations: number[]): number {
  if (observations.length < 2) return 0;
  const mean = observations.reduce((sum, item) => sum + item, 0) / observations.length;
  const variance = observations.reduce((sum, item) => sum + (item - mean) ** 2, 0) / observations.length;
  const deviation = Math.sqrt(variance);
  return deviation === 0 ? 0 : (value - mean) / deviation;
}

export function getRiskLevel(score: number): RiskLevel {
  if (score > 0.8) return 'EXTREME';
  if (score >= 0.6) return 'HIGH';
  if (score >= 0.3) return 'MEDIUM';
  return 'LOW';
}

/**
 * Daily-close market model. AI-GPR is deliberately excluded because its release lag makes
 * it unsuitable as a same-day trading input. The five weights total 1.00.
 * The linear factor form follows Grinold & Kahn, Active Portfolio Management.
 */
export function calculateRiskRecord(history: RawFactors[], current: RawFactors): RiskRecord {
  const window = history.slice(-252);
  const correlationWindow = history.slice(-1260);
  const gprBaseline = history
    .filter((row) => row.date >= '2010-01-01' && row.date <= '2019-12-31')
    .map((row) => row.gpr);
  const factorZ = {} as FactorZ;
  const brentReturns = history.slice(-257).map((row, index, values) => index < 5 ? null : row.brent / values[index - 5].brent - 1).filter((value): value is number => value !== null);
  const currentBrentWindow = [...history.slice(-5), current];
  const currentBrentReturn = currentBrentWindow.length >= 6 ? current.brent / currentBrentWindow[0].brent - 1 : 0;

  // Brent 5-session return captures an oil-market shock, rather than treating a high price level as risk by itself.
  factorZ.brent = zScore(currentBrentReturn, brentReturns);
  // AI-GPR remains a labelled backtest reference, not a component of compositeScore.
  factorZ.gpr = zScore(current.gpr, gprBaseline.length >= 252 ? gprBaseline : window.map((row) => row.gpr));
  // Stock-bond correlation is a regime signal, so its Z-score uses a five-year reference window.
  factorZ.correlation = zScore(current.correlation, correlationWindow.map((row) => row.correlation));
  factorZ.vix = zScore(current.vix, window.map((row) => row.vix));
  factorZ.liquidity = zScore(current.liquidity, window.map((row) => row.liquidity));
  factorZ.sentiment = zScore(current.sentiment, window.map((row) => row.sentiment));

  // Close model = 0.30 BrentShock_Z + 0.25 Corr_Z + 0.20 VIX_Z + 0.15 Liquidity_Z + 0.10 SKEW_Z.
  const compositeScore = (Object.keys(FACTOR_WEIGHTS) as FactorName[]).reduce(
    (sum, factor) => sum + FACTOR_WEIGHTS[factor] * factorZ[factor],
    0,
  );

  return {
    ...current,
    brentZ: round(factorZ.brent),
    gprZ: round(factorZ.gpr),
    correlationZ: round(factorZ.correlation),
    vixZ: round(factorZ.vix),
    liquidityZ: round(factorZ.liquidity),
    sentimentZ: round(factorZ.sentiment),
    compositeScore: round(compositeScore),
    riskLevel: getRiskLevel(compositeScore),
  };
}

/** A 20-session breakout is the Donchian-channel rule popularized by trend-following systems (Turtle Trading rules). */
export function isBrentBreakout(history: RawFactors[], currentBrent: number): boolean {
  const prior20 = history.slice(-20).map((row) => row.brent);
  return prior20.length === 20 && currentBrent > Math.max(...prior20);
}

export function determineStrategy(history: RiskRecord[], latest: RiskRecord): StrategySignal {
  const rawHistory = history.map(({ date, brent, gpr, correlation, vix, liquidity, sentiment }) => ({
    date, brent, gpr, correlation, vix, liquidity, sentiment,
  }));
  const vixFalling = history.length > 1 && latest.vix < history.at(-2)!.vix;

  if (latest.compositeScore > 0.6 && isBrentBreakout(rawHistory.slice(0, -1), latest.brent)) {
    return {
      type: 'RISK_ON_HEDGE',
      strength: latest.compositeScore > 0.8 ? 'STRONG' : 'LIGHT',
      title: latest.compositeScore > 0.8 ? '极高地缘风险：重仓对冲' : '高地缘风险：轻仓试错',
      recommendation: latest.compositeScore > 0.8
        ? '建议增配黄金 ETF 20%，配置原油与国防股，同时减持航空和高估值成长股。'
        : '布伦特原油突破 20 日高点，可小仓位做多黄金、能源和国防股，设置严格止损。',
    };
  }

  if (latest.compositeScore < 0.3 && vixFalling) {
    return {
      type: 'DEFENSIVE_REBALANCE',
      strength: 'MODERATE',
      title: '低风险窗口：执行防御性再平衡',
      recommendation: 'VIX 正在回落。按策略框架减仓高贝塔风险资产，并逐步加仓中短久期美国国债。',
    };
  }

  return {
    type: 'NEUTRAL',
    strength: 'LIGHT',
    title: '监测中：维持中性仓位',
    recommendation: '尚未触发完整交易条件。维持既定风险预算，等待地缘风险突破与波动率确认。',
  };
}

/** Least-squares linear projection, a transparent baseline for the seven-session display forecast (Hyndman & Athanasopoulos, 2021). */
export function forecastScores(records: RiskRecord[], days = 7): Array<{ date: string; forecast: number }> {
  const sample = records.slice(-30);
  if (sample.length < 2) return [];
  const n = sample.length;
  const meanX = (n - 1) / 2;
  const meanY = sample.reduce((sum, row) => sum + row.compositeScore, 0) / n;
  const denominator = sample.reduce((sum, _, index) => sum + (index - meanX) ** 2, 0);
  const slope = sample.reduce((sum, row, index) => sum + (index - meanX) * (row.compositeScore - meanY), 0) / denominator;
  const intercept = meanY - slope * meanX;
  const baseDate = new Date(`${sample.at(-1)!.date}T00:00:00Z`);

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(baseDate);
    date.setUTCDate(date.getUTCDate() + index + 1);
    return { date: date.toISOString().slice(0, 10), forecast: round(intercept + slope * (n + index)) };
  });
}
