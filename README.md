# GeoRisk Terminal

一个基于 Next.js 的地缘政治风险监测与策略信号仪表盘。系统将传统 GPR、AI-GPR、波动率、相关性机制、流动性和期权情绪数据统一成五因子风险得分，并输出可解释的策略状态。

## 项目结构

```text
.
├── app/
│   ├── api/risk/
│   │   ├── history/route.ts       # 1 年历史数据与 7 日预测
│   │   ├── nowcast/route.ts       # 仪表盘实时风险视图
│   │   ├── realtime/route.ts      # 严格 JSON 实时风险快照
│   │   ├── score/route.ts         # 最新得分与交易信号
│   │   └── update/route.ts        # 受保护的日更接口
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   ├── Dashboard.tsx              # SWR + Recharts 主仪表盘
│   └── FactorHistory.tsx          # 可选因子的历史折线/柱状图与模型说明
├── lib/
│   ├── cache.ts                   # Redis / 进程内缓存
│   ├── calculation.ts             # 五因子模型、策略、预测
│   ├── fetchers.ts                # FRED / CBOE / GPR 抓取适配器
│   ├── risk-service.ts            # 业务编排层
│   ├── store.ts                   # PostgreSQL / 本地演示数据回退
│   └── types.ts
├── prisma/schema.prisma            # DailyRiskData 表定义
├── scripts/cron.ts                 # 5 分钟市场检查、锚序列刷新与文件日志
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## 快速启动

1. 安装 Node.js 20+，复制环境变量模板：

   ```bash
   cp .env.example .env.local
   npm install
   ```

2. 不配置数据库时，应用使用进程内缓存保存已抓取的真实公开数据。启动应用：

   ```bash
   npm run dev
   ```

   浏览器打开 `http://localhost:3000`。

3. 生产数据模式需要填写 `FRED_API_KEY`、可选 Redis 地址和 PostgreSQL 地址。创建数据库表：

   ```bash
   npx prisma generate
   npx prisma db push
   ```

   之后执行一次日更：

   ```bash
   curl -X POST http://localhost:3000/api/risk/update -H "x-cron-secret: $CRON_SECRET"
   ```

## 数据、模型与接口

五因子权重为 GPR `0.30`、相关性机制 `0.25`、VIX `0.20`、流动性压力 `0.15`、期权情绪 `0.10`。GPR 使用 2010-2019 固定基线，相关性使用五年滚动基线，VIX、流动性与情绪使用过去 252 个观测日的 Z-score；得分阈值为低风险 `<0.3`、中风险 `0.3-0.6`、高风险 `0.6-0.8`、极高风险 `>0.8`。公式和实现说明见 `lib/calculation.ts` 内联注释。

仪表盘的“因子历史与模型说明”工作区支持点击多选 GPR、VIX、相关性、流动性与期权情绪，切换 `30/90/365` 日、折线/柱状图和原始值/Z-score 视图。每个选中指标都显示数据来源、原始计算、标准化方式以及其在综合得分中的权重。

| Endpoint | Description |
| --- | --- |
| `GET /api/risk/score` | 最新得分、五因子、风险等级和策略信号 |
| `GET /api/risk/history?days=365` | 历史记录与七日基准预测 |
| `GET /api/risk/nowcast` | 仪表盘实时风险视图：当日市场快变量、低频 GPR 锚、新闻脉冲及下一交易日风险情景 |
| `GET /api/risk/realtime` | 严格 JSON 实时风险快照，字段为 `calc_date`、`gpr_release_date`、`market_factors`、`news_pulse_z`、`market_score`、`risk_score`、`risk_level`、`action`、`news_trigger`、`comment` |
| `POST /api/risk/update` | 触发抓取、计算、写库和缓存失效；设置 `CRON_SECRET` 后需请求头 `x-cron-secret` |

抓取器使用官方 AI-GPR 日度 CSV（`GPR_AI`、`THREATS_GPR_AI`、`ACTS_GPR_AI`）、FRED `VIXCLS`/`DGS10`/`BAA10Y`、CBOE `SKEW_History.csv`，以及 SPY 日收盘（Yahoo，地区受限时依序回退至 Alpha Vantage 和 FRED `SP500`）。AI-GPR 按 `0.50 Threat + 0.35 Acts + 0.15 Total` 合成。可选的 `GPR_DAILY_XLS_URL` 可接入从 Iacoviello 官网下载的传统 GPR Excel，用于传统 GPR 交叉核验；系统不再生成模拟曲线。

AI-GPR 是低频锚序列，而非当日观测：系统用 2010 年以来 AI-GPR 计算锚值 Z-score，仅在每周一和每月首日刷新；`gpr_release_date` 与 `calc_date` 分开输出。高频新闻同时统计文章计数与标题/摘要负面情感比例，关键词包括 `war`、`missile`、`invasion`、`sanction`、`tariff`、`blockade`、`airstrike` 与 `nuclear talks`。GDELT 提供主计数和文章标题情感；配置 `NEWS_API_KEY` 后 NewsAPI 是独立生产回退，Google News RSS 仅为无密钥备选。实时 `GPR_anchor_Z` 被限制在 `[-3, 3]`。

实时风险得分为 `0.20 GPR_anchor_Z + 0.30 NewsPulse_Z + 0.20 rho_eq_bond_Z + 0.15 VIX_Z + 0.10 BAA10Y_Z + 0.05 SKEW_Z`。`NewsPulse_Z = clip(0.60 Count_Z + 0.40 NegativeSentiment_Z + ComboBoost, 0, 3)`；若同时检测到制裁/封锁、关税/贸易战和军事行动，`ComboBoost = +0.50`。记忆状态为 `max(当前脉冲, 0.75 x 上一期脉冲)`，因此冲突未决时风险不会立即归零。新闻脉冲超过 `1.20` 提高对冲，超过 `2.00` 进入强对冲审查。两路实时新闻均不可用时，系统保留衰减后的上一期状态并以 `ESTIMATED` 明示；若此时 AI-GPR 也滞后超过 5 天，则触发 `0.60` 的保护性风控下限，明确表示数据盲区而非确认发生冲突。系统只报告当前风险温度，不预测价格方向。

## 定时与部署

独立定时进程执行 `npm run cron`，每 5 分钟检查 FRED/CBOE 市场数据、通过内部 TTL 每 15 分钟刷新新闻源、每周一和每月首日刷新 AI-GPR 锚，并在每天 `20:00 UTC` 完成日终更新。所有任务同时输出控制台与 `logs/risk-cron.log`。本地完整环境可使用：

```bash
docker compose up --build
```

Vercel 部署 Web/API 时设置相同的环境变量，并用 Vercel Cron 或 Railway scheduler 每日请求 `/api/risk/update`。Railway/Heroku 可承载 PostgreSQL、Redis 和独立 scheduler；不要把长期 node-cron 进程放在 Vercel Serverless Function 中。

## 风险提示

本项目用于研究和监测，不构成投资建议。市场、宏观和新闻数据可能延迟、修订或缺失；信号应进入既有的风险预算、流动性与合规流程后再执行。
