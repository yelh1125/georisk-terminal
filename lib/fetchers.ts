import axios from 'axios';
import * as cheerio from 'cheerio';
import * as XLSX from 'xlsx';
import { unzipSync } from 'node:zlib';
import type { RawFactors } from '@/lib/types';

const AI_GPR_DAILY_URL = 'https://www.matteoiacoviello.com/ai_gpr_files/ai_gpr_data_daily.csv';
const FRED_GRAPH_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/SPY';
const YAHOO_BRENT_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/BZ=F';
const YAHOO_GOLD_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/GC=F';
const YAHOO_WTI_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/CL=F';
const TWELVE_DATA_TIME_SERIES_URL = 'https://api.twelvedata.com/time_series';
const ALPHA_VANTAGE_URL = 'https://www.alphavantage.co/query';
const CBOE_SKEW_HISTORY_URL = 'https://cdn.cboe.com/api/global/us_indices/daily_prices/SKEW_History.csv';
const REQUEST_TIMEOUT = 25_000;
const GDELT_DOC_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_LAST_UPDATE_URL = 'https://data.gdeltproject.org/gdeltv2/lastupdate.txt';
const GOOGLE_NEWS_RSS_URL = 'https://news.google.com/rss/search';
const BBC_WORLD_RSS_URL = 'https://feeds.bbci.co.uk/news/world/rss.xml';
const GDELT_RISK_QUERY = '(war OR missile OR invasion OR sanction OR tariff OR nuclear OR "nuclear talks" OR terror OR blockade OR airstrike OR "military conflict")';
const NEWS_QUERY = '(war OR missile OR invasion OR sanction OR tariff OR nuclear OR "nuclear talks" OR terror OR blockade OR airstrike OR "military conflict") when:1d';

type NumericSeries = Map<string, number>;
type GprComponents = { total: number; threat: number; act: number };
type YahooResponse = { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> } };
type AlphaVantageResponse = { 'Time Series (Daily)'?: Record<string, { '4. close'?: string }> };
type TwelveDataResponse = { status?: string; message?: string; values?: Array<{ datetime?: string; close?: string }> };
type GdeltPoint = { date?: string; value?: number; norm?: number };
type GdeltResponse = { timeline?: Array<{ data?: GdeltPoint[] }> };
type GdeltArticleResponse = { articles?: Array<{ title?: string }> };
export type HighFrequencyNews = {
  count: number;
  negativeRatio: number;
  comboDetected: boolean;
  asOf: string;
  source: 'gdelt_multisource' | 'gdelt_newsapi' | 'newsapi' | 'gdelt_google' | 'gdelt_bbc' | 'google_bbc' | 'google_rss' | 'bbc_rss' | 'gdelt' | 'gdelt_events';
};

export type FreshMarketFactors = RawFactors & {
  marketProviderVersion: 2;
  brentSource: 'twelve_data_xbr_usd' | 'yahoo_bz_f' | 'fred_dcoilbrenteu';
  factorAsOf: { brent: string; oilSpread: string; oilIv: string; goldOil: string; correlation: string; vix: string; liquidity: string; sentiment: string };
};

let historyCache: { expiresAt: number; records: RawFactors[] } | null = null;
let gdeltRequestQueue: Promise<void> = Promise.resolve();
let lastGdeltRequestAt = 0;

const finite = (value: unknown): number | null => {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '.') return null;
  const parsed = Number(raw.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

/** Used by the weekly/monthly anchor job; intraday calculations never use AI-GPR as a same-day observation. */
export function invalidatePublishedGprCache(): void {
  historyCache = null;
}

function normalizeDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const raw = String(value ?? '').trim();
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const timestamp = Date.parse(raw);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString().slice(0, 10);
}

function findColumn(headers: string[], patterns: RegExp[]): string | undefined {
  return headers.find((header) => patterns.some((pattern) => pattern.test(header)));
}

function parseFredCsv(csv: string, seriesId: string): NumericSeries {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines.shift()?.split(',') ?? [];
  const valueIndex = header.findIndex((item) => item.trim() === seriesId);
  const dateIndex = header.findIndex((item) => item.trim() === 'observation_date');
  if (dateIndex < 0 || valueIndex < 0) throw new Error(`FRED ${seriesId} CSV has an unexpected header`);
  const result: NumericSeries = new Map();
  for (const line of lines) {
    const columns = line.split(',');
    const date = normalizeDate(columns[dateIndex]);
    const value = finite(columns[valueIndex]);
    if (date && value !== null) result.set(date, value);
  }
  return result;
}

async function fetchFredSeries(seriesId: string): Promise<NumericSeries> {
  const { data } = await axios.get<string>(FRED_GRAPH_URL, { params: { id: seriesId }, timeout: REQUEST_TIMEOUT, responseType: 'text' });
  const series = parseFredCsv(data, seriesId);
  if (!series.size) throw new Error(`FRED ${seriesId} returned no valid observations`);
  return series;
}

