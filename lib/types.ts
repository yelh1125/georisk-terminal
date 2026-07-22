export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';

export interface RawFactors {
  date: string;
  gpr: number;
  correlation: number;
  vix: number;
  liquidity: number;
  sentiment: number;
}

export interface RiskRecord extends RawFactors {
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
  gprAsOf: string;
  newsAsOf: string;
  newsPulseZ: number;
  articleCount: number;
  negativeSentimentRatio: number;
  comboBoost: number;
  newsSource: 'gdelt_newsapi' | 'newsapi' | 'gdelt_google' | 'google_rss' | 'gdelt' | 'estimated';
  newsStatus: 'live' | 'estimated';
  signal: StrategySignal;
}

export interface RealtimeRiskSnapshot {
  calc_date: string;
  gpr_release_date: string;
  market_factors: {
    gpr_anchor_z: number;
    rho_eq_bond_z: number;
    vix_z: number;
    baa10y_z: number;
    skew_z: number;
    gpr_source: 'GDELT_bridged' | 'AI-GPR_lagged' | 'ESTIMATED';
  };
  news_pulse_z: number;
  market_score: number;
  risk_score: number;
  risk_level: '低' | '中' | '高' | '极高';
  action: '维持监测' | '收紧风险预算' | '提高对冲' | '强对冲审查';
  news_trigger: boolean;
  comment: string;
}
