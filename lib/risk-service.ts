import { calculateRiskRecord, determineStrategy, zScore } from '@/lib/calculation';
import { fetchCurrentFactors, fetchFreshMarketFactors, fetchHighFrequencyNews, fetchRealFactorHistory, invalidatePublishedGprCache, type FreshMarketFactors } from '@/lib/fetchers';
import { deleteCache, getCache, setCache } from '@/lib/cache';
import { getRiskHistory, replaceMemoryHistory, upsertRiskRecord } from '@/lib/store';
import type { NowcastResponse, RawFactors, RealtimeRiskSnapshot, RiskResponse, StrategySignal } from '@/lib/types';

export async function ensureRiskHistory(forcePublishedRefresh = false): Promise<{ records: import('@/lib/types').RiskRecord[]; source: 'live' }> {
  let { records, source } = await getRiskHistory(5_000);
  if (source === 'unavailable' || forcePublishedRefresh) {
    if (forcePublishedRefresh) invalidatePublishedGprCache();
    const raw = await fetchRealFactorHistory();
    records = raw.map((row, index) => calculateRiskRecord(raw.slice(0, index), row));
    replaceMemoryHistory(records);
    source = 'live';
  }
  return { records, source };
}

export async function getLatestRisk(): Promise<RiskResponse> {
  const { records, source } = await ensureRiskHistory();
  const latest = records.at(-1);
  if (!latest) throw new Error('Risk history is empty');
  return { latest, signal: determineStrategy(records, latest), updatedAt: new Date().toISOString(), source };
}

export async function runDailyRiskUpdate(): Promise<RiskResponse> {
  const { records } = await ensureRiskHistory();
  const raw = await fetchCurrentFactors();
  const current = calculateRiskRecord(records, {
    date: raw.date, brent: raw.brent,
    gpr: raw.gpr, correlation: raw.correlation, vix: raw.vix, liquidity: raw.liquidity, sentiment: raw.sentiment,
  });
  const source = await upsertRiskRecord(current);
  await deleteCache('risk:score');
  const updatedHistory = [...records.filter((row) => row.date !== current.date), current];
  return { latest: current, signal: determineStrategy(updatedHistory, current), updatedAt: new Date().toISOString(), source };
}

type NewsObservation = { count: number; negativeRatio: number; comboDetected: boolean; source: 'gdelt_newsapi' | 'newsapi' | 'gdelt_google' | 'google_rss' | 'gdelt' | 'gdelt_events'; observedAt: string };
type NewsMetrics = { pulseZ: number; rawZ: number; count: number; negativeRatio: number; comboBoost: number; asOf: string; source: NewsObservation['source'] };
type RealtimeCalculation = { snapshot: RealtimeRiskSnapshot; marketAsOf: string; brentAsOf: string; brentClose: number; factorAsOf: NowcastResponse['factorAsOf']; newsAsOf: string; articleCount: number; negativeSentimentRatio: number; comboBoost: number; newsSource: NowcastResponse['newsSource']; newsLive: boolean };

const round = (value: number) => Number(value.toFixed(3));
const clip = (value: number, lower = -3, upper = 3) => Math.max(lower, Math.min(upper, value));

function rawFactors(records: import('@/lib/types').RiskRecord[]): RawFactors[] {
  return records.map(({ date, brent, gpr, correlation, vix, liquidity, sentiment }) => ({ date, brent, gpr, correlation, vix, liquidity, sentiment }));
}