function parseCboeIndexCsv(csv: string): NumericSeries {
  const lines = csv.trim().split(/\r?\n/);
  const headers = lines.shift()?.split(',').map((item) => item.trim()) ?? [];
  const dateIndex = headers.findIndex((header) => /^date$/i.test(header));
  const closeIndex = headers.findIndex((header) => /^close$/i.test(header)) >= 0
    ? headers.findIndex((header) => /^close$/i.test(header))
    : headers.findIndex((header, index) => index !== dateIndex);
  if (dateIndex < 0 || closeIndex < 0) throw new Error('CBOE SKEW CSV has an unexpected header');
  const result: NumericSeries = new Map();
  for (const line of lines) {
    const columns = line.split(',');
    const date = normalizeDate(columns[dateIndex]);
    const close = finite(columns[closeIndex]);
    if (date && close !== null) result.set(date, close);
  }
  return result;
}

async function fetchCboeSkewSeries(): Promise<NumericSeries> {
  const { data } = await axios.get<string>(CBOE_SKEW_HISTORY_URL, { timeout: REQUEST_TIMEOUT, responseType: 'text' });
  const series = parseCboeIndexCsv(data);
  if (!series.size) throw new Error('CBOE SKEW history file returned no valid observations');
  return series;
}

function parseTraditionalGpr(workbookData: ArrayBuffer): Map<string, GprComponents> {
  const workbook = XLSX.read(workbookData, { type: 'array', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: true });
  if (!rows.length) throw new Error('Official GPR workbook is empty');
  const headers = Object.keys(rows[0]);
  const dateColumn = findColumn(headers, [/^date$/i, /^day$/i]);
  const totalColumn = findColumn(headers, [/^gprd$/i, /^gpr$/i]);
  const threatColumn = findColumn(headers, [/gprd.*threat/i, /^threat/i]);
  const actColumn = findColumn(headers, [/gprd.*act/i, /^act/i]);
  if (!dateColumn || !totalColumn || !threatColumn || !actColumn) throw new Error('Official GPR workbook is missing GPRD component columns');

  const result = new Map<string, GprComponents>();
  for (const row of rows) {
    const date = normalizeDate(row[dateColumn]);
    const total = finite(row[totalColumn]);
    const threat = finite(row[threatColumn]);
    const act = finite(row[actColumn]);
    if (date && total !== null && threat !== null && act !== null) result.set(date, { total, threat, act });
  }
  return result;
}

function parseAiGpr(csv: string): Map<string, GprComponents> {
  const rows = csv.trim().split(/\r?\n/).map((line) => line.split(','));
  const headers = rows.shift()?.map((header) => header.trim()) ?? [];
  const dateIndex = headers.findIndex((header) => /^date$/i.test(header));
  const totalIndex = headers.findIndex((header) => /^gpr[_ ]?ai$/i.test(header) || /^ai[_ ]?gpr$/i.test(header));
  const threatIndex = headers.findIndex((header) => /threat/i.test(header));
  const actIndex = headers.findIndex((header) => /act/i.test(header));
  if (dateIndex < 0 || totalIndex < 0 || threatIndex < 0 || actIndex < 0) throw new Error('AI-GPR CSV is missing date, total, threat, or act columns');
  const result = new Map<string, GprComponents>();
  for (const row of rows) {
    const date = normalizeDate(row[dateIndex]);
    const total = finite(row[totalIndex]);
    const threat = finite(row[threatIndex]);
    const act = finite(row[actIndex]);
    if (date && total !== null && threat !== null && act !== null) result.set(date, { total, threat, act });
  }
  return result;
}

async function fetchSpyCloseSeries(startDate: string): Promise<NumericSeries> {
  const period1 = Math.floor(new Date(`${startDate}T00:00:00Z`).getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000) + 86_400;
  try {
    const { data } = await axios.get<YahooResponse>(YAHOO_CHART_URL, {
      params: { period1, period2, interval: '1d', events: 'history' }, timeout: REQUEST_TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0 (GeoRiskTerminal; data-research)' },
    });
    const result = data.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const series: NumericSeries = new Map();
    timestamps.forEach((timestamp, index) => {
      const close = closes[index];
      if (close !== null && close !== undefined && Number.isFinite(close)) series.set(new Date(timestamp * 1000).toISOString().slice(0, 10), close);
    });
    if (series.size) return series;
  } catch (error) {
    console.warn('[fetch] Yahoo SPY unavailable; using FRED SP500 fallback', error instanceof Error ? error.message : error);
  }
  const alphaVantageKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (alphaVantageKey) {
    try {
      const { data } = await axios.get<AlphaVantageResponse>(ALPHA_VANTAGE_URL, {
        params: { function: 'TIME_SERIES_DAILY', symbol: 'SPY', outputsize: 'full', apikey: alphaVantageKey },
        timeout: REQUEST_TIMEOUT,
      });
      const series: NumericSeries = new Map();
      Object.entries(data['Time Series (Daily)'] ?? {}).forEach(([date, row]) => {
        const close = finite(row['4. close']);
        if (date >= startDate && close !== null) series.set(date, close);
      });
      if (series.size) return series;
      console.warn('[fetch] Alpha Vantage returned no usable SPY history; using FRED SP500 fallback');
    } catch (error) {
      console.warn('[fetch] Alpha Vantage SPY unavailable; using FRED SP500 fallback', error instanceof Error ? error.message : error);
    }
  }
  // FRED SP500 is a published daily S&P 500 closing series and remains a real-price fallback where Yahoo is region-blocked.
  return fetchFredSeries('SP500');
}

