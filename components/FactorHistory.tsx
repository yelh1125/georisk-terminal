'use client';

import { useMemo, useState } from 'react';
import {
  Bar, BarChart, Brush, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { RiskRecord } from '@/lib/types';

type FactorId = 'gpr' | 'vix' | 'correlation' | 'liquidity' | 'sentiment';
type MetricKey = 'gpr' | 'vix' | 'correlation' | 'liquidity' | 'sentiment';
type ZKey = 'gprZ' | 'vixZ' | 'correlationZ' | 'liquidityZ' | 'sentimentZ';

type FactorDefinition = {
  id: FactorId;
  label: string;
  shortLabel: string;
  valueKey: MetricKey;
  zKey: ZKey;
  unit: string;
  color: string;
  activeClass: string;
  source: string;
  definition: string;
  formula: string;
  weight: string;
};

const FACTORS: FactorDefinition[] = [
  {
    id: 'gpr', label: '地缘政治风险', shortLabel: 'GPR 指数', valueKey: 'gpr', zKey: 'gprZ', unit: 'index', color: '#c2410c', activeClass: 'border-orange-700 bg-orange-700 text-white',
    source: 'Matteo Iacoviello 官方 AI-GPR 日度 CSV；可配置官方传统 GPR Excel 直链用于传统序列交叉核验。',
    definition: '新闻文本中与战争、恐怖主义和国际紧张局势相关的关注度代理。',
    formula: 'GPR = 0.50 x Threat + 0.35 x Acts + 0.15 x Total（与提供的工作簿逻辑一致）。',
    weight: '30%',
  },
  {
    id: 'vix', label: '市场波动率', shortLabel: 'VIX', valueKey: 'vix', zKey: 'vixZ', unit: 'index', color: '#087e8b', activeClass: 'border-teal bg-teal text-white',
    source: 'FRED 系列 VIXCLS（CBOE Volatility Index）。',
    definition: '标普 500 期权隐含波动率，反映市场近期不确定性定价。',
    formula: '使用 FRED 最新有效 VIXCLS 收盘观测值。',
    weight: '20%',
  },
  {
    id: 'correlation', label: '相关性机制转移', shortLabel: '相关性代理', valueKey: 'correlation', zKey: 'correlationZ', unit: 'ratio', color: '#2563eb', activeClass: 'border-blue-600 bg-blue-600 text-white',
    source: 'Yahoo Finance SPY 日收盘；地区限制时使用 Alpha Vantage SPY（配置密钥后）或 FRED SP500 备用，与 FRED DGS10 日度 10 年期国债收益率对齐。',
    definition: '检测股票与债券是否由负相关转为正相关，以识别传统 60/40 对冲机制的潜在失效。',
    formula: 'rho_20d = CORREL(SPY_ret, -8 x Delta(DGS10)/100, 20 日)。',
    weight: '25%',
  },
  {
    id: 'liquidity', label: '流动性压力', shortLabel: '流动性代理', valueKey: 'liquidity', zKey: 'liquidityZ', unit: 'proxy', color: '#7c3aed', activeClass: 'border-violet-600 bg-violet-600 text-white',
    source: 'FRED BAA10Y（Moody’s Baa 公司债相对 10 年期美债利差）。',
    definition: '信用利差上升代表风险资产融资条件和二级市场流动性压力走高。',
    formula: 'Liquidity = 100 x BAA10Y（换算为基点）。',
    weight: '15%',
  },
  {
    id: 'sentiment', label: '期权情绪', shortLabel: 'CBOE 情绪代理', valueKey: 'sentiment', zKey: 'sentimentZ', unit: 'proxy', color: '#be185d', activeClass: 'border-pink-700 bg-pink-700 text-white',
    source: 'CBOE 公开 SKEW_History.csv（日度 CBOE SKEW Index）。',
    definition: 'S&P 500 尾部风险的期权定价代理，数值越高代表市场对极端下行的定价越强。',
    formula: 'Sentiment = CBOE SKEW History 的 Close 观测值。',
    weight: '10%',
  },
];

function formatDate(date: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(`${date}T00:00:00Z`));
}

