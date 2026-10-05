# Inventory: what the app has, and where each part goes

This is phase 1 of the V3 reorganization. It maps every page, setting, scheduler and IPC channel
before anything is re-homed, so that nothing is lost on the way. Nothing here is deleted. The new
navigation has 15 pages in four groups:

| Group | Pages |
|---|---|
| AI TRADER | Overview, Opportunities, Markets, AI Decisions, Positions, Performance |
| TRADING | Paper Trading, Live Trading, Strategies |
| RESEARCH | Backtest & Research, AI Benchmark, Discovery |
| SYSTEM | Risk & Safety, Connections, Settings |

Taken on 5 October 2026, at commit `aef376d`.

## Pages, tabs and cards

| Today | Tab or card | What it does | New home |
|---|---|---|---|
| **Portfolio** (landing page) | First-run card | Offers the starter presets when nothing is set up | Overview |
| | Total Value | Value of everything held, change since the session started | Overview (value) and Performance |
| | Active Bots, Bot PNL, System | How many bots run, their combined P&L, assets and executors | Performance |
| | Portfolio evolution chart | Value or composition over 1D/1W/1M/3M | Performance |
| | Top holdings | The largest holdings | Performance |
| **Account** | Get started, Add funds, Balances, Movements | The paper account: set up, fund, balances, ledger | Paper Trading |
| | Live balances (one card per connected exchange) | Real balances read over the user's key | Live Trading |
| | Futures positions | Real Binance futures positions, closable, exchange-held stops | Live Trading |
| **Trade** | Order Ticket, Session Orders | A manual paper order and this session's orders | Paper Trading |
| **Bots** | Active, Runs, Archived | Strategy bots on paper, their finished runs, archived ones | Strategies › Active Runs |
| **Executors** | Local Executor, Bots on this executor | Where bots and executors run | Strategies › Execution |
| | Executor cards, detail view | Every executor, paper or live, with its state | Strategies › Execution |
| | New Executor (8 types), Starter Presets | Make an executor by hand or from a preset, or from a call's filled-in form | Strategies › Execution |
| **Controllers** | New Controller, list, Snapshots | Groups executors under shared stop-loss, take-profit and drawdown limits | Risk & Safety |
| **Positions** | Open Positions | Paper bots' open positions | Positions (unchanged) |
| | Live Positions (with ledger check), Live Trade History | Real positions, closable; realized P&L | Positions (unchanged) |
| | Inventory | Positions handed over from stopped paper executors | Positions (unchanged) |
| **Agents** | API key | The OpenRouter key: set, test, remove | Connections; also above the AI pages while none is stored |
| | Analyze | Ask a model about one market | AI Decisions |
| | Opportunities › Watch | Puts events to models with no click; its paper trades | Opportunities |
| | Opportunities › Right now | Recommendations still valid, ranked | Opportunities, and the top one on Overview |
| | Opportunities › Models to ask, Events | Each event with its answers, Ask and Paper trade | Opportunities |
| | Opportunities › What the watch's recommendations earned | The live board over the last 10/50/100 trades and 7/30 days | Performance |
| | Opportunities › Journal | Every recommendation with its outcome, CSV export | Performance |
| | Signals › Call history | Every call and how it turned out | AI Decisions |
| | Benchmark | Models on the same questions, routes, the event benchmark, experiments | AI Benchmark |
| | Models | Which models may be asked, the default, routing to a second model | Settings › AI |
| | Usage | Daily budget, pace, spend by model today and over 30 days | Settings › AI |
| **Routines** | New Routine, list, Reports | Backtests re-run on a schedule while the app is open | Backtest & Research › Automation |
| **Market** | Chart, indicators, symbol search, ticker | The original dashboard | Markets |
| **Backtest** | Configuration, Progress, Charts, Compare, Live | A strategy over history, trade charts, strategy comparison, the live strategy monitor | Backtest & Research |
| | Market conditions, AI confirmation, Controller and Executor replay | Readouts and replays beside a backtest | Backtest & Research |
| **Explorer** | Scanner | Scanner on or off and how many pairs it watches, with its status | Settings › Market (the switch); Discovery (the status) |
| | Now, Events | What is moving, scored the same way for every pair; recorded events | Discovery |
| **Settings** | Appearance | Theme | Settings › General |
| | API Credentials | Exchange keys: set, test, remove | Connections |
| | Risk Limits | Live order size, daily cap, daily loss limit, allocation | Risk & Safety |
| **Live trading bar** (every page) | Arm, kill switch, watchers, blocked exits | The gates real orders pass | Stays on every page, with status chips added; the detail on Live Trading |