type BrentMarketSeries = { series: NumericSeries; source: 'twelve_data_xbr_usd' | 'yahoo_bz_f' | 'fred_dcoilbrenteu' };

async function fetchTwelveDataSeries(symbol: string, startDate: string, minimumObservations = 1): Promise<NumericSeries> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) throw new Error('TWELVE_DATA_API_KEY is not configured');
  const { data } = await axios.get<TwelveDataResponse>(TWELVE_DATA_TIME_SERIES_URL, {
    params: { symbol, interval: '1day', outputsize: 5000, timezone: 'UTC', apikey: apiKey }, timeout: REQUEST_TIMEOUT,
  });
  if (data.status === 'error') throw new Error(data.message ?? `Twelve Data ${symbol} returned an error`);
  const series: NumericSeries = new Map();
  (data.values ?? []).forEach((row) => {
    const date = normalizeDate(row.datetime);
    const close = finite(row.close);
    if (date && date >= startDate && close !== null) series.set(date, close);
  });
  if (series.size < minimumObservations) throw new Error(`Twelve Data ${symbol} returned only ${series.size} usable daily observations`);
  return series;
}

/** Brent futures close is the timely oil-market input; FRED's spot series is the published fallback. */
async function fetchBrentMarketSeries(startDate: string): Promise<BrentMarketSeries> {
  if (process.env.TWELVE_DATA_API_KEY) {
    try {
      return { series: await fetchTwelveDataSeries('XBR/USD', startDate), source: 'twelve_data_xbr_usd' };
    } catch (error) {
      console.warn('[fetch] Twelve Data XBR/USD unavailable; trying Yahoo Brent', error instanceof Error ? error.message : error);
    }
  }
  const period1 = Math.floor(new Date(`${startDate}T00:00:00Z`).getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000) + 86_400;
  try {
    const { data } = await axios.get<YahooResponse>(YAHOO_BRENT_CHART_URL, {
      params: { period1, period2, interval: '1d', events: 'history' }, timeout: REQUEST_TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0 (GeoRiskTerminal; data-research)' },
    });
    const result = data.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const series: NumericSeries = new Map();
    timestamps.forEach((timestamp, index) => {
      const close = closes[index];
      if (close !== null && close !== undefined && Number.isFinite(close)) series.set(new Date(timestamp * 1000).toISOString().slice(0, 10), close);
    });
    if (series.size) return { series, source: 'yahoo_bz_f' };
  } catch (error) {
    console.warn('[fetch] Yahoo Brent unavailable; using FRED DCOILBRENTEU fallback', error instanceof Error ? error.message : error);
  }
  return { series: await fetchFredSeries('DCOILBRENTEU'), source: 'fred_dcoilbrenteu' };
}

async function fetchBrentCloseSeries(startDate: string): Promise<NumericSeries> {
  return (await fetchBrentMarketSeries(startDate)).series;
}

async function fetchGoldCloseSeries(startDate: string): Promise<NumericSeries> {
  const twelveDataKey = process.env.TWELVE_DATA_API_KEY;
  if (twelveDataKey) {
    try {
      return await fetchTwelveDataSeries('XAU/USD', startDate, 252);
    } catch (error) {
      console.warn('[fetch] Twelve Data XAU/USD unavailable; trying Yahoo fallback', error instanceof Error ? error.message : error);
    }
  }
  const period1 = Math.floor(new Date(`${startDate}T00:00:00Z`).getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000) + 86_400;
  try {
    const { data } = await axios.get<YahooResponse>(YAHOO_GOLD_CHART_URL, {
      params: { period1, period2, interval: '1d', events: 'history' }, timeout: REQUEST_TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0 (GeoRiskTerminal; data-research)' },
    });
    const result = data.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const series: NumericSeries = new Map();
    timestamps.forEach((timestamp, index) => {
      const close = closes[index];
      if (close !== null && close !== undefined && Number.isFinite(close)) series.set(new Date(timestamp * 1000).toISOString().slice(0, 10), close);
    });
    if (series.size) return series;
  } catch (error) {
    console.warn('[fetch] Yahoo gold unavailable; Gold/Oil factor will be excluded', error instanceof Error ? error.message : error);
  }
  throw new Error('No usable gold series. Configure TWELVE_DATA_API_KEY for stable XAU/USD history.');
}

