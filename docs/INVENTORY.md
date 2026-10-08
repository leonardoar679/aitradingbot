# Inventory: what the app has, and where each part goes

This is phase 1 of the V3 reorganization. It maps every page, setting, scheduler and IPC channel
before anything is re-homed, so that nothing is lost on the way. Nothing here is deleted. The new
navigation has 15 pages in four groups:

| Group | Pages |
|---|---|
| AI TRADER | Overview, Opportunities, Markets, AI Decisions, Positions, Performance |
| RESEARCH | Backtest & Research, AI Benchmark, Discovery |
| TRADING | Paper Trading, Live Trading, Strategies |
| SYSTEM | Risk & Safety, Connections, Settings |

(Research before Trading since 8 October 2026, as the document's §50 has it; the groups were the
other way round from 5 October.) Since 8 October 2026 Overview also has three blocks of its own, not
old cards moved: Breaking events, News impact and Today's performance (`src/overview/`).

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
| | The path to live (added 8 October 2026, not an old card) | Where a person stands on the document's safe workflow to live: the key and its test, paper trading, the two test runs, a trade from a call, the session armed; read-only | Live Trading |
| **Trade** | Order Ticket, Session Orders | A manual paper order and this session's orders | Paper Trading |
| **Bots** | Active, Runs, Archived | Strategy bots on paper, their finished runs, archived ones | Strategies › Active Runs |
| **Executors** | Local Executor, Bots on this executor | Where bots and executors run | Strategies › Execution |
| | Executor cards, detail view | Every executor, paper or live, with its state | Strategies › Execution |
| | New Executor (8 types), Starter Presets | Make an executor by hand or from a preset, or from a call's filled-in form | Strategies › Execution |
| **Controllers** | New Controller, list, Snapshots | Groups executors under shared stop-loss, take-profit and drawdown limits | Risk & Safety |
| **Positions** | Open Positions | Paper bots' open positions | Positions (unchanged) |
| | Live Positions (with ledger check), Live Trade History | Real positions, closable; realized P&L | Positions (unchanged) |
| | Inventory | Positions handed over from stopped paper executors | Positions (unchanged) |
| | The App's Own Paper Trades | The watch's and the news rules' open paper trades, where each stands on the last closed minute, and its THESIS STATUS (a reading, never a control); a watched real position's barriers and status | Positions (new, 8 October 2026) |
| **Agents** | API key | The OpenRouter key: set, test, remove | Connections; also above the AI pages while none is stored |
| | Analyze | Ask a model about one market | AI Decisions |
| | Opportunities › Watch | Puts events to models with no click; its paper trades | Opportunities |
| | Opportunities › Right now | Recommendations still valid, ranked; since 6 October 2026 a table with the last hour's other events, a signal and an execution score, and a row that opens the plan, the risk, the news and each model's reasoning | Opportunities, and the top one on Overview |
| | Opportunities › Models to ask, Events | Each event with its answers, Ask and Paper trade | Opportunities |
| | Opportunities › What the watch's recommendations earned | The live board over the last 10/50/100 trades and 7/30 days; since 6 October 2026 with "Does AI help?" | Performance |
| | Opportunities › Journal | Every recommendation with its outcome, CSV export | Performance |
| | Signals › Call history | Every call and how it turned out | AI Decisions |
| | Benchmark | Models on the same questions, routes, the event benchmark, experiments; since 6 October 2026 the quant, hybrid and buy-and-hold rows and "Does AI help?" | AI Benchmark |
| | Models | Which models may be asked, the default, routing to a second model | Settings › AI |
| | Model registry (added 8 October 2026, not an old card) | Each model the app may ask: the catalogue's entry, thirty days of the ledger, and its leaderboard row by event type and regime; shown, never stored or promoted | Settings › AI |
| | Usage | Daily budget, pace, spend by model today and over 30 days | Settings › AI |
| | AI additions (added 6 October 2026, not an old card) | Each addition on or off, its daily limit, what it asked today and what a day of it can cost | Settings › AI |
| | Does the exit check help? (added 6 October 2026, not an old card) | Each trade the exit check closed set against its plan, in R and in money, and its answers | Performance |
| | Session report (added 6 October 2026, not an old card) | What the app did over the last hour, twelve hours or a session, and the V3 document's gates; saved as JSON or CSV | Performance |
| **Routines** | New Routine, list, Reports | Backtests re-run on a schedule while the app is open | Backtest & Research › Automation |
| **Market** | Chart, indicators, symbol search, ticker | The original dashboard | Markets |
| **Backtest** | Configuration, Progress, Charts, Compare, Live | A strategy over history, trade charts, strategy comparison, the live strategy monitor | Backtest & Research |
| | Market conditions, AI confirmation, Controller and Executor replay | Readouts and replays beside a backtest | Backtest & Research |
| **Explorer** | Scanner | Scanner on or off and how many pairs it watches, with its status | Settings › Market (the switch); Discovery (the status) |
| | Now, Events | What is moving, scored the same way for every pair; recorded events | Discovery › Market scanner |
| | News & Market Events (added 6 October 2026, not an old card) | Four free news feeds and Binance's announcements, each story's coins, kind, impact and what the price did after; what each kind did | Discovery › News & Market Events, which it opens on while an alert is unseen |
| **Settings** | Appearance | Theme | Settings › General |
| | API Credentials | Exchange keys: set, test, remove | Connections |
| | Risk Limits | Live order size, daily cap, daily loss limit, allocation; and, added 8 October 2026, the share of the allocation a real order filled in from a call is sized to risk | Risk & Safety |
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
| | `executors[].params.entryFill` (added 8 October 2026): the live book's fill a watch paper trade entered at, the second it was made; the score stays on minute bars | — | Strategies › Execution (the card), the trade's timeline |
| | `bots`, `botRuns` | Bots | Strategies › Active Runs |
| | `executors` (the watch's paper trades are written by `src/agents/watchPaperTrade.ts`) | Executors | Strategies › Execution |
| | `routines` | Routines | Backtest & Research › Automation |
| | `heldPositions` | Positions | Positions |
| | `controllers` | Controllers | Risk & Safety |
| | `paperAccount` | Account | Paper Trading |
| | `paperRisk` (added 5 October 2026): how the paper trades the app opens by itself are sized, by what their stop would lose, by a share of the paper account's equity (added 8 October 2026), or at their stake, and what they may stake together | — | Risk & Safety |
| | `paperDigest` (added 5 October 2026): the daily notice of what those trades did, on or off, and the last day it told | — | Risk & Safety |
| | `paperPause` (added 5 October 2026): the losing run in R that pauses those trades, or never; and for the watch and for the news rules, each, whether a run has paused it and when it was last resumed | — | Risk & Safety |
| | `alerts` (added 6 October 2026): desktop notices on or off, and with sound or silent; obeyed where every notice is raised (`appHandlers.ts`) | — | Settings › Essentials |
| `aiConfig.json` | `defaultModel`, `enabledModels`, `route` | Agents › Models | Settings › AI |
| | `dailyCapUsd`, `callsPerMinute` | Agents › Usage | Settings › AI |
| | `watch` (on, models, events a day, lowest band, first model gates; and, added 8 October 2026, CONFIRM: a paper BUY it opens is told as ready to confirm as a real order a person places) | Agents › Opportunities › Watch | Opportunities (stays with its results) |
| | `watchPaper` (on, model, stake, most open; and, added on 5 October 2026, most open in one direction, the losing run that pauses it, the Bitcoin move that drops a waiting trade) | Agents › Opportunities › Watch | Opportunities |
| `scanner.json` | `enabled`, `universeSize` (20, 40, 60 or 100) | Explorer › Scanner | Settings › Market |
| `marketEvents/` | since 8 October 2026 an event may be a market-wide move (`type: 'market_move'`, on BTCUSDT, with `live.members`), and its members carry `live.marketMove`; detector version `events-v2` | — | Opportunities, Discovery |
| `news.json` | `enabled`; for `delisting` and for `monitoringTag`, each: `notifyHeld`, `paperShort` (on, stake), `askModels` (added with the news reader, V3 Stage 7) | — | Settings › Market |
| `credentials.json` (encrypted) | Binance and Upbit keys; when added, last tested, result | Settings | Connections |
| `aiCredentials.json` (encrypted) | The OpenRouter key | Agents | Connections |
| `liveTrading.json` | Session armed, kill switch | Live trading bar | The bar (stays); detail on Live Trading |
| | Max order size, daily cap, daily loss limit, allocation; and, added 8 October 2026, the share of the allocation a real order filled in from a call is sized to risk | Settings | Risk & Safety |

These files are records, not settings, and stay where they are: `livePositions.json`,
`liveOrders.json`, `livePositionWatchers.json`, `liveTwapRuns.json`, `aiLedger/`, `aiSignalCache/`,
`aiExperiments/`, `marketEvents/`, `news/` and `aiModels.json`; and, since 8 October 2026,
`paperRefusals/` (the app's own paper trades refused, and why) and `alerts/` (the alerts told), one
JSON line each in a file per UTC month (`shared/records.ts`), written by the main process as the
renderer tells them and read back by the session report, a trade's timeline and Overview.

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

And a seventh and an eighth on 5 October 2026:
- **`PaperDigestScheduler`** tells once a day, in a desktop notice, what the watch's and the news
  rules' paper trades did the UTC day before. It reads settings and marks the day told; it opens
  and closes nothing.
- **`PaperPauseScheduler`** reads those trades once a minute, and when the watch's run, or the news
  rules', has lost what pauses it, writes the pause down and says so once. It writes the pause and
  nothing else; it opens and closes nothing.

And a ninth on 6 October 2026:
- **`NewsAlertScheduler`** gives each story the news feed reads in the session, published within
  the last half hour, a severity (INFO, WATCH, HIGH, CRITICAL), and looks at Bitcoin's last hour on
  the live stream once a minute. WATCH and above raise a desktop notice and a count on Discovery,
  and CRITICAL a banner until dismissed. It writes nothing, and opens, closes, sells and asks
  nothing. Beside it, `AlertBanner` and `WhyItMovedHost` (the "Why did it move?" window) are
  mounted above every page.

The main process also runs loops that need no window at all:
- `marketScannerService` reads the market once a minute while it is on.
- `marketResearchService` (added 6 October 2026) studies the market as the app opens and every ten
  minutes after, always: the liquid pairs, a day's and a week's moves, CoinGecko's trending list
  every fifteen minutes, and the market's status. Public data only.
- `liveMarketService` (added 6 October 2026) holds one public socket to the market-data host: the
  live book and minute of the pairs shown and of the app's own paper trades, Bitcoin's and ether's
  minutes always, and a log of drops, quiet gaps and host moves. Since 7 October 2026 a socket that
  cannot connect three times in a row moves to the data host that answers (never binance.us), and a
  closed one follows a REST move at once. Since 8 October 2026 the connection is renewed before
  Binance's 24-hour cut (a second socket opened before the first is closed; counted apart from
  drops), the minutes missed in a drop or a gap are read again over REST, refused requests are
  counted, the chart's own sockets follow the data host by the same rule, and the bar shows the
  socket's state (`src/status/liveMarketChip.ts`). Public data only.
- `newsService` reads Binance's two announcement lists once a minute while it is on (added in V3
  Stage 7).
