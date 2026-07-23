export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';

export interface RawFactors {
  date: string;
  /** Brent front-month settlement / latest available close in USD per barrel. */
  brent: number;
  /** Brent minus WTI cross-benchmark spread, USD per barrel. This is not Dubai crude. */
  oilSpread: number;
  /** CBOE OVX, the implied-volatility index for the USO crude-oil ETF. */
  oilIv: number;
  /** Gold price divided by Brent price, used as a flight-to-safety regime ratio. */
  goldOilRatio: number;
  /** Published academic reference only. It never contributes to the live score. */
  gpr: number;
  correlation: number;
  vix: number;
  liquidity: number;
  sentiment: number;
}

export interface RiskRecord extends RawFactors {
  brentZ: number;
  oilSpreadZ: number;
  oilIvZ: number;
  goldOilZ: number;
  marketTransmissionZ: number;
  gprZ: number;
  correlationZ: number;
  vixZ: number;
  liquidityZ: number;
  sentimentZ: number;
  compositeScore: number;
  riskLevel: RiskLevel;
}

export interface StrategySignal {
  type: 'RISK_ON_HEDGE' | 'DEFENSIVE_REBALANCE' | 'NEUTRAL';
  strength: 'LIGHT' | 'MODERATE' | 'STRONG';
  title: string;
  recommendation: string;
}

export interface RiskResponse {
  latest: RiskRecord;
  signal: StrategySignal;
  updatedAt: string;
  source: 'live';
}

export interface NowcastResponse {
  score: number;
  tomorrowScore: number;
  riskLevel: RiskLevel;
  marketAsOf: string;
  brentAsOf: string;
  brentClose: number;
  brentSource: 'yahoo_bz_f' | 'fred_dcoilbrenteu';
  factorAsOf: { brent: string; oilSpread: string; oilIv: string; goldOil: string; correlation: string; vix: string; liquidity: string; sentiment: string };
  gprAsOf: string;
  newsAsOf: string;
  newsPulseZ: number;
  articleCount: number;
  negativeSentimentRatio: number;
  comboBoost: number;
  newsSource: 'gdelt_multisource' | 'gdelt_newsapi' | 'newsapi' | 'gdelt_google' | 'gdelt_bbc' | 'google_bbc' | 'google_rss' | 'bbc_rss' | 'gdelt' | 'gdelt_events' | 'estimated';
  newsStatus: 'live' | 'estimated';
  signal: StrategySignal;
}

export interface RealtimeRiskSnapshot {
  calc_date: string;
  gpr_release_date: string;
  market_factors: {
    oil_spread_z: number;
    oil_iv_z: number;
    gold_oil_z: number;
    market_transmission_z: number;
    rho_eq_bond_z: number;
    vix_z: number;
    baa10y_z: number;
    skew_z: number;
    /** Present for data-vintage disclosure only; this field has zero model weight. */
    gpr_reference_z: number;
    gpr_source: 'AI-GPR_lagged' | 'ESTIMATED';
  };
  news_pulse_z: number;
  market_score: number;
  risk_score: number;
  risk_level: '低' | '中' | '高' | '极高';
  action: '维持监测' | '收紧风险预算' | '提高对冲' | '强对冲审查';
  news_trigger: boolean;
  comment: string;
}