async function fetchWtiCloseSeries(startDate: string): Promise<NumericSeries> {
  if (process.env.TWELVE_DATA_API_KEY) {
    try {
      return await fetchTwelveDataSeries('WTI/USD', startDate);
    } catch (error) {
      console.warn('[fetch] Twelve Data WTI/USD unavailable; trying Yahoo WTI', error instanceof Error ? error.message : error);
    }
  }
  const period1 = Math.floor(new Date(`${startDate}T00:00:00Z`).getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000) + 86_400;
  try {
    const { data } = await axios.get<YahooResponse>(YAHOO_WTI_CHART_URL, {
      params: { period1, period2, interval: '1d', events: 'history' }, timeout: REQUEST_TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0 (GeoRiskTerminal; data-research)' },
    });
    const result = data.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const series: NumericSeries = new Map();
    timestamps.forEach((timestamp, index) => {
      const close = closes[index];
      if (close !== null && close !== undefined && Number.isFinite(close)) series.set(new Date(timestamp * 1000).toISOString().slice(0, 10), close);
    });
    if (series.size) return series;
  } catch (error) {
    console.warn('[fetch] Yahoo WTI unavailable; using FRED DCOILWTICO fallback', error instanceof Error ? error.message : error);
  }
  return fetchFredSeries('DCOILWTICO');
}

function pearson(left: number[], right: number[]): number | null {
  if (left.length !== right.length || left.length < 2) return null;
  const meanLeft = left.reduce((sum, value) => sum + value, 0) / left.length;
  const meanRight = right.reduce((sum, value) => sum + value, 0) / right.length;
  const top = left.reduce((sum, value, index) => sum + (value - meanLeft) * (right[index] - meanRight), 0);
  const leftDeviation = Math.sqrt(left.reduce((sum, value) => sum + (value - meanLeft) ** 2, 0));
  const rightDeviation = Math.sqrt(right.reduce((sum, value) => sum + (value - meanRight) ** 2, 0));
  return leftDeviation && rightDeviation ? top / (leftDeviation * rightDeviation) : null;
}

/**
 * Builds daily raw factor observations only from external published series.
 * GPR composition follows the supplied workbook logic: 50% threats, 35% acts, 15% total index.
 */
export async function fetchRealFactorHistory(): Promise<RawFactors[]> {
  if (historyCache && historyCache.expiresAt > Date.now()) return historyCache.records;
  const startDate = '2010-01-01';
  const [aiCsv, vix, skew, dgs10, baa10y, spy, brent, wti, oilIv, gold] = await Promise.all([
    axios.get<string>(AI_GPR_DAILY_URL, { timeout: REQUEST_TIMEOUT, responseType: 'text' }).then((response) => response.data),
    fetchFredSeries('VIXCLS'), fetchCboeSkewSeries(), fetchFredSeries('DGS10'), fetchFredSeries('BAA10Y'), fetchSpyCloseSeries(startDate),
    fetchFredSeries('DCOILBRENTEU'), fetchFredSeries('DCOILWTICO'), fetchFredSeries('OVXCLS'), fetchGoldCloseSeries(startDate).catch((error) => { console.warn('[fetch] Gold/Oil factor unavailable; excluding it from this refresh', error instanceof Error ? error.message : error); return null; }),
  ]);
  const ai = parseAiGpr(aiCsv);
  const traditional = await (async () => {
    const configuredUrl = process.env.GPR_DAILY_XLS_URL;
    if (!configuredUrl) return new Map<string, GprComponents>();
    try {
      const workbook = await axios.get<ArrayBuffer>(configuredUrl, { timeout: 90_000, responseType: 'arraybuffer' });
      return parseTraditionalGpr(workbook.data);
    } catch (error) {
      console.warn('[fetch] configured traditional GPR workbook unavailable; using AI-GPR', error instanceof Error ? error.message : error);
      return new Map<string, GprComponents>();
    }
  })();
  const dates = Array.from(vix.keys()).filter((date) => date >= startDate && skew.has(date) && dgs10.has(date) && baa10y.has(date) && spy.has(date) && brent.has(date) && wti.has(date) && oilIv.has(date)).sort();
  const stockReturns: number[] = [];
  const bondReturns: number[] = [];
  const observations: RawFactors[] = [];
  let previousSpy: number | null = null;
  let previousYield: number | null = null;

  let lastGpr = 0;
  for (const date of dates) {
    const spyClose = spy.get(date)!;
    const yield10 = dgs10.get(date)!;
    const gprComponents = ai.get(date) ?? traditional.get(date);
    if (gprComponents) lastGpr = 0.15 * gprComponents.total + 0.5 * gprComponents.threat + 0.35 * gprComponents.act;
    if (previousSpy === null || previousYield === null) {
      previousSpy = spyClose;
      previousYield = yield10;
      continue;
    }
    stockReturns.push(spyClose / previousSpy - 1);
    // Modified-duration approximation: bond return ~= -duration x yield change (yield is in percent).
    bondReturns.push(-8 * (yield10 - previousYield) / 100);
    previousSpy = spyClose;
    previousYield = yield10;
    const correlation = pearson(stockReturns.slice(-20), bondReturns.slice(-20));
    if (correlation === null) continue;
    observations.push({
      date,
      brent: Number(brent.get(date)!.toFixed(4)),
      oilSpread: Number((brent.get(date)! - wti.get(date)!).toFixed(4)),
      oilIv: oilIv.get(date)!,
      goldOilRatio: gold?.has(date) ? Number((gold.get(date)! / brent.get(date)!).toFixed(6)) : 0,
      // Carry only the latest published reference after an AI-GPR release gap; it has zero score weight.
      gpr: Number(lastGpr.toFixed(4)),
      correlation: Number(correlation.toFixed(6)),
      vix: vix.get(date)!,
      // BAA10Y is the published Baa-minus-10Y credit spread; convert percent to basis points for readability.
      liquidity: Number((baa10y.get(date)! * 100).toFixed(2)),
      sentiment: skew.get(date)!,
    });
  }
  if (observations.length < 252) throw new Error('Real data intersection has fewer than 252 daily observations');
  // AI-GPR is an anchor series, refreshed weekly rather than treated as an intraday observation.
  historyCache = { records: observations, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 };
  return observations;
}