- `aiAdditionsService` (added 6 October 2026) puts each story of high impact the news feed reads to
  the news analyst, once, and asks why the coin it names moved, while the watch is on, each within
  its daily limit and the AI budget.
- `newsFeedService` (added 6 October 2026) reads four free news feeds every three minutes, always:
  CoinDesk, The Block, Cointelegraph and Decrypt. It keeps each story once, and reads the 1-minute
  candles of the coins they name to say what the price did after. Public data only.
- `exchangeHealthService` (added 8 October 2026) measures the data host once a minute, one public
  request for the time, and keeps the live-price socket's state and the key's last test beside it;
  the live order gate refuses a NEW real position while the exchange is degraded (stale data with
  REST failing, a clock over five seconds off, REST slow three reads running, a key whose last test
  failed), and never a closing order. The bar and Live Trading show it (`shared/exchangeHealth.ts`).
- `livePositionWatchersService` evaluates live exits every 5 seconds.
- `liveTwapService` places TWAP slices.

## IPC channels

79 channels when this was written, each found by searching `src/` for the `window.api` call that
reaches it. A call may span lines. The `news` channels were added after: four in V3 Stage 7, and the record of the news rules on 5 October 2026. The `research`, `feed` and four live `market` channels were added on 6 October 2026, and `app:notify` then took a severity.

