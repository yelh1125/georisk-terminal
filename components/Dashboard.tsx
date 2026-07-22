'use client';

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { Activity, AlertTriangle, CircleHelp, Database, Radio, RefreshCw, ShieldAlert, Signal } from 'lucide-react';
import {
  CartesianGrid, Line, LineChart, PolarAngleAxis, PolarGrid, Radar, RadarChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { NowcastResponse, RiskRecord, RiskResponse } from '@/lib/types';
import FactorHistory from '@/components/FactorHistory';

const fetcher = (url: string) => fetch(url).then(async (response) => {
  if (!response.ok) throw new Error((await response.json()).error ?? 'Request failed');
  return response.json();
});

const riskMeta = {
  LOW: { label: '低风险', color: 'bg-emerald-500', text: 'text-emerald-700', surface: 'bg-emerald-50' },
  MEDIUM: { label: '中风险', color: 'bg-amber-400', text: 'text-amber-700', surface: 'bg-amber-50' },
  HIGH: { label: '高风险', color: 'bg-orange-500', text: 'text-orange-700', surface: 'bg-orange-50' },
  EXTREME: { label: '极高风险', color: 'bg-red-600', text: 'text-red-700', surface: 'bg-red-50' },
} as const;

type HistoryResponse = { records: RiskRecord[]; forecast: Array<{ date: string; forecast: number }>; source: 'live' | 'mock' };

function formatDate(date: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(`${date}T00:00:00Z`));
}

function FactorCard({ label, value, unit, z, previous }: { label: string; value: number; unit: string; z: number; previous?: number }) {
  const delta = previous === undefined ? 0 : ((value - previous) / Math.max(Math.abs(previous), 0.001)) * 100;
  return (
    <article className="border border-slate-200 bg-white p-4 shadow-panel">
      <div className="flex items-center justify-between gap-3 text-xs font-medium uppercase tracking-[0.12em] text-slate-500">
        <span>{label}</span><span className="font-mono text-teal">Z {z >= 0 ? '+' : ''}{z.toFixed(2)}</span>
      </div>
      <div className="mt-3 flex items-baseline gap-1"><strong className="text-2xl text-ink">{value.toFixed(value < 1 ? 3 : 1)}</strong><span className="text-sm text-slate-500">{unit}</span></div>
      <p className={delta > 0 ? 'mt-2 text-xs text-red-600' : 'mt-2 text-xs text-emerald-700'}>{delta >= 0 ? '+' : ''}{delta.toFixed(1)}% <span className="text-slate-400">较前一日</span></p>
    </article>
  );
}

