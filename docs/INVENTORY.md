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
| **News URLs** (added 26 October 2026, V8 Stage 4) | Paste box, the steps, the verdict, the article reading, your own view, the links on file | Reads a pasted news link safely -- its text, its time, who says it, the coins it names and their prices -- and keeps what it found; since V8 Stage 5 a model's reading of it on a click, at the price shown, its size calls recorded and scored | News URLs |
| **Copy Traders** (added 27 October 2026, V8 Stages 6-8; in the normal sidebar, and in ten languages, since Stage 8) | Paste box, Open a file of trades, the steps, the record's figures (and OKX's beside the app's), the skill test, the delay table, the clone, On paper (since Stage 8: Follow on paper, Run the clone on paper, their trades in the copy book, the measured delay, the copy book's last missed opportunities), the traders on file, the Bitget check | Reads a pasted Hyperliquid trader's record (VERIFIED) or an OKX lead trader's (REPORTED, the app's fees and funding ESTIMATED beside OKX's figure) without a key, or a file of trades the person opens (UNVERIFIABLE), and keeps it; rebuilds the round trips; works out what they made after fees and funding; judges the record by V8-S6-SKILL, V8-S6-DELAY and V8-S7-CLONE; and, on its own button, reads the person's own Bitget copy trading, read-only. Since Stage 8, on the trader's own buttons, follows them or runs their clone in the copy book, on paper only | Copy Traders |
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
| | Who asks which model (added 20 October 2026, V7.2-R Stage 1) | Every caller that asks a model by itself (the watch, its paper trades, the five additions that ask by themselves and, since 26 October 2026, the article reading, asked only on a click; each paid bot), the model it asks now and where that comes from, its calls and cost today and the model that answered; three roles (decides, first look, summaries) and one move that puts every caller on them, priced and confirmed before it is applied; the models nothing asks, which can be disabled | Settings › AI |
| | What a round trip costs now (added 22 October 2026, V7.2-R Stage 4) | The pair's round trip on Binance and on Bitget from their public books at a 1,000 USDT stake -- each venue's fee each way, the spread, the impact -- and which is cheaper; said where the books are held (the forecast's top ten and the app's open trades) | Predictions' drawer |
| | Best current prediction, since 20 October 2026 (V7.2-R Stage 3) | The hour's, four hours' and day's ranges; an expected price only where a source of the way that beat the base rate is in use ("not forecast: no way is known" otherwise); how often the coin moved 1% and 2% either way at an hour, four hours and a day, and touched 1% within four hours, over its last ninety days; the drawer's How often it moved table | Home, Predictions' drawer |
| | Research record (added 20 October 2026, V7.2-R Stage 2) | The folder kept for analysis on another machine (`trader-spider-research/`: the configuration with every secret field left out, the errors and warnings, every AI call with the model asked and the one that answered, each paper trade's opening and end, the hour's and the day's reports), its exports (a ZIP every day at 00:05 UTC and on Export now, the newest fourteen kept: the folder and the fortnight's records with a manifest of every file's size and SHA-256, never a key file), Open folder | Settings › Advanced |
| | Model registry (added 8 October 2026, not an old card) | Each model the app may ask: the catalogue's entry, thirty days of the ledger, its health by the daily look at its last thirty closed trades (DEGRADED, told once a day), its leaderboard row by event type and Bitcoin's regime, and the promotion checklist under it; shown, never stored, promoted or switched off | Settings › AI |
| | Strategy health (added 8 October 2026, not an old card) | On each bot's card: its last thirty closed paper trades against what its strategy made a trade where it was measured (profit factor, win rate, hold); a flag and one notice a day, and the bot keeps running | Strategies › Active Runs |
| | Usage | Daily budget, pace, spend by model today and over 30 days | Settings › AI |
| | AI additions (added 6 October 2026, not an old card) | Each addition on or off, its daily limit, what it asked today and what a day of it can cost; since 8 October 2026 five, with the daily summary; since 26 October 2026 six, with the article reading (V8 Stage 5), which ships off and asks only on a click on News URLs | Settings › AI |
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
| **The price forecast** (added 13 October 2026, V6 Stage 10, not an old page) | Best current prediction, Top predictions | The ranking's first pair: its call, the current price, its likely ranges at 15 minutes, an hour and four hours from the live price, its expected price and change at the best horizon, its bull and bear cases, since V7.1 Stage 3 its likely high and low and when the expected price is reached, quality, reliability, the story moving it, volume, momentum, the watch's vote where it asked, and the decision with its reasons (since V7.1 Stage 13 ENGINE_DRIFT among them); VIEW WHY opens the drawer and PAPER TRADE fills the Position form on paper (V7.1 Stage 14, the buttons' words); the top three under it | Home |
| | Ranked forecasts, and a row's drawer | Every pair's forecast best first, with filters; the drawer's timeline to 24 hours, Why?, Why this range?, its recorded forecasts against the price, the decision, and since V6 Stage 12 its trade plan and TRADE THIS | Predictions |
| | Start AI trading (added 13 October 2026, V6 Stage 12) | The forecast trader on paper, off until switched on: what the risk mode holds it to, its open and closed paper trades, what its last pass did | Predictions |
| | The Forecast Lab (added 13 October 2026, V6 Stage 11) | How the forecast did on the walk forward's weeks and on the live record: performance by horizon, variant and class, calibration, kinds of error and drift, by event, V1 to V4 on the same moments, the leaderboard with promotion and DEGRADED, a tested hour replayed, the forecast trader and its comparison with the strategies, buy and hold and the hybrid; the nightly refit's switch; since V6 Stage 12 the opportunity classes, each APPROVED, PROBATION, DISABLED or NOT ENOUGH DATA; since V6.1 the rule on Bitcoin's sharp moves by horizon -- in use or why not -- and the forecasts it widened live; since V7.1 Stage 2 (16 October 2026) the direction models beside the distribution's P(up) on the same weeks, each verdict, its last week and the classes that read from it; since V7.1 Stage 3 the path's figures on the live record -- the chance said of the expected price's touch against the share reached, UNLIKELY's record, the minutes said and seen, and whether the 80% levels held; since V7.1 Stage 11 the market's shock states -- each state's widening by horizon as the walk forward fitted it, in use or why not, the horizon's choice between V6.1's one rule and the states' rules with the figures it was made on, and the live record's forecasts in each state; since V7.1 Stage 12 the scheduled events -- the macro calendar's next releases, what Bitcoin did after past ones by kind (too few under thirty, said so), and each release inside the walk forward's weeks replayed at its hour before and first hour after, as forecast, by the line's rule and by the states', with the state, Bitcoin's fifteen minutes and the calls; since V7.1 Stage 13 the champion and the last challenger with its verdict, and a Roll back button that puts the run before back in use (models and verdicts, nothing else); since V7.2 Stage 1 (17 October 2026) every share and skill on its tables carries its 95% interval, with the independent outcomes it rests on and the blocks resampled, and each direction model the smallest skill its sample could tell from zero; since V7.2 Stage 2 the Which way table says each model's breakeven precision, its calls' edge after costs with its interval, whether it is promoted and tradeable by the direction bar's lines and whether the run before found it so; since V7.2 Stage 3 the champion card says a challenge's verdict beyond noise (the paired figures, within noise, newer, better or worse) and a Registered lines card shows research/preregistered.jsonl with each line's last result; since V7.2 Stage 4 a By hour card reads the forecast shown by the UTC hour it was made at (coverage, pinball, the implied dispersion, the misses in a shock state, four halves, the failing-band line) and a What a block of figures added card reads the ablation files research/ablation.ts wrote; since V7.2-R Stage 5 (22 October 2026) an Out of sample card: the newest walk forward that kept its weeks' models replayed out of sample -- each strategy's orders, trades, share filled, net a trade after costs with its interval, win rate, profit factor, cost, deepest fall, the best hours' share and the long held over the same lives, by sample, and what the replay cannot know -- with the registered lines band reversion and the range grid are offered on paper by (V72R-S5-BAND, V72R-S5-GRID: failed, neither offered); since V7.2-R Stage 6 a Your direction hypotheses on a year card: the user's five ideas of the way as rules (a day's top gainer, Bitcoin and ether leading, a news catalyst, a confirmed breakout, a fall's recovery) at an hour, four hours and a day on a year of bars, each with its calls, share right, skill over the base rate and move less the round trip with their intervals, its halves and its verdict by the direction bar, beside the registered verdicts (none passed; shipped as data in shared/forecast/hypotheses-2026.json); since V7.2-R Stage 8 the champion card says a challenger in its shadow week (its run, its week, what it cleared) and how the last shadow week ended; CSV each | Forecast Lab |
| | Binance vs Bitget (added 16 October 2026, V7.1 Stage 6) | The shown pair's last price, best bid and ask, spread, depth within half a percent of the mid, 24h volume, book age and read time on Binance and on Bitget, read at the same moment from public market data on request; Bitget's spot pairs, candles and tickers offered wherever an exchange is chosen, data only | Market |
| | Demo positions (added 16 October 2026, V7.1 Stage 8) | Positions on Bitget's demo account (play money) opened by a demo executor or the paper laboratory, their watchers' barriers, Close (a demo sell), and their history, apart from paper and real | Positions |
| | A real Order or Position on Bitget (added 16 October 2026, V7.1 Stage 9) | Live mode on Bitget for an Order (market or limit) or a buy-only 1x Position with an exit, over a verified Bitget key, through the same gates, ledgers, watcher, poll and reconciliation as Binance's; a ladder or a series stays Binance-only | Strategies › Execution; Live |
| | A demo Order or Position (added 16 October 2026, V7.1 Stage 8) | The executor form's third mode on Bitget while a demo key is stored: an Order (market or limit) or a buy-only 1x Position with an exit, placed on the demo account, watched and exited there, shown with a DEMO badge | Strategies › Execution |
| | The paper laboratory (added 16 October 2026, V7.1 Stage 4) | The paper account funded to 10,000 USDT at a click; four strategies -- STRICT, DIRECTION, NEWS EVENT, HYBRID -- each off until switched on, each trading on paper from the ranked forecasts under the laboratory's lines (0.25% of the equity risked, a tenth staked, 3 open, a 1.5% daily stop, no leverage); each strategy's record, what the last pass did, and the sensitivity counts at 55% and 52% beside the 58% line | Forecast Lab |

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
| | `bots`, `botRuns`; since 20 October 2026 a bot moved to another model keeps `aiModelHistory` (the models it had and until when) | Bots | Strategies › Active Runs |
| | `executors` (the watch's paper trades are written by `src/agents/watchPaperTrade.ts`) | Executors | Strategies › Execution |
| | `routines` | Routines | Backtest & Research › Automation |
| | `heldPositions` | Positions | Positions |
| | `controllers` | Controllers | Risk & Safety |
| | `paperAccount` | Account | Paper Trading |
| | `paperRisk` (added 5 October 2026): how the paper trades the app opens by itself are sized, by what their stop would lose, by a share of the paper account's equity (added 8 October 2026), or at their stake, and what they may stake together; and, added 13 October 2026 (V6 Stage 12), `correlatedShare`, the share they may stake on one side on coins that move with Bitcoin (0.15 as it was fixed) | — | Risk & Safety; the risk mode on Settings › Essentials |
| | `paperDigest` (added 5 October 2026): the daily notice of what those trades did, on or off, and the last day it told | — | Risk & Safety |
| | `paperPause` (added 5 October 2026): the losing run in R that pauses those trades, or never; and for the watch, the news rules and, since V6 Stage 12, the forecast trader, each, whether a run has paused it and when it was last resumed | — | Risk & Safety |
| | `copyTrading` (added 27 October 2026, V8 Stage 8; `shared/traders/copyTrading.ts`): the traders followed on paper, each since when and the longest a follow of theirs stays open (their longest hold, at most seven days), and the traders whose clone runs, each since when, its rule and its coins; empty by default, a trader added only by their own button | — | Copy Traders (On paper) |
| | `paperBooks` (added 26 October 2026, V8 Stage 2; `shared/paperBooks.ts`): V8's three tested paper books -- news, copy, baseline -- each its own start (10,000 USDT unless set), most open, a trade's share of its equity and its daily stop, and whether they run and since when (nothing runs until Start paper testing, V8 Stage 9); a book counts only the executors its writer stamped with its mark (`executors[].book`), its money derived from them as the account's is | — | Paper Trading (V8 Stage 9) |
| | `alerts` (added 6 October 2026): desktop notices on or off, and with sound or silent; obeyed where every notice is raised (`appHandlers.ts`); since 13 October 2026 (V6 Stage 13) `desktop`, whether the operating system's notices are shown at all (they are always silent: the window plays the sound) | — | Settings › Essentials; the desktop's under Settings › Advanced › Notifications |
| | `sounds` (added 13 October 2026, V6 Stage 13): the four sounds' volume, the kinds muted, the cooldown between two of one sound, quiet hours (`shared/sounds.ts`) | — | Settings › Advanced › Notifications |
| | `keepRunningWhenClosed` (added 8 October 2026, V5 Stage 2): closing the window hides it to the tray and everything runs on, or quits the app (off by default; `shared/keepRunning.ts`) | — | Settings › Essentials |
| | `uiMode` (added 13 October 2026, V6 Stage 1): the sidebar's layout, Normal (Research and All Features folded until opened) or Expert (every group open) | — | Settings › Essentials › Layout |
| | `language` (added 13 October 2026, V6 Stage 14): the language of the normal-user pages and of every notice, one of ten; absent until chosen, when the first launch asks, offering the computer's (`shared/i18n/languages.ts`) | — | Settings › Language; the first launch's chooser |
| | `forecast.refitNightly` (added 13 October 2026, V6 Stage 5): the price forecast refitted every night at 00:30 UTC on the newest ninety days, and at a start when the last fit is over 26 hours old (on unless `false`; `shared/forecast/training.ts`) | — | Forecast Lab (V6 Stage 11); until then `settings.json` and the effective-config card |
| | `forecast.trader` (added 13 October 2026, V6 Stage 12): START AI TRADING, the forecast trader opening paper Positions on TRADE decisions by itself (off until switched on), its stake, and how many it keeps open and on one side, which the risk mode sets (`shared/forecast/trader.ts`) | — | Predictions (Start AI trading); the caps by the risk mode on Settings › Essentials |
| | `forecast.lab` (added 16 October 2026, V7.1 Stage 4): the paper laboratory's four strategies, each on only where `true` is stored, the UTC day its daily stop was reached with what was lost against what equity, or null, and since V7.1 Stage 8 `execution`, where its trades go: `paper` unless `demo` is stored (`shared/forecast/labTrader.ts`) | — | Forecast Lab (Paper laboratory) |
| `demoPositions.json`, `demoOrders.json`, `demoPositionWatchers.json` (added 16 October 2026, V7.1 Stage 8) | The demo book's ledgers: positions on Bitget's demo account, its resting demo orders, the watchers guarding demo positions -- the real book's three files' shapes, in files of their own, polled and reconciled apart | Positions | Positions (Demo positions); Strategies › Execution |
| `aiConfig.json` | `defaultModel`, `enabledModels`, `route`; since 20 October 2026 `roles` (the first look's and the summaries' models, the decider being `defaultModel`; null until a move to roles is applied, and set only by it) | Agents › Models | Settings › AI |
| | `dailyCapUsd`, `callsPerMinute` | Agents › Usage | Settings › AI |
| | `watch` (on, models, events a day, lowest band, first model gates; and, added 8 October 2026, CONFIRM: a paper BUY it opens is told as ready to confirm as a real order a person places; added with V5 Stage 4, `askAt`: at the raise, or once the event is confirmed a pass later; and since V5 Stage 5 three models offered by default with the first gating, and the paper trade following their vote when two or more are asked) | Agents › Opportunities › Watch | Opportunities (stays with its results) |
| | `watchPaper` (on, model, stake, most open; and, added on 5 October 2026, most open in one direction, the losing run that pauses it, the Bitcoin move that drops a waiting trade) | Agents › Opportunities › Watch | Opportunities |
| `scanner.json` | `enabled` (on by default since 8 October 2026; only `false` switches it off), `universeSize` (20, 40, 60 or 100) | Explorer › Scanner | Settings › Market |
| `marketEvents/` | since 8 October 2026 an event may be a market-wide move (`type: 'market_move'`, on BTCUSDT, with `live.members`), and its members carry `live.marketMove`; detector version `events-v2`; since V5 Stage 4 each event carries a `fingerprint` and a `cause`, and `status-YYYY-MM.jsonl` holds each event's life (DETECTED → CONFIRMED → ACTIVE → WEAKENING → EXPIRED), one line a change, read back at start | — | Opportunities, Explorer |
| `news.json` | `enabled`; for `delisting` and for `monitoringTag`, each: `notifyHeld`, `paperShort` (on, stake), `askModels` (added with the news reader, V3 Stage 7) | — | Settings › Market |
| `credentials.json` (encrypted) | Binance and Upbit keys; when added, last tested, result (Bitget's, with its passphrase and a demo slot, from V7.1 Stage 7; a Bitget key on a Classic account is stored as CLASSIC, read over the Classic endpoint and refused a real order, 16 October 2026) | Settings | Connections |
| `aiCredentials.json` (encrypted) | The OpenRouter key | Agents | Connections |
| `liveTrading.json` | Session armed, kill switch | Live trading bar | The bar (stays); detail on Live Trading |
| | Max order size, daily cap, daily loss limit, allocation; and, added 8 October 2026, the share of the allocation a real order filled in from a call is sized to risk | Settings | Risk & Safety |

These files are records, not settings, and stay where they are: `livePositions.json`,
`liveOrders.json`, `livePositionWatchers.json`, `liveTwapRuns.json`, `aiLedger/`, `aiSignalCache/`,
`aiExperiments/`, `marketEvents/`, `news/` and `aiModels.json`; since 26 October 2026 (V8 Stage 2) `predictions/`
(every prediction that is not the forecast's own -- a rule's card, an article's reading, a trader's trade, a person's
own call -- when it is made, `sources-YYYY-MM.jsonl`, and its outcome settled from its venue's one-minute bars once its
horizon has passed, `source-outcomes-YYYY-MM.jsonl`; owed ones read back for eight days; never swept;
`electron/services/predictionLedgerService.ts`; since V8 Stage 3 also the large moves of the forecast's pairs -- 2% in
an hour or 5% in a day -- with the predictions that called them, `moves-YYYY-MM.jsonl`, and each coin's card state at
every whole hour, `cards-YYYY-MM.jsonl`); since V8 Stage 4 `news/urls-YYYY-MM.jsonl` (each pasted or discovered news
link: the link as cut down and the hash of what was pasted, how its text was had, its publication time and how it was
read, who says it, the coins it names and those refused, each coin's price from a day before publication to four hours
after, the verdict, the predictions and paper trades made from it, and a trail; one line a change, the last its state;
`electron/services/newsUrlService.ts`) and `paperBooks/` (each paper book's equity marked once an hour while
they run, `equity-YYYY-MM.jsonl`, and every missed opportunity -- a candidate its source called and its writer did not
open, with the stage that stopped it -- `misses-YYYY-MM.jsonl`; the laboratory's and the forecast trader's refusals
among them, and the liquidity gate's in shadow over the forecast's TRADE decisions; since V8 Stage 8 a book's trades
settled a day ago, moved out of `settings.json`, `archive-YYYY-MM.jsonl`; `electron/services/booksService.ts`); since V8
Stage 8 `traders/<key>/` holds, beside a trader's record, each change of a followed leader's position as it was read,
under its own key, before anything acts on it (`events-YYYY-MM.jsonl`), and each signal of a running clone
(`clone-signals-YYYY-MM.jsonl`; `electron/services/followService.ts`);
and, since 8 October 2026,
`paperRefusals/` (the app's own paper trades refused, and why) and `alerts/` (the alerts told), one
JSON line each in a file per UTC month (`shared/records.ts`), written by the main process as the
renderer tells them and read back by the session report, a trade's timeline and Overview. Since
8 October 2026 (the V5 document, §93) `aiSignalCache/` is swept at start of files older than 90
days (`recordRetentionService`), and the size of each record directory is on the effective-config
card. Since 13 October 2026 `forecastData/` holds the price forecast's five-minute bars, a file per
pair and UTC month (`forecastDataService`, V6 Stage 2), and a month file whose month ended before the
ninety days the forecast keeps is deleted at start; and `forecastModels/` holds the forecast's fitted
models, a folder a run (`<horizon>.json`, the walk forward's `oos-<horizon>.bin` and, since V7.2 Stage 5, each fold's models `fold-<k>-<horizon>.json` -- since V6.1 with
Bitcoin's last fifteen minutes at each hour, since V7.1 Stage 11 with the market's shock state at each hour -- and, since V6 Stage 6, the calibration made from it,
`calibration.json`, since V6.1 with each horizon's rule on Bitcoin's sharp moves, since V7.1 Stage 2 with its direction models' verdicts, the record itself holding their readings; since V7.1 Stage 3 with each horizon's excursion calibration and the run's first-touch table, the record holding the excursion models' levels; since V7.1 Stage 11 with each horizon's rules by market shock state and its choice among the widenings; since V7.2 Stage 1 with every score's intervals, effective sample and blocks, run-calibration-v6), `current.json` (the run in use, the walk
forward whose verdicts and calibration hold, the verdicts) and `training-YYYY-MM.jsonl` (a line for
every fit, walk forward and calibration), written by `forecastTrainingService` (V6 Stage 5), which keeps
the run in use and the one before it and deletes older runs after a walk forward; and `forecasts/`
holds the live forecast's record (V6 Stage 7): every pair's forecast at each quarter-hour and each made
again between closes (`predictions-YYYY-MM.jsonl`), each horizon's outcome when due
(`outcomes-YYYY-MM.jsonl`), since V6 Stage 16 the pairs each recorded quarter-hour's pass held bars for
(`passes-YYYY-MM.jsonl`), the adaptive levels (`aci.json`), since V7.2 Stage 5 the tape
(`tape-YYYY-MM-DD.jsonl`: one line a minute per streamed pair's book and each of Bitcoin's minutes, its
day files deleted with the month files) and, since V6 Stage 8, the outcomes of the forecasts a story
moved (`news-outcomes.jsonl`), its month files deleted at start once their month ended over 180 days
before; since V7.2 Stage 5 an outcome line says the close it was settled at and a forecast line the day's
volatility it was scaled by, for a replay. Since V7.2-R Stage 8 a challenger in its shadow week has its own record
beside it (`shadow-predictions-YYYY-MM.jsonl`, `shadow-outcomes-YYYY-MM.jsonl`, `shadow-aci.json`), deleted with the
month files, and `current.json` names the shadow, its week and the run in use it was set against. Nothing else is ever
deleted.

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
- **`CopyTradingScheduler`** (added 27 October 2026, V8 Stage 8) hands each leader event and clone signal the main
  process pushes to `src/traders/paperFollow.ts` and `paperClone.ts`, one at a time, reads the last ten minutes' back at
  start, and once a minute closes the follows and clone trades that are due; it writes nothing itself.
- **`OpportunityScheduler`** is the watch: it puts events to models and opens and settles its paper
  trades when those are switched on. Since 8 October 2026 (the V5 document, §94) it first reads
  today's ledger and writes a refusal at stage `restart` for an answer the app was not running to
  act on (`shared/restartMisses.ts`), so the record is whole and the event is shown as MISSED.

And since 13 October 2026 (V6 Stage 12):
- **`ForecastTraderScheduler`** is the forecast trader (`src/forecast/forecastTrader.ts`): after each
  of the forecast's passes, while switched on, it opens a paper Position on each TRADE decision in an
  approved or probation opportunity class, and every minute it settles those that have closed.
  Switched off, a pass reads one setting and opens nothing.

And since 16 October 2026 (V7.1 Stage 4):
- **`LabTraderScheduler`** is the paper laboratory (`src/forecast/labTrader.ts`): after each of the
  forecast's passes it opens a paper Position on each ranked forecast that qualifies for a strategy
  switched on -- STRICT, DIRECTION, NEWS EVENT or HYBRID -- under the laboratory's lines and its daily
  stop, and every minute it settles those that have closed. With every strategy off, a pass reads the
  settings and opens nothing.

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
- **`ResearchReportScheduler`** (20 October 2026, V7.2-R Stage 2; `src/performance/researchReports.ts`)
  looks every five minutes and, once an hour has closed, builds the hour's report -- the session report
  over it, the forecast's section over it, the paper laboratory's and the forecast trader's standing --
  and after 00:10 UTC the day's, each once, and hands them to the main process to keep in the research
  folder's `reports/`. It reads the records, asks nothing and opens nothing.
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
  socket's state (`src/status/liveMarketChip.ts`). Since V7.2-R Stage 9 (22 October 2026) it reads, in one REST
  request before each forecast pass, the books of the pairs the pass decides on that the socket does not carry fresh
  (readPassBooks; a refused request pair by pair), and a pair's freshest book is the socket's or that read (heldBook),
  which the forecast's decisions use. Public data only.
- `newsService` reads Binance's two announcement lists once a minute while it is on (added in V3
  Stage 7).
- `forecastDataService` (added 13 October 2026, V6 Stage 2) keeps ninety days of five-minute bars
  for the research's pairs and Bitcoin and ether in `forecastData/`, read from the public data host
  a few minutes after the research first names its pairs and a page a pair after every five-minute
  close. Since 20 October 2026 a usual pass stops taking pairs after sixty seconds, so that a slow host
  cannot carry it past the next close; the pairs not reached are read by the next pass. Public data only.
- `venueQuotesService` (added 22 October 2026, V7.2-R Stage 4) reads Binance's and Bitget's public books, a hundred
  levels, every minute for the pairs of the app's open paper and demo trades and the forecast's top ten (at most twelve),
  and Bitget's per-pair fees every six hours; the forecast's decisions are costed at the cheaper venue from them. Public
  data only: nothing signed, nothing placed.
- `predictionLedgerService` (added 26 October 2026, V8 Stage 2) settles each owed prediction once a minute from its
  venue's one-minute bars once its horizon has passed, reads the owed ones of the last eight days back at a start and
  writes missing, with its reason, one older or whose bars could not be read for six hours. Public data only.
- `booksService` (added 26 October 2026, V8 Stage 2) marks each paper book's equity at every UTC hour while the books
  run, and nothing while they are stopped. It opens, closes and places nothing.
- `primaryCallService` (added 26 October 2026, V8 Stage 3) weighs the primary call every minute and whenever the
  announcements reader has read: each coin a Binance delisting names, while its rule's hold lasts, goes in the venues'
  event lane (at most five coins, books read on demand) and is weighed into a card within the rule's five minutes --
  its expected net from the study's coins (`shared/delistingStudy.ts`) less this route's cost and funding, the rule's
  live check read first -- or put on the late list; a direction model in use as a P(up) source is weighed the same way
  (none is). Each card is written once to the prediction record, and each coin's card state at every whole hour. Public
  data and the app's own records; it opens, closes and places nothing.
- `newsUrlService` (added 26 October 2026, V8 Stage 4) reads each pasted news link's prices again every five minutes
  until four hours after its publication, and records each story of the app's own feed of impact 70 or more that names
  a coin directly, passively -- nothing fetched -- unless `newsUrls.autoAnalyze` (off by default) has it read as a
  pasted link would be. A page is fetched only through `urlFetchService` (https, its addresses vetted, the vetted one
  read, three redirects, fifteen seconds, two megabytes, one start a host in ten seconds) and read as text in a worker.
- `researchFolderService` (added 20 October 2026, V7.2-R Stage 2) keeps `trader-spider-research/`: the
  configuration's snapshots at start and hourly, the main process's errors and warnings and every AI call
  as the ledger appends it (`onAiCallAppended`), each paper order's life as the settings are written
  (`onSettingsWritten`), the reports the window hands it, and the daily export at 00:05 UTC. It reads the
  app's own files through an allowlist that names no key file, asks no model and places nothing.
- `forecastTrainingService` (added 13 October 2026, V6 Stage 5) fits the forecast's models in a
  worker thread of their own (`electron/forecast/trainWorker.ts`, through `forecastWorkerService`):
  a first fit once the bars are there for twenty pairs, the walk forward after it, and a refit every
  night at 00:30 UTC unless `forecast.refitNightly` is off; it writes `forecastModels/`. Since V6
  Stage 6 each walk forward also writes its calibration, and a run without one is calibrated again
  from its record at start. Since V7.2-R Stage 8 (challenger-v3) a refit that clears the run in use is first its shadow
  for seven days, read back at a start, put in use or dropped on the verdict the forecast service hands it at the week's
  end; no refit is made while a shadow is in its week. Public data only; no key, no model call, no order.
- `forecastReplayService` (added 22 October 2026, V7.2-R Stage 5) replays, once the training is idle, the newest walk
  forward on file that kept every week's models (in use or refused as a challenger) in the same worker (task `replay`):
  each week after the first forecast again at every five-minute close with that week's models and a calibration from the
  weeks before it alone, and the paper strategies played on the bars after; it keeps `forecastModels/replay.json` and
  `replay-trades.jsonl`, the newest replay's alone, once a run. Its own bars and models only; no key, no model call, no
  order.
- `forecastService` (added 13 October 2026, V6 Stage 7) forecasts every pair at every five-minute
  close with those models and their calibration, and again between closes for a story of impact 70
  naming it, an event the scanner raised on it, a live price out of its range or a volume shock, at
  most once a minute; it writes `forecasts/`, each horizon's outcome when due, and moves the adaptive
  levels by them. Since V6 Stage 8 the stories the news feed holds and the news analyst's readings on
  file (handed in by `electron/main.ts` from the AI ledger) move a coin's forecast by fixed rules; it
  asks nothing. Since V6 Stage 9 it decides, after every pass, whether each pair's forecast is worth
  trading and ranks them all; it places nothing. Since V7.2-R Stage 8 it forecasts every close a second time with a
  challenger in its shadow week, into the shadow's own files, shown and ranked nowhere, and at the week's end pairs the
  two records and hands the verdict to the training. Public data only; no key, no model call, no order.
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
| `ai` | 29: key, signal tapes, config, calls, usage, entry confirmation, benchmark, opportunities, experiments; since 20 October 2026 who asks which model (the routing preview, free, and the move to roles, applied only with the preview's token); and since 6 October 2026 the AI additions' status, the conclusion to "Why did it move?" (paid, on a click), the reviewer (paid, before a paper trade of the watch's, only when something stands out) and the exit check (paid, on one of the app's own open paper trades, only when something about it has changed); and since 26 October 2026 the article reading (paid, on a click on News URLs at the price shown, twenty a day at most) | Agents' tabs, Backtest, Bots, the watch and its paper writer; the exit check's look; the additions' card under Settings › AI, the news analyst's readings and the reviewer's verdicts read from the ledger, the Why window's conclusion, and the exit check's card on Performance |
| `liveTrading` | 19: status, limits, kill switch, arm, positions, orders, watchers, TWAP | The live trading bar, Settings, Executors, Positions, `LiveOrderScheduler`, Portfolio |
| `executors` | `placeLiveOrder`, `placeLiveLimitOrder` | Executors only |
| `researchFolder` | 4 (added 20 October 2026, V7.2-R Stage 2): status, export now, open the folder, keep a report | Settings › Advanced › Research record, and `ResearchReportScheduler` (the hour's and the day's reports) |
| `predictions` | 2 (added 26 October 2026, V8 Stage 2): a person's own call recorded (the window may record no other source's), the record read with each one's outcome | V8's pages from Stage 3 on |
| `books` | 5 (added 26 October 2026, V8 Stage 2): each paper book's standing, a book's equity marks, a missed opportunity written, the misses read; and since Stage 8 a book's settled trades archived | `LabTraderScheduler` and `ForecastTraderScheduler` (their refusals, as misses); V8's pages from Stage 3 on |
| `calls` | 2 (added 26 October 2026, V8 Stage 3): the primary call as last weighed -- its cards, the delisted coins past the rule's window, the refusals, the rule's live check -- and each new weighing pushed | Home's and Predictions' primary call card and Predictions' lines, through `usePrimaryCall`; read-only |
| `urls` | 4 (added 26 October 2026, V8 Stage 4): a pasted link read and kept (with text a person supplies where its page cannot be read), the links on file, a person's own view linked to one, and each record pushed | News URLs; the window's link and text held to their shape and length |
| `traders` | 15 (added 27 October 2026, V8 Stages 6-8): a pasted trader read from its venue and kept, a file of trades chosen in the main process's own dialog read and kept (the window never names a path), an analysis of one on file, the traders on file with their last analysis, each step pushed, and the read-only Bitget copy-trading check on its button; since Stage 8 a follow and a clone switched on or off, how each follow is read, the last day's leader events and clone signals read back, a perpetual's price and its funding rates, and the leader events, clone signals and follow statuses pushed | Copy Traders; the paste held to its length, the key never crossing the bridge |
| `forecast` | 13 (added 13 October 2026, V6 Stages 7-15; since 22 October 2026 a pair's round trips on both venues, read-only, for a buy or (since V8 Stage 3) a sell, and the replay out of sample's state and kept file, read-only): state, every pair's forecast, a pair's, its history, the ranking, a pair's decision, the Lab, a tested hour's replay, the replay out of sample, bars, the record over a span (V6 Stage 15), updates | Home, Predictions and the drawer, TRADE THIS, the forecast trader, the Forecast Lab, the top prediction's chime, and an experiment's report |

**Nothing in `src/` calls `app:ping` or `app:getVersion`.** Both are left from the project template.
They are flagged here and not removed, since they cost nothing and something outside `src/` may
use them.

## V7.2 — what exists for the honest-figures cycle (17 October 2026)

The V7.2 plan (honest figures first, then information, then the decision layer) starts from what V7.1
left. Its Phase 0, taken 17 October 2026 before Stage 1 was built:

| Candidate kept | Status at the start | What exists, where |
|---|---|---|
| Intervals on every figure | **BUILT in Stage 1** (was NEW) | `shared/forecast/uncertainty.ts`: the circular block bootstrap over the hours, its corrections for overlapping outcomes and few blocks, the effective sample, the detectable skill and the paired difference; carried by `HonestScore`, `DirectionScore` (run-calibration-v6) and `LabMetrics`; printed by the Lab's tables, `research/uncertainty.ts`, `research/direction.ts`, `research/rangeLag.ts` and `scripts/shadow-analyze.py` |
| The direction bar | **BUILT in Stage 2** (was EXISTS, too permissive) | `promotion.ts directionChecklist` with `DIRECTION_PROMOTION_LINES` (skill 1%, 200 calls, the precision's lower bound above an even chance, both halves of the weeks and of the pairs, the class floor, the calls' edge after costs for TRADEABLE; an unread line blocks); a direction score's halves and edge (run-calibration-v7); a P(up) source needs tradeable on two walk forwards in a row, the run in use's verdicts handed to the next walk forward (`forecastTrainingService.ts`, `trainWorker.ts`); the Lab's Which way table with the breakeven precision and the edge; `research/direction.ts`; the day-shift null test and the exploratory readings in `research/directionNull.ts` |
| Pre-registration | **BUILT in Stage 3** (was EXISTS as habit, not as a file) | `research/preregistered.jsonl` (21 registrations, V72-S1-INTERVALS to V72-S13-BUNDLE, the results of Stages 1-3 locked to theirs); `shared/forecast/preregistration.ts` (the parser, the hash of a registration's locked fields, the checks); `tests/preregistration.test.ts` (the lock, duplicates, orphan results, every constant added since 16 October 2026 named or infrastructure); the Lab's Registered lines card |
| Challenger beyond noise | **BUILT in Stage 3** (was NEEDS EXTENSION) | challenger-v2: `pairedHorizonOf`/`pairedChallengeOf` (the two walk forwards paired on the hours both tested, 90% intervals of the pinball, coverage-distance and direction-skill differences, the tolerances as floors), `compareRuns` adopting beyond noise or a week newer and no worse, the why and a summary on the training log; the worker pairs a refit with the champion's record (`championRunId`); `research/pairedChallenge.ts` prints a pair; since V7.2-R Stage 8 (challenger-v3, `shared/forecast/shadow.ts`) a refit that clears it forecasts beside the run in use for seven days first, recorded apart and shown nowhere, and is put in use only where the two live records paired on the same pairs and closes are worse beyond noise at no horizon (V72R-S8-SHADOW, held on Stage 9's three-day run: every grid forecast paired and every due horizon settled; its week outlasted the run, so no verdict was read) |
| The clock | **MEASURED in Stage 4** (was NEEDS MEASURING) | `shared/forecast/byHour.ts` (the forecast shown by UTC hour and weekday, in four halves, the implied dispersion, the misses in a shock state, the failing-band line `BY_HOUR_LINES`), made with every Lab (`LabHorizon.byHour`) and shown on the Lab's By hour card; `research/byHour.ts` with the bars' range and volume by hour; the registered line V72-S4-CLOCK cannot be read on three weeks (no half holds 500) and is recorded not measured |
| Feature ablation | **BUILT in Stage 4** (was NEW) | `shared/forecast/ablation.ts` (`FEATURE_BLOCKS`, `BLOCK_COLUMNS`, a block held at its training mean in a copy of the rows, a block permuted for the control, the ablation file's reader); `research/ablation.ts` fits the walk forward twice on identical folds and seeds and pairs the two (deterministic: zero differing figures); the Lab's What a block of figures added card reads the files the tool writes into `forecastModels/` |
| Replay harness | **BUILT in part in Stage 5** (was NEW; parts exist) | `shared/forecast/pass.ts` (the live forecast's every decision as pure functions handed `PassSources` and one `PassState`, the service writing what they return); `fidelity.ts` (a record replayed through them and compared on V2's own levels to four decimals, every remainder with its reason) and `research/replayFidelity.ts`; each fold's models saved beside a walk forward's record (`fold-<k>-<horizon>.json`); the tape (`tape.ts`, `forecasts/tape-YYYY-MM-DD.jsonl`) counted on a run's report; the record carrying the close each outcome was settled at (`OutcomeLine.at`) and the day's volatility each forecast was scaled by (`PredictionLine.rv`), which the registered line V72-S5-FIDELITY found missing (60% of the two-day record replayed to four decimals, the arithmetic reproduced and the adaptive steps' timing not); the replay out of sample itself was built in V7.2-R Stage 5 (22 October 2026): `shared/forecast/replay.ts` (each week after the first through the pass with its own models and a calibration from the weeks before alone, the strategies on the bars after, every line stamped with its sample, two replays byte for byte the same: V72R-S5-REPLAY held), `research/replay.ts`, the worker's `replay` task and `forecastReplayService` |
| A year of bars | **BUILT in V7.2-R Stage 6** (was NEW) | `research/fetch-forecast-archive.mjs`: every USDT pair the archive has held, each month's 40 by the month before's volume (stock tokens and pegged coins left out), their five-minute klines checked against Binance's SHA-256 into a scratch folder the live fit never reads (653 of 653 checked: V72R-S6-ARCHIVE held); the user's five direction hypotheses as rules on it (`shared/forecast/hypotheses.ts`, `research/hypotheses.ts`: none passed) and the long walk forward (`research/longWalkForward.ts`: eight months out of sample, the ranges held month after month -- V72R-S6-COVERAGE held -- a year of rows lowered the loss by under 1% at every horizon -- V72R-S6-LONGWF failed, the live fit stays ninety days -- and no horizon has a direction, V72R-S6-DIRYEAR failed) |
| Cross-section, taker size | **MEASURED in V7.2-R Stage 7: failed** (was NEEDS EXTENSION) | `shared/forecast/blocksV3.ts` CROSS and FLOW (14 columns) appended to the year's long walk forward and fitted again on the same folds, seeds and rows beside a shuffled control (`research/blockAblation.ts`): the loss moved by a twentieth of a percent at most, as the control's did, no direction model promoted (V72R-S7-CROSSFLOW failed); in research, out of the rows |
| Positioning | **MEASURED in V7.2-R Stage 7: failed** (was NEW in the app; studied) | `research/fetch-positioning.mjs` (the year's metrics, premium and funding for 27 pairs) and `blocksV3.ts` POSITIONING (10 columns, read ten minutes or more before each moment): at four hours and a day the loss moved -0.07% and +0.02%, as the control's did, no direction model promoted (V72R-S7-POSITIONING failed); in research, out of the rows |
| Band-reversion | **MEASURED in V7.2-R Stage 5: failed** (was NEW) | `shared/forecast/rangeStrategies.ts`: band reversion (a resting bid at P10, sold at the median, the excursion stop) at an hour, four hours and a day, and the range grid between a day's P10 and P90, replayed out of sample: every registered line failed (V72R-S5-BAND, V72R-S5-GRID), neither offered on paper |
| Conditions verdict | **NEW; inputs exist** | the states, `drift.ts`, UNCERTAIN, `REFRESH_LINES.spreadShock`, `RELIABILITY_LINES.rvRatio`, `RISK_LINES.reduced` |
| Evaluation bundle | **NEW** | three one-off readers (`direction.ts`, `rangeLag.ts`, `eventImpact.ts`), a Python printer; since Stage 1 each with the intervals |

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
