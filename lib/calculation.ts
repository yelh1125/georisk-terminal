import type { RawFactors, RiskLevel, RiskRecord, StrategySignal } from '@/lib/types';

export const FACTOR_WEIGHTS = {
  oilSpread: 0.3846,
  oilIv: 0.2308,
  goldOil: 0.2308,
  marketTransmission: 0.1538,
} as const;

type FactorName = keyof typeof FACTOR_WEIGHTS;
type FactorZ = Record<FactorName | 'gpr' | 'brent', number>;

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
 * Market-only close model. AI-GPR is deliberately excluded because its release lag makes
 * it unsuitable as a same-day trading input. It re-normalizes the four market components
 * to 1.00 because the 35% high-frequency news factor is not available historically.
 * The linear factor form follows Grinold & Kahn, Active Portfolio Management.
 */
export function calculateRiskRecord(history: RawFactors[], current: RawFactors): RiskRecord {
  const window = history.slice(-252);
  const correlationWindow = history.slice(-1260);
  const gprBaseline = history
    .filter((row) => row.date >= '2010-01-01' && row.date <= '2019-12-31')
    .map((row) => row.gpr);
  const factorZ = {} as FactorZ;
  const goldOilChanges = history.slice(-257).map((row, index, values) => index < 5 ? null : row.goldOilRatio / values[index - 5].goldOilRatio - 1).filter((value): value is number => value !== null);
  const currentGoldOilWindow = [...history.slice(-5), current];
  const currentGoldOilChange = currentGoldOilWindow.length >= 6 ? current.goldOilRatio / currentGoldOilWindow[0].goldOilRatio - 1 : 0;

  // Spread isolates cross-benchmark supply-risk pricing; it must not be labelled Brent-Dubai without a Dubai feed.
  factorZ.oilSpread = zScore(current.oilSpread, window.map((row) => row.oilSpread));
  // OVX is an option-implied crude-oil uncertainty measure, distinct from direction of oil prices.
  factorZ.oilIv = zScore(current.oilIv, window.map((row) => row.oilIv));
  // A rising Gold/Brent ratio over five sessions identifies flight-to-safety beyond an ordinary oil supply shock.
  factorZ.goldOil = zScore(currentGoldOilChange, goldOilChanges);
  factorZ.brent = 0;
  // AI-GPR remains a labelled backtest reference, not a component of compositeScore.
  factorZ.gpr = zScore(current.gpr, gprBaseline.length >= 252 ? gprBaseline : window.map((row) => row.gpr));
  // Stock-bond correlation is a regime signal, so its Z-score uses a five-year reference window.
  const correlationZ = zScore(current.correlation, correlationWindow.map((row) => row.correlation));
  const vixZ = zScore(current.vix, window.map((row) => row.vix));
  factorZ.marketTransmission = 0.5 * correlationZ + 0.5 * vixZ;

  // Market-only close model = normalized weights of OilSpread, OVX, Gold/Oil, and market transmission.
  const compositeScore = (Object.keys(FACTOR_WEIGHTS) as FactorName[]).reduce(
    (sum, factor) => sum + FACTOR_WEIGHTS[factor] * factorZ[factor],
    0,
  );

  return {
    ...current,
    brentZ: 0,
    oilSpreadZ: round(factorZ.oilSpread),
    oilIvZ: round(factorZ.oilIv),
    goldOilZ: round(factorZ.goldOil),
    marketTransmissionZ: round(factorZ.marketTransmission),
    gprZ: round(factorZ.gpr),
    correlationZ: round(correlationZ),
    vixZ: round(vixZ),
    liquidityZ: round(zScore(current.liquidity, window.map((row) => row.liquidity))),
    sentimentZ: round(zScore(current.sentiment, window.map((row) => row.sentiment))),
    compositeScore: round(compositeScore),
    riskLevel: getRiskLevel(compositeScore),
  };
}

/** A 20-session breakout is the Donchian-channel rule popularized by trend-following systems (Turtle Trading rules). */
export function isOilSpreadBreakout(history: RawFactors[], currentSpread: number): boolean {
  const prior20 = history.slice(-20).map((row) => row.oilSpread);
  return prior20.length === 20 && currentSpread > Math.max(...prior20);
}

export function determineStrategy(history: RiskRecord[], latest: RiskRecord): StrategySignal {
  const rawHistory = history.map(({ date, brent, oilSpread, oilIv, goldOilRatio, gpr, correlation, vix, liquidity, sentiment }) => ({
    date, brent, oilSpread, oilIv, goldOilRatio, gpr, correlation, vix, liquidity, sentiment,
  }));
  const vixFalling = history.length > 1 && latest.vix < history.at(-2)!.vix;

  if (latest.compositeScore > 0.6 && isOilSpreadBreakout(rawHistory.slice(0, -1), latest.oilSpread)) {
    return {
      type: 'RISK_ON_HEDGE',
      strength: latest.compositeScore > 0.8 ? 'STRONG' : 'LIGHT',
      title: latest.compositeScore > 0.8 ? '极高地缘风险：重仓对冲' : '高地缘风险：轻仓试错',
      recommendation: latest.compositeScore > 0.8
        ? '建议增配黄金 ETF 20%，配置原油与国防股，同时减持航空和高估值成长股。'
        : 'Brent-WTI 供给风险价差突破 20 日高点，可小仓位做多黄金、能源和国防股，设置严格止损。',
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