| Namespace | Channels | Called from |
|---|---|---|
| `app` | `ping`, `getVersion`, `notify`, `effectiveConfig` | `notify`: the watch, its paper trader, the bots' call notifier, the digest and the pause, the exit check, the news short and `NewsAlertScheduler`; since 8 October 2026 each carries a kind and a thread (`shared/notices.ts`), and one service tells them all and the main process's own (`electron/services/noticeService.ts`) |
| `settings` | `get`, `set` | Almost every page and scheduler; writes go through `utils/settingsWrites.ts` and `utils/serialQueue.ts` |
| `market` | 12: symbols, symbol rules, candles and ticker subscriptions, 24-hour ticker, historical ranges; and since 6 October 2026, 4 more for live prices: interest, state, a pair's book, updates | Charts, Market, Backtest, executors, the watch, benchmarks, Explorer; live prices: Right Now, Overview's top card, and the watch's paper writer |
| `backtest` | `exportSave` | Backtest results, strategy comparison, Journal |
| `scanner` | 8: state, config, events, history scan, universe, updates | Explorer, Opportunities, the watch, the event benchmark, the live board, Journal |
| `research` | 3 (added 6 October 2026): state, read again, updates | Overview's market status and Markets' movers, through `useMarketResearch`. Nothing else reads it (`tests/aiNoLivePath.test.ts`) |
| `news` | 5: state, config, list, updates, the rules' record (with the two near misses, from Binance's lists and Upbit's) | Discovery's announcements card and its record of the news rules, Settings › Market, and `NewsScheduler` (what a delisting or a tag does). Nothing else reads it (`tests/aiNoLivePath.test.ts`) |
| `feed` | 4 (added 6 October 2026): state, updates, open a story's link (https on a feed's own host only), and the stories on file over a span | Discovery's News & Market Events tab, "Why did it move?", and `NewsAlertScheduler`, through `useNewsFeed`; the history by the event benchmark and the live leaderboard, for "Does AI help?". Nothing else reads it (`tests/aiNoLivePath.test.ts`) |
| `credentials` | 10: list, set, test, remove, balances, futures positions, close, stops | Settings, Account, the live trading bar, New Executor, the ledger check |
| `ai` | 26: key, signal tapes, config, calls, usage, entry confirmation, benchmark, opportunities, experiments; and since 6 October 2026 the AI additions' status, the conclusion to "Why did it move?" (paid, on a click), the reviewer (paid, before a paper trade of the watch's, only when something stands out) and the exit check (paid, on one of the app's own open paper trades, only when something about it has changed) | Agents' tabs, Backtest, Bots, the watch and its paper writer; the exit check's look; the additions' card under Settings › AI, the news analyst's readings and the reviewer's verdicts read from the ledger, the Why window's conclusion, and the exit check's card on Performance |
| `liveTrading` | 19: status, limits, kill switch, arm, positions, orders, watchers, TWAP | The live trading bar, Settings, Executors, Positions, `LiveOrderScheduler`, Portfolio |
| `executors` | `placeLiveOrder`, `placeLiveLimitOrder` | Executors only |

**Nothing in `src/` calls `app:ping` or `app:getVersion`.** Both are left from the project template.
They are flagged here and not removed, since they cost nothing and something outside `src/` may
use them.

## What the document asks for that does not exist

The Configuration Center is built from the settings above. Since 6 October 2026 (the second V3
document) Settings opens on **Essentials**, the six settings that decide what the app does by
itself: trading mode (read from the live gates: PAPER, LIVE READY or LIVE ACTIVE), risk level
(Conservative or Custom, from `shared/appDefaults.ts`), the scanner's market, the AI's mode (changed
only on Opportunities), notifications, and the exchange. The rest is under **Advanced**. These
settings from the document have no behaviour behind them, so they are not added as controls:
- **General:** language, currency, timezone, startup page. Desktop notices have had a switch, with
  sound, since 6 October 2026; the daily paper digest has one of its own, on Risk & Safety.
- **Market:**
  - default exchange: the scanner reads Binance;
  - quote currency: USDT;
  - refresh rate: once a minute, fixed;
  - timeframes;
  - minimum volume, liquidity and maximum spread: the scanner takes the most traded pairs and
    leaves out stablecoins and pegged tokens by a fixed list (`SCAN_EXCLUDED_BASES`), and stock
    tokens by Binance's own listing (`stockToken`).
- **AI:**
  - fast, reasoning and reviewer roles: routing to a second model is what exists;
  - prompt version: pinned by tests, not chosen;
  - structured output: always required;
  - temperature.
- **Trading:**
  - a global trading mode to set: the status bar and Essentials show the real gates instead;
  - default order type;
  - default holding horizon;
  - allowed and excluded pairs.
- **Risk:**
  - maximum position or trade risk as a share of an account. The paper trades the app opens by
    itself are sized by a fixed amount at their stop, and capped in what they stake together, since
    5 October 2026 (Risk & Safety); nothing sizes a person's own trades;
  - maximum correlated exposure for a person's own trades. The app's own paper trades have had, since
    5 October 2026, the watch's limit on how many are open in one direction, and, since 6 October
    2026, a cap on what they stake on one side on coins that move with Bitcoin (15% of the paper
    account, or of the money-out cap; `shared/paperExposure.ts`), shown on Risk & Safety;
  - maximum slippage or spread. The watch's paper trades are refused on a spread over 0.1% (6 October
    2026), and since 8 October 2026 on a best level that cannot hold the stake and on major news
    against the side (`shared/liveMarket.ts`, `shared/paperNewsBlock.ts`); nothing limits a person's
    own trades.
- **News:** Binance's own announcements are read when switched on under Settings › Market, with
  what a delisting does (V3 Stage 7, after the study in `research/NEWS.md`). Since 6 October 2026,
  four free feeds are read too, always (CoinDesk, The Block, Cointelegraph, Decrypt), for Discovery's
  News & Market Events, the alerts and "Why did it move?"; nothing trades on them. Upbit's public
  list of trading notices is read only for the record on Discovery, while that card is shown, and
  nothing acts on it. A choice of sources, social or sentiment feeds, and news services that need a
  key have nothing behind them: CoinGecko's news needs a paid plan and CryptoPanic a key.
- **Execution:** order timeout, retry, partial-fill and cancel policies.
- **Advanced:** event thresholds, polling intervals, cache lifetimes and the number of candidates
  ranked are constants in code. A model's raw text is kept only for a refused answer
  (`answerExcerpt`).