export async function fetchCurrentFactors(): Promise<RawFactors> {
  const history = await fetchRealFactorHistory();
  const latest = history.at(-1);
  if (!latest) throw new Error('No real factor observation is available');
  return latest;
}

/** Builds a current market snapshot independently of the slower published GPR/AI-GPR vintage. */
export async function fetchFreshMarketFactors(gprReference = 0): Promise<FreshMarketFactors> {
  const startDate = '2010-01-01';
  const [vix, skew, dgs10, baa10y, spy, brentMarket, wti, oilIv, gold] = await Promise.all([
    fetchFredSeries('VIXCLS'), fetchCboeSkewSeries(), fetchFredSeries('DGS10'), fetchFredSeries('BAA10Y'), fetchSpyCloseSeries(startDate), fetchBrentMarketSeries(startDate), fetchWtiCloseSeries(startDate), fetchFredSeries('OVXCLS'), fetchGoldCloseSeries(startDate).catch((error) => { console.warn('[fetch] Gold/Oil factor unavailable; real-time score will re-normalize', error instanceof Error ? error.message : error); return null; }),
  ]);
  const brent = brentMarket.series;
  // Do not require a common date: SKEW and Baa spreads can publish after the futures market.
  // Each component uses its own latest published value and exposes its as-of date to the UI.
  const latestDate = (series: NumericSeries, label: string) => {
    const date = Array.from(series.keys()).sort().at(-1);
    if (!date) throw new Error(`${label} has no current observation`);
    return date;
  };
  const correlationDates = Array.from(spy.keys()).filter((date) => dgs10.has(date)).sort();
  const oilSpreadDates = Array.from(brent.keys()).filter((date) => wti.has(date)).sort();
  const goldOilDates = gold ? Array.from(brent.keys()).filter((date) => gold.has(date)).sort() : [];
  const correlationDate = correlationDates.at(-1);
  if (!correlationDate) throw new Error('SPY and DGS10 have no common current observation');
  const oilSpreadDate = oilSpreadDates.at(-1);
  const goldOilDate = goldOilDates.at(-1);
  if (!oilSpreadDate) throw new Error('Brent and WTI have no common current observation');
  const lookbackDates = correlationDates.slice(-21);
  const stockReturns: number[] = [];
  const bondReturns: number[] = [];
  for (let index = 1; index < lookbackDates.length; index += 1) {
    const previous = lookbackDates[index - 1];
    const current = lookbackDates[index];
    stockReturns.push(spy.get(current)! / spy.get(previous)! - 1);
    bondReturns.push(-8 * (dgs10.get(current)! - dgs10.get(previous)!) / 100);
  }
  const correlation = pearson(stockReturns, bondReturns);
  if (correlation === null) throw new Error('Insufficient current market history for stock-bond correlation');
  const factorAsOf = {
    brent: latestDate(brent, 'Brent'), oilSpread: oilSpreadDate, oilIv: latestDate(oilIv, 'OVX'), goldOil: goldOilDate ?? 'unavailable', correlation: correlationDate, vix: latestDate(vix, 'VIX'),
    liquidity: latestDate(baa10y, 'BAA10Y'), sentiment: latestDate(skew, 'SKEW'),
  };
  return {
    // The displayed market date is the fastest tradable component; individual dates remain visible.
    date: [factorAsOf.brent, factorAsOf.oilSpread, factorAsOf.oilIv, factorAsOf.correlation, factorAsOf.vix].sort().at(-1)!,
    brent: Number(brent.get(factorAsOf.brent)!.toFixed(4)),
    oilSpread: Number((brent.get(oilSpreadDate)! - wti.get(oilSpreadDate)!).toFixed(4)),
    oilIv: oilIv.get(factorAsOf.oilIv)!,
    goldOilRatio: gold && goldOilDate ? Number((gold.get(goldOilDate)! / brent.get(goldOilDate)!).toFixed(6)) : 0,
    gpr: gprReference,
    correlation: Number(correlation.toFixed(6)),
    vix: vix.get(factorAsOf.vix)!,
    liquidity: Number((baa10y.get(factorAsOf.liquidity)! * 100).toFixed(2)),
    sentiment: skew.get(factorAsOf.sentiment)!,
    marketProviderVersion: 2,
    brentSource: brentMarket.source,
    factorAsOf,
  };
}

function parseGdeltTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?/);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0));
}

async function gdeltRequest<T extends { timeline?: unknown; articles?: unknown[] }>(params: Record<string, string>): Promise<T> {
  let releaseQueue: (() => void) | undefined;
  const previousRequest = gdeltRequestQueue;
  gdeltRequestQueue = new Promise<void>((resolve) => { releaseQueue = resolve; });
  await previousRequest;
  const delay = Math.max(0, 5_000 - (Date.now() - lastGdeltRequestAt));
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  try {
    const { data } = await axios.get<T>(GDELT_DOC_URL, {
      params: { query: GDELT_RISK_QUERY, mode: 'timelinevolraw', format: 'json', ...params },
      timeout: REQUEST_TIMEOUT,
    });
    if (!data.timeline && !data.articles) throw new Error('GDELT returned no usable data');
    return data;
  } finally {
    lastGdeltRequestAt = Date.now();
    releaseQueue?.();
  }
}

function parseGdeltCounts(data: GdeltResponse): Array<{ timestamp: number; count: number }> {
  return (data.timeline ?? []).flatMap((series) => series.data ?? [])
    .map((point) => ({ timestamp: parseGdeltTimestamp(point.date), count: Number(point.value ?? 0) }))
    .filter((point): point is { timestamp: number; count: number } => point.timestamp !== null && Number.isFinite(point.count) && point.count >= 0);
}

function aggregateGdeltDaily(points: Array<{ timestamp: number; count: number }>): Array<{ date: string; count: number }> {
  const totals = new Map<string, number>();
  points.forEach((point) => {
    const date = new Date(point.timestamp).toISOString().slice(0, 10);
    totals.set(date, (totals.get(date) ?? 0) + point.count);
  });
  return Array.from(totals.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([date, count]) => ({ date, count }));
}

/** Current 24-hour article count from GDELT DOC 2.0. This is an intraday proxy, not AI-GPR. */
export async function fetchGdeltCurrentArticleCount(): Promise<{ count: number; asOf: string }> {
  const data = await gdeltRequest<GdeltResponse>({ timespan: '1day' });
  const points = parseGdeltCounts(data);
  if (points.length < 4) throw new Error('GDELT returned insufficient current article-count observations');
  return { count: points.reduce((sum, point) => sum + point.count, 0), asOf: new Date(Math.max(...points.map((point) => point.timestamp))).toISOString() };
}

/** GDELT article headlines supply the negative-sentiment ratio and the cross-topic escalation rule. */
async function fetchGdeltHeadlineSentiment(): Promise<{ negativeRatio: number; comboDetected: boolean }> {
  const data = await gdeltRequest<GdeltArticleResponse>({ mode: 'artlist', timespan: '1day', maxrecords: '250' });
  const titles = (data.articles ?? []).map((article) => article.title?.trim() ?? '').filter(Boolean);
  if (titles.length < 3) throw new Error('GDELT article list returned insufficient headlines');
  return analyzeNewsTexts(titles);
}

/**
 * Structured GDELT Event fallback. The latest Event export is published every 15 minutes;
 * root CAMEO classes 18/19/20 capture assault, fighting and unconventional mass violence.
 * Goldstein Scale filters to adverse interactions, so this is an event-intensity signal rather
 * than a second copy of keyword headline volume.
 */