export default function Dashboard() {
  const { data: score, error: scoreError, mutate: refreshScore, isLoading: scoreLoading } = useSWR<RiskResponse>('/api/risk/score', fetcher, { refreshInterval: 60_000 });
  const { data: history, error: historyError, mutate: refreshHistory } = useSWR<HistoryResponse>('/api/risk/history?days=365', fetcher, { refreshInterval: 300_000 });
  const { data: nowcast, mutate: refreshNowcast } = useSWR<NowcastResponse>('/api/risk/nowcast', fetcher, { refreshInterval: 60_000 });
  const [updating, setUpdating] = useState(false);

  const latest = score?.latest;
  const meta = latest ? riskMeta[latest.riskLevel] : riskMeta.LOW;
  const previous = history?.records.at(-2);
  const trendData = useMemo(() => {
    const actual = (history?.records ?? []).slice(-30).map((row) => ({ date: row.date, actual: row.compositeScore }));
    const last = actual.at(-1);
    return [...actual, ...(history?.forecast ?? []).map((row, index) => ({ date: row.date, forecast: row.forecast, actual: index === 0 ? last?.actual : undefined }))];
  }, [history]);
  const radarData = latest ? [
    ['地缘风险', latest.gprZ], ['相关性转移', latest.correlationZ], ['波动率', latest.vixZ], ['流动性压力', latest.liquidityZ], ['期权情绪', latest.sentimentZ],
  ].map(([factor, z]) => ({ factor, score: Math.max(0, Math.min(100, 50 + Number(z) * 18)) })) : [];

  async function updateData() {
    setUpdating(true);
    try {
      const response = await fetch('/api/risk/update', { method: 'POST' });
      if (!response.ok) throw new Error('更新失败');
      await Promise.all([refreshScore(), refreshHistory(), refreshNowcast()]);
    } finally { setUpdating(false); }
  }

  if (scoreError || historyError) return <main className="grid min-h-screen place-items-center bg-canvas p-6"><p className="border border-red-200 bg-red-50 p-5 text-red-800">无法加载风险数据，请检查 API 服务与环境变量。</p></main>;
  if (scoreLoading || !latest || !history) return <main className="grid min-h-screen place-items-center bg-canvas text-slate-500"><Activity className="mr-2 inline animate-pulse" /> 正在同步风险监测数据...</main>;

  return (
    <main className="min-h-screen bg-canvas px-4 py-6 text-ink sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-col gap-5 border-b border-slate-200 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div><p className="text-sm font-semibold uppercase tracking-[0.16em] text-teal">GeoRisk Terminal</p><h1 className="mt-1 text-2xl font-semibold">地缘政治风险实时监测</h1><p className="mt-1 text-sm text-slate-500">五因子模型 · 官方日度数据 · 最近观测日 {formatDate(latest.date)}</p></div>
          <button title="立即更新数据" onClick={updateData} disabled={updating} className="inline-flex h-10 items-center justify-center gap-2 border border-teal bg-teal px-4 text-sm font-medium text-white disabled:opacity-60"><RefreshCw size={16} className={updating ? 'animate-spin' : ''} />{updating ? '更新中' : '立即更新'}</button>
        </header>

        {nowcast ? <section className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]" aria-label="实时风险脉冲">
          <div className="border border-teal/30 bg-white shadow-panel">
            <div className="grid gap-0 lg:grid-cols-[1.35fr_repeat(4,minmax(0,1fr))]">
              <div className="border-b border-slate-200 p-5 lg:border-b-0 lg:border-r"><div className="flex items-center gap-2 text-teal"><Radio size={17} /><span className="text-xs font-semibold uppercase tracking-[0.13em]">Real-time pulse</span></div><div className="mt-2 flex items-end gap-3"><strong className="font-mono text-4xl leading-none">{nowcast.score.toFixed(2)}</strong><span className={`mb-0.5 px-2 py-1 text-xs font-semibold ${riskMeta[nowcast.riskLevel].surface} ${riskMeta[nowcast.riskLevel].text}`}>{riskMeta[nowcast.riskLevel].label}</span></div><p className="mt-3 text-sm leading-6 text-slate-600">{nowcast.signal.title}</p></div>
              <div className="border-b border-slate-200 p-5 lg:border-b-0 lg:border-r"><p className="text-xs font-medium uppercase tracking-[0.1em] text-slate-500">下一交易日情景</p><strong className="mt-2 block font-mono text-2xl">{nowcast.tomorrowScore.toFixed(2)}</strong><p className="mt-2 text-xs leading-5 text-slate-500">仅延续当前新闻脉冲，不构成价格预测</p></div>
              <div className="border-b border-slate-200 p-5 lg:border-b-0 lg:border-r"><p className="text-xs font-medium uppercase tracking-[0.1em] text-slate-500">新闻事件脉冲</p><strong className="mt-2 block font-mono text-2xl">+{nowcast.newsPulseZ.toFixed(2)} Z</strong><p className="mt-2 text-xs leading-5 text-slate-500">{nowcast.newsStatus === 'live' ? `${nowcast.newsSource === 'newsapi' ? 'NewsAPI' : nowcast.newsSource === 'gdelt_newsapi' ? 'GDELT + NewsAPI' : nowcast.newsSource === 'google_rss' ? 'Google News RSS' : nowcast.newsSource === 'gdelt_google' ? 'GDELT + Google' : 'GDELT'} · ${nowcast.articleCount.toLocaleString()} 篇 · 负面 ${(nowcast.negativeSentimentRatio * 100).toFixed(0)}%${nowcast.comboBoost ? ' · 组合加成' : ''}` : '双源新闻暂不可用，沿用衰减脉冲'}</p></div>
              <div className="border-b border-slate-200 p-5 lg:border-b-0 lg:border-r"><p className="text-xs font-medium uppercase tracking-[0.1em] text-slate-500">市场日线共同最新日</p><strong className="mt-2 block text-lg">{nowcast.marketAsOf}</strong><p className="mt-2 text-xs leading-5 text-slate-500">VIX、SKEW、信用利差、股债相关性</p></div>
              <div className="p-5"><p className="text-xs font-medium uppercase tracking-[0.1em] text-slate-500">GPR 发布日</p><strong className="mt-2 block text-lg">{nowcast.gprAsOf}</strong><p className="mt-2 text-xs leading-5 text-slate-500">学术 GPR 慢变量，保留原始数据版本</p></div>
            </div>
          </div>
          <aside className="border border-slate-200 bg-white p-5 shadow-panel" aria-label="实时风险指标说明">
            <div className="flex items-center gap-2 text-teal"><CircleHelp size={17} /><h2 className="text-sm font-semibold uppercase tracking-[0.11em]">实时风险口径</h2></div>
            <p className="mt-3 text-sm leading-6 text-slate-600">实时得分将高频新闻脉冲作为独立 30% 因子。AI-GPR 仅作 20% 的低频锚；新闻计数与负面情感任一源可用即可计算。</p>
            <dl className="mt-4 space-y-2.5 text-xs leading-5 text-slate-600">
              <div><dt className="font-semibold text-ink">六因子实时得分</dt><dd>0.20 AI-GPR 锚 Z + 0.30 新闻脉冲 Z + 0.20 股债相关 Z + 0.15 VIX Z + 0.10 BAA10Y Z + 0.05 CBOE SKEW Z。</dd></div>
              <div><dt className="font-semibold text-ink">新闻与记忆</dt><dd>GDELT 与 Google News RSS 统计 war、missile、invasion、sanction、tariff、blockade、airstrike、nuclear talks 等关键词。新闻脉冲 = 计数 Z 与负面情感 Z 的加权值；制裁+关税+军事行动加 0.50，并保留上一期脉冲的 75%。</dd></div>
              <div><dt className="font-semibold text-ink">时间戳</dt><dd>“市场观测日”代表高频市场数据日期；“GPR 发布日”代表学术序列的最后可用日期，两者分开显示以避免把滞后数据当作实时数据。</dd></div>
            </dl>
            <div className="mt-4 grid grid-cols-2 gap-2 border-t border-slate-100 pt-4 text-xs">
              <div className="border-l-2 border-emerald-500 pl-2"><strong className="block text-ink">&lt; 0.30 低</strong><span className="text-slate-500">维持监测</span></div>
              <div className="border-l-2 border-amber-400 pl-2"><strong className="block text-ink">0.30-0.59 中</strong><span className="text-slate-500">收紧风险预算</span></div>
              <div className="border-l-2 border-orange-500 pl-2"><strong className="block text-ink">0.60-0.80 高</strong><span className="text-slate-500">提高对冲</span></div>
              <div className="border-l-2 border-red-600 pl-2"><strong className="block text-ink">&gt; 0.80 极高</strong><span className="text-slate-500">强对冲审查</span></div>
            </div>
            <p className="mt-3 text-xs leading-5 text-slate-500">新闻脉冲单独触发：Z &gt; 1.20 提高对冲，Z &gt; 2.00 启动强对冲。下一交易日情景仅额外延续 10% 的当前新闻脉冲。</p>
          </aside>
        </section> : <section className="mt-6 border border-slate-200 bg-white p-4 text-sm text-slate-500">实时新闻脉冲正在同步，历史 GPR 与市场风险面板仍可正常使用。</section>}

        <section className="mt-6 grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <div className="border border-slate-200 bg-white p-6 shadow-panel">
            <div className="flex items-start justify-between"><div><p className="text-sm text-slate-500">今日综合风险得分</p><div className="mt-2 flex items-end gap-3"><strong className="font-mono text-6xl font-semibold leading-none text-ink">{latest.compositeScore.toFixed(2)}</strong><span className="mb-1 text-sm text-slate-400">Z-score</span></div></div><span className={`${meta.color} h-3 w-3 rounded-full`} aria-label={meta.label} /></div>
            <div className={`mt-5 inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold ${meta.surface} ${meta.text}`}><ShieldAlert size={16} />{meta.label}</div>
            <p className="mt-5 border-t border-slate-100 pt-4 text-sm text-slate-500">最新观测：{formatDate(latest.date)} · 模型权重已按 252 日窗口标准化</p>
          </div>
          <aside className="border border-signal/30 bg-white p-6 shadow-panel"><div className="flex items-center gap-2 text-signal"><AlertTriangle size={18} /><span className="text-sm font-semibold uppercase tracking-[0.12em]">策略建议</span></div><h2 className="mt-3 text-xl font-semibold text-ink">{score.signal.title}</h2><p className="mt-3 leading-7 text-slate-600">{score.signal.recommendation}</p><div className="mt-5 flex items-center gap-2 text-xs text-slate-500"><Signal size={14} />信号强度：{score.signal.strength === 'STRONG' ? '强' : score.signal.strength === 'MODERATE' ? '中' : '轻仓'}</div></aside>
        </section>

        <section className="mt-6 grid gap-6 xl:grid-cols-[1.75fr_1fr]">
          <article className="border border-slate-200 bg-white p-5 shadow-panel"><div className="mb-4"><h2 className="font-semibold">综合风险得分趋势</h2><p className="mt-1 text-sm text-slate-500">近 30 日实际值与未来 7 日线性基准预测</p></div><div className="h-72"><ResponsiveContainer width="100%" height="100%"><LineChart data={trendData} margin={{ top: 8, right: 10, left: -20, bottom: 0 }}><CartesianGrid stroke="#e2e8f0" vertical={false} /><XAxis dataKey="date" tickFormatter={formatDate} tick={{ fontSize: 11, fill: '#64748b' }} minTickGap={34} /><YAxis tick={{ fontSize: 11, fill: '#64748b' }} /><Tooltip labelFormatter={(label) => formatDate(String(label))} /><Line type="monotone" dataKey="actual" stroke="#087e8b" strokeWidth={2.5} dot={false} name="实际得分" connectNulls /><Line type="monotone" dataKey="forecast" stroke="#e76f51" strokeWidth={2} strokeDasharray="6 5" dot={false} name="预测基准" connectNulls /></LineChart></ResponsiveContainer></div></article>
          <article className="border border-slate-200 bg-white p-5 shadow-panel"><div><h2 className="font-semibold">五因子风险轮廓</h2><p className="mt-1 text-sm text-slate-500">以历史 Z-score 归一化显示</p></div><div className="h-72"><ResponsiveContainer width="100%" height="100%"><RadarChart data={radarData} outerRadius="68%"><Tooltip formatter={(value) => [Number(value).toFixed(0), '风险相对强度']} /><Radar dataKey="score" stroke="#087e8b" fill="#a8dadc" fillOpacity={0.7} /><PolarGrid /><PolarAngleAxis dataKey="factor" tick={{ fontSize: 11, fill: '#475569' }} /></RadarChart></ResponsiveContainer></div></article>
        </section>

        <section className="mt-6"><div className="mb-3 flex items-center gap-2"><Database size={16} className="text-teal" /><h2 className="font-semibold">因子详情</h2></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><FactorCard label="GPR 指数" value={latest.gpr} unit="index" z={latest.gprZ} previous={previous?.gpr} /><FactorCard label="VIX" value={latest.vix} unit="index" z={latest.vixZ} previous={previous?.vix} /><FactorCard label="相关性机制" value={latest.correlation} unit="ratio" z={latest.correlationZ} previous={previous?.correlation} /><FactorCard label="流动性压力" value={latest.liquidity} unit="proxy" z={latest.liquidityZ} previous={previous?.liquidity} /><FactorCard label="期权情绪" value={latest.sentiment} unit="proxy" z={latest.sentimentZ} previous={previous?.sentiment} /></div></section>
        <FactorHistory records={history.records} />
        <p className="mt-8 text-xs leading-5 text-slate-400">本系统仅为量化研究和风险监测工具，不构成投资建议。外部数据可能延迟、修订或不可用。</p>
      </div>
    </main>
  );
}