export default function FactorHistory({ records }: { records: RiskRecord[] }) {
  const [selected, setSelected] = useState<FactorId[]>(['gpr', 'vix']);
  const [range, setRange] = useState<30 | 90 | 365>(90);
  const [chartType, setChartType] = useState<'line' | 'bar'>('line');
  const [scale, setScale] = useState<'raw' | 'z'>('raw');

  const visibleRecords = useMemo(() => records.slice(-range), [records, range]);
  const selectedFactors = FACTORS.filter((factor) => selected.includes(factor.id));

  function toggleFactor(id: FactorId) {
    setSelected((current) => {
      if (current.includes(id)) return current.length === 1 ? current : current.filter((item) => item !== id);
      return [...current, id];
    });
  }

  return (
    <section className="mt-6 border border-slate-200 bg-white p-5 shadow-panel" aria-labelledby="factor-history-heading">
      <div className="flex flex-col gap-5 border-b border-slate-100 pb-5 xl:flex-row xl:items-start xl:justify-between">
        <div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-teal">Factor explorer</p><h2 id="factor-history-heading" className="mt-1 text-xl font-semibold">因子历史与模型说明</h2><p className="mt-1 text-sm text-slate-500">点击指标选择查看。每张图单独使用对应的纵轴，避免不同量纲产生错误比较。</p></div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="inline-flex border border-slate-200 p-0.5" aria-label="图表类型">
            <button onClick={() => setChartType('line')} className={`h-8 px-3 font-medium ${chartType === 'line' ? 'bg-ink text-white' : 'text-slate-600'}`}>折线</button>
            <button onClick={() => setChartType('bar')} className={`h-8 px-3 font-medium ${chartType === 'bar' ? 'bg-ink text-white' : 'text-slate-600'}`}>柱状</button>
          </div>
          <div className="inline-flex border border-slate-200 p-0.5" aria-label="数据尺度">
            <button onClick={() => setScale('raw')} className={`h-8 px-3 font-medium ${scale === 'raw' ? 'bg-teal text-white' : 'text-slate-600'}`}>原始值</button>
            <button onClick={() => setScale('z')} className={`h-8 px-3 font-medium ${scale === 'z' ? 'bg-teal text-white' : 'text-slate-600'}`}>Z-score</button>
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-2" role="group" aria-label="选择风险因子">
          {FACTORS.map((factor) => {
            const active = selected.includes(factor.id);
            return <button key={factor.id} title={`切换 ${factor.label}`} aria-pressed={active} onClick={() => toggleFactor(factor.id)} className={`h-9 border px-3 text-sm font-semibold transition-colors ${active ? factor.activeClass : 'border-slate-300 bg-white text-slate-600 hover:border-slate-500'}`}>{factor.shortLabel}</button>;
          })}
        </div>
        <div className="inline-flex w-fit border border-slate-200 p-0.5" aria-label="历史区间">
          {([30, 90, 365] as const).map((days) => <button key={days} onClick={() => setRange(days)} className={`h-8 px-3 text-xs font-semibold ${range === days ? 'bg-slate-100 text-ink' : 'text-slate-500'}`}>{days}日</button>)}
        </div>
      </div>

      <div className={`mt-5 grid gap-4 ${selectedFactors.length > 1 ? 'xl:grid-cols-2' : ''}`}>
        {selectedFactors.map((factor) => {
          const data = visibleRecords.map((row) => ({ date: row.date, value: row[scale === 'raw' ? factor.valueKey : factor.zKey] }));
          const axisLabel = scale === 'raw' ? factor.unit : 'Z-score';
          const Chart = chartType === 'line' ? LineChart : BarChart;
          return (
            <article key={factor.id} className="border border-slate-200 bg-slate-50/50 p-4">
              <div className="mb-3 flex items-start justify-between gap-3"><div><h3 className="font-semibold">{factor.label}历史走势</h3><p className="mt-1 text-xs text-slate-500">{range} 日 · {scale === 'raw' ? '原始观测值' : '252 日滚动标准化'}</p></div><span className="border border-slate-200 bg-white px-2 py-1 text-xs font-mono text-slate-600">权重 {factor.weight}</span></div>
              <div className="h-64"><ResponsiveContainer width="100%" height="100%"><Chart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}><CartesianGrid stroke="#e2e8f0" vertical={false} /><XAxis dataKey="date" tickFormatter={formatDate} tick={{ fontSize: 11, fill: '#64748b' }} minTickGap={34} /><YAxis tick={{ fontSize: 11, fill: '#64748b' }} width={42} label={{ value: axisLabel, angle: -90, position: 'insideLeft', fontSize: 10, fill: '#64748b' }} /><Tooltip labelFormatter={(label) => formatDate(String(label))} formatter={(value) => [Number(value).toFixed(scale === 'raw' && factor.valueKey === 'correlation' ? 4 : 2), axisLabel]} />{chartType === 'line' ? <Line type="monotone" dataKey="value" stroke={factor.color} strokeWidth={2.3} dot={false} /> : <Bar dataKey="value" fill={factor.color} maxBarSize={28} />}{range === 365 && <Brush dataKey="date" height={22} stroke={factor.color} tickFormatter={() => ''} />}</Chart></ResponsiveContainer></div>
            </article>
          );
        })}
      </div>

      <div className="mt-5 grid gap-3 border-t border-slate-100 pt-5 lg:grid-cols-2">
        <article className="border-l-4 border-teal bg-teal/5 p-4"><h3 className="font-semibold text-ink">标准化与合成公式</h3><p className="mt-2 text-sm leading-6 text-slate-600">GPR 以 2010-2019 固定基线计算 Z；股债相关性使用五年滚动基线；VIX、流动性和情绪使用 252 个交易日窗口。综合得分 = 0.30 GPR_Z + 0.25 Corr_Z + 0.20 VIX_Z + 0.15 Liquidity_Z + 0.10 Sentiment_Z。</p></article>
        <article className="border-l-4 border-signal bg-orange-50 p-4"><h3 className="font-semibold text-ink">读图约定</h3><p className="mt-2 text-sm leading-6 text-slate-600">原始值用于检查数据本身；Z-score 用于跨因子的相对极端程度比较。权重反映因子在综合风险得分中的线性贡献，不代表单独交易仓位。</p></article>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {selectedFactors.map((factor) => <article key={`${factor.id}-details`} className="border border-slate-200 p-4"><div className="flex items-center justify-between gap-3"><h3 className="font-semibold">{factor.label}</h3><span className="text-sm font-mono text-teal">{factor.weight}</span></div><dl className="mt-3 space-y-2 text-sm leading-6"><div><dt className="font-medium text-slate-500">数据来源</dt><dd className="text-slate-700">{factor.source}</dd></div><div><dt className="font-medium text-slate-500">指标含义</dt><dd className="text-slate-700">{factor.definition}</dd></div><div><dt className="font-medium text-slate-500">原始计算</dt><dd className="font-mono text-xs text-slate-700">{factor.formula}</dd></div></dl></article>)}
      </div>
    </section>
  );
}