Duplicates, all intentional and kept:
- **The live board** appears on Opportunities and again in the event benchmark, beside the same
  models' backtested results.
- **The scanner's on/off state** is read by Explorer and by Opportunities, which warns when it is
  off.
- **The list of credentials** is read by Settings, Account, the live trading bar and the New
  Executor form.

## Settings, by where they are stored

All files are in the user's profile folder.

| File | Setting | Edited today on | New home |
|---|---|---|---|
| `settings.json` | `theme` | Settings | Settings › General |
| | `bots`, `botRuns` | Bots | Strategies › Active Runs |
| | `executors` (the watch's paper trades are written by `src/agents/watchPaperTrade.ts`) | Executors | Strategies › Execution |
| | `routines` | Routines | Backtest & Research › Automation |
| | `heldPositions` | Positions | Positions |
| | `controllers` | Controllers | Risk & Safety |
| | `paperAccount` | Account | Paper Trading |
| | `paperRisk` (added 5 October 2026): how the paper trades the app opens by itself are sized, by what their stop would lose or at their stake, and what they may stake together | — | Risk & Safety |
| | `paperDigest` (added 5 October 2026): the daily notice of what those trades did, on or off, and the last day it told | — | Risk & Safety |
| `aiConfig.json` | `defaultModel`, `enabledModels`, `route` | Agents › Models | Settings › AI |
| | `dailyCapUsd`, `callsPerMinute` | Agents › Usage | Settings › AI |
| | `watch` (on, models, events a day, lowest band, first model gates) | Agents › Opportunities › Watch | Opportunities (stays with its results) |
| | `watchPaper` (on, model, stake, most open; and, added on 5 October 2026, most open in one direction, the losing run that pauses it, the Bitcoin move that drops a waiting trade) | Agents › Opportunities › Watch | Opportunities |
| `scanner.json` | `enabled`, `universeSize` (20, 40, 60 or 100) | Explorer › Scanner | Settings › Market |
| `news.json` | `enabled`; for `delisting` and for `monitoringTag`, each: `notifyHeld`, `paperShort` (on, stake), `askModels` (added with the news reader, V3 Stage 7) | — | Settings › Market |
| `credentials.json` (encrypted) | Binance and Upbit keys; when added, last tested, result | Settings | Connections |
| `aiCredentials.json` (encrypted) | The OpenRouter key | Agents | Connections |
| `liveTrading.json` | Session armed, kill switch | Live trading bar | The bar (stays); detail on Live Trading |
| | Max order size, daily cap, daily loss limit, allocation | Settings | Risk & Safety |

These files are records, not settings, and stay where they are: `livePositions.json`,
`liveOrders.json`, `livePositionWatchers.json`, `liveTwapRuns.json`, `aiLedger/`, `aiSignalCache/`,
`aiExperiments/`, `marketEvents/`, `news/` and `aiModels.json`.

## What runs without a page open

Five renderer schedulers are mounted in `App.tsx` above every page, each behind its own error
boundary. They are unchanged by the reorganization:
- **`RoutineScheduler`** re-runs routines on their schedules.
- **`ControllerScheduler`** takes P&L snapshots every 5 minutes and stops a controller's executors
  on a breach.
- **`LiveOrderScheduler`** polls resting real orders every 5 seconds, and writes resolved orders and
  watcher exits back into settings.
- **`PortfolioScheduler`** values the portfolio for the chart.
- **`OpportunityScheduler`** is the watch: it puts events to models and opens and settles its paper
  trades when those are switched on.

A sixth was added after, in V3 Stage 7:
- **`NewsScheduler`** acts on a delisting, or a coin added to the Monitoring Tag, that the news
  reader has read. It tells someone who holds the coin, and opens the kind's paper short, each when
  switched on, and it settles those shorts.

And a seventh on 5 October 2026:
- **`PaperDigestScheduler`** tells once a day, in a desktop notice, what the watch's and the news
  rules' paper trades did the UTC day before. It reads settings and marks the day told; it opens
  and closes nothing.

The main process also runs loops that need no window at all:
- `marketScannerService` reads the market once a minute while it is on.
- `newsService` reads Binance's two announcement lists once a minute while it is on (added in V3
  Stage 7).