function differenceInDays(later: string, earlier: string): number {
  return Math.max(0, Math.floor((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000));
}

async function getFreshMarketSnapshot(gprReference: number): Promise<FreshMarketFactors> {
  const cached = await getCache<FreshMarketFactors>('risk:market:current');
  if (cached) return cached;
  const market = await fetchFreshMarketFactors(gprReference);
  await setCache('risk:market:current', market, 5 * 60);
  return market;
}

function zWithBootstrap(value: number, observations: number[], mean: number, deviation: number): number {
  return observations.length >= 20 ? zScore(value, observations) : (value - mean) / deviation;
}

/**
 * Captures a 15-minute high-frequency news observation. Redis retains up to 90 days of
 * same-source samples; bootstrap values only cover the first warm-up period after deployment.
 */
async function getHighFrequencyNewsMetrics(): Promise<NewsMetrics> {
  if (await getCache<boolean>('risk:news:unavailable')) throw new Error('High-frequency news retry is deferred after a recent source failure');
  let current = await getCache<NewsObservation>('risk:news:current');
  if (!current) {
    let live;
    try {
      live = await fetchHighFrequencyNews();
    } catch (error) {
      await setCache('risk:news:unavailable', true, 15 * 60);
      throw error;
    }
    current = { count: live.count, negativeRatio: live.negativeRatio, comboDetected: live.comboDetected, source: live.source, observedAt: live.asOf };
    await setCache('risk:news:current', current, 15 * 60);
    const prior = (await getCache<NewsObservation[]>('risk:news:history')) ?? [];
    const history = [...prior.filter((item) => item.observedAt !== current!.observedAt), current].slice(-8_640);
    await setCache('risk:news:history', history, 100 * 24 * 60 * 60);
  }
  const allHistory = (await getCache<NewsObservation[]>('risk:news:history')) ?? [];
  const sameSource = allHistory.filter((item) => item.source === current!.source && item.observedAt !== current!.observedAt);
  const countHistory = sameSource.map((item) => Math.log(item.count + 1));
  const sentimentHistory = sameSource.map((item) => item.negativeRatio);
  const gdeltScale = current.source === 'gdelt_newsapi' || current.source === 'gdelt_google' || current.source === 'gdelt';
  const eventScale = current.source === 'gdelt_events';
  const countZ = zWithBootstrap(Math.log(current.count + 1), countHistory, eventScale ? Math.log(250) : gdeltScale ? Math.log(12_000) : Math.log(20), eventScale ? 0.8 : gdeltScale ? 0.55 : 0.65);
  const sentimentZ = zWithBootstrap(current.negativeRatio, sentimentHistory, 0.55, 0.18);
  const comboBoost = current.comboDetected ? 0.5 : 0;
  const rawZ = clip(0.60 * countZ + 0.40 * sentimentZ + comboBoost, 0, 3);
  const priorMemory = await getCache<{ pulseZ: number }>('risk:news:decay');
  // Conflict memory: risk retains 75% of the preceding pulse until fresh data exceeds or decays it.
  const pulseZ = clip(Math.max(rawZ, (priorMemory?.pulseZ ?? 0) * 0.75), 0, 3);
  const metrics = { pulseZ: round(pulseZ), rawZ: round(rawZ), count: current.count, negativeRatio: current.negativeRatio, comboBoost, asOf: current.observedAt, source: current.source };
  await setCache('risk:news:last-known', metrics, 7 * 24 * 60 * 60);
  await setCache('risk:news:decay', { pulseZ: metrics.pulseZ }, 14 * 24 * 60 * 60);
  return metrics;
}

function chineseRiskLevel(score: number): RealtimeRiskSnapshot['risk_level'] {
  if (score > 0.8) return '极高';
  if (score >= 0.6) return '高';
  if (score >= 0.3) return '中';
  return '低';
}

function actionFor(score: number, newsPulseZ: number): RealtimeRiskSnapshot['action'] {
  if (newsPulseZ > 2 || score > 0.8) return '强对冲审查';
  if (newsPulseZ > 1.2 || score >= 0.6) return '提高对冲';
  if (score >= 0.3) return '收紧风险预算';
  return '维持监测';
}

function nowcastSignal(action: RealtimeRiskSnapshot['action']): StrategySignal {
  if (action === '强对冲审查') return { type: 'RISK_ON_HEDGE', strength: 'STRONG', title: '实时地缘事件脉冲：启动强对冲', recommendation: '风险温度或新闻脉冲已进入极端区间。增配黄金和短久期国债，降低高贝塔、航空与地区暴露仓位。' };
  if (action === '提高对冲') return { type: 'RISK_ON_HEDGE', strength: 'MODERATE', title: '实时地缘风险抬升：提高对冲比例', recommendation: '维持风险预算下调，分批配置黄金或能源对冲，并收紧风险资产止损。' };
  if (action === '收紧风险预算') return { type: 'NEUTRAL', strength: 'MODERATE', title: '实时风险处于警戒区间', recommendation: '收紧风险预算，减少新增高贝塔敞口，等待市场与新闻脉冲确认。' };
  return { type: 'NEUTRAL', strength: 'LIGHT', title: '实时脉冲未触发升级', recommendation: '未出现足以改变既定仓位的风险异常，继续监测市场与新闻数据。' };
}

async function calculateRealtimeRisk(): Promise<RealtimeCalculation> {
  const { records } = await ensureRiskHistory();
  const latestPublished = records.at(-1);
  if (!latestPublished) throw new Error('Published AI-GPR history is unavailable');
  const history = rawFactors(records);
  const calcDate = new Date().toISOString().slice(0, 10);
  const aiGprZ = zScore(latestPublished.gpr, history.map((item) => item.gpr));
  const [marketRaw, newsResult] = await Promise.all([getFreshMarketSnapshot(latestPublished.gpr), getHighFrequencyNewsMetrics().catch(() => null)]);
  const lagDays = differenceInDays(calcDate, latestPublished.date);
  const lastKnown = newsResult ? null : await getCache<NewsMetrics>('risk:news:last-known');
  const gprReferenceZ = clip(aiGprZ);
  let gprSource: RealtimeRiskSnapshot['market_factors']['gpr_source'] = 'AI-GPR_lagged';
  if (!newsResult) gprSource = 'ESTIMATED';
  const marketFactors = calculateRiskRecord(history, marketRaw);
  const newsPulseZ = clip(newsResult?.pulseZ ?? (lastKnown?.pulseZ ?? 0) * 0.75, 0, 3);
  // AI-GPR has zero score weight. Real-time score uses timely market closes and high-frequency news only.
  const marketScore = 0.20 * marketFactors.brentZ + 0.30 * newsPulseZ + 0.20 * marketFactors.correlationZ + 0.15 * marketFactors.vixZ + 0.10 * marketFactors.liquidityZ + 0.05 * marketFactors.sentimentZ;
  const riskScore = marketScore;
  const riskLevel = chineseRiskLevel(riskScore);
  const action = actionFor(riskScore, newsPulseZ);
  const newsComment = newsResult
    ? `${newsResult.source === 'gdelt_newsapi' ? 'GDELT 计数与 NewsAPI 情感' : newsResult.source === 'newsapi' ? 'NewsAPI 计数与情感' : newsResult.source === 'gdelt_google' ? 'GDELT 计数与 Google News 情感' : newsResult.source === 'google_rss' ? 'Google News RSS 计数与情感' : 'GDELT 计数'}驱动新闻脉冲 ${newsPulseZ.toFixed(2)}Z${newsResult.comboBoost ? '，制裁+关税+军事行动组合拳加成 +0.50' : ''}`
    : '两路高频新闻源暂不可用，沿用衰减后的上一期新闻脉冲 [ESTIMATED]';
  const lagComment = lagDays > 5 ? `AI-GPR滞后${lagDays}天，仅用于回测对照，权重为 0%。` : 'AI-GPR仅用于回测对照，权重为 0%。';
  const snapshot: RealtimeRiskSnapshot = {
    calc_date: calcDate,
    gpr_release_date: latestPublished.date,
    market_factors: {
      brent_z: marketFactors.brentZ,
      rho_eq_bond_z: marketFactors.correlationZ,
      vix_z: marketFactors.vixZ,
      baa10y_z: marketFactors.liquidityZ,
      skew_z: marketFactors.sentimentZ,
      gpr_reference_z: round(gprReferenceZ),
      gpr_source: gprSource,
    },
    news_pulse_z: round(newsPulseZ),
    market_score: round(marketScore),
    risk_score: round(riskScore),
    risk_level: riskLevel,
    action,
    news_trigger: newsPulseZ > 1.2,
    comment: `${newsComment}；${lagComment}`,
  };
  return {
    snapshot,
    marketAsOf: marketRaw.date,
    brentAsOf: marketRaw.factorAsOf.brent,
    brentClose: marketRaw.brent,
    factorAsOf: marketRaw.factorAsOf,
    newsAsOf: newsResult?.asOf ?? 'unavailable',
    articleCount: newsResult?.count ?? 0,
    negativeSentimentRatio: newsResult?.negativeRatio ?? 0,
    comboBoost: newsResult?.comboBoost ?? 0,
    newsSource: newsResult?.source ?? 'estimated',
    newsLive: Boolean(newsResult),
  };
}

/** Strict JSON risk snapshot for scheduled consumers and external monitoring. */
export async function getRealtimeRiskSnapshot(): Promise<RealtimeRiskSnapshot> {
  return (await calculateRealtimeRisk()).snapshot;
}

export async function getRiskNowcast(): Promise<NowcastResponse> {
  const result = await calculateRealtimeRisk();
  const { snapshot } = result;
  const tomorrowScore = round(snapshot.risk_score + clip(snapshot.news_pulse_z, 0, 2) * 0.1);
  const riskLevel = snapshot.risk_level === '极高' ? 'EXTREME' : snapshot.risk_level === '高' ? 'HIGH' : snapshot.risk_level === '中' ? 'MEDIUM' : 'LOW';
  return {
    score: snapshot.risk_score,
    tomorrowScore,
    riskLevel,
    marketAsOf: result.marketAsOf,
    brentAsOf: result.brentAsOf,
    brentClose: result.brentClose,
    factorAsOf: result.factorAsOf,
    gprAsOf: snapshot.gpr_release_date,
    newsAsOf: result.newsAsOf,
    newsPulseZ: snapshot.news_pulse_z,
    articleCount: result.articleCount,
    negativeSentimentRatio: result.negativeSentimentRatio,
    comboBoost: result.comboBoost,
    newsSource: result.newsSource,
    newsStatus: result.newsLive ? 'live' : 'estimated',
    signal: nowcastSignal(snapshot.action),
  };
}

/** Called by the scheduler every five minutes; internal TTLs keep FRED at 5m and GDELT at 15m. */
export async function warmRealtimeRiskCache(): Promise<RealtimeRiskSnapshot> {
  return getRealtimeRiskSnapshot();
}

/** Weekly Monday and first-of-month job: refresh the published AI-GPR anchor without overwriting the intraday news memory. */
export async function refreshPublishedAnchor(): Promise<RealtimeRiskSnapshot> {
  await ensureRiskHistory(true);
  return getRealtimeRiskSnapshot();
}
