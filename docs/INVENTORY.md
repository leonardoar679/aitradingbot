# Inventory: what the app has, and where each part goes

This is phase 1 of the V3 reorganization. It maps every page, setting, scheduler and IPC channel
before anything is re-homed, so that nothing is lost on the way. Nothing here is deleted. Since 13
October 2026 (the V6 document, §64-65) the sidebar has five groups and two personalities: the normal
one folds RESEARCH and ALL FEATURES away, one click from opening (remembered on the computer), and
the expert one (Settings › Essentials › Layout, `uiMode`) opens every group. The app opens on Home.

| Group | Entries (the page each opens) |
|---|---|
| AI TRADER | Home, Predictions, Opportunities, Positions, Performance |
| TRADING | Paper (Paper Trading), Live (Live Trading) |
| RESEARCH | Backtest (Backtest & Research), Forecast Lab, AI Benchmark |
| ALL FEATURES | Strategies; Bots and Executors (Strategies' two views); Controllers (Risk & Safety, at its card); Routines (Backtest & Research › Automation); Market (the page titled Market, once Markets); Portfolio (Performance, at the portfolio cards); Explorer (the page titled Explorer, once Discovery); Overview; AI Decisions |
| SYSTEM | Risk (Risk & Safety), Connections, Settings |

Home is new (V6 Stage 1): the market in a line, the top opportunity and what you hold, the cards
Overview has; since V6 Stage 10 it leads with the forecast's best current prediction and its top
three, and Predictions (new, after Home) ranks every pair's forecast. Overview keeps everything it
had. From 5 to 13 October 2026 the sidebar had four groups (AI TRADER, RESEARCH,
TRADING, SYSTEM; Research before Trading from 8 October). Since 8 October 2026 Overview also has
three blocks of its own, not old cards moved: Breaking events, News impact and Today's performance
(`src/overview/`).

Taken on 5 October 2026, at commit `aef376d`.

## Pages, tabs and cards

| Today | Tab or card | What it does | New home |
|---|---|---|---|
| **Portfolio** (landing page) | First-run card | Offers the starter presets when nothing is set up | Overview |
| | Total Value | Value of everything held, change since the session started | Overview (value) and Performance |
| | Active Bots, Bot PNL, System | How many bots run, their combined P&L, assets and executors | Performance |
| | Portfolio evolution chart | Value or composition over 1D/1W/1M/3M | Performance (Portfolio) |
| | Top holdings | The largest holdings | Performance |
| **Account** | Get started, Add funds, Balances, Movements | The paper account: set up, fund, balances, ledger | Paper Trading |
| | Live balances (one card per connected exchange) | Real balances read over the user's key | Live Trading |
| | Futures positions | Real Binance futures positions, closable, exchange-held stops | Live Trading |
| | The path to live (added 8 October 2026, not an old card) | Where a person stands on the document's safe workflow to live: the key and its test, paper trading, the two test runs, a trade from a call, the session armed; read-only | Live Trading |
| **Trade** | Order Ticket, Session Orders | A manual paper order and this session's orders | Paper Trading |
| **Bots** | Active, Runs, Archived | Strategy bots on paper, their finished runs, archived ones | Strategies › Active Runs (Bots) |
| **Executors** | Local Executor, Bots on this executor | Where bots and executors run | Strategies › Execution (Executors) |
| | Executor cards, detail view | Every executor, paper or live, with its state | Strategies › Execution (Executors) |
| | New Executor (8 types), Starter Presets | Make an executor by hand or from a preset, or from a call's filled-in form | Strategies › Execution |
| **Controllers** | New Controller, list, Snapshots | Groups executors under shared stop-loss, take-profit and drawdown limits | Risk & Safety (Controllers) |
| **Positions** | Open Positions | Paper bots' open positions | Positions (unchanged) |
| | Live Positions (with ledger check), Live Trade History | Real positions, closable; realized P&L | Positions (unchanged) |
| | Inventory | Positions handed over from stopped paper executors | Positions (unchanged) |
| | The App's Own Paper Trades | The watch's and the news rules' open paper trades, where each stands on the last closed minute, and its THESIS STATUS (a reading, never a control); a watched real position's barriers and status | Positions (new, 8 October 2026) |
| **Agents** | API key | The OpenRouter key: set, test, remove | Connections; also above the AI pages while none is stored |
| | Analyze | Ask a model about one market | AI Decisions |
| | Events (added 8 October 2026, V5 Stage 5) | Each recent event with every model's answer, read-only | AI Decisions |
| | Opportunities › Watch | Puts events to models with no click; its paper trades | Opportunities |
| | Opportunities › Right now | Recommendations still valid, ranked; since 6 October 2026 a table with the last hour's other events, a signal and an execution score, and a row that opens the plan, the risk, the news and each model's reasoning | Opportunities, and the top one on Home and Overview |
| | Opportunities › Models to ask, Events | Each event with its answers, Ask and Paper trade | Opportunities |
| | Opportunities › What the watch's recommendations earned | The live board over the last 10/50/100 trades and 7/30 days; since 6 October 2026 with "Does AI help?" | Performance |
| | Opportunities › Journal | Every recommendation with its outcome, CSV export | Performance |
| | Signals › Call history | Every call and how it turned out | AI Decisions |
| | Benchmark | Models on the same questions, routes, the event benchmark, experiments; since 6 October 2026 the quant, hybrid and buy-and-hold rows and "Does AI help?" | AI Benchmark |
| | Models | Which models may be asked, the default, routing to a second model | Settings › AI |
| | Model registry (added 8 October 2026, not an old card) | Each model the app may ask: the catalogue's entry, thirty days of the ledger, its health by the daily look at its last thirty closed trades (DEGRADED, told once a day), its leaderboard row by event type and Bitcoin's regime, and the promotion checklist under it; shown, never stored, promoted or switched off | Settings › AI |
| | Strategy health (added 8 October 2026, not an old card) | On each bot's card: its last thirty closed paper trades against what its strategy made a trade where it was measured (profit factor, win rate, hold); a flag and one notice a day, and the bot keeps running | Strategies › Active Runs |
| | Usage | Daily budget, pace, spend by model today and over 30 days | Settings › AI |
| | AI additions (added 6 October 2026, not an old card) | Each addition on or off, its daily limit, what it asked today and what a day of it can cost; since 8 October 2026 five, with the daily summary | Settings › AI |
| | Daily report (added 8 October 2026, not an old card) | One UTC day as the records hold it: the market at its end and its movers, the major news, the app's own paper trades, the models' thirty days and the risk condition; yesterday or any day back thirty; JSON and CSV; beside it the fifth addition's paragraph, asked once a day by itself or on a click | Performance |
| | Does the exit check help? (added 6 October 2026, not an old card) | Each trade the exit check closed set against its plan, in R and in money, and its answers | Performance |
| | Session report (added 6 October 2026, not an old card) | What the app did over the last hour, twelve hours or a session, and the V3 document's gates; saved as JSON or CSV | Performance |
| | What an answer costs a trade (added 8 October 2026, not an old card) | By model, what the ledger says was spent to make each of the watch's paper trades: a trade, a winning trade, a dollar of net result | Performance |
| | Research (added 8 October 2026, not an old card) | The record as tables, no model asked: exit rules, entry timing, holding time by kind, news timing, consensus, the score's inputs by ablation, capture and misses, false opportunities, the excursions on file; CSV each | AI Benchmark › Research |
| **Routines** | New Routine, list, Reports | Backtests re-run on a schedule while the app is open | Backtest & Research › Automation (Routines) |
| **Market** | Chart, indicators, symbol search, ticker | The original dashboard | Markets |
| | Movers › the Score columns and the Emerging tab (added 8 October 2026, V5 Stage 3) | Each mover's standing across the researched universe, the day's and the week's; the scanner's latest reading of every watched pair ranked by its score beside the day | Markets |
| | Candidates (added 8 October 2026, V5 Stage 3) | The 15 liquid pairs standing highest by the larger of their two scores, read every ten minutes; a place to look, not a signal | Explorer › Market scanner |
| **Backtest** | Configuration, Progress, Charts, Compare, Live | A strategy over history, trade charts, strategy comparison, the live strategy monitor | Backtest & Research |
| | Market conditions, AI confirmation, Controller and Executor replay | Readouts and replays beside a backtest | Backtest & Research |
| **Explorer** | Scanner | Scanner on or off and how many pairs it watches, with its status | Settings › Market (the switch); Explorer (the status) |
| | Now, Events | What is moving, scored the same way for every pair; recorded events | Explorer › Market scanner |
| | News & Market Events (added 6 October 2026, not an old card) | Four free news feeds and Binance's announcements, each story's coins, kind, impact and what the price did after; what each kind did, with the median excursions within an hour since 8 October 2026; a second source recorded on the story, and recycled news at half the impact | Explorer › News & Market Events, which it opens on while an alert is unseen |
| **Settings** | Appearance | Theme | Settings › General |
| | API Credentials | Exchange keys: set, test, remove | Connections |
| | Risk Limits | Live order size, daily cap, daily loss limit, allocation; and, added 8 October 2026, the share of the allocation a real order filled in from a call is sized to risk | Risk & Safety |
| **Live trading bar** (every page) | Arm, kill switch, watchers, blocked exits | The gates real orders pass | Stays on every page, with status chips added; the detail on Live Trading |
| **The price forecast** (added 13 October 2026, V6 Stage 10, not an old page) | Best current prediction, Top predictions | The ranking's first pair: its likely ranges at 15 minutes, an hour and four hours from the live price, its bull and bear cases, quality, reliability, the story moving it, volume, momentum, the watch's vote where it asked, and the decision; the top three under it | Home |
| | Ranked forecasts, and a row's drawer | Every pair's forecast best first, with filters; the drawer's timeline to 24 hours, Why?, Why this range?, its recorded forecasts against the price, the decision, and since V6 Stage 12 its trade plan and TRADE THIS | Predictions |
| | Start AI trading (added 13 October 2026, V6 Stage 12) | The forecast trader on paper, off until switched on: what the risk mode holds it to, its open and closed paper trades, what its last pass did | Predictions |
| | The Forecast Lab (added 13 October 2026, V6 Stage 11) | How the forecast did on the walk forward's weeks and on the live record: performance by horizon, variant and class, calibration, kinds of error and drift, by event, V1 to V4 on the same moments, the leaderboard with promotion and DEGRADED, a tested hour replayed, the forecast trader and its comparison with the strategies, buy and hold and the hybrid; the nightly refit's switch; since V6 Stage 12 the opportunity classes, each APPROVED, PROBATION, DISABLED or NOT ENOUGH DATA; CSV each | Forecast Lab |

Duplicates, all intentional and kept:
- **The live board** appears on Opportunities and again in the event benchmark, beside the same
  models' backtested results.
- **The scanner's on/off state** is read by Explorer and by Opportunities, which warns when it is
  off.
- **The list of credentials** is read by Settings, Account, the live trading bar and the New
  Executor form.

## Settings, by where they are stored

All files are in the user's profile folder. Since 8 October 2026 (V5 Stage 1) each of the five
settings files carries `configVersion` (`shared/configMigration.ts`), stamped on its first read and
on every write by `electron/services/configFiles.ts`; every default is composed in
`shared/appDefaults.ts DEFAULT_CONFIG`; the hard limits above every setting are
`shared/hardLimits.ts`; and what the start read (each file's version, every value healed) is shown
under Settings › Advanced › Effective configuration.

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
| | `paperRisk` (added 5 October 2026): how the paper trades the app opens by itself are sized, by what their stop would lose, by a share of the paper account's equity (added 8 October 2026), or at their stake, and what they may stake together; and, added 13 October 2026 (V6 Stage 12), `correlatedShare`, the share they may stake on one side on coins that move with Bitcoin (0.15 as it was fixed) | — | Risk & Safety; the risk mode on Settings › Essentials |
| | `paperDigest` (added 5 October 2026): the daily notice of what those trades did, on or off, and the last day it told | — | Risk & Safety |
| | `paperPause` (added 5 October 2026): the losing run in R that pauses those trades, or never; and for the watch, the news rules and, since V6 Stage 12, the forecast trader, each, whether a run has paused it and when it was last resumed | — | Risk & Safety |
| | `alerts` (added 6 October 2026): desktop notices on or off, and with sound or silent; obeyed where every notice is raised (`appHandlers.ts`); since 13 October 2026 (V6 Stage 13) `desktop`, whether the operating system's notices are shown at all (they are always silent: the window plays the sound) | — | Settings › Essentials; the desktop's under Settings › Advanced › Notifications |
| | `sounds` (added 13 October 2026, V6 Stage 13): the four sounds' volume, the kinds muted, the cooldown between two of one sound, quiet hours (`shared/sounds.ts`) | — | Settings › Advanced › Notifications |
| | `keepRunningWhenClosed` (added 8 October 2026, V5 Stage 2): closing the window hides it to the tray and everything runs on, or quits the app (off by default; `shared/keepRunning.ts`) | — | Settings › Essentials |
| | `uiMode` (added 13 October 2026, V6 Stage 1): the sidebar's layout, Normal (Research and All Features folded until opened) or Expert (every group open) | — | Settings › Essentials › Layout |
| | `language` (added 13 October 2026, V6 Stage 14): the language of the normal-user pages and of every notice, one of ten; absent until chosen, when the first launch asks, offering the computer's (`shared/i18n/languages.ts`) | — | Settings › Language; the first launch's chooser |
| | `forecast.refitNightly` (added 13 October 2026, V6 Stage 5): the price forecast refitted every night at 00:30 UTC on the newest ninety days, and at a start when the last fit is over 26 hours old (on unless `false`; `shared/forecast/training.ts`) | — | Forecast Lab (V6 Stage 11); until then `settings.json` and the effective-config card |
| | `forecast.trader` (added 13 October 2026, V6 Stage 12): START AI TRADING, the forecast trader opening paper Positions on TRADE decisions by itself (off until switched on), its stake, and how many it keeps open and on one side, which the risk mode sets (`shared/forecast/trader.ts`) | — | Predictions (Start AI trading); the caps by the risk mode on Settings › Essentials |
| `aiConfig.json` | `defaultModel`, `enabledModels`, `route` | Agents › Models | Settings › AI |
| | `dailyCapUsd`, `callsPerMinute` | Agents › Usage | Settings › AI |
| | `watch` (on, models, events a day, lowest band, first model gates; and, added 8 October 2026, CONFIRM: a paper BUY it opens is told as ready to confirm as a real order a person places; added with V5 Stage 4, `askAt`: at the raise, or once the event is confirmed a pass later; and since V5 Stage 5 three models offered by default with the first gating, and the paper trade following their vote when two or more are asked) | Agents › Opportunities › Watch | Opportunities (stays with its results) |
| | `watchPaper` (on, model, stake, most open; and, added on 5 October 2026, most open in one direction, the losing run that pauses it, the Bitcoin move that drops a waiting trade) | Agents › Opportunities › Watch | Opportunities |
| `scanner.json` | `enabled` (on by default since 8 October 2026; only `false` switches it off), `universeSize` (20, 40, 60 or 100) | Explorer › Scanner | Settings › Market |
| `marketEvents/` | since 8 October 2026 an event may be a market-wide move (`type: 'market_move'`, on BTCUSDT, with `live.members`), and its members carry `live.marketMove`; detector version `events-v2`; since V5 Stage 4 each event carries a `fingerprint` and a `cause`, and `status-YYYY-MM.jsonl` holds each event's life (DETECTED → CONFIRMED → ACTIVE → WEAKENING → EXPIRED), one line a change, read back at start | — | Opportunities, Explorer |
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
renderer tells them and read back by the session report, a trade's timeline and Overview. Since
8 October 2026 (the V5 document, §93) `aiSignalCache/` is swept at start of files older than 90
days (`recordRetentionService`), and the size of each record directory is on the effective-config
card. Since 13 October 2026 `forecastData/` holds the price forecast's five-minute bars, a file per
pair and UTC month (`forecastDataService`, V6 Stage 2), and a month file whose month ended before the
ninety days the forecast keeps is deleted at start; and `forecastModels/` holds the forecast's fitted
models, a folder a run (`<horizon>.json`, the walk forward's `oos-<horizon>.bin` and, since V6
Stage 6, the calibration made from it, `calibration.json`), `current.json` (the run in use, the walk
forward whose verdicts and calibration hold, the verdicts) and `training-YYYY-MM.jsonl` (a line for
every fit, walk forward and calibration), written by `forecastTrainingService` (V6 Stage 5), which keeps
the run in use and the one before it and deletes older runs after a walk forward; and `forecasts/`
holds the live forecast's record (V6 Stage 7): every pair's forecast at each quarter-hour and each made
again between closes (`predictions-YYYY-MM.jsonl`), each horizon's outcome when due
(`outcomes-YYYY-MM.jsonl`), the adaptive levels (`aci.json`) and, since V6 Stage 8, the outcomes of the
forecasts a story moved (`news-outcomes.jsonl`), its month files deleted at start once their month
ended over 180 days before. Nothing else is ever deleted.

## What runs without a page open

Since 8 October 2026 (V5 Stage 2) the window is not throttled while minimized
(`backgroundThrottling: false`), a tray icon shows the socket, the watch and the app's own open
paper trades, and with "Keep running when the window is closed" on (Settings › Essentials;
`keepRunningWhenClosed`, off by default) closing the window hides it and everything below runs on
until Quit from the tray.

Five renderer schedulers are mounted in `App.tsx` above every page, each behind its own error
boundary. They are unchanged by the reorganization:
- **`RoutineScheduler`** re-runs routines on their schedules.
- **`ControllerScheduler`** takes P&L snapshots every 5 minutes and stops a controller's executors
  on a breach.
- **`LiveOrderScheduler`** polls resting real orders every 5 seconds, and writes resolved orders and
  watcher exits back into settings. Since 8 October 2026 the account's own stream in the main
  process (`liveUserStreamService`) hears a fill first and books it through the same function; the
  poll is the check, and hands the renderer what the stream and the reconciliation resolved.
- **`PortfolioScheduler`** values the portfolio for the chart.
- **`OpportunityScheduler`** is the watch: it puts events to models and opens and settles its paper
  trades when those are switched on. Since 8 October 2026 (the V5 document, §94) it first reads
  today's ledger and writes a refusal at stage `restart` for an answer the app was not running to
  act on (`shared/restartMisses.ts`), so the record is whole and the event is shown as MISSED.

And since 13 October 2026 (V6 Stage 12):
- **`ForecastTraderScheduler`** is the forecast trader (`src/forecast/forecastTrader.ts`): after each
  of the forecast's passes, while switched on, it opens a paper Position on each TRADE decision in an
  approved or probation opportunity class, and every minute it settles those that have closed.
  Switched off, a pass reads one setting and opens nothing.

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
  and CRITICAL a banner until dismissed. Since 8 October 2026 the notice says what is known of the
  story -- the pair's price and move, the source's class, what the price did, the analyst's reading,
  the watch's call -- read from the stream and the ledger. It writes nothing, and opens, closes,
  sells and asks nothing. Beside it, `AlertBanner` (which, since 8 October 2026, asks the main
  process for a sound once a minute while a CRITICAL alert is up) and `WhyItMovedHost` (the "Why did
  it move?" window) are mounted above every page.
- **`StrategyHealthScheduler`** (8 October 2026) reads each running bot's health once an hour, for
  the bots that ask no model, and tells a DEGRADED one once a day on its thread; the bots that ask a
  model are read by their card, as before. It stops nothing.
- **`AttributionCard`** on Performance (8 October 2026; `shared/performance/attribution.ts`): where
  the result came from, over the app's own closed paper trades -- concentration, the signal at the
  call, pair, cap tier, regime, model, kind, news, vote, and the pair's move over each window
  against the exit -- read from the records on a click, with a CSV. The market's regime is written
  on each paper trade's mark when it opens, as a record.
- **`ExperimentScheduler`** (8 October 2026; `shared/experimentRun.ts`) builds the report of one of
  the app's own runs once it has ended -- the session report over its span, the document's five
  further gates, "Does AI help?" over its events, the costs and the verdict -- from the records, and
  files it on the run through the main process, which keeps the runs and their clock
  (`experimentRunService.ts`, `aiExperiments/runs.jsonl`). Started and shown on AI Benchmark ›
  Experiments. It asks nothing and opens nothing.

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
- `forecastDataService` (added 13 October 2026, V6 Stage 2) keeps ninety days of five-minute bars
  for the research's pairs and Bitcoin and ether in `forecastData/`, read from the public data host
  a few minutes after the research first names its pairs and a page a pair after every five-minute
  close. Public data only.
- `forecastTrainingService` (added 13 October 2026, V6 Stage 5) fits the forecast's models in a
  worker thread of their own (`electron/forecast/trainWorker.ts`, through `forecastWorkerService`):
  a first fit once the bars are there for twenty pairs, the walk forward after it, and a refit every
  night at 00:30 UTC unless `forecast.refitNightly` is off; it writes `forecastModels/`. Since V6
  Stage 6 each walk forward also writes its calibration, and a run without one is calibrated again
  from its record at start. Public data only; no key, no model call, no order.
- `forecastService` (added 13 October 2026, V6 Stage 7) forecasts every pair at every five-minute
  close with those models and their calibration, and again between closes for a story of impact 70
  naming it, an event the scanner raised on it, a live price out of its range or a volume shock, at
  most once a minute; it writes `forecasts/`, each horizon's outcome when due, and moves the adaptive
  levels by them. Since V6 Stage 8 the stories the news feed holds and the news analyst's readings on
  file (handed in by `electron/main.ts` from the AI ledger) move a coin's forecast by fixed rules; it
  asks nothing. Since V6 Stage 9 it decides, after every pass, whether each pair's forecast is worth
  trading and ranks them all; it places nothing. Public data only; no key, no model call, no order.
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
- `liveUserStreamService` (added 8 October 2026; the V5 document, §101) keeps one authenticated
  socket to Binance's user-data stream while a key is stored and the session is armed or an order or
  position of the app's own is open: a listen key (`exchanges/binanceUserStream.ts`), kept alive
  every thirty minutes and renewed before the day is up, each order report booked at once through
  `resolveOrderFromExchange`, each balances frame into the balance cache. It places nothing.
- `liveReconcileService` (added 8 October 2026; §102) looks once a minute while a key is stored at
  the orders resting on the exchange and the account's balances against the ledgers; a resting
  order the ledger does not know and a holding the account does not back are told as RECONCILIATION
  notices (HIGH, a thread per order or asset, four hours), a ledger order the exchange no longer
  rests is resolved as the poll resolves it, and the ledger is never rewritten. Live Trading and
  Positions show its last look.
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
| `forecast` | 11 (added 13 October 2026, V6 Stages 7-15): state, every pair's forecast, a pair's, its history, the ranking, a pair's decision, the Lab, a tested hour's replay, bars, the record over a span (V6 Stage 15), updates | Home, Predictions and the drawer, TRADE THIS, the forecast trader, the Forecast Lab, the top prediction's chime, and an experiment's report |

**Nothing in `src/` calls `app:ping` or `app:getVersion`.** Both are left from the project template.
They are flagged here and not removed, since they cost nothing and something outside `src/` may
use them.

## What the document asks for that does not exist

The Configuration Center is built from the settings above. Since 6 October 2026 (the second V3
document) Settings opens on **Essentials**, the six settings that decide what the app does by
itself: trading mode (read from the live gates: PAPER, LIVE READY or LIVE ACTIVE), risk level
(Conservative, Balanced or Aggressive since V6 Stage 12, or Custom, from `shared/appDefaults.ts`), the scanner's market, the AI's mode (changed
only on Opportunities), notifications, and the exchange. The rest is under **Advanced**. These
settings from the document have no behaviour behind them, so they are not added as controls:
- **General:** currency, timezone, startup page (the language has been chosen under Settings ›
  Language since 13 October 2026, V6 Stage 14). Desktop notices have had a switch, with
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
    own trades;
  - risk falling with the conditions. Since 8 October 2026 (the V5 document, §46-47) the watch's
    paper trades are sized at six tenths of the risk on high volatility, a spread of 0.05% or more, a
    thin best level, a vote with dissent or correlated exposure already out, and refused at extreme
    volatility (`shared/dynamicRisk.ts`); the amount a real order from a call is suggested to stake
    follows the volatility. Pinned lines, not settings.
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