async function fetchGdeltEventConflictIntensity(): Promise<{ count: number; negativeRatio: number; comboDetected: boolean; asOf: string }> {
  const { data: listing } = await axios.get<string>(GDELT_LAST_UPDATE_URL, { timeout: REQUEST_TIMEOUT, responseType: 'text' });
  const eventUrl = listing.split(/\r?\n/).map((line) => line.trim().split(/\s+/).at(-1) ?? '').find((url) => /\.export\.CSV\.zip$/i.test(url));
  if (!eventUrl) throw new Error('GDELT lastupdate did not contain an Event export URL');
  const { data: archive } = await axios.get<ArrayBuffer>(eventUrl, { timeout: REQUEST_TIMEOUT, responseType: 'arraybuffer' });
  const rows = unzipSync(Buffer.from(archive)).toString('utf8').trim().split(/\r?\n/);
  let severeEvents = 0;
  let adverseEvents = 0;
  for (const row of rows) {
    const columns = row.split('\t');
    const rootCode = columns[28];
    const goldstein = Number(columns[30]);
    if (!Number.isFinite(goldstein) || goldstein >= 0) continue;
    adverseEvents += 1;
    if (rootCode === '18' || rootCode === '19' || rootCode === '20') severeEvents += 1;
  }
  if (!severeEvents) throw new Error('GDELT Event export contained no qualifying conflict events');
  const stamp = eventUrl.match(/(\d{14})\.export/i)?.[1];
  const asOf = stamp ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}Z` : new Date().toISOString();
  // Convert one 15-minute bucket to a 24-hour comparable rate for the shared news calibration.
  return { count: severeEvents * 96, negativeRatio: severeEvents / Math.max(adverseEvents, severeEvents), comboDetected: false, asOf };
}

function hasTerm(text: string, pattern: RegExp): boolean {
  return pattern.test(text.toLowerCase());
}

/**
 * Google News RSS is deliberately independent from GDELT. It supplies high-frequency headline
 * count and a transparent lexicon-based negative-sentiment ratio when GDELT is delayed or rate-limited.
 */
async function fetchGoogleNewsHeadlines(): Promise<{ count: number; negativeRatio: number; comboDetected: boolean; asOf: string }> {
  const { data } = await axios.get<string>(GOOGLE_NEWS_RSS_URL, {
    params: { q: NEWS_QUERY, hl: 'en-US', gl: 'US', ceid: 'US:en' },
    timeout: 6_000,
    responseType: 'text',
    headers: { 'User-Agent': 'Mozilla/5.0 (GeoRiskTerminal; research monitor)' },
  });
  const $ = cheerio.load(data, { xmlMode: true });
  const cutoff = Date.now() - 30 * 60 * 60 * 1000;
  const headlines = new Set<string>();
  $('item').each((_, item) => {
    const title = $(item).find('title').first().text().replace(/\s+-\s+[^-]+$/, '').trim();
    const description = $(item).find('description').first().text();
    const published = Date.parse($(item).find('pubDate').first().text());
    if (title && (!Number.isFinite(published) || published >= cutoff)) headlines.add(`${title} ${description}`.toLowerCase());
  });
  const articles = Array.from(headlines);
  if (articles.length < 3) throw new Error('Google News RSS returned insufficient current headlines');
  const negative = /\b(war|missile|invasion|attack|airstrike|strike|terror|blockade|retaliat|escalat|killed|casualt)\b/i;
  const military = /\b(war|missile|invasion|attack|airstrike|strike|military|conflict)\b/i;
  const sanctions = /\b(sanction|blockade)\b/i;
  const tariffs = /\b(tariff|trade\s+war)\b/i;
  const corpus = articles.join(' ');
  return {
    count: articles.length,
    negativeRatio: articles.filter((article) => hasTerm(article, negative)).length / articles.length,
    comboDetected: hasTerm(corpus, military) && hasTerm(corpus, sanctions) && hasTerm(corpus, tariffs),
    asOf: new Date().toISOString(),
  };
}

/** BBC World RSS is a no-key, editorially independent confirmation source for the news pulse. */
async function fetchBbcWorldHeadlines(): Promise<{ count: number; negativeRatio: number; comboDetected: boolean; asOf: string }> {
  const { data } = await axios.get<string>(BBC_WORLD_RSS_URL, {
    timeout: 6_000, responseType: 'text', headers: { 'User-Agent': 'Mozilla/5.0 (GeoRiskTerminal; research monitor)' },
  });
  const $ = cheerio.load(data, { xmlMode: true });
  const cutoff = Date.now() - 30 * 60 * 60 * 1000;
  const relevant = /\b(war|missile|invasion|attack|airstrike|strike|terror|blockade|sanction|tariff|nuclear|military|conflict)\b/i;
  const texts: string[] = [];
  $('item').each((_, item) => {
    const title = $(item).find('title').first().text().trim();
    const description = $(item).find('description').first().text().trim();
    const published = Date.parse($(item).find('pubDate').first().text());
    const text = `${title} ${description}`.trim();
    if (text && relevant.test(text) && (!Number.isFinite(published) || published >= cutoff)) texts.push(text.toLowerCase());
  });
  if (texts.length < 1) throw new Error('BBC World RSS returned no current geopolitically relevant headlines');
  const analysis = analyzeNewsTexts(texts);
  return { count: texts.length, ...analysis, asOf: new Date().toISOString() };
}

function analyzeNewsTexts(texts: string[]): { negativeRatio: number; comboDetected: boolean } {
  const negative = /\b(war|missile|invasion|attack|airstrike|strike|terror|blockade|retaliat|escalat|killed|casualt)\b/i;
  const military = /\b(war|missile|invasion|attack|airstrike|strike|military|conflict)\b/i;
  const sanctions = /\b(sanction|blockade)\b/i;
  const tariffs = /\b(tariff|trade\s+war)\b/i;
  const corpus = texts.join(' ');
  return {
    negativeRatio: texts.filter((text) => hasTerm(text, negative)).length / texts.length,
    comboDetected: hasTerm(corpus, military) && hasTerm(corpus, sanctions) && hasTerm(corpus, tariffs),
  };
}

type NewsApiResponse = { totalResults?: number; articles?: Array<{ title?: string; description?: string }> };

/** Optional production-grade independent source. NEWS_API_KEY enables historical and current headline retrieval without GDELT. */
async function fetchNewsApiHeadlines(): Promise<{ count: number; negativeRatio: number; comboDetected: boolean; asOf: string }> {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) throw new Error('NEWS_API_KEY is not configured');
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await axios.get<NewsApiResponse>('https://newsapi.org/v2/everything', {
    params: { q: NEWS_QUERY.replace(' when:1d', ''), from, language: 'en', sortBy: 'publishedAt', pageSize: 100, apiKey },
    timeout: REQUEST_TIMEOUT,
  });
  const texts = (data.articles ?? []).map((item) => `${item.title ?? ''} ${item.description ?? ''}`.trim()).filter(Boolean);
  if (texts.length < 3) throw new Error('NewsAPI returned insufficient current headlines');
  const analysis = analyzeNewsTexts(texts);
  return { count: Math.max(texts.length, data.totalResults ?? 0), ...analysis, asOf: new Date().toISOString() };
}

/**
 * GDELT remains the calibrated article-count series. Independent editorial feeds confirm
 * sentiment and escalation combinations even when GDELT itself remains available.
 */
export async function fetchHighFrequencyNews(): Promise<HighFrequencyNews> {
  const [gdelt, gdeltSentiment, newsApi, google, bbc] = await Promise.all([
    fetchGdeltCurrentArticleCount().catch(() => null),
    fetchGdeltHeadlineSentiment().catch(() => null),
    fetchNewsApiHeadlines().catch(() => null),
    fetchGoogleNewsHeadlines().catch(() => null),
    fetchBbcWorldHeadlines().catch(() => null),
  ]);

  if (gdelt) {
    const independent = [newsApi, google, bbc].filter((item): item is NonNullable<typeof item> => item !== null);
    const independentSentiment = independent.length ? independent.reduce((sum, item) => sum + item.negativeRatio, 0) / independent.length : null;
    const negativeRatio = gdeltSentiment && independentSentiment !== null
      ? 0.6 * gdeltSentiment.negativeRatio + 0.4 * independentSentiment
      : gdeltSentiment?.negativeRatio ?? independentSentiment ?? 0.5;
    const comboDetected = [gdeltSentiment, ...independent].some((item) => item?.comboDetected);
    const source = newsApi && google && bbc ? 'gdelt_multisource' : newsApi ? 'gdelt_newsapi' : google ? 'gdelt_google' : bbc ? 'gdelt_bbc' : 'gdelt';
    return { count: gdelt.count, negativeRatio, comboDetected, asOf: gdelt.asOf, source };
  }

  const gdeltEvents = await fetchGdeltEventConflictIntensity().catch(() => null);
  if (gdeltEvents) return { ...gdeltEvents, source: 'gdelt_events' };

  // GDELT failed: use the independent feeds as the calibrated count fallback.
  if (newsApi) return { ...newsApi, source: 'newsapi' };
  if (google && bbc) {
    return {
      count: Math.round((google.count + bbc.count) / 2),
      negativeRatio: (google.negativeRatio + bbc.negativeRatio) / 2,
      comboDetected: google.comboDetected || bbc.comboDetected,
      asOf: new Date().toISOString(), source: 'google_bbc',
    };
  }
  if (google) return { ...google, source: 'google_rss' };
  if (bbc) return { ...bbc, source: 'bbc_rss' };
  throw new Error('GDELT and independent high-frequency news sources are unavailable');
}

/**
 * Fetches the same keyword count at 15-minute resolution and aggregates it to daily counts.
 * GDELT is rate-limited, so callers should cache this 90-day calibration sample for at least a week.
 */
export async function fetchGdeltHistoricalDailyCounts(): Promise<Array<{ date: string; count: number }>> {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 92);
  const stamp = (date: Date) => date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const data = await gdeltRequest<GdeltResponse>({ startdatetime: stamp(start), enddatetime: stamp(end) });
  const daily = aggregateGdeltDaily(parseGdeltCounts(data));
  if (daily.length < 60) throw new Error(`GDELT historical calibration returned only ${daily.length} daily observations`);
  return daily;
}