- `livePositionWatchersService` evaluates live exits every 5 seconds.
- `liveTwapService` places TWAP slices.

## IPC channels

79 channels when this was written, each found by searching `src/` for the `window.api` call that
reaches it. A call may span lines. The `news` channels were added after: four in V3 Stage 7, and the record of the news rules on 5 October 2026.

| Namespace | Channels | Called from |
|---|---|---|
| `app` | `ping`, `getVersion`, `notify` | `notify`: the watch, its paper trader, the bots' call notifier |
| `settings` | `get`, `set` | Almost every page and scheduler; writes go through `utils/settingsWrites.ts` and `utils/serialQueue.ts` |
| `market` | 12: symbols, symbol rules, candles and ticker subscriptions, 24-hour ticker, historical ranges | Charts, Market, Backtest, executors, the watch, benchmarks, Explorer |
| `backtest` | `exportSave` | Backtest results, strategy comparison, Journal |
| `scanner` | 8: state, config, events, history scan, universe, updates | Explorer, Opportunities, the watch, the event benchmark, the live board, Journal |
| `news` | 5: state, config, list, updates, the rules' record (with the two near misses, from Binance's lists and Upbit's) | Discovery's announcements card and its record of the news rules, Settings › Market, and `NewsScheduler` (what a delisting or a tag does). Nothing else reads it (`tests/aiNoLivePath.test.ts`) |
| `credentials` | 10: list, set, test, remove, balances, futures positions, close, stops | Settings, Account, the live trading bar, New Executor, the ledger check |
| `ai` | 22: key, signal tapes, config, calls, usage, entry confirmation, benchmark, opportunities, experiments | Agents' tabs, Backtest, Bots, the watch |
| `liveTrading` | 19: status, limits, kill switch, arm, positions, orders, watchers, TWAP | The live trading bar, Settings, Executors, Positions, `LiveOrderScheduler`, Portfolio |
| `executors` | `placeLiveOrder`, `placeLiveLimitOrder` | Executors only |

**Nothing in `src/` calls `app:ping` or `app:getVersion`.** Both are left from the project template.
They are flagged here and not removed, since they cost nothing and something outside `src/` may
use them.

## What the document asks for that does not exist

The Configuration Center is built from the settings above. These settings from the document have
no behaviour behind them, so they are not added as controls:
- **General:** language, currency, timezone, startup page, a notifications switch. Desktop notices
  from the watch are always on; the daily paper digest has a switch of its own, on Risk & Safety.
- **Market:**
  - default exchange: the scanner reads Binance;
  - quote currency: USDT;
  - refresh rate: once a minute, fixed;
  - timeframes;
  - minimum volume, liquidity and maximum spread: the scanner takes the most traded pairs and
    leaves out stablecoins and pegged tokens by a fixed list (`SCAN_EXCLUDED_BASES`).
- **AI:**
  - fast, reasoning and reviewer roles: routing to a second model is what exists;
  - prompt version: pinned by tests, not chosen;
  - structured output: always required;
  - temperature.
- **Trading:**
  - a global trading mode: the status bar shows the real gates instead;
  - default order type;
  - default holding horizon;
  - allowed and excluded pairs.
- **Risk:**
  - maximum position or trade risk as a share of an account. The paper trades the app opens by
    itself are sized by a fixed amount at their stop, and capped in what they stake together, since
    5 October 2026 (Risk & Safety); nothing sizes a person's own trades;
  - maximum correlated exposure, beyond the watch's own paper trades (which have, since 5 October
    2026, a limit on how many are open in one direction);
  - maximum slippage or spread.
- **News:** one source is read, Binance's own announcements. It is switched on under Settings ›
  Market, with what a delisting does (V3 Stage 7, after the study in `research/NEWS.md`). Upbit's
  public list of trading notices is read only for the record on Discovery, while that card is shown,
  and nothing acts on it. A choice of sources, social or sentiment feeds, and news services that
  need a key have nothing behind them.
- **Execution:** order timeout, retry, partial-fill and cancel policies.
- **Advanced:** event thresholds, polling intervals, cache lifetimes and the number of candidates
  ranked are constants in code. A model's raw text is kept only for a refused answer
  (`answerExcerpt`).
