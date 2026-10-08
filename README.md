# TraderSpider

A desktop trading dashboard built with Electron, React, and TypeScript. It streams live market
data from eight exchanges, runs a pluggable library of validated technical-analysis strategies,
and provides a full paper-trading workspace — bots, multi-type strategy executors, portfolio
views, and scheduled backtests — modeled on Hummingbot's [Condor](https://condor.hummingbot.org)
dashboard, adapted to run entirely inside a single Electron process with no server backend.

**Most of this app is simulated, but not all of it.** Every bot and every executor replays real
market data through deterministic paper-trading logic by default. Five of the eight executor types
— **Order, Position, DCA, TWAP and Grid** — can additionally be created in *live* mode on Binance,
where they place real orders with real money, behind a stack of safety gates that default off and
reset every launch. Live Position, DCA and Grid executors also *exit* on their own, placing a real
sell with no per-exit confirmation. Read [Live Trading](#live-trading--real-money) before enabling
any of it. XEMM, Arbitrage and Market Making remain paper-only, as does every non-Binance
exchange.

## Table of Contents

- [Features](#features)
- [Live Trading (Real Money)](#live-trading--real-money)
- [Architecture](#architecture)
- [Core Strategy & Simulation Logic](#core-strategy--simulation-logic)
- [How the strategies make money (the math)](STRATEGIES.md)
- [Tech Stack](#tech-stack)
- [Supported Exchanges](#supported-exchanges)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Building](#building)

## Features

The sidebar follows a trade rather than the order the app was built in. It has four groups: what
is happening and what to do about it, trading it, research, and the system. Every page the app had
before this layout still exists inside one of these. [`docs/INVENTORY.md`](docs/INVENTORY.md) says
where each card went, and `tests/navigation.test.ts` holds the sidebar and that inventory to each
other.

| Group | Page | What it does |
|---|---|---|
| AI Trader | **Overview** | The landing page, answering five questions from what the app already reads. **Market status** first, from the [research the app does as it opens](#market-research-when-the-app-opens): the market's [regime](#the-opportunity-table-and-the-markets-regime) in a word (BULL, BEAR, SIDEWAYS, HIGH-VOL, PANIC or RECOVERY), Bitcoin and ether rising, falling or flat, the other pairs against Bitcoin, and a risk state (NORMAL, ELEVATED or PANIC), with a "Researching…" line while it reads. **The market**: Bitcoin and ether over the hour and four hours, whether Bitcoin is rising, falling or flat, and what is moving most, from the scanner's last pass. **What can be acted on**: the recommendation still on offer with the strongest signal, with its entry, stop, target, time left, signal score and a Paper trade button — or, usually, "No high-quality opportunity right now. Wait." with the strongest event of the last hour and what it lacks. **What the models said** about it. **What you hold**: value, paper strategies running, real positions open. With a paper account the value is the account's, with what the session made; with none it is what the open positions are worth and what they are up or down, as a position's stake is not a gain. **Safety**: whether a real order can be placed, the day's loss, the AI's spend and what the watch does. The starter presets lead it for someone with nothing running. |
| | **Opportunities** | What can be traded right now: the [watch](#ai-signals--paper-only) that puts events to models with no click, and [the table](#the-opportunity-table-and-the-markets-regime) of the recommendations still valid and the last hour's other events, ranked by a signal score with fixed weights ("No high-quality opportunity right now. Wait." when nothing is on offer), each entry checked against the [live price](#live-prices) — enterable now, waiting for its range, or invalidated, with an execution score — and a row opening the score, the plan and what ends it, the risk, the news and each model's reasoning. Below it, every event the scanner raised with each model's call, Ask and Paper trade. **Why?** beside a pair says what moved it, from the [news and Bitcoin](#news--market-events). A call fills in an order form at most; a person places it. |
| | **Markets** | One pair on any supported exchange: candlestick chart with indicators, symbol search, live ticker. Below it, **Movers**: the liquid USDT pairs that moved most over the day and over the week, by volume against their week, and CoinGecko's trending list, from the [market research](#market-research-when-the-app-opens); a row opens its chart. **Why did it move?** for the chart's pair, by [fixed rules](#news--market-events). |
| | **AI Decisions** | **Analyze** asks a model about one market; **Signals** lists every call any model has made and how it turned out. A model is handed a market snapshot and returns one JSON decision, and is given no tools at all. |
| | **Positions** | Live paper positions for active bots; a **Live Positions** table of real Binance holdings from live-mode Order Executor fills, closable (fully or partially) for real; a **Live Trade History** table of realized P&L from closed live positions; an **Inventory** table of positions handed over from stopped paper executors (see [Position Handover](#position-handover--inventory)); **The App's Own Paper Trades**, the watch's and the news rules' open paper trades, each with where it stands on the last closed minute and a **THESIS STATUS** (VALID, WEAKENING or BROKEN) that is a reading and never a control; a live position with a watcher shows the watcher's barriers and the same status (see [the thesis status](#the-ai-additions)). |
| | **Performance** | Total value, active-bot count, bot P&L and system cards; the portfolio's value over time (value/composition, 1D/1W/1M/3M) and its largest holdings; what the watch's recommendations earned, in percent and in R, over the last 10/50/100 trades and 7/30 days, with and without the [reviewer](#the-ai-additions), and whether they beat the [quant strategies](#does-ai-help-the-models-against-the-quant-strategies) on the same events; the app's own paper trades, the watch's and the news rules', as a running total in R; the journal of every recommendation with its outcome, exportable as CSV, where any line opens [its whole story](#one-trades-whole-story) on one timeline. |
| Trading | **Paper Trading** | The paper account paper strategies spend and hand back (fund it, balances, movements), and a manual paper order ticket — market/limit, live last price, session-only order history. Nothing here reaches an exchange. |
| | **Live Trading** | Real money: the session's gates as they stand (armed, kill switch, the day's notional and loss, the managed allocation, exits being watched), and what you hold on each connected exchange, with Binance futures positions closable for real. |
| | **Strategies** | **Active Runs**: a bot is a single continuous dry-run of a [chosen strategy](#strategies) against one exchange/symbol, optionally with a model asked to [confirm each entry](#ai-signals--paper-only); disabling one records a run, removing one archives it. **Execution**: the eight executor types, each running independently against live candles, the starter presets, and the New Executor form a call's filled-in form opens on — see [Executors](#executors) below. |
| Research | **Backtest & Research** | **Backtest** runs a chosen strategy over a historical range and shows full stats, equity curve vs. buy-and-hold, monthly breakdown and a trade log; its **Live** view monitors the same route continuously ([Live strategy monitor](#live-strategy-monitor)), **Charts** replays each trade against the candles, and **Compare Strategies** ranks every registered strategy over the same candles. An optional tick box has a model [confirm each entry](#ai-signals--paper-only). Both views export CSV, JSON and a PNG. **Automation** re-runs saved backtests on a schedule while the app is open, each run keeping a session-only report. |
| | **AI Benchmark** | Several models on the same questions, scored side by side: on candles, and on the events the scanner raised, with the no-model rows beside them — following, fading and holding every event, and the [quant strategies](#does-ai-help-the-models-against-the-quant-strategies) where they agree — and **Does AI help?**, the models against the quant strategies with three verdicts. Every run is kept as an experiment that can be reopened for nothing. |
| | **Discovery** | Two tabs. **Market scanner**: once a minute it reads the most traded USDT pairs on Binance and says what is moving, scores each the same way, and records the moves that qualify as events — see [Discovery](#discovery--a-market-scanner). Public market data only: no key, no model, no order. It is switched on, and its pairs chosen, under Settings › Market. **News & Market Events**: four free news feeds and Binance's announcements, each story with its coins, kind, impact and what the price did after, filtered by coin or by Major alerts, and what each kind of story has done once 30 are in — see [News & market events](#news--market-events); a count on Discovery in the sidebar says how many new alerts it holds. Below the stories, [Binance's own announcements](#binances-announcements-on-discovery) — delistings, Monitoring Tags, futures launches, listings — as they are released, with what each kind did to prices. The reader is switched on under Settings › Market too, with what a delisting or a tag does: a notice if you hold the coin, a paper short by the kind's rule, a question to the watch's models. |
| System | **Risk & Safety** | The live trading limits every real order is checked against (largest order, the day's notional, the day's loss, the managed allocation); the size of the paper trades the app opens by itself, the watch's and the news rules' (sized by what their stop would lose, and capped in what they stake together), the losing run in R that pauses them until resumed, the cap on what they stake on one side on coins that move with Bitcoin, and a daily notice of what they did; and the controller groups: executors under a shared stop-loss, take-profit and maximum drawdown with a P&L snapshot every 5 minutes, all stopped on a breach. Arming and the kill switch stay on the bar at the top of every page. |
| | **Connections** | Every key the app holds: Binance and Upbit ([Credentials](#credentials--api-keys)), and the OpenRouter key for the AI models. Each is tested before it is stored, stored encrypted, and never read back into the window. |
| | **Settings** | Since 6 October 2026, **Essentials** first: the six settings that decide what the app does by itself — trading mode (PAPER, LIVE READY with a verified key and the session disarmed, or LIVE ACTIVE when armed; read, never changed here), risk level (Conservative at the shipped paper defaults, or Custom, with a reset that only ever opens less), the market the scanner watches, the AI's mode (changed only on Opportunities, behind its priced confirmation), desktop notices with or without sound, and the exchange. Everything else is under **Advanced**, closed until opened: the Configuration Center, in sections, built only from settings that exist. **General**: appearance (Dark / Light / Colorblind-safe). **Market**: the scanner on or off, and how many pairs it watches; the reader of Binance's announcements, and what a delisting does. **AI**: which models may be asked, the default and the route, the daily budget, the pace, the [AI additions](#the-ai-additions) (each on or off, with its daily limit and what a day of it can cost), and what asking has cost. Keys stay on Connections and limits on Risk & Safety, each in the one place, linked from here. What the V3 document asked for that has no behaviour behind it (language, timezone, default order type, allowed pairs, other news sources…) is listed in `docs/INVENTORY.md` rather than added as a control. |

**The status bar** at the top of every page carries three chips beside the arm and kill controls,
each read from the thing it describes (`src/status/statusModes.ts`); hovering one says what it
means:
- **PAPER, LIVE ARMED or KILL SWITCH**, from the live session's own gates.
- **The Binance key**: none, stored, or its last test failed.
- **What the AI does by itself**: the watch off, **SHADOW** (it asks models about events and scores
  their calls, and opens nothing) or **PAPER TRADES**, with today's AI spend against its budget.

Those are the V3 document's modes as this app has them. Its "confirm" mode is how any call reaches
a real order: it fills in a form a person submits. Its fourth mode, a model placing real orders,
does not exist and is not shown.

### Live strategy monitor

**Backtest → Live** answers the question a historical backtest structurally cannot: *is anything
about to happen?* It re-runs the **same engine** over candles fetched up to the present minute,
every 60 seconds, on whichever exchange/symbol/interval/strategy is already set on Configuration —
no bot to create, nothing extra to configure.

It opens with all three shipped strategies on the current symbol at once, **each at its own
measured bar size** — Trend Regime at 4h, the two channel strategies at 15m — because forcing them
onto one interval would compare three strategies at a bar size two of them were never validated
on. The cost is two fetches rather than three: the candle cache keys on exchange/symbol/interval,
so the two 15m strategies share a series.

| Strategy | Bar | Position | Unrealized | Window P&L | Trades | Waiting on |
|---|---|---|---|---|---|---|
| Trend Regime Ensemble | 4h | Long | +22.42% | +20.27% | 1 | holding |
| Short-Term Channel Breakout | 15m | Flat | — | +0.00% | 0 | channel position 55%→95% |
| Short-Term Channel + Trend Regime | 15m | Flat | — | +0.00% | 0 | channel position 55%→95% |

That table is for **choosing** between them, not for running several: their monthly returns
correlate 0.70 to 0.97, so holding two is one bet at 1.7× size rather than diversification.

Below it, the selected strategy in full — the current position with unrealized P&L, the window's
closed trades, and the part that exists nowhere else in the app: **how far the market is from
making the strategy act.**

> Holding. Exits when trend agreement falls to 1 of 4 or below — it is 4 of 4 now.

Each governing quantity gets a gauge marked with both thresholds, so the gap between them — the
hysteresis band that is the whole reason these strategies are affordable to run — is visible
rather than described.

Four things it deliberately does:

- **Re-runs the whole engine** instead of stepping one bar forward. Stepping would be faster and
  would be a second implementation of execution — fees, stops, position tracking — free to
  disagree with the backtest that justified the strategy.
- **Reads every threshold from the strategy**, via the exported `regimeAgreement()`,
  `channelPositionSeries()`, `REGIME_VOTE` and `CHANNEL_BAND`. A panel with `0.95` typed into it
  beside a copy of the rule drifts the moment the rule changes.
- **Distinguishes what gates an entry from what gates an exit.** Short-Term Channel + Trend Regime
  needs both readings to *open* but exits on the channel alone, so the regime gauge is labelled
  "gates entries only". Without that, a falling regime beside a long position would imply an exit
  the rule will never produce.
- **Refuses to poll GPT Intraday.** It costs a paid API call per decision, so a screen
  re-requesting it every minute would spend real money for as long as the tab stayed open.

Polling stops when the tab is not on screen, and a failed poll keeps the last good reading with
the failure named rather than blanking what you are watching. It places no orders and holds no
money.

If the interval differs from the strategy's own `preferredInterval` the panel says so, because the
difference is real: on the same day, BTCUSDT Trend Regime read **long since 08-17, +21.92%** at its
measured 4h and **long since 08-25, −0.81%** at 1h.

### Executors

Each executor type is a pure, deterministic simulation function in `src/executors/engine.ts` (or
`spreadEngine.ts` for the two dual-market types) that replays historical candles through the
strategy's rules — nothing about "which levels filled" or "is a position open" is ever persisted;
it's recomputed from the executor's saved config + fresh candle history on every poll (every 60s
while active). This mirrors the backtest engine's own replay pattern and means an executor's
state can never drift from what the market actually did.

| Type | Behavior |
|---|---|
| **Grid** | Divides a price range into levels spaced by a %; a level fills when price touches it, and closes (booking P&L) when it reaches its own take-profit target, freeing it to refill. An optional **Stop Price** closes every filled level at that price and freezes the grid for good — it will not fill another level even if price re-enters the range. |
| **DCA** | A configurable ladder of buy/sell levels at % offsets from a base price; tracks a running volume-weighted average entry and exits the whole position on take-profit / stop-loss / a time limit. |
| **TWAP** | Slices a total order into equal pieces over a duration, executing one slice per interval at that candle's close; tracks cumulative VWAP and progress. |
| **Position** | The Triple Barrier Method: one entry (at a set price or at market), then exits on whichever comes first — take-profit, stop-loss, a trailing stop (with its own activation/trail %), or a time limit. A position that carries a slippage rate (`slippageRate`; the app's own paper trades do) fills its entry, a stop, a trailing stop and the time limit that much worse than their price; a take-profit is a resting limit and is paid exactly. Its levels stay where the market price put them, so what the entry gave up is lost whichever ends it. |
| **Order** | A single order with one of four fill strategies: `market`/`limit_chaser` fill immediately at the next candle's open (chasing the best price isn't modelable without a real order book, so it's approximated as an immediate market fill); `limit`/`limit_maker` fill the first time price touches the limit. |
| **XEMM** | Cross-exchange market making: monitors a *buying market* and a *selling market* simultaneously; when the spread crosses a minimum-profitability threshold in that direction, books a capture. Edge-triggered (re-arms only once the spread retreats) so a spread that stays wide doesn't produce unrealistic repeated captures. |
| **Arbitrage** | Like XEMM but bidirectional — captures the spread whichever way it's skewed, since arbitrage isn't tied to a fixed maker/taker leg. |
| **Market Making** | Classic two-sided quoting: places a bid/ask around the live price at a fixed spread, refreshed on an interval. Optional inventory-skew management biases the quoted mid price back toward a target inventory as fills drift holdings away from it. Fills are tracked with a running average-cost basis, so P&L splits correctly into realized (closed/reduced exposure) and unrealized. |

Five of these — **Order, Position, DCA, TWAP and Grid** — can also be created in live mode against
real money on Binance; the live behaviour differs from the simulation in ways worth reading before
you use it (see [Live Trading](#live-trading--real-money)). XEMM, Arbitrage and Market Making are
paper-only.

New executor types, forms, and card/detail-view rendering all follow the same three-file pattern
(`shared/ipc.ts` param type → `engine.ts`/`spreadEngine.ts` `simulateX()` function → a small
`*Form.tsx`), which is why they're straightforward to extend.

### Position Handover → Inventory

Mirrors Condor's Position Handover: when an executor with **"Keep position when stopped"** enabled
is stopped while it holds an open, unrealized position, that position is copied into
`settings.heldPositions` (shown on the Positions page's **Inventory** table) instead of being
silently discarded. A "Close" button there removes it (locking in P&L locally — still no real
order). Defaults to on for Position and Order executors, off for Grid/DCA/TWAP, and doesn't apply
to XEMM/Arbitrage (they never leave a lingering position by design).

### Market research when the app opens

Since 6 October 2026 (the second V3 document's §4 and §9) the app studies the market by itself as
it opens, and every ten minutes after, whatever else is switched on
(`electron/services/marketResearchService.ts`; the arithmetic is `shared/marketResearch.ts`):
- **The pairs:** the scanner's own choice of USDT pairs (no stablecoins, pegged tokens or stock
  tokens), the 50 most traded that each trade at least $20M a day.
- **A day and a week:** each pair's 24-hour move from the one all-pairs ticker request; its week
  from nine daily bars — the move from the close eight days back, the day's volume against the
  week's daily mean, how many of the seven days closed up, and how far it is from the week's high.
- **Trending:** CoinGecko's free list of the most searched coins, matched to Binance's USDT pairs,
  read every fifteen minutes. When it cannot be read, that is said, and the last list is kept.
- **The market's status:** Bitcoin and ether rising, falling or flat by the four-hour rule the event
  benchmark slices by (`btcRegimeOf`), from a day of 15-minute bars each; the other pairs' median
  day against Bitcoin's (STRONG, IN LINE or WEAK, 2 points either way); the share that rose; and
  a risk state — PANIC when Bitcoin falls 3% in an hour or 8% in a day, ELEVATED when it moves 1.5%
  in an hour or 4% in a day either way or fewer than one pair in five rose, NORMAL otherwise. These
  lines are engineering defaults, written down before any result was looked at.

It is shown at the top of Overview, with a "Researching…" line while it reads, and as Movers under
the chart on Markets. It reads public market data from the data host only, never the one that
trades, and CoinGecko's free list; it holds no key, asks no model and writes nothing.
`tests/aiNoLivePath.test.ts` holds it to that. Checked on 6 October 2026 against the live market:
it finished eleven seconds after launch with 36 pairs over the floor, both regimes flat, risk
normal, and 15 trending coins, 8 of them on Binance.

**Overview in five seconds** (since 8 October 2026; the document's §51). Under the market's status
and the best opportunity (with the next two on offer named under it), Overview now has three more
blocks, each a selection over what is on file (`src/overview/overviewBlocks.ts`): **Breaking
events**, the last hour's events at candidate or above, strongest first (a market-wide move before
the pairs in it, which say they are part of it rather than waiting for an answer), with what the
models said about each and the session's HIGH and CRITICAL alerts; **News impact**, the strongest stories of the
last six hours that name a coin, with the analyst's reading where it read them and what the price
did after; and **Today's performance**, the app's own paper trades opened, closed and open by the
UTC day, their net after fees and in R, the best and the worst, and, with a Binance key, what real
trading realized today. None of them asks or opens anything. The same day the sidebar's groups took
the document's order (AI Trader, Research, Trading, System), and a CRITICAL notice flashes the
window's taskbar entry until the window is focused (`electron/ipc/handlers/appHandlers.ts`).

### Live prices

Candles are context; the stream is the price now (the second V3 document's §7, §8, §25 and §42).
Since 6 October 2026 the main process holds one public socket to Binance's market-data host —
never the host that trades — and streams, for the pairs that matter at the moment, the best bid
and ask and the minute forming: the pairs a recommendation is shown on (Right Now, Overview) and
the pairs the app's own paper trades are open on. Bitcoin's and ether's minutes stream always, so
how far Bitcoin has moved since an event is known at any moment; the five best levels are read for
the first five pairs shown. Not every pair's book: a liquid pair's best bid and ask changes many
times a second — Bitcoin's more than a hundred — and only what is being looked at needs it. A minute
with no message is written down as a gap and a closed socket as a drop, for the session report
(`electron/services/liveMarketService.ts`; the arithmetic is `shared/liveMarket.ts`).

**The socket follows the data host** (since 7 October 2026). A healthy socket stays where it is,
whatever REST does; a socket that cannot connect three times in a row goes to the host that answers:
first the host REST has moved to, if it has, else binance.com's partner, the public mirror, probed
once with one small request. Never binance.us. In a 24-hour run on 7 October 2026 REST moved to the
mirror at 15:44 UTC while the socket, opened on binance.com at launch, kept dialling
`stream.binance.com` every fifteen seconds for the rest of the run: the name had stopped resolving to
Binance at all. A closed socket also follows a REST move at once, having nothing to lose by it. A
move is not a drop, and what is shown is asked for again as the new socket opens. The session report
says which host the stream is on, and how often it, and the data host, moved; neither is a gate.

**The connection is renewed before Binance's 24-hour cut, and holes are filled** (since 8 October
2026; the V4 document's §12). Binance closes every stream connection after 24 hours; left to that,
the cut is a drop. So after twenty-three and a half hours a second socket is opened to the same host,
and the first is closed only once the second is open: a planned renewal, counted apart from drops,
with nothing missed between. After a drop, and after a gap closes, the minutes the stream did not
deliver are read again over REST for every pair streamed. A frame that is not a stream's — the
answer to a request, or its refusal — is counted rather than dropped. The bar shows the socket's
state on every page: LIVE MARKET with the age of the last frame, QUIET after ten seconds without
one, MARKET DATA STALE after a minute (a gap), RECONNECTING while it is closed. The chart's own
sockets (the candles and the ticker of the pair shown) follow the data host by the same rule as the
live socket.

- **Each recommendation on offer is checked against it.** ENTERABLE when what a fill would pay —
  the ask for a buy, the bid for a sell — is inside the entry range, the spread is within 0.1% and
  the price is under ten seconds old; WAITING while the price is outside the range, since the entry
  waits for its range until it expires; INVALIDATED once the entry has expired, Bitcoin has moved
  against it by the watch's safeguard, the spread is wider than 0.1% or no fresh price is had.
- **An execution score** from 0 to 100 sits beside it: half for the spread (full at 0.02% or
  tighter, nothing at 0.1%), three tenths for what the side a fill would take holds against ten
  stakes, a fifth for the price's age; what held it down is said.
- **The watch's paper trades are refused on it.** Before one opens, the live book of its pair is
  read — the stream's while fresh, otherwise once over REST — and with no fresh price, or a spread
  over 0.1%, none is opened; nor, since 8 October 2026, when the best level on the side a fill would
  take (the ask for a buy, the bid for a sell) holds less than the stake, since a fill there would go
  through the book. The book it opened against is written on its mark. It only ever opens less. The
  news rules' shorts are their measured rules, and are not changed by it.
- **It fills from that book** (since 8 October 2026; the document's §41). Where the book's fill
  price — the ask for a buy, the bid for a sell — is inside the entry range the second the trade is
  made, the trade enters there and then, at that price plus its slippage, instead of waiting for the
  first minute bar inside the range: an answer at second 18 of a minute no longer loses the minute.
  The fill is written on the trade (`entryFill`), the engine runs its barriers from that minute (which
  can stop it and cannot pay its target, as the score's own rule for an entry inside a bar has it),
  and a trade in the market is no longer dropped for Bitcoin's move. The recommendation's SCORE stays
  on minute bars, unchanged and replayable, and the trade's timeline sets the two side by side:
  "Filled at 100.07 from the live book at 12:00:38 UTC; scored on minute bars: 100.12 at 12:03 UTC",
  or "expired unfilled". A price outside the range waits by the range, as before.
- **The models' question is not changed by it.** That question is built from completed candles
  only, so that a benchmark replaying an old event asks exactly what the watch asked live; a live
  bid and ask cannot be had for a replay. The plan had the question gain them; that was dropped for
  this reason, and the live price is used after the answer instead.

Checked on 6 October 2026 on a separate build and a scratch profile, against the live market, with
two faked watch answers on real prices: SOLUSDT's, with its entry around the price, read
"ENTERABLE at 120.62 · Execution 100/100"; XRPUSDT's, five percent above it, "WAITING … the ask
1.504 is under the range"; Overview's top card said the same of SOLUSDT; the stream held both books
and their five best levels, fifteen milliseconds old.

### News & market events

Since 6 October 2026 (the second V3 document's §11–14 and §28–30) the main process reads four free
news feeds every three minutes: CoinDesk, The Block, Cointelegraph and Decrypt, by RSS, with no key
and no new dependency. Binance's own announcements join them where [the
reader](#binances-announcements-on-discovery) is on (`electron/services/newsFeedService.ts`; the
arithmetic is `shared/newsFeed.ts`). Each item is kept once, in `news/feed-YYYY-MM.jsonl`, and a week
of them is shown. CoinGecko's news needs a paid plan and CryptoPanic a key, so neither is read.

**What each story is given, by fixed rules, never by a model:**
- **Its coins.** Binance's USDT pairs' base assets, and the names of 53 of the largest coins
  ("Solana", "Optimism"). A ticker counts only in capitals as a whole word, or as `$TICKER`; a
  ticker that is also a word (OP, ONE, GAS…) counts only by its name or with the `$`. Named in the
  title, a coin is DIRECT; only in the summary, INDIRECT.
- **Its kind:** hack, delisting, listing, ETF, regulation, token unlock, macro, upgrade, partnership
  or other, the first of those patterns its title and summary meet. Binance's announcements keep the
  kind the study sorted them by.
- **Its source's credibility:** Binance 1.0, CoinDesk and The Block 0.85, Cointelegraph and Decrypt
  0.8.
- **An impact from 0 to 100:** the kind's weight (hack 90, delisting 85, listing 75, ETF 70,
  regulation 60, unlock and macro 55, upgrade 45, partnership 40, other 20), times how directly it
  concerns a coin (named 1, mentioned 0.6, market-wide 0.8, neither 0.4), times the credibility,
  times its freshness (full for an hour, down to four tenths at a day).
- **Old news:** published more than a day before it was first read, it is marked so and raises
  nothing.
- **One story, several sources:** titles from different feeds within six hours that share at least
  60% of their words are one story, listed with "and N more".

**What the price did.** Five minutes after a story names a coin traded on Binance, the coin's
1-minute candles are read, and read again at each pass for up to twelve hours:
- the move at 5 minutes, 15 minutes, 1 hour and 4 hours, from the close of the minute it was
  published in;
- CONFIRMED when the price moved 1% its way within 15 minutes, AGAINST when 1% the other way, NONE
  otherwise. A kind with no way of its own (regulation, macro, unlock, other) is CONFIRMED by 1.5%
  either way on twice the volume;
- "priced in" when it had already moved 1% its way in the 15 minutes before.

Once its four hours are in, a reaction is final and kept in `news/reactions-YYYY-MM.jsonl`. **What
each kind did** (the median move and the share that rose, at each horizon) is shown only from 30
final stories of a kind. Below that it says "Insufficient historical evidence".

**"Why did it move?"** A Why? button beside a pair reads its last four hours of minutes and
Bitcoin's, and answers by fixed rules (`shared/moveExplanation.ts`). The button is on Discovery's
events and news, on Right Now, and on Markets for the chart's pair.
- **KNOWN:** Binance announced something about the coin within the hour, or the two before it.
- **PROBABLE:** a story names it in that time, and nothing in the story points the other way.
- **POSSIBLE:** a story only mentions it, or points the other way; Bitcoin made half or more of
  the move, the same way; or the volume was twice its usual with no story found.
- **UNKNOWN:** none of those, or a move under 0.5% either way, which is not a move to explain.

It never invents a cause. A cause named is a story found or a figure measured, and with none it
says "No cause found".

**Alerts** (`shared/alerts.ts`) are raised for each story first read in this session and published
within the last half hour:
- **CRITICAL:** a hack or a delisting of a coin you hold, named in the title. "Held" means on the
  paper account, in a paper strategy, in the Inventory, or, with a key, on Binance. Bitcoin down 5%
  within an hour on the live stream is CRITICAL too, told once and not again until it has come back
  above −2.5%.
- **HIGH:** impact 70 or more, or a story the price has confirmed.
- **WATCH:** impact 45 or more.
- **INFO:** the rest, and old news.

What each raises:
- **INFO** stays on its page.
- **WATCH** raises a silent desktop notice, but not for news already told. Outlets tell the same
  news in their own words, and stories are merged only when their titles are close. In a twelve-hour
  run on 6 October 2026, one Zcash ETF filing raised three notices over four hours, from The Block,
  Decrypt and Cointelegraph. A WATCH notice is held back when a story told in the last six hours named
  a coin it names and has a title at least 0.15 alike. Other news about the same coin is still told.
  - **Why 0.15:** on the four feeds of 7 October 2026, 15 pairs of stories naming a coin in common
    came to that or more. 13 were one piece of news told again, and 2 were Bitcoin falling under
    $84,000 twice, six hours apart, which the rule takes for one fall.
  - **Below it:** the most alike pair of different news came to 0.125.
  - **Over those two days:** the rule held back the second and third Zcash tellings and a second
    telling of a court ruling, and told 12 notices. One notice per coin per six hours, the rule
    before it, told 9, and held back three different Bitcoin stories.
  - Every story is still kept on its page.
- **HIGH and CRITICAL** raise one with sound, where sound is on under Settings' Essentials, every
  time.
- **CRITICAL** also stays as a red banner above every page until it is dismissed.
- **WATCH and above** put a count on Discovery in the sidebar, and Discovery opens on the news until
  it is seen.

For a coin held, Binance's announcements keep the notice the reader already raises, so none is raised
twice. The plan had the kill switch engaged as CRITICAL too. Only a person engages it, from the bar
where it already shows, so it raises none.

**Every kind the V4 document names, in threads** (since 8 October 2026; §47-49). Every notice the app
raises -- from the window, or from the main process's own loops -- goes through one service
(`electron/services/noticeService.ts`) and carries a kind (`shared/alerts.ts`): MARKET_EVENT (an
urgent event the watch could not ask about: off, no model, every model rested, the day's events
spent; Bitcoin's crash), NEWS_EVENT, TRADE_OPPORTUNITY (a call), TRADE_EXECUTED (a paper trade opened
or run out, the exit check closing one, a news short, the daily digest), TRADE_BLOCKED (a paper trade
not opened for a reason a person can act on -- the paper account, the money-out cap, a pause -- or
dropped before entry), POSITION_RISK (a paper or real position three quarters of the way to its
stop), TARGET_REACHED and STOP_TRIGGERED (a paper trade's or a real position's close, in money and
R), MODEL_DISAGREEMENT (models on opposite sides of one event), SYSTEM_FAILURE (the scanner failing
three passes running, the stream dead for three minutes, every feed unread for half an hour, the
OpenRouter key rejected) and CIRCUIT_BREAKER (the day's AI budget spent, a model rested for the day,
the losing-run pause, the live session disarmed by the day's loss, live entries paused or resumed by
the exchange's health). A kind with a thread -- a pair, an event, a trade, or a fixed name -- is told
once per thread per half hour (a day for the budget and a rested model, an hour for a failure): a
repeat inside the window is counted on the thread and raises nothing. A notice that names no severity
is as loud as its kind: WATCH silent, HIGH with sound. What is told is written to the alerts file
(`shared/records.ts`) and sent to the window whatever the desktop could show, so Overview's major
alerts hold it; only news lights Discovery's badge. The texts are `shared/notices.ts`.

**News against a paper trade** (since 8 October 2026; the document's §25, "news contradicted"). A
story of impact 70 or more naming the coin, published from three hours before the event to now,
that points against the side — the news analyst's reading where it read the story about this coin,
else its kind's way — refuses the watch's paper trade before the reviewer is asked, and names the
story (`shared/paperNewsBlock.ts`). A story pointing the trade's own way changes nothing, and so
does one with no way of its own; stories that cannot be read refuse nothing. The news rules' shorts
are not changed.

**Discovery's News & Market Events tab** lists the stories, newest first:
- **Filters:** All, Bitcoin, Ethereum, Altcoins, Market-wide and Major alerts (HIGH and above).
- **Each story shows** its coins, kind, impact, sources and what the price did after.
- **Open** goes to the browser through the main process, which opens only an https link on one of
  the feeds' own hosts.

It reads and tells. It places, sells, opens and asks nothing, and `tests/aiNoLivePath.test.ts`
holds its files to that: they import nothing that trades or asks a model.

Checked on 6 October 2026 on a separate build and a scratch profile, against the live feeds:
- **The feeds:** all four were read (111 stories, 54 naming a coin), and the first price reactions
  were in within seconds.
- **A faked hack of SOL,** with 3 SOL on the paper account, raised one CRITICAL notice, a "1 new"
  count on Discovery, and the banner "CRITICAL: SOL · Hack or exploit … You hold it: 3 SOL in the
  paper account". Discovery then opened on the news and the count cleared; Dismiss took the banner
  away.
- **Why? on ETH** at a quiet moment read UNKNOWN: "not a move to explain".

### A market-wide move is one question

Since 8 October 2026 (the second V3 document's §17 and §43–44, chosen by the user on 7 October) one
pass of the scanner raises ONE event for a move the whole market makes, instead of putting three of
its pairs to the models. The rule (`shared/marketEvent.ts`, `marketMoveOf`, detector version
`events-v2`): five or more events raised in the pass with a direction, four in five of them the same
way, while Bitcoin's own fifteen-minute move is 1% or more that way. The event is raised on BTCUSDT,
the market's own pair, from Bitcoin's own reading, named `market_move`, pointing the way most of the
market moved, with the strongest band among the pairs that moved its way, ranked first; Bitcoin's own
event, where the pass raised one, becomes the move. The pairs that moved its way are still raised and
recorded, marked as part of it, and the watch skips them: "It is part of a market-wide move, which
the watch asks about as one event." One move per half hour, like any event of Bitcoin's; the pairs
that moved the other way are raised as they always were.

**The question** (`market-move-v1`) is Bitcoin's pair, read as an event's is, with the members as
breadth: each one's symbol, direction, score, fifteen-minute return and volume ratio. The main
process looks the move up in its own record of the events it raised, and puts the question only for
a move of that id on BTCUSDT at the minute the candles end at; the members come from the record,
never from the request. Any trade in the answer is in BTCUSDT: the members are evidence, not pairs
to trade, since a question carrying every member's candles would be many times the size, and the
answer's levels could not be placed against a price the model was not shown. The answer is scored
on Bitcoin's minutes and paper traded like any call, and its answers are compared on their own
events. In the study week such minutes took 7 of the watch's 67 questions, so it replaces calls
rather than adding them. The history scan ("Find events") is still one pair at a time, and finds no
market-wide move in history.

### The opportunity table, and the market's regime

Since 6 October 2026 (the second V3 document's §20, §24 and §42–44) what is on offer is ranked by
two scores, the market has a regime in a word, and the app's own paper trades have one more cap.

**The market's regime** leads Overview's status strip: one of six words, from Bitcoin's moves alone,
so that the same rule reads any minute from its candles (`shared/marketResearch.ts`). The first that
applies, in this order:
- **PANIC:** past the panic lines, −3% in an hour or −8% in a day.
- **HIGH-VOL:** the last hour past 1.5%, either way.
- **RECOVERY:** up 1% or more over four hours, after a day down 4% or more.
- **BULL and BEAR:** four hours past 1% one way, and the day not the other way.
- **SIDEWAYS:** the rest.

These are lines already drawn for the risk state and the benchmark, not new ones.

**The regime is not put to the models.** The plan had it added to the question the watch asks, but
that would make a new question:
- The question with Bitcoin's and ether's moves in it, which the regime is worked out from, was
  measured against the pair-alone question on 5 October, and did worse.
- By the rule written down before that run, the watch's question changes only when a new one beats
  it on the same events.
- A label made from the same numbers is a new question too, and would have to be measured the same
  way, at a price.

So it is shown and ranked by, and the watch asks what it asked.

**Two scores for each opportunity.** The **signal** (`shared/opportunityScore.ts`) is 0 to 100, by
fixed weights:

| Part | Weight | What it reads |
|---|---|---|
| Event | 25% | The scanner's score for the event |
| Volume | 10% | The event's volume reading |
| Break | 10% | How far past the four hours before the move it closed |
| Liquidity | 10% | How much the pair trades a day, $1M to $100M on a log scale |
| News | 15% | The strongest story naming the coin in the three hours before the event or since: its impact, in full when its kind points the side's way, half with no way of its own, nothing against |
| Regime | 15% | How well the regime suits the side: BULL 100 for a buy and 0 for a sell, BEAR the other way round, SIDEWAYS 50, HIGH-VOL 25 |
| Models | 15% | Of the models that answered, the share that would take the side at 65% or more |

Penalties come off the signal:
- **Wild bars:** up to 10, for bars far wider than usual.
- **Old news:** 10, when only stale stories name the coin, or the strongest was already priced in.
- **Models split:** 15, when the models take opposite sides.

The **execution** score is the live price's ([Live prices](#live-prices)).

A model counts only as a side it would take. Its confidence, its own reading of the market and its
reasons are shown beside the score, not in it. The weights were written down before any result was
looked at. The score ranks; it is not a probability, and nothing is opened or refused by it.

**The table** is Opportunities' "Right now". It lists each entry on offer and the last hour's other
events, strongest signal first. Its columns:
- the pair, with Why?;
- the live price;
- its 24 hours and 7 days, from the research;
- the event, and the strongest story about the coin;
- how many of the models would take the side;
- the action: BUY or SELL with ENTERABLE, WAITING or INVALIDATED, or where the event stands;
- the signal, the execution, and when the entry runs out.

A row opens what is behind it:
- the score, part by part, and the live check;
- the plan, and what ends it: the entry unfilled by its expiry, Bitcoin moving against it by the
  watch's safeguard, a spread over 0.1%, or no price fresher than ten seconds;
- what it would risk, sized as the app sizes its own paper trades, and what the app has out on that
  side;
- the news on the coin, and each model's answer with its reasoning.

Paper trade fills in a form, as before. Overview's top card leads with the same entry, and shows its
signal.

**One more cap on the app's own paper trades** (`shared/paperExposure.ts`). On pairs whose hourly
moves over seven days correlate with Bitcoin's at 0.7 or more, the watch's and the news rules' open
paper trades on one side stake at most 15% together. That is 15% of what the paper account was
funded with, or, with no account, of the money-out cap: 150 USDT at the default 1,000.
- **Unknown counts as tracking.** A pair whose correlation could not be read counts as one that
  tracks Bitcoin, and so does a trade opened before 6 October 2026, which carries none.
- **It is written down.** Each new trade has its correlation written on it.
- **It only ever opens less.** The watch's own limit on how many it keeps open in one direction
  stays as it was.

Checked on 6 October 2026 on a separate build and a scratch profile, against the live market and
feeds, with four faked events and answers on real prices:
- **The regime** read SIDEWAYS: Bitcoin −0.35% over four hours and −0.88% over the day.
- **The table** held XRPUSDT's entry (WAITING, signal 69) and SOLUSDT's (ENTERABLE, signal 65, with
  a CoinDesk story on Solana in it). Under them were DOGEUSDT (no trade, 52) and ADAUSDT (not
  asked, 51).
- **SOLUSDT's row** opened its score part by part, the plan and what ends it, a stake of 58.99 USDT
  losing about 1.00 at its stop, 0 of the 150 USDT out on that side, the story, and both answers.
- **Overview** led with XRPUSDT, and its signal.
- **The correlations with Bitcoin** read that day, over seven days of hours: SOL 0.87, DOGE 0.78,
  XRP 0.77, and PAX Gold 0.45.

### Does AI help? The models against the quant strategies

Since 6 October 2026 (the second V3 document's §21, §33 and §61, its central question), the event
benchmark on AI Benchmark and the live leaderboard on Performance set the models against the app's
two quant strategies, on the same events. It is worked out from answers already held, and nothing
more is asked of a model.

**The strategies' state at each event** is read from their own exports, as the live strategy
monitor reads it (`src/agents/quantState.ts`):
- **Trend Regime, on 4-hour bars:** on the long side where all four of its averages agree, and on
  the short side where one or none does.
- **Short-Term Channel, on 15-minute bars:** long at the top of its channels (95%), short at the
  bottom (25%).
- **Only what had closed:** only bars closed before the event are read, and none before the
  strategy's own warm-up has passed.
- **Each pair's bars are read once:** one request of 4-hour bars and a few of 15-minute bars.

**New rows** sit beside "follow" and "fade":
- **Quant:** the follow rule's trade, only where the strategy is on the move's side.
- **Hybrid:** each model's own trades, only where the strategy is on its side.
- **Buy and hold an hour:** every event's pair, bought at the follow rule's entry and held an hour,
  whatever the move did.

Every row now carries R a trade, and a trade's Sharpe and Sortino.

**Does AI help?** is a card on both pages. For one model it sets Quant, Buy and hold, AI and Hybrid
side by side. Each row has its closed trades, won, gains ÷ losses, net and R a trade, deepest fall,
Sharpe and Sortino. Three verdicts follow (`shared/aiHelp.ts`):
- **Did the model improve each strategy?** The hybrid, against the quant rule it is built on.
- **Did news help?** The model's trades on events where a fresh story named the coin in the three
  hours before and pointed the trade's way, against its trades on events no story named. The
  stories are the feed's files (`feed:history`), kept since the app began reading the feeds on
  6 October 2026. An event from before them is left out.
- **Did the live price help?** The model's trades on events whose spread, as the scanner saw it,
  was within the 0.1% the live check enters at, against those on a wider spread, which the check
  refuses.

Each verdict compares net return a trade. It says:
- **yes** only when the difference is larger than the 95% margin around it;
- **no** when it is smaller, or inside the noise;
- **not enough trades** until each side has 30 closed trades.

The lines were written down before any result was looked at.

**The strategies on their own:** beside the verdicts, each strategy is run through the backtest
engine over the same pairs and window, warmed up first, next to holding the pairs.

Checked on 6 October 2026 on a separate build and a scratch profile, with twelve faked watch
answers on real past events (2–4 October; SOL, XRP, ETH, DOGE):
- **Score them** read each event's minutes, both strategies' bars for the four pairs, and the 112
  stories on file.
- **The card** showed the six rows, and every verdict at "not enough trades": 8 trades a side with
  Trend Regime, 1 with the channel, 0 against 12 for news, and 9 against 3 for the live price.
- **On their own over the 30 days**, Trend Regime 4h made +7.15% on the four pairs (4 trades)
  against +8.01% for holding them. Short-Term Channel 15m made −0.84% (8 trades) against +7.62%.

### The model registry

Since 8 October 2026 (the second V3 document's §16 and §35) Settings › AI has a **Model registry**
card (`shared/modelRegistry.ts`): each model the app may ask, in one place. From the saved catalogue,
its context, its prices per million tokens and whether it can be held to a schema; from the ledger's
last thirty days, its calls, how many came back and how many the validator refused, its latency at
the median and the 95th percentile, what it cost, when it was last asked, and the dated versions
OpenRouter said answered; and, on a click that reads public candles, its row of the live leaderboard
with its results by event type and by Bitcoin's regime. The leaderboard's lines hold: a figure under
thirty closed trades, or ten in a slice, is not printed. Nothing is stored and nothing is promoted;
the document's promotion rule is not built, since no model has shown an edge to promote and a rule
would be fitted to noise. The watch's models are still chosen on Opportunities.

### The AI additions

Since 6 October 2026 (the V3 plan's Stage 7) small questions are put to a model beside the watch's.
The user chose "On, within the $5 day".
- **Switches and limits:** each addition is on unless switched off under Settings › AI, and each
  has a daily limit of its own, so that none can starve the watch.
- **The same gates as every other call:** the daily budget immediately before it, the pace, the
  validator after it, a ledger row either way, and the cache, so that nothing is paid for twice
  (`shared/aiAdditions.ts`, `electron/services/aiAdditionsService.ts`).
- **The model:** they ask the one the watch's paper trades follow.
- **Asking by itself:** an addition does so only while the watch is on.
- **Nothing placed:** none of them places, sizes or arms anything. The exit check can close one of
  the app's own paper trades sooner than its plan would, never a live one.

**The news analyst** makes at most 40 calls a day. It reads each story of high impact the feed
reads (70 or more, or one the price confirmed), once, within the hour it was published. It returns:
- the coin the story concerns most, and whether that coin is its subject or only touched by it;
- which way it points, its impact from 0 to 100, and over what horizon;
- how confident it is, whether the story was already in the price, and why.

What a reading does:
- **Shown:** it appears under its story on Discovery's news.
- **Scored:** the signal score's news part takes the analyst's direction for a story it read about
  the coin, in place of the fixed rule's guess from the story's kind. The impact and the weight
  stay the fixed rules'.
- **Refused answers:** an answer the validator refuses is kept, as every refused answer is, and is
  used nowhere.

**The conclusion to "Why did it move?"** makes at most 20 calls a day. It is asked in two ways:
- **On a click** in the Why window, "Ask for a conclusion", at the price shown. A click is consent,
  so it is asked with the watch off too.
- **By itself**, while the watch is on, for the coin a story of high impact names, after the
  analyst has read the story.

How it works:
- **The evidence is rebuilt in the main process,** never handed in. It reads the pair's last four
  hours of minutes and Bitcoin's from the market-data host, and the stories the feed holds, and
  works out the fixed rules' explanation (`shared/moveExplanation.ts`).
- **It is asked only with something to weigh:** a move of half a percent or more, and at least one
  item of evidence (a story that names the coin, Bitcoin's share of the move, or a volume surge),
  each with an id.
- **It must cite what it rests on:** at least one item, each exactly as listed. A conclusion that
  cites nothing, or anything not listed, is dropped.
- **Shown:** the conclusion appears under the rules' explanation, with what it cites. The newest
  one on file for the pair, if it is less than an hour old, shows when the window opens.

**The exit check** makes at most 30 calls a day. Every two minutes it looks again at the app's own
open paper trades, the watch's and the news rules' shorts. It asks only when something about one has
changed:
- **Near its target or its stop:** the price has come three quarters of the way from the entry to
  either.
- **News on the coin:** a story of impact 70 or more has named it since the trade was opened.
- **The market's regime changed:** Bitcoin's regime when the trade entered differs from now, by the
  rule the market status uses.
- **A sharp move against it:** 2% against the trade over the pair's last fifteen minutes.

It asks once a trade for each reason, whatever came of it.
- **What it reads, and where:** the trade itself (its side, levels, time limit and what opened it)
  is read in the main process from the executors on file. Only the app's own paper positions still
  open are looked at. Where it entered and what the market has done since are measured in the
  renderer, where the engine runs.
- **What it is shown:** the trade, what it was opened on (the call's reasoning, or the
  announcement), where it stands, the news since, and why it is asked.
- **Its answer:** KEEP, REDUCE or EXIT, with a reason.

What an answer does:
- **EXIT closes the paper trade at the next minute.** Its time limit is brought forward, so the
  engine ends it at that minute's close by its own rule. It is then stopped and settled like any
  other, and its card says "Closed by the exit check". Nothing else changes: the stop and the target
  stay where they were, and a time limit is never made longer.
- **KEEP and REDUCE change nothing.** REDUCE is recorded only.
- **Measured against the plan:** once the plan's own time limit has passed, the plan is simulated on
  the same minutes and its result is written beside the exit's. Performance's "Does the exit check
  help?" adds them up: better or worse than the plan, in R where the trade had a stop, and in money.

**The thesis status** is shown on Positions beside each of the app's own open paper trades, and
beside a real position that has a watcher: VALID, WEAKENING or BROKEN, by lines already in force
elsewhere and said once (`shared/thesisStatus.ts`). WEAKENING when one of these holds: three quarters
of the way from the entry to the stop; a story of impact 70 or more naming the coin and pointing
against the side; Bitcoin's regime turned against the side since the entry; 2% against the trade
over the pair's last fifteen minutes. BROKEN when the stop is hit, or two of them hold. It is
measured once a minute while the page is open, on the last closed minute, as the exit check measures
its trades (`src/agents/openTradeReading.ts`), and it is a reading: nothing acts on it. The exit
check asks by its own triggers, a paper stop is a stop, and a watcher closes a real position by its
own barriers.

**The reviewer** makes at most 20 calls a day. It takes a second look before one of the watch's
paper trades, and only when something about the trade stands out. It is asked in the main process,
which works out why itself:
- **The models disagree:** another model's call on the same event, on file when the trade would
  open, takes the other side.
- **The move is unusually large:** 5% in fifteen minutes, or eight of the pair's usual moves.
- **Major news hit the coin:** a story of impact 70 or more named it in the three hours before, or
  an announcement raised the event.
- **The pair is thin:** under $5M a day, or quoted wider than 0.05%.

With none of these, nothing is asked. Nor is it asked about a trade the live market would refuse:
the book is looked at first, and a spread over 0.1% or no fresh price ends it there. The book is
read again after the review, which can take seconds. The reviewer is shown the event, the call (its side,
confidence, entry, stop, target and reasoning), the other calls on file, the major news and the
reasons it was asked. It answers APPROVE or REJECT, with a reason.
- **REJECT means no paper trade.** The watch says why: "The reviewer rejected it (the move is
  unusually large): …".
- **Anything else leaves the trade as it was:** a review not asked, refused or that could not be
  had. So the reviewer only ever opens less.
- **Performance's leaderboard** shows the watch with and without it. Beside each model whose call
  it rejected at least once is a row of the same answers with those calls taken as no trade,
  compared on the same events.
- **Not yet measured:** the watch opens a paper trade as soon as its model answers, so only the
  answers already on file can disagree with it.

**On Settings › AI**, a card lists each addition:
- its switch, and what it asks and when;
- what it has asked today, against its limit;
- what a day of it can cost at that limit: from its own calls once it has made some, else from the
  price list.

Checked on 6 October 2026 on a separate build and a scratch profile, with the network faked in its
main process. A fake key and the watch were switched on in that profile only.
- **The analyst asked once:** one feed returned a fresh story, "Hackers drain $50 million from a
  Solana bridge" (impact 77). The analyst asked about it within fifteen seconds, the faked answer
  cost $0.0009, and its row was written to the ledger.
- **Discovery's news** showed under the story: "AI reading: SOL (the subject), down, impact 85 over
  4h, 75%".
- **Settings › AI** read "1 of 40, about $0.036 at its limit", and its switch turned it off.
- **Cleared afterwards:** the key, the watch and the profile were removed.

The conclusion was checked the same way, with a fake key and the watch off. One feed returned a
story naming Solana, and SOLUSDT's minutes were faked to rise 2.5% in the last hour on three times
its usual volume.
- **The Why window** on the story read PROBABLE, with the volume and the story as evidence.
- **"Ask for a conclusion"** made one call, at a faked $0.0008. It answered "The developer story
  arrived as volume tripled, and Bitcoin did not move: the rise is the coin's own", citing both
  items.
- **The ledger row** kept both citations.

The reviewer was checked through the real bridge, with a fake key and the watch on in a scratch
profile.
- **A large move:** a call to buy a 6% fifteen-minute move was asked about for that reason alone.
  The faked answer, at $0.0007, was REJECT: "A 6% move in fifteen minutes is already extended;
  buying the top of it risks the stop at once."
- **A quiet one:** a 1.2% move on the same pair asked nothing.
- **A malformed request** was refused.
- **Settings › AI** read "1 of 20" for the reviewer, about $0.014 a day at its limit.

The exit check was checked through the real bridge, with a fake key and the watch on in a scratch
profile. One pair's minutes were faked: a paper buy of the watch's entered at 100, then the price
slid to 98.4 over fifteen minutes, past three quarters of the way to its 2% stop.
- **Asked at the next look,** about two minutes after the trade was written, for two reasons: it
  was near its stop, and the market's regime, read from Bitcoin's real minutes, had gone from
  sideways to bull since it entered.
- **The faked answer, at $0.0006, was EXIT:** "It has given back most of the way to its stop in
  fifteen minutes; the breakout it was bought on has failed."
- **The trade's time limit** went from 7,200 to 1,980 seconds, which ends it in the next minute. Its
  stop and target stayed at 2% and 4%, and a notice said it was closing.
- **The settle loop** stopped it a minute later: "Closed by the exit check: −1.798 USDT after fees,
  −0.82 R".
- **Refused requests:** asking again about it once it was stopped was refused, and so was a
  malformed request. Neither wrote a row.
- **Performance** read: "It has closed 1 of the app's paper trades early. 1 is still waiting for
  its plan's time to pass."
- **Settings › AI** read "1 of 30" for the exit check, about $0.018 a day at its limit.

### The session report

Since 6 October 2026 (the V3 plan's Stage 8) Performance has a **Session report** card
(`shared/shadowReport.ts`). It covers the last hour, the last twelve hours, the last day (since
7 October 2026, for the document's 24-hour run), or the time since **Start a session**. It reports what the app did and whether it held to the gates the V3 document
sets for its 1-hour and 12-hour test runs. It reads what is on file and asks nothing. **Save as
JSON** and **Save as CSV** write it to a file you name.

What it reports:
- **Events:** how many were raised, how many of them urgent, and how many the watch put to its
  models.
- **AI calls:** made, answered, valid and failed; latency at the median and the 95th percentile;
  and what they cost.
- **The watch's answers:** BUY and SELL it would act on; HOLD; and NO TRADE, a side it would not
  act on.
- **Paper trades:**
  - opened, ended and open now, and those refused, by reason;
  - the net in money and in R, and the fees;
  - how far each went for and against it while held;
  - how long from the event to the trade.

  Profit is reported, not gated.
- **Alerts** by severity, and the stream's connects, drops and gaps.
- **The versions it ran under** (since 8 October 2026; the V4 document's §61): the configuration
  and engine versions (Settings › Advanced › Effective configuration, `shared/appConfig.ts`), the
  detector, and the prompt and schema versions of the span's calls.

Since 8 October 2026 the alerts told and the paper trades refused are on file (`shared/records.ts`,
one JSON line each in a file per UTC month), so the report reaches back for them as far as the span
does; only the stream's log reaches back to the app's start. A trade's timeline reads the same file
for the reason a call got no paper position, and the trade's mark names the ledger row of the call
it follows, so the two are joined by id and not by guessing.

The gates:
- **Must be zero:**
  - **Stale prices:** an entry on a price older than 10 seconds, or with none recorded.
  - **Invalid answers:** a trade that followed an answer the validator refused.
  - **Duplicates:** two trades for one event.
  - **Stream gaps:** a gap left open past two minutes, or a trade opened on the stream's price
    inside one.
  - **Limits:** a trade past a limit as set now: one a pair, so many open, so many on a side, and
    the money out.
  - **Bad prices:** a price that is not one, or a spread over 0.1%.
  - **Malformed decisions:** no entry range, stop, target, time limit or stake, or an answer the
    app would not act on.
- **Rates:** more than 98% of calls answered, and more than 99% of answers valid.
- **Twelve hours or more adds five more:**
  - every recommendation whose life is over has an outcome;
  - every trade traces to its event and its answer, or to its announcement;
  - fees are charged;
  - slippage is charged;
  - every story has its https link.

Two things to know:
- **Slippage is charged on the app's own paper trades**, since 6 October 2026. Each one carries the
  rate its recommendation is scored at (`shared/aiOpportunityOutcome.ts`):
  - **The watch's:** 2 bp a side on a pair trading $50M a day or more, 2.5 times that down to $5M,
    five times below; or half the spread the scanner saw, when that is more.
  - **The news rules' shorts:** the rate the coin's last twelve hours of trading put it at, or the
    middle rate when those could not be read.

  The paper engine charges it on the entry, a stop, a trailing stop and the time limit, and not on a
  target, which is a resting limit. The stop and the target stay where the market price put them, so
  what the entry gave up is lost whichever of them ends the trade, as it is in the score. Sizing by
  risk, and R, count it on both fills. A trade opened before then carries no rate, filled at its
  prices, and the slippage gate names it. A position a person makes carries none either.
- **Kept only while the app runs:** the stream's log, the alerts and the refused trades. The report
  says when the app started, and reaches back no further for those.

**The runs themselves** are made by `scripts/shadow-run.mjs` (since 7 October 2026; before that the
script lived outside the repo): hours of the real market, feeds and stream on a scratch profile and
a separate build (`npx electron-vite build --outDir dist/<name>`, never `out/`), with OpenRouter faked
in the main process before the first window opens, so that nothing is spent and the only key ever
stored is a made-up one the fake answers. It writes a status line every ten minutes, the last hour's
report every hour (what the app keeps only in memory, on file), and at the end the hour, twelve-hour,
day and session reports as JSON and CSV; then the watch goes off, the fake key is removed and the app
closes. A run killed by a restart is resumed with `RESUME=1`, which keeps the profile and the output
and runs the minutes left; `scripts/shadow-analyze.py` prints every segment, the hourly and final
reports with their gates, and the records on file. The profile has to be inside the run's own root
and is never the real one; the script refuses to run the `out/` build.

Checked on a separate build and a scratch profile. It was seeded with an hour of records: one
event, a watch answer and a failed call, a news analyst's call, and a paper trade of the watch's
that reached its target. SOLUSDT's minutes were faked to match.
- **"Last hour"** read the trade as +2.797 USDT after 0.203 in fees (+1.65 R). Its best move was
  +3.4% and its worst −0.1%, and it opened 25 seconds after the event.
- **"AI calls answered" failed:** 2 of 3 calls got an answer back (66.7%). Every other gate that
  applies passed, and the twelve-hour gates read "not applied".
- **Saving:** Save as JSON and Save as CSV wrote both files.
- **Sessions:** Start a session made "This session" report from then.

### Discovery — a market scanner

**Discovery** answers "is anything happening?" for many pairs at once, by arithmetic, so that the
slower and dearer question — "is it a trade?" — is only ever asked about a pair that has already
been singled out. Switched on, the main process reads each of the 20, 40, 60 or 100 most traded
USDT pairs on Binance once a minute, a few seconds after the minute closes, from that pair's last
twelve hours of completed 1-minute candles (`shared/marketEvent.ts`,
`electron/services/marketScannerService.ts`). Stablecoins and pegged tokens are left out, and so
are the tokens that track a US stock or fund (NVDAB, SPYB, CRCLB and the rest, 87 of them in
October 2026). Binance keeps those in a trading group of their own, and that group is how they are
told apart (`electron/services/exchanges/binance.ts`): their names all end in "B", but so do BNB's
and SHIB's. A stock token moves with its stock. When the US market opens it catches up on the night
in a few minutes, on many times its usual volume, and the scanner read that as an urgent breakout.
In a twelve-hour run on 6 October 2026 the first five events were three stock tokens, between 13:32
and 13:38 UTC, and three of the watch's first four questions went to them. Over the week before,
the detector run on the same 60 pairs found those three tokens making 16 of the 112 urgent events.
Ten came within 13 minutes of the open and the other six before it or on Sunday evening, New York
time, with at least one on every trading day. At its 10 a day, the watch would have spent about one
question in seven on them. Nothing the watch is shown, such as Bitcoin's regime, the crypto news or
its own safeguard on Bitcoin's move, says anything about a stock. They can still be charted on
Markets.

Each pair gets a score from 0 to 100, the plain mean of five readings:

| Reading | Scores 100 at |
|---|---|
| The last fifteen minutes' move, against that pair's own usual one | five times it |
| The last five minutes' traded value, against the hours before the move began | eight times it |
| How wide the bars are, against the same | five times |
| Where the bars closed inside their own ranges, in the direction of the move | the far end |
| How far the close has cleared the high or low of the four hours before the move | two usual moves beyond |

60 is worth watching, 75 is a candidate and 85 is urgent. A rise that clears the prior four hours
is a *breakout* and one that does not is a *pump*; *breakdown* and *dump* mirror them. Nothing is
fitted: every scale is a number chosen to be read, and their mean is unweighted.

A pair that reaches the candidate band is recorded as an **event**, and again only if it climbs to
urgent within half an hour: one move is one event. Events are appended to
`marketEvents/events-YYYY-MM.jsonl` and never rewritten, with what the scanner knew that a candle
does not hold — the spread at that moment and the pair's 24-hour volume — and where it ranked
among the events of its minute. When the whole market moves at once only the three strongest are
put forward; the rest are recorded and marked. What the price did 15 minutes, an hour and four
hours after each event is read from candles when the page is opened, like every other outcome in
this app.

Three properties, each pinned by a test, and the same three `shared/aiContext.ts` keeps: a reading
uses nothing at or after the bar a call on it would execute on; it does not depend on how much
history was fetched, so the live scanner, a scan of history and a research script give the same
reading for the same minute; and a move does not set its own yardstick — the volatility, volume
and range it is measured against are all taken from before it began, or a pump would score lower
the larger it was.

It is public market data and nothing else: no key, no model, no order, and
`tests/aiNoLivePath.test.ts` fails if the scanner ever imports something that trades or asks a
model. It is off until switched on, stays on across restarts, reads the market at once when
switched on, and costs one request a pair a minute — sixty pairs take about seven seconds of each
minute and about 130 of the 6,000 request-weight a minute Binance allows.

**What an event is worth**, measured before any model was asked about one
(`research/EVENTS.md`). Every event at candidate or above over three years on four large pairs was
scored by one fixed trade — entered a minute after the last price the scanner saw, a stop and a
target set from the pair's own volatility, an hour at most, fees and slippage paid — against the
same trade at arbitrary minutes on the same pair. The rule was then fixed and committed, and
scored once on four more large pairs and on eight smaller ones chosen by rule:

| At candidate or above | 4 pairs it was found on | 4 large pairs held out | 8 smaller pairs held out |
|---|---|---|---|
| Buy a breakout: net a trade | −0.28% | −0.27% | −0.38% |
| …against an arbitrary buy | −0.04% (t −2.4) | −0.02% (t −1.2) | −0.08% (t −2.5) |
| Buy a breakdown: net a trade | −0.15% | −0.13% | −0.23% |
| …against an arbitrary buy | +0.09% (t +5.0) | +0.11% (t +4.9) | +0.07% (t +2.3) |

- **Rises do not continue.** Buying a breakout a minute later does slightly worse than buying at
  an arbitrary minute, on the smaller pairs most of all. The premise a pump scanner is usually
  built on is false on every pair measured.
- **Falls come back a little.** Buying a breakdown beats an arbitrary buy by about a tenth of a
  percent, confirmed on both held-out sets. It is real, and it is between a quarter and a half of
  what a round trip costs.
- **Nothing pays for its own fees.** Every row is negative after costs. An event is something
  unusual, not a signal, and the page says so.
- Two things did not survive. A recovery lasting a full day showed on the large pairs and not on
  the smaller ones, so it is recorded as a failure. And Binance's taker-buy volume predicted
  nothing the candle-only pressure reading did not, so that column is not carried into the app.
- One thing changed because of it: a volume spike with no direction is shown in the table and no
  longer raised as an event. Nothing followed one at any horizon from five minutes to a day, and
  on thinly traded pairs they were two thirds of everything that fired.

With that, a watched pair raises about one event a day, large or small.

**What comes before an event**, measured the same way (`research/SETUPS.md`), to see whether a
model could be asked about a market about to move instead of one that already has. Two setups,
fixed formulas on the detector's own reading with scales set by how often they fire: a coil (an
hour's range at most 1.5 usual moves) pressed against the four-hour high or low, and an early move
on three times the usual volume while the score is still under candidate. The rule was committed
before the held-out pairs were scored.

- **An early move predicts an event**: one follows it within the hour six to eight times as often
  as an arbitrary minute, on both held-out sets. It is the start of the move the detector later
  names. A coil predicts one at most 1.6 times as often.
- **Neither is a trade.** Taken in its direction with the same bracket, every setup loses 0.25% to
  0.38% a trade after costs, and does worse than the same trade at an arbitrary minute — seven
  rows of eight significantly. Being early to a move that does not continue is losing sooner.
- So **nothing was built**: no setup is recorded, listed or put to a model.

**How the futures market is positioned**, measured the same way (`research/POSITIONING.md`), to
see whether anything beyond a pair's own candles says which events to take.
- **Five readings** from Binance's free archive: positions added over the hour, ordinary accounts
  and top traders leaning against their own day, perp takers buying, and the perpetual's premium
  over the index. Each is read only once it would have been published live.
- **The archive was checked** value by value against the live endpoints over a month.
- **The rule was committed** before the held-out pairs were scored.

The result:
- **Positioning does not say which events to take.** Split at fixed points, no reading separates
  better events from worse on any set, and no half of any split nets positive. The best loses
  0.09% a trade.
- **A crowded market is not a trade either.** In a crowded market, accounts lean hard one way and
  the premium is stretched the same way. Taking either side within the hour loses 0.16% to 0.33% a
  trade.
- **One thing looked larger than costs on the discovery pairs, and it did not survive.** Over the
  next day the price moved against the crowd by 0.3% to 0.4%. On the held-out pairs that held only
  for crowds long on the large pairs. It did not hold for crowds short there. On the smaller pairs,
  where the perpetual trades at a discount most of the time, a crowd short marked a market that
  kept falling.
- So **nothing was built**: positioning is not read, shown or put to a model.

**What Binance's own announcements do**, measured the same way (`research/NEWS.md`), before any
news was read in the app.
- **Three kinds, sorted by fixed patterns on the title, never by a model:** delistings, launches of
  a USDT perpetual, and spot listings of a coin that already had a perpetual.
- **Data:** each announcement's minute is from Binance's own lists. The coins' 1-minute candles
  come from Binance's archive, which keeps delisted coins.
- **The rule was committed** before the held-out half, 2025 to September 2026, was scored.

The result:
- **A futures launch or a listing moves the price at once:** 7% to 16%, nearly all of it before an
  app that reads the list once a minute could buy. From there, no trade pays.
- **A delisting is a slow fall.** On the held-out half, a coin was 13% lower four hours after an
  app could first act, after costs; before 2025 it was 25%. 75 of 87 coins were lower.
- **Held short four hours, that is the first trade in these event studies to pass on held-out
  data.** It is paper only: a short can never be placed for real here, and Binance spot cannot be
  sold short. Two coins were squeezed upward, and a held short lost 44% and 80% on them.
- **The usual bracket**, with a stop and a target, does not pass for any of those three kinds.

**Binance's Monitoring Tag**, its warning that a coin may be delisted, was measured after, under the
same rule, committed before any of its candles were read:
- 81 of the 87 coins delisted in the held-out half had carried the tag first.
- The tag's announcement starts a fall: a coin was 4% lower within the minute and 10% four hours
  on, half of it before an app reading once a minute could act.
- **The bracket passes, narrowly:** 0.35% a trade after costs, beating the usual with t 2.3 against
  a bar of 2. Held short four hours, a coin made 4.5% a trade but missed its stricter bar. One
  squeeze cost the hold 39%.
- The user chose what a tag does, the same three things as for a delisting: a notice if you hold
  the coin, a paper short by the rule that passed, and a question to the watch's models (below,
  under [Binance's announcements on Discovery](#binances-announcements-on-discovery)).

**What Upbit's notices do to a coin on Binance**, measured the same way and by the same code
(`research/UPBIT.md`). Upbit is Korea's largest exchange. Three kinds of its notices were sorted by
fixed patterns on the title, across the ways Upbit has worded them since 2017: a KRW listing, its
caution designation, and a delisting. The rule was committed before the held-out half, 2025 to
September 2026, was scored. **Nothing passed, so nothing was built:**
- **A KRW listing** lifted the coin's Binance price 38% within the notice's minute. All of it was
  gone before an app reading once a minute could buy, and from there the coin faded.
- **A caution** started a slow fall that an app could reach. Held short four hours it made 3.9% a
  coin, and 18 of 24 coins were lower, but it missed its bar (t 2.3 against 3), as Binance's
  Monitoring Tag held four hours did.
- **A delisting** fell 6% in the minute and stopped.

#### Binance's announcements on Discovery

Because a delisting passed, the app reads the news (V3 Stage 7). Under Settings › Market, a reader
can be switched on. It is off until then, and stays as it was left across restarts.

**What it does:**
- Once a minute, three seconds into the minute, it reads Binance's three public announcement lists:
  delistings, new listings, and its news, where coins are added to the Monitoring Tag. Three
  requests, no key.
- It keeps each new article once, in `news/news-YYYY-MM.jsonl`.
- It sorts each by its title, with the same patterns the study measured with
  (`shared/newsTitles.ts`).

**Discovery** lists the announcements of the four kinds. For each, it shows:
- when it was released;
- how soon after release it was read;
- the coins it names;
- the title.

A tick box shows every other announcement too. Under the list, each kind carries what it did to
prices on the held-out half.

**The news rules since the study**, a card below it, is the two rules' running record: every
delisting and every coin added to the Monitoring Tag Binance has announced since 1 October 2026, the
day after the study's held-out half ended.
- **Each coin is scored as its rule trades it:** a delisting's short held four hours, and a tag's
  stop-and-target short. It is scored on the coin's own 1-minute candles, after the study's fees and
  slippage, by the very functions the study scored with (`shared/newsRules.ts`, which
  `research/announcementStudy.ts` now imports for both studies, their output unchanged to the byte).
- **It does not depend on the app.** It counts whether or not the paper short was on, the reader was
  on, or the app was open: the main process reads Binance's delisting and news lists back to that
  day, and Upbit's list of trading notices (`electron/services/newsRecordService.ts`).
- **Beside each rule, the study's own figure:** a delisting held short made 15.5% a coin, 75 of 87
  ahead; a tag's bracket 0.6% a coin, 59 of 103 ahead.
- **Two near misses are on record the same way**, below the rules, since 5 October 2026, when the
  user chose to keep them:
  - a tagged coin held short four hours (in the study, 6.7% a coin, 82 of 103 ahead);
  - a coin Upbit designates for caution, held short four hours on its Binance pair (3.9% a coin, 18
    of 24 ahead; `research/UPBIT.md`).

  Both started a slow fall in their studies and missed the bar they were held to; the record shows
  whether the fall goes on. Nothing in the app acts on either. Upbit's notices are sorted by the
  study's own patterns (`shared/upbitTitles.ts`), and a coin is scored on the Binance pair of the
  same ticker; one Binance does not list says so.
- **A trade that is not over yet** says so, and is scored on a later look: a tag's bracket an hour
  after the announcement, a hold four hours after.
- **A score is kept once made**, in `news/record.json`, because a delisted coin's candles are soon
  gone from Binance. A coin that could not be scored is tried again on the next look.
- **It reads only when the card is shown**, or asked to look again, and reads each list at most once
  in ten minutes, Upbit's a page a second. It is public data: no key, no model and no order, and
  nothing is opened because of it.

Checked in the app on 5 October 2026, on a scratch profile with the lists faked. A delisting of DOGE
and a tag of XRP were released five hours before, and a tag of ADA ten minutes before. On real
candles, DOGE scored +0.20% held four hours, and XRP +0.17% by the bracket. ADA was not over yet. The
lists were read once, a second look within ten minutes read nothing again, and the news reader was
never switched on.

Checked again with the near misses, later that day, on a separate build and a scratch profile:
- **With the lists faked:**
  - XRP's tag scored by both trades from one read of its candles: −0.79% by the bracket and
    −0.45% held four hours.
  - A tag of ADA seventy minutes old had its bracket scored and its hold not over yet.
  - Upbit's caution of SAND scored +0.93% on SANDUSDT. One of BLAST ten minutes old waited.
  - A KRW listing in the same list was not on record.
  - Each list was read once, and a second look read none again.
- **With nothing faked,** the app read Upbit's real list. It found the caution of BLAST of 2 October,
  and said Binance has no spot pair for it.

**What a delisting does** is what the user chose on 5 October 2026, once the study was in. Each part
is switched under the same card on Settings › Market, and acts only on a delisting read while the app
is open:
- **A notice, if you hold the coin** (on by default once the reader is on). It reads where the coin
  is held:
  - your Binance balances, where a key is stored;
  - the paper account, Inventory, and any executor running on the coin.

  It says where you hold it, what such coins did, and that nothing has been sold. It sells nothing.
- **A paper short by the rule** (off until switched on, with a stake of 25 to 1,000 USDT). It is the
  trade the study measured. On each coin the announcement names that has a USDT pair, a paper
  Position short is opened within five minutes of the announcement. It is out at the open four hours
  after the announcement's minute, with no stop and no target. The news reader then stops it and
  settles it into the paper account, as the watch does with its trades. Its card says where it came
  from. A coin squeezed upward can cost it a great deal, as two of 87 did. Having no stop, it stakes
  its stake however Risk & Safety sizes the app's own paper trades, and is held with them to what
  they may have out together.
- **The models** (on by default once the reader is on; nothing is asked unless the watch is on too).
  Each coin the delisting names that has a USDT pair is raised as an event. The main process raises
  it, from the coin's own candles at the minute it read the announcement. The event is named
  `delisting`, points down, and carries which announcement raised it. It shows on Discovery and
  Opportunities like any event.
  - **The watch** takes it up as it takes up any fresh event. It is not held to the band floor,
    because the announcement raised it, not the move. It counts toward the watch's daily limit and
    the day's AI budget.
  - **The question** has a prompt of its own (`opportunity-news-v1`, pinned by its hash), with the
    announcement's title and release time in a `news` block after the event. The prompt says what
    the block is, not what such coins did.
  - **The main process checks** the article against the reader's own record before asking: it must
    be a delisting the app read, naming that pair, from around that minute. A request cannot bring
    its own news.
  - **What comes back** is an answer like any other. A call to sell can open the watch's paper trade
    when that is switched on, and can never be placed for real.
  - **Where answers show:** the feed, the journal and the live board read these answers beside the
    scanner's. A benchmark leaves these events out, since it compares models on the scanner's
    question.

**What a Monitoring Tag does** is what the user chose the same day, once its own study was in: the
same three things, switched separately, in a group of their own on the same card.
- **A notice, if you hold the coin** (on by default once the reader is on), read the same way. It
  says what tagged coins did, and that 84 of 97 were later delisted. It sells nothing.
- **A paper short by the rule** (off until switched on, with a stake of its own). It is the bracket
  the study measured:
  - It is made in the minute after the announcement's, so that it enters at the open of the second
    minute after it, where the study entered. A tag read later than that gets no short.
  - Its stop is 1.5, and its target 3, of the coin's usual fifteen-minute move, read from the twelve
    hours of minutes before the announcement. A coin whose minutes cannot all be read gets none.
  - It is out at the close of its sixtieth minute otherwise. The news reader then stops and settles
    it, as it does a delisting's.
  - It stakes what its stop would lose the risk per trade at, where Risk & Safety sizes the app's
    own paper trades so, and never more than its stake; and none is opened past what they may have
    out together.
- **The models** (on by default once the reader is on; nothing is asked unless the watch is on too),
  as for a delisting, with three differences:
  - the event is named `monitoring_tag`;
  - its question has a prompt of its own (`opportunity-tag-v1`, pinned by its hash). Its one
    paragraph more says what the tag is, in Binance's own terms, and not what tagged coins did or
    how many were delisted. The delisting's question is left word for word as it was;
  - the main process asks only about a tag it read itself, naming that pair, from around that
    minute.

**Nothing real is placed or sold because of an announcement.** A short can never be placed for real
here. `src/news/newsPaperShort.ts`, the one file that writes these shorts, spells paper as a
literal. `tests/aiNoLivePath.test.ts` names every file that reads the news and holds that one to
the rule the watch's writer is held to.

**Checked in the app** (5 October 2026, UTC), on a separate build with an empty scratch profile:
- Off, it read nothing, and Discovery said where to switch it on.
- Switched on from Settings › Market, it read both lists at once and kept 40 articles. Four were of
  the three kinds: the CT futures launch, the HYPE listing, and two delistings.
- The next read came at three seconds past the next minute, with no duplicates.
- Switched off, it stopped.
- No write went to an exchange, no model was reached, and no executor was made.

**And what a delisting does**, checked the same day on another scratch profile. Binance's list was
faked in the main process to hold one delisting, of DOGE and XRP, released two seconds earlier;
desktop notices were captured.
- **Read:** two seconds after its release.
- **The holder's notice:** "You hold 500 DOGE in the paper account. Nothing has been sold."
- **The shorts:** one paper short each on DOGEUSDT and XRPUSDT, 100 USDT, no stop, no target,
  timed to end four hours after the announcement. Each raised its own notice, and its card said
  where it came from.
- **Read again a minute later:** nothing more was opened.
- **Writes:** none went to an exchange, and no model was reached.

**And the models**, checked the same day on a third scratch profile. OpenRouter was a canned
transport in the main process, with a fake key and one fake model; nothing was billed. The list held
one delisting of DOGE.
- **Raised:** a DOGEUSDT `delisting` event, quiet by its candles, pointing down, carrying the
  announcement.
- **Asked:** the watch put it to the model once, under the news prompt. The `news` block came last,
  and the event read `delisting`, down.
- **Recorded:** the ledger row was `opportunity-news-v1`, a delisting.
- **Paper trade:** the canned SELL at 80% opened the watch's paper SELL.
- **Shown:** Right Now on Opportunities showed the delisting with the call and its entry, and
  Discovery's events listed it.
- **Writes:** none went to an exchange; one model call was made, to the fake.

**And a Monitoring Tag**, checked the same day on a fourth scratch profile, the same way. Binance's
news list held one tag, of DOGE and XRP; the paper account held DOGE; the tag's paper short was on.
- **Read:** two seconds after its release, from the news list, as a Monitoring Tag.
- **The holder's notice:** "Binance's Monitoring Tag now includes DOGE, which you hold … Nothing has
  been sold."
- **Raised:** a `monitoring_tag` event on each of DOGEUSDT and XRPUSDT, quiet by their candles,
  pointing down.
- **Asked:** under `opportunity-tag-v1`, with the tag's block last and kind `monitoring_tag`. The
  canned SELL opened the watch's paper trade on DOGE.
- **The rule's shorts:** one on each coin, made 79 and 81 seconds into the minute after the
  announcement's, so each entered at the second; stops of 0.45% and 0.36% and targets of 0.89% and
  0.73%, from each coin's own usual move; out within 59 minutes. Each card says where it came from.
- **Shown:** Discovery listed the tag and both events; Settings › Market showed the tag's own
  switches.
- **Writes:** none went to an exchange.

In that run the watch asked about DOGE and not XRP. Run again, it asked about both. An event whose
candles cannot be read is left for the watch's next pass, and with the scanner off -- as it was
there -- no pass followed to take it up again. So the watch now looks again by itself, 20 seconds
later, at an event it could not ask about for that reason, while the event is still fresh; it never
asks twice about one event. Checked the same way with the first read of XRP's candles made to fail:
the Watch card said its candles could not be read, and 21 seconds later XRP was asked about.

### AI signals — paper only

A model can be asked for a buy / sell / hold decision on a market. It is asked through
[OpenRouter](https://openrouter.ai), one key in front of every model, so which model answers is a
setting rather than a rewrite. **A model's answer never places an order**: it becomes a decision
on a tape, and the tape is replayed through the same paper engine as every other strategy.
`tests/aiNoLivePath.test.ts` fails if an AI module ever imports a live-trading one, or the reverse.
The furthest a call can go is to fill in an order form that a person then submits — see
*From a call to an order, by hand* below.

**What is asked.** `shared/aiContext.ts` builds the question from exactly the 672 completed
15-minute candles before the candle being decided — seven days — and from nothing at or after it:
a short tail of raw bars, the same history aggregated to 1h and 4h, and EMA / RSI / ATR / ADX /
Bollinger readings from the same code the strategies and the chart use. The window is fixed on
purpose. An EMA remembers everything before it, so a context built from "whatever was fetched"
would differ between a backtest and a bot for the same candle, and the same decision would be
billed twice.

**What comes back.** A strict JSON object: the action, a confidence, a market regime, a risk
level, a horizon, an optional stop and target, and reason codes from a closed list. The schema
sent to the provider carries types and enums only; every range is checked locally by
`validateAiAnswer`, and an answer that fails is refused whole and treated as a hold. The position
machine acts on the action and the confidence (0.65 or better) and places its own ATR stop — the
model's stop and target are recorded so they can be scored, not executed.

**How often it is asked.** GPT Intraday can ask its model on every 15-minute candle, every hour,
or every four hours: a choice on the Backtest page and in the Add Bot dialog, fixed once a bot is
created. The ceiling on a run is 672 decisions whatever the cadence, so the same money covers 7,
28 or 112 days, and a bot makes 96, 24 or 6 calls a day. Decisions fall on the clock — the candles
that open on the hour, or on every fourth hour UTC — so a backtest and a bot ask about the same
candles. Between two questions the position is held, and its stop is still checked on every
candle. The question does not change with the cadence (the same seven days of 15-minute candles,
the same prompt; the model is not told how often it is asked), so an answer paid for at one
cadence is the cached answer at the others, and on AI Benchmark.

`research/gptcadence.ts` measured what asking less often changes, the way `gptneed.ts` measured
the original: a synthetic signal of known accuracy through the real strategy, engine and fees,
over three years of BTCUSDT. Lowest accuracy at a four-hour horizon that does not lose money:

| Asked every | Acts on 5% of decisions | on 25% | on every one |
|---|---|---|---|
| 15 minutes | 71% | 89% | never, even at 100% |
| hour | 68% | 72% | 88% |
| 4 hours | 72% | 70% | 67% |

The bar barely moves — about 67–72% wherever a cadence is used sensibly — but it stops depending
on restraint: asked on every candle, a signal has to act rarely *and* be right; asked every four
hours, it can call every time. What a slower cadence does **not** buy is much more evidence per
paid run. At 75% accuracy, 672 decisions close 9 to 141 trades in seven days on every candle and
12 to 239 in 112 days every four hours, depending on how often the signal acts: trades come from
decisions, and the number of those is the same. It buys a run across sixteen times more market,
not sixteen times more trades.

**Where it is used.** The **GPT Intraday (Paper Only)** strategy, as a backtest (672 decisions at
most: 7, 28 or 112 days by cadence) or a paper bot; **AI confirmation** of any other strategy's
entries, described next; an **AI signals** overlay on the Markets chart, off by default; and the
AI pages:

| Where | What it does |
|---|---|
| **AI Decisions › Analyze** | One market, one model, one click, one call — or four, when what is picked is a panel of agents on a model. The button states the cost of the whole click before it is pressed, and reads "cached, free" when the answer is already held. Answers from different models for the same candle stack into a comparison. A call to buy can be turned into an order form — see *From a call to an order, by hand*. |
| **Opportunities** | The events the scanner raised, each with what the ticked models recommended for it — BUY, SELL or NO TRADE, with an entry range, a stop, a target and an expiry — and what each recommendation has done since. A watch can put events to models as they are raised, within its own daily limit, and open a paper position on a call it would act on; a list says what can still be acted on right now. Described below. |
| **Performance** | A leaderboard of what the watch's recommendations earned; the watch's and the news rules' paper trades as a running total in R, one line each; and a journal that lists every recommendation, saves as a spreadsheet, and opens any line's whole story on one timeline. |
| **AI Decisions › Signals** | Every answered call, scored against the candles that followed: the move after 1h, 4h and 1d, which of the model's own levels was touched first, and whether the call was right. Per model: act rate, hit rate, and hit rate by confidence. |
| **AI Benchmark** | The same questions put to every model you tick, with the answers scored side by side. Two kinds: one market asked on a clock, with a panel of agents beside its own model and what a route between two of them would have done; and events across the market, where each recommendation is followed through its own entry, stop and target — both described below. |
| **Settings › AI** | OpenRouter's catalogue with prices. Only models that can be held to a strict JSON schema can be enabled, and one that reasons can be enabled again at a lower reasoning effort. Also where a route to a second model, or to a panel, is set — described below. Below it: calls, tokens, dollars and latency per model, the daily budget, and the pace, the most calls a minute to one model. |

**The key.** An OpenRouter key — made at openrouter.ai/keys, and starting `sk-or-` — is entered on
Connections, beside the exchange keys, where it can be replaced, tested or removed. Until one is
stored the same card sits above Opportunities, AI Decisions and AI Benchmark, which can do nothing
without it. Saving a key asks OpenRouter a free question about the key itself and spends nothing,
and a value that is plainly some other secret is refused before it is sent anywhere to be checked.

**Opportunities: an event, put to several models.** The Opportunities page lists the events the
[scanner](#discovery--a-market-scanner) has raised and lets each one be put to the models you tick.
The question is not "would you buy this market?" but "the scanner just raised this — is it a
trade, and if so where, and until when?":

- **What is asked.** The seven-day snapshot every other question carries, and on top of it an
  `event` block: its type and direction, the score and its five components, the returns behind it,
  the last thirty 1-minute bars and the two hours before those in 5-minute bars
  (`buildEventContext` in `shared/aiContext.ts`). The event is worked out in the main process from
  the candles the request carries, by the same detector the scanner runs, so a model cannot be
  asked — and billed — about a minute on someone's say-so that it was interesting. The prompt says
  what an event is and deliberately not what usually follows one: the figures in
  `research/EVENTS.md` were measured over the months a benchmark replays, and putting them in the
  prompt would hand the model a summary of the answers.
- **What comes back.** The signal's answer with three fields added: `entryMin`, `entryMax` and
  `validMinutes` (5, 15, 30 or 60); the horizon is the holding time. BUY opens a long, SELL opens
  a short, and NO TRADE is a first-class answer. The app, not the model, stamps when the
  recommendation was made and when it expires. Here the levels are the product, so an answer whose
  entry range is upside down, far from the price, or not bracketed by its stop and target is
  refused whole (`validateOpportunityAnswer` in `shared/aiOpportunity.ts`) — billed, kept, and
  counted as no trade.
- **Every model answers alone.** Ticked models are asked together, each with the same snapshot,
  and none is shown another's answer. The card counts them — "2 BUY · 1 SELL · 1 NO TRADE" — and
  says so when two take opposite sides. That count is shown to be read, and nothing acts on it.
- **What a recommendation did** is worked out from 1-minute candles whenever the tab is looked at
  (`shared/aiOpportunityOutcome.ts`), and never stored. An answer can only be acted on from the
  first minute that opens after it arrived, so a slower model enters later: latency is charged in
  whole minutes. The entry fills the first time the price trades in its range while it is valid,
  at the open if that is inside the range and otherwise at the nearer edge; if it never does, the
  recommendation expired and was never a trade. Then the stop, the target or the holding time
  ends it. Where a candle cannot say which came first, the answer is the worse one: a bar touching
  both levels is a stop, a position entered part-way through a bar is not credited with a target
  that bar reached, a bar that opens beyond the stop fills at its open. Fees are paid on both
  fills and slippage on every market fill: more of it on a thinner pair, and never less than half
  the spread the scanner saw on the book when it raised the event.
- **Paper trade** opens the same New Executor form as *From a call to an order, by hand* below,
  with the side, the entry (at market while the price is inside the model's range, otherwise
  its nearer edge), the stop, the target, the time limit and the expiry. Once the
  entry has expired the form will not submit it as it stands, and a paper position made from it
  that is still waiting to enter when the expiry comes is abandoned: it closes having bought
  nothing (`entryExpiresAt` on a Position, in `simulatePosition`). Before this a waiting entry
  waited for as long as its executor ran, which is not what a recommendation says. **A short is
  paper only**: the form refuses Live for any position that is not a buy, because on a spot
  account a live "sell" would sell coins you hold, which is not what a short call means.
- **A paper position made from a recommendation enters where the recommendation says**: in the
  first minute the price trades inside the model's range, at that minute's open when the open is
  inside it and otherwise at the edge the price came in by (`entryRange` on a Position). It is
  the rule the recommendation is scored by, and the form's two kinds of entry are not it. A
  market entry takes the next minute's open wherever the price has gone, which chases a price
  that has run from the range. An entry price is a limit, and a limit on the far side of the
  market is filled at once: with the price already under a buy's range, "waiting at its bottom
  edge" buys at the next open, below the range, a position the recommendation never entered. A
  check in the app opened a trade "waiting for" the bottom of a range the price was already
  under, which is how this was found. So the range itself goes with the proposal, and the engine
  enters by it while the form's entry is still the one the recommendation filled in; a price
  typed over it is the user's own limit. `tests/engineExecutors.test.ts` runs the engine and the scoring over the same
  candles and holds them to the same minute and the same price. A live position is entered at
  market only, as before, and never carries a range.
- **Right now** is a table at the top of the tab: each event with a call this app would act on
  whose entry has not run out or filled, the strongest candidate first, with every model's call,
  the entry on offer and the time left. A line leaves when its entry does.
- **Each card says where its event stands**: not asked, no trade, an entry on offer, in a trade,
  expired, or closed (`feedItemStatus` in `src/agents/opportunities.ts`). It is worked out from
  the answers and the candles, like everything else here, and where the candles that would say
  have not been read the card shows no status rather than a guess.
- **Why this pair** opens on a card: the five components the event's score is the mean of, each
  beside the reading it was made from — the fifteen-minute move in units of its usual size, the
  volume and the bar size against the hours before, where the last minutes closed in their bars,
  and whether the price cleared the prior four hours — and, for an event raised live, its rank in
  its minute with the volume and spread the scanner saw (`eventReasons` in
  `shared/marketEvent.ts`).

Nothing is asked until **Ask** is pressed on an event, and the price of exactly those calls is
stated first — unless the watch below has been switched on. `tests/aiNoLivePath.test.ts` and
`tests/aiProposal.test.ts` pin that none of this reaches an order path, and that a short's form
cannot be made live.

**The watch: events asked about as they are raised.** A recommendation with a fifteen-minute
entry is worth nothing an hour later, so the Opportunities page carries a switch for the one thing
in this app that asks a model with nobody pressing anything. It is off until it is switched on.

- **Switching it on is the confirmation it gets**, so that confirmation states each model's price
  a call, the most a day of it can cost — every model, for every event its limit allows, and the
  least as well when the first model is asked alone — and how that sits against the daily AI
  budget. A call is priced on the question of an event the scanner has raised, so the watch
  cannot be switched on before the scanner has raised its first; on a flat market that is a wait
  (sixty pairs raised nothing for over two hours on Sunday 4 October 2026, against an average of
  about two an hour). What it asks cannot be changed while it is on: a different list of models
  or a higher limit is a different price, agreed to by switching it off and on again. A model it
  asks cannot be disabled from under it.
- **What it takes up**: an event raised live in the last three minutes, among the strongest three
  of its minute, at urgent (or at candidate and urgent), and never one that was on file when the
  app started. At most 5, 10, 20 or 40 events a UTC day, counted from the call ledger rather than
  kept in memory, so a restart does not start the count again. A call that never reached a model
  still uses its event's place, so a provider that is down is not tried all day.
- **The first model can be asked alone.** Most events are no trade. With that option the first
  model answers every event and the others are asked only about the ones it would act on.
- **The limits are held twice.** A headless scheduler in the renderer (`OpportunityScheduler`,
  `src/agents/opportunityWatch.ts`) decides which events to take up each time the scanner reports
  a pass. The main process makes the same decision again immediately before every call made in
  the watch's name (`electron/services/aiWatchService.ts`), from the two things only it owns —
  the setting and the ledger — one check at a time, so that two events arriving together cannot
  both take the day's last place. The daily AI budget is checked after that, as for every call.
- **A model that keeps failing is rested.** One whose last three calls for the watch today all
  failed or were refused is not asked again until the next UTC day; the others still are, and
  the card says who was left out. A refused answer was paid for, and a provider that is down
  fails every call it is sent, so asking on only buys more of the same. Counted from the ledger,
  and held in the main process as well, like the day's events.
- **It recommends and notifies.** An answer lands on its event's card exactly as one bought with
  Ask does, and the first call to trade on an event raises one desktop notice, which says that
  nothing has been placed. **It places nothing real**: it opens no order form and no real order.
  What it may do beyond that is the next paragraph, and only when that is switched on.
- **It runs while the app is open**, whichever page is showing, and stays on across restarts
  until it is switched off. With the watch and the scanner both on, starting the app can
  therefore spend money without a click, inside those limits.

**Paper trades from the watch.** On 4 October 2026 the user chose to let the watch open *paper*
positions by itself, so that what following its recommendations does is on Strategies › Execution,
and in the paper account where there is one, without anyone being at the screen inside a
fifteen-minute entry. It is a second switch on the Watch card, off until it is switched on, with
a confirmation of its own that says what will be opened with nobody pressing anything, and that
it is paper.

- **What it opens is the recommendation, as the form would have filled it in.** When the model it
  follows answers an event the watch put to it with BUY or SELL at 65% confidence or more, a
  paper Position is created at once with what the *Paper trade* button would have filled in for
  that answer at that moment: the model's own stop and target; its hold as the time limit; and
  its entry abandoned when its validity ends. It enters by the model's range, as above: in the
  first minute the price trades inside it, and never by chasing a price that has left it. The
  one thing a person would have typed is the amount: the stake in the setting (25 to 1,000), or,
  sized by its stop, less (below). One thing is stricter than the form: a stop or target that is
  not a usable distance from the entry is a reason not to trade, where the form would have shown
  its own in its place.
- **Its limits are counted from the executors on file**: one paper trade an event, one open on a
  pair at a time, and at most 1, 2, 3, 5 or 10 open at once. Where a paper account is set up, a
  trade it cannot fund is not opened, by the check the order form makes. Each is looked at again
  inside the one queue every settings write goes through, so two answers arriving together
  cannot both pass.
- **Three safeguards** (chosen on 5 October 2026, from the V3 document's later items). Each only
  ever opens less, is counted from what is on file, and is set beside the stake:
  - **So many in one direction:** at most 1, 2, 3, 5 or 10 open BUYs, and as many SELLs (2 by
    default). Altcoins move together, so several open the same way are one bet on the market.
  - **A pause after a losing run:** once the last 2, 3 or 5 of its trades to close today all lost (3
    by default), it opens none until midnight UTC. One that never entered is neither a loss nor a
    win. The Watch card says when it is paused.
  - **Bitcoin moving against a call:** a trade still waiting for its entry is dropped when Bitcoin
    has moved 0.5%, 1% or 2% against it (1% by default) since the minute the event was read.
    Bitcoin's closed minutes are read once a minute with the trade's own. A dropped trade is
    stopped, books nothing, raises a notice, and its card and timeline say "Dropped before it
    entered: Bitcoin fell 1.17% after the call". One that has entered is left to its own stop and
    target.

  Each can be set to never. None is shown to make the trades pay: no measurement here found an
  edge in the models' calls. They bound what following them can do. A setting saved before they
  existed reads them at their defaults and stays on; changing one, like the stake, means switching
  paper trades off first.

  Checked in the app on 5 October 2026, on a scratch profile with a separate build. A faked tag
  of DOGE, XRP and ADA raised three events, and a canned model answered BUY on each with a range
  below the price. Bitcoin's minutes were synthetic, falling 1.67% a minute after the event:
  - the first two BUYs opened, and the third was refused: "2 in one direction is the most it
    keeps";
  - once the fall had a closed minute, both waiting BUYs were dropped, each with a notice, and
    their cards said "Dropped before it entered: Bitcoin fell 1.67% after the call";
  - with three losses closed that day seeded, the Watch card said it was paused until 00:00 UTC;
  - nothing went to an exchange.

  The recommendations themselves stay on Opportunities' Right Now until they expire: only the
  watch's paper trades are dropped.
- **Sized by its stop, and capped with the news rules'** (chosen on 5 October 2026, and set on
  Risk & Safety for every paper trade the app opens by itself; `shared/paperRisk.ts`):
  - **Sized by risk:** a trade stakes what its stop would lose about 1, 2, 5, 10, 25 or 50 at,
    after a round trip's fees (1 by default), and never more than its stake, which becomes the most
    it stakes. Against the stops the models have given, a median of 1% from the entry, a stake of
    100 is held to 100 only for a stop nearer than about 0.8%, so nearly every trade risks the
    same. One that would stake under 5 USDT, the smallest order on Binance, is not opened.
  - **Out together:** the watch and the news rules open nothing that would take what their open
    paper trades stake together past 250 to 10,000 (1,000 by default), or there is no cap. A
    trade made by hand on Strategies › Execution is not counted, and the bots hold no paper money:
    a bot's run is a replay, measured in percent.

  Both only ever open less, so either may be changed while paper trades are on, and neither is
  asked again by the watch's confirmation, which names them. A settings file written before them
  reads them at their defaults.
- **A daily digest** (chosen the same day; `shared/paperDigest.ts`). One desktop notice a day, the
  first time the app is open after 00:00 UTC, says what the watch and the news rules opened and
  closed on paper the day before, and what each closed trade made against what it risked at its
  stop (R): "The watch opened 4 paper trades and closed 2, 1 of them ahead: +0.85 USDT after fees,
  or +0.50 R against what each risked at its stop; 1 more never entered." A delisting's short has
  no stop, and says so. A day with nothing to tell raises none, and days the app was closed are not
  caught up on. The day told is kept in `settings.json`, so a restart does not tell it twice. It is
  on until switched off, on the same card on Risk & Safety.
- **Paused after a losing run** (chosen the same day; `shared/paperPause.ts`). When the last 20
  paper trades the watch closed with a stop lost 5 R or more together, it opens none until it is
  resumed on Risk & Safety, and one desktop notice says so: "The watch's last 5 closed paper trades
  lost 5.20 R together: Risk & Safety pauses them at 5 R. It opens none until they are resumed
  there, and any still open run to their end." The news rules are paused the same way on their own
  record, so a bad run for the model does not stop them, nor theirs the watch; a delisting's short
  has no stop, no R, and is not counted. The loss is 3, 5, 8 or 10 R, or never, and the run the
  last 10, 20 or 50, on the same card.
  - **It holds until it is resumed.** `src/risk/PaperPauseScheduler.tsx` reads the record once a
    minute and writes the pause into `settings.json`, so a trade still open that ends ahead does
    not lift it, nor does a restart; until it is written down, the two writers read the same
    record and refuse anyway. Resume counts again from that moment.
  - **It only ever opens less**: it refuses, and closes nothing. It is apart from the pause for the
    day after losses in a row above, which ends by itself at midnight.
  - **Where it shows:** the notice, Risk & Safety (each side's run in R, or since when it is
    paused, with Resume), the Watch card ("Paused. …"), and the watch's confirmation. The status
    bar still reads AI: PAPER TRADES while it holds, as during the pause for the day: it is held to
    reading the AI setting alone (`tests/aiNoLivePath.test.ts`).

  Checked in the app on a separate build and a scratch profile with four of the watch's trades
  lost at 1 R each: a fifth closed while it ran, and within the minute the watch was paused with
  one notice; Resume lifted it, and a reload told nothing again.
- **Checked against the live price before it opens** (since 6 October 2026; see
  [Live prices](#live-prices)): with no fresh price for its pair, or a spread over 0.1%, none is
  opened, and the book it opened against is written on its mark.
- **It follows one model.** Comparing models is the leaderboard's job, and three models trading
  one event would be three positions on one view of the market. The model has to be one the
  watch asks, and neither the model, the stake nor the limit can be changed while it is on.
- **A trade it opened closes itself, and says how.** Once a minute its open paper trades are
  replayed on closed 1-minute candles; one whose stop, target or time limit has ended it, or
  whose entry expired unfilled, is stopped, as pressing Stop on its card would do. That is what
  frees its place under the limit. How it ended is written on it in the same write — the exit,
  the minute, and what it made or lost after the simulation's fees — because a stopped executor
  is not simulated again and nobody was there to see: its card on Strategies › Execution shows it
  ("Target reached: +1.7 USDT after fees, +1.00 R", "Never entered"), beside where the trade came
  from, and the Watch card adds up the ones that have ended ("2 have ended: 1 entered, 1 of them
  ahead, +1.7 USDT in all after fees, or +1.00 R"). One stopped by hand carries no result and is
  not counted.
- **Each result is in R as well** (since 5 October 2026): what the trade made over what its stop
  would have lost, its stake times the distance to the stop and a round trip's fees
  (`shared/paperRisk.ts`). +1 R is a win as large as the loss its stop allowed. Sized by risk, a
  trade's R and its result in USDT tell the same story; at a stake, R is what makes trades with
  near and far stops comparable, and it adds across quote assets. The card, the Watch card's tally,
  the trade's timeline and the daily digest all say it, and Performance draws the running total,
  one line for the watch and one for the news rules (`shared/paperRCurve.ts`), stepping at each
  close. A news rule's short is told the same way on
  its card; a delisting's has no stop and gives no R. The leaderboard and the journal below say
  the same of every recommendation they score, against the call's own stop.
- **With a paper account, the result is settled into it** by the settlement a press of Stop
  runs, and a trade the account cannot fund is not opened. **With none, a result is added to no
  balance** and nothing limits what the positions add up to; the confirmation and the card both
  say so, and the cards are then the only place a result is kept.
- **It is paper, and cannot be anything else.** The one file that writes
  (`src/agents/watchPaperTrade.ts`) spells the mode as a literal and takes none;
  `shared/aiWatchPaper.ts` holds the rules. `tests/aiNoLivePath.test.ts` reads both: neither
  mentions the bridge a real order travels over, the word for the other mode appears in neither
  as a value, no leverage is ever named, and of the watch's files only that one reaches settings.
  A bot that trades real money by itself was offered twice and not chosen, and is not built.
- **It asks nothing and costs nothing.** A paper trade is made from an answer the watch already
  bought. The desktop notice for one says it is paper and that nothing real was placed.

**What the watch's recommendations earned** is the leaderboard under the feed: the watch's own
answers of the last thirty days, in the tables of the benchmark on events described below — the
same scoring, the same two rows that are not models, the same rules for combining models, and
only the events every model answered. It differs from a benchmark in what a benchmark has to
assume. A replayed answer is taken to have arrived ten seconds after its event plus the model's
latency; here each answer is scored from the second its call finished. A replayed event is
charged a slippage rate for its liquidity; here half the spread the scanner recorded is charged
instead, when that is more.
AI Benchmark shows the same card for the models it compares, so a model's replayed results
and its live ones sit on one page, and the difference between them is what those assumptions
were worth. An answer bought later by pressing Ask is left out: it arrived when a person got
round to it, which says nothing about the model. Scoring is free and waits for a click, since it
reads a request of public candles an event. A table headed **Lately** sits under each model's
row: its last 10, 50 and 100 closed trades and those of the last 7 and 30 days, added up in
percent and in R, beside the same events followed with no model. They are sums and counts, never
a rate: ten trades do not make one.

**The journal** is the card at the foot of Performance: one line for every answer a model has given
about an event the scanner raised, whoever asked — the watch, a click on Ask, or a benchmark that
happened to cover a live event — with the call, the confidence, the levels, how it ended, what it
returned and whether the watch paper traded it. What it returned is given in R as well, beside the
percentage and in the totals over the lines: the net over what the call's own stop would have
lost after the same fees and slippage, so a clean stop-out is −1 R wherever the model put its
stop, and models whose stops sit near and far can be compared. It filters by model, pair, call
and day, and **Save as a spreadsheet** writes the lines on screen to a CSV through the save
dialog the Backtest page uses, R in its `r` column; its times are UTC, and an entry or an exit is
given as the minute it happened in, named as its candle is, by when it opened. Loading it reads
two files, scoring reads public candles, and nothing is stored (`src/agents/journal.ts`).

#### One trade's whole story

**Timeline**, on any journal line and on the card of every paper trade the watch opened
(Strategies › Execution), lays out what happened to one recommendation, step by step and in UTC:
- **the event**: its pair, type, score, rank in its minute and price;
- **every model's answer** about it: when, the call and its confidence, the version the provider
  actually served when that differs from the one asked for, how long it took, who asked, and a
  refusal with its reason;
- **the paper position** the watch opened on it: the stake, the entry range and when it expired,
  the stop, the target and the longest hold;
- **its entry**: the minute and the fill;
- **its end**: why it closed and what it made or lost after fees, or that it never entered.

Under the steps, three prices sit side by side: the price the model saw, the range it named, and
the fill. Where there is no fill, the line says why: no position was opened, the entry never
traded, it was stopped first, or it is still waiting.

**Nothing new is stored.** Each step is a record the app already keeps, joined by the ids that
link them:
- the event's id is on every answer about it;
- the event's id and the followed model are on the paper position;
- the fill comes from the position's own candles, replayed by the simulation its card runs;
- how it ended is what the watch wrote when it stopped it.

One link was never recorded. When the watch opened nothing on a call it would act on, the
timeline says so and that the reason was not recorded: paper trades may have been off, another
model followed, or a limit or the paper account may have stopped it. It does not guess which.

This is the V3 document's chain (its sections 65–67):

| Document's link | Record in this app |
|---|---|
| MarketEvent | the event |
| AiRecommendation | the call ledger's rows |
| TradeIntent, RiskDecision | the paper position the watch opened when its checks passed |
| ExecutionResult | the replayed fill |
| TradeOutcome | the result written on the position |

Code:
- `shared/tradeLifecycle.ts` assembles it.
- `src/agents/watchTradeRecords.ts` reads the records.
- `tests/tradeLifecycle.test.ts` pins both.

The timeline reads four things through the bridge: the events, the calls, the settings and public
candles. `tests/aiNoLivePath.test.ts` holds it to that. It writes nothing, offers no order form,
and mentions no bridge a real order travels over.

**Checked in the app, at no cost** (5 October 2026, UTC):
- **Setup:** a separate build on a scratch profile with no key, the watch off, and no model
  reachable. Seeded on file: one BTCUSDT event three hours earlier and three answers about it, one
  followed by a paper trade, one acted-on call with none, and one refused. The trade went in
  through the app's own settings write and was replayed on Binance's real candles.
- **The card:** its timeline showed all seven steps and the three prices, and hid again.
- **The journal:** each of its three lines told its own story. The followed call showed the fill.
  The acted-on call said the watch opened nothing and that why was not recorded. The refusal said
  it was not a call this app acts on, with no range named.
- **Writes:** no write reached an exchange, and the one executor on file was unchanged.

**Checked in the app, at no cost** (5 October 2026, UTC): a separate build on a scratch profile,
the models faked in the main process, and made-up markets on a few pairs so that the real
scanner raised real events on them. With paper trades off, the watch asked and opened nothing.
Switched on, the followed model's call opened one paper position, a second waited for its entry,
and a third call was refused by a cap of two, with the reason on the Watch card. Positions ended
by their target, by their stop and by an entry that expired were each stopped by the watch within
a minute; each card said how it ended, the Watch card added them up, and a paper account moved by
exactly the figures on the cards and not at all for the trade that never entered. Two trades
whose price had already left the model's range when the answer came — one under it and falling,
one over it and rising — never entered, and the journal scored both recommendations "never
filled". A model that failed three calls running was not asked a fourth, by the scheduler or,
asked directly, by the main process. Right now, the status on each card, Why this pair, the
journal (loaded, scored, filtered and saved as a spreadsheet), Lately, and a benchmark run
recorded as an experiment and opened again without asking a model all showed as described. No
order or other write was sent to an exchange, no tool was offered to a model, and every executor
on file was paper. A card's figure is the executor engine's, after its fees; the journal's is the
recommendation's score, which charges slippage as well, so one stop-out read −1.998 USDT on a
stake of 100 on its card and −2.24% in the journal.

**From a call to an order, by hand.** A call to buy that this app would act on — answered,
accepted, at 65% confidence or more — carries a **Prepare an order from this call** button on the
Analyze view of AI Decisions for as long as its candle is open. The button opens the New Executor form as a
Position on that market, with the model's own stop and target turned into distances from the price
it was shown, and its horizon as the time limit. That is all it does:

- **The amount is never filled in from a call.** A model is not asked for one, and what a call is
  worth risking is the user's decision and the risk limits'.
- **The form opens on paper**, as every new executor does. Real money still means ticking Live
  Trading for that order, typing the confirmation phrase, and passing every gate in
  [Live Trading](#live-trading--real-money) — the same path as an executor made by hand.
- **Nothing is created until the form is submitted.** A buy below 65%, a hold, a sell, a refused
  answer and a call whose candle has closed get no button, and the card says why.

The executor's card records which call its form was filled in from. `shared/aiProposal.ts` holds
the rules; `tests/aiProposal.test.ts` pins them, including that the form's mode is set by its own
checkbox and by nothing else.

The same button is on a running GPT Intraday bot's card and detail view, for the call the paper
bot itself just opened a position on — not for one made while it was already long, which is a call
about holding and opens nothing. The offer lasts as long as the call's candle, fifteen minutes,
and a bot makes its call when nobody is looking, so the desktop is told once: what was called,
until when, and that nothing has been placed.

**Reasoning effort.** Most of what a call costs, and most of its wait, is the model's reasoning. A
model that takes a reasoning effort can be enabled a second time at a lower one, under Settings › AI
— `openai/gpt-5-mini@low`, `@minimal` — and is then a model of its own everywhere: cached, priced
from its own history, benchmarked, routed to and pinned on a bot under that id. Only the request
takes it apart, asking OpenRouter for the model and passing the effort as a parameter; an id with
no effort is sent exactly as it always was, with no reasoning parameter at all. First real calls on
`gpt-5-mini`: about $0.0033 and 14 seconds at its default, $0.0019 and 9 seconds at low, $0.0010
and 4 seconds at minimal. Whether the cheaper ones answer as well is not assumed: AI Benchmark
puts the same questions to each, and the first such run is reported under *What this does not
show* below.

**AI confirmation of a strategy's entries.** GPT Intraday asks a model what to do on a schedule.
This is the other way round: the strategy decides exactly as it always has — its rules, its stop,
its exits — and a model is asked only when it signals an entry, to confirm that trade or veto it.
It is a tick box on the Backtest page and in the Add Bot dialog, for every strategy except GPT
Intraday.

- **The model can only remove a trade.** The one thing read from its answer is whether it said
  "buy" at 0.65 confidence or better. A hold, a hesitant buy, an unusable answer and a model that
  could not be reached all leave the account flat; nothing it says opens, closes, sizes or moves
  anything.
- **A veto removes the whole trade**, so each trade is asked about once. The account stays out
  until the strategy would have closed the position it was vetoed out of, and the next question
  is about the strategy's next trade. The first version held a veto only until the entry signal
  dropped, and on real candles a breakout signal drops and re-fires within the hour: the same
  trade was vetoed three times and then confirmed, 28 calls for 9 trades. A veto that can be
  outlasted by asking again is not a veto.
- **What it is shown** is the same snapshot as above on the strategy's own bar size (672 of its
  bars, ending *with* the bar it signalled on, since that is the close the entry fills at), plus
  the strategy's name, its rule, its stop distance and its own readings on that bar — the four
  trend lookbacks and how far above each the close sits, or where the close sits in the 2/3/5/8-day
  channels.
- **What a backtest reports** is the strategy alone beside the strategy with the vetoed trades
  missing, and every ruling beside the trade it confirmed or removed. That second column is the
  point: a veto that skipped a loser and one that skipped a winner look the same on an equity
  curve. Under thirty reviews the page says the gap between the two rows is not evidence.
- **A bot** reviews only entries signalled after it was switched on, on bars that have closed.
  Stopped, it asks nothing, so its chart is free to open.

**Model benchmark.** AI Decisions › Signals scores whatever each model happened to be asked, and
those are different candles for every model: a better hit rate there can mean an easier week.
**AI Benchmark** fixes the questions first and asks every ticked model all of them.

- **The question** is GPT Intraday's, with the account holding nothing: at each sampled 15-minute
  candle, the seven days before it. The position is always flat because it is part of the
  question — a tape walks a position machine, so two models stop being asked the same thing at
  the first decision they disagree on. It is also the very question a flat bot, a backtest or
  Analyze asks at that candle, so answers are shared with them through the cache in both
  directions.
- **The sample** is a period (7 to 90 days) and a spacing (1 hour to 1 day; 4 hours by default, so
  that no two calls are scored on the same candles), at most 672 decisions per model and six
  models. Candles are taken on the clock (00:00, 04:00, 08:00 UTC …) rather than counted back
  from now, so running the same benchmark tomorrow asks only about the new candles. Nothing newer
  than four hours is sampled: an answer that cannot be scored yet buys nothing today.
- **Only decisions every model answered are compared**, so no model is scored on easier candles
  than the one beside it. A run that stopped early leaves the models with different numbers of
  answers; each row says how many it has, and running again asks only for what is missing. Calls
  are made candle by candle, not model by model, so what was bought before a stop is comparable.
- **What it reports**, per model and for "buy every time" (the market itself on those candles,
  and the rate a model has to beat to be adding anything): how often it acted; its hit rate at
  four hours with a 95% margin — two models whose ranges overlap have not been told apart; the
  mean move, best and worst price inside the four hours after a buy; hit rate by confidence; what
  taking each entry and holding it four hours would have returned after costs, and its drawdown;
  median latency and cost per answer; how often each pair of models made the same call; and every
  decision with what each model said and what price did next.
- **Pressing Run spends nothing by itself.** It reads the cache first. If any answer is missing
  it says, per model, how many calls remain and what they are expected to cost, and whether that
  is more than the budget has left. Declining shows what is already held. Leaving the tab stops
  the run; a model that fails three calls running is dropped and the others carry on.

**Benchmark on events.** The clock benchmark asks about one market at fixed times, and the 90-day
run below found nothing there. AI Benchmark's second view, **Events across the market**, asks
the Opportunities question instead — about the minutes the scanner would have raised — and scores
each recommendation by following it.

- **Only *Run benchmark* can spend.** *Find events* is free: it reads 7, 14 or 30 days of 1-minute
  candles for the 10, 20 or 40 most traded pairs, runs the detector the live scanner runs, and
  takes a sample of at most 50 to 300 events. *Run benchmark* asks each ticked model about each
  sampled event it has not answered, after stating the price and the time.
- **The period ends a day back**, at the last UTC midnight at least 25 hours ago, so every
  recommendation has had its hour to enter and its day to run before it is scored. It is anchored
  to the day, so tomorrow's run covers the same days and one more.
- **The sample is chosen by a hash of each event's own id**, each type in proportion to how many
  of it there are (`sampleEvents` in `shared/aiEventBenchmark.ts`). Whether an event is in it does
  not depend on which others were found, so a longer period keeps the events a shorter one had and
  their answers come from the cache; and a hash cannot prefer the events that turned out well,
  which choosing "the strongest" quietly would.
- **A run that asks a model is recorded, with its events** (`shared/aiExperiment.ts`, kept in
  `userData/aiExperiments/experiments.jsonl`). The hash keeps a sample steady only while the same
  events are found, and they are not: the most traded pairs are ranked by the last 24 hours. A
  day after the run below, the same settings found 220 events where it had found 214, and
  brought back 80 of its 100. So each run is written down under an id (`EXP-2026-1004-001`): the
  period, the pairs, every sampled event as it was found, the models asked, the versions of the
  prompt, the context, the schema and the detector, the fees, slippage and fixed bracket it is
  scored with, and its calls and dollars, counted by the main process from the ledger rows those
  calls wrote. The **Experiments** list opens one: its own events are read again, with the
  answers held for them, for nothing. Tick another model there and *Run benchmark* asks it about
  exactly those events, and that run is recorded beside the first. Results are still never
  stored, and an experiment opened under a changed detector or changed scoring says so above its
  tables. The detector's version is pinned the way the prompts are: a hash of what it makes of
  one fixed market sits beside the version in `tests/marketEvent.test.ts`.
- **The answers are the Opportunities page's**, through the same cache, in both directions: an
  event a benchmark paid for shows its answers on that event's card, and the reverse.
- **Only events every model answered are compared.** A recommendation is acted on when it takes a
  side at 65% confidence or more, and is then followed to the letter on 1-minute candles —
  `shared/aiOpportunityOutcome.ts`, the same scoring as a card. A replayed answer is taken to have
  arrived ten seconds after the event plus however long that model took to give it, so a slow
  model enters a minute or two later here exactly as it would live.
- **What it reports**, per model: buys, sells and no-trades; how many were acted on, how many
  expired unfilled; the win rate with a 95% margin; every closed trade's net return added up, and
  the mean; the same added up in R, each trade's net over what its call's own stop would have
  lost (since 5 October 2026), which is what compares a model that sets near stops with one that
  sets far ones; gains over losses; the deepest fall of the running total; the average hold; median
  wait; what the answers cost; the result at $1,000 a trade before and after that cost, and per
  dollar of it; the best and worst price inside a trade; and the period cut into three consecutive
  parts, because a result that holds in one part only is a stretch of market and not a model. A
  rate is withheld under 30 closed trades, and a slice (by event type, side, holding time or
  confidence) under 10. There is no overall score: its weights would be invented.
- **Two rows are not models.** *Follow every event* and *fade every event* take the same events
  with one fixed bracket — a stop 1.5 usual fifteen-minute moves away, a target 3, one hour — and
  no judgement. They are on screen as soon as the events are found, before anything is asked, and
  a model is worth its price by as much as it beats them. On the first sample looked at (50
  events on the ten most traded pairs, 26 September to 3 October 2026) following lost 4.3% of a
  stake over 50 trades and fading lost 23.3%, and the run below lost more on a second: what
  `research/EVENTS.md` found over years, that neither is a trade.
- **Three more rows are the models combined**, worked out from the answers held and costing
  nothing: a side taken when more than half the models take it and none takes the other, when all
  do, or when its confidence outweighs the other side's and the abstainers' together. A rule has
  no levels of its own, so it trades those of the model surest of that side, and it cannot act
  until the slowest model has answered.
- **What each model changed.** A model's row runs two things together: which events it chose, and
  the levels it traded them with. This table pulls them apart with the one thing that is the same
  for every event, the fixed bracket. Beside a model's own trades it puts the bracket on the same
  calls, on the side the model took — what "follow every event" would have traded had it waited
  for the model to confirm it — and the bracket on the events the model let go. Three figures in
  net a trade follow: how far the model came out from following everything, how much of that was
  its choice of events, and how much its levels. The last two add up to the first. The page also
  says what a coin tossed for the side is expected to return: the average of the follow and fade
  rows.
- **How the trades ended**, for every row: at the target, at the stop, when the holding time ran
  out, and how many entries never filled. A stop that is hit nearly every time and a target that
  is never reached are two different ways to lose, and a net figure shows neither.

One real benchmark on events has been run, on 4 October 2026: 100 events sampled from the 214
the detector finds on the twenty most traded pairs between 19 September and 3 October, put to
three models. It made 300 calls in eight minutes and cost $0.69. Scored on the 95 events all
three answered (OpenRouter refused Mistral Small for rate on the other five):

| | Took a side | At 65%+ | Closed | Won | Net, added up | A trade | Median wait | Per answer |
|---|---|---|---|---|---|---|---|---|
| `openai/gpt-5-mini` | 94 | 68 | 63 | 30% ± 11 | −9.70% | −0.15% | 14.5 s | $0.0043 |
| `openai/gpt-5-mini@minimal` | 32 | 32 | 30 | 30% ± 16 | −0.75% | −0.02% | 2.2 s | $0.0015 |
| `mistralai/mistral-small-2603` | 94 | 94 | 73 | 34% ± 11 | −25.37% | −0.35% | 2.0 s | $0.0011 |
| Follow every event, no model | 95 | 95 | 95 | 31% ± 9 | −17.87% | −0.19% | | |
| Fade every event, no model | 95 | 95 | 95 | 32% ± 9 | −33.86% | −0.36% | | |
| More than half agree | 71 | 71 | 58 | 38% ± 12 | −10.07% | −0.17% | | |
| Weighed by confidence | 77 | 77 | 63 | 41% ± 12 | −10.15% | −0.16% | | |
| All agree | 29 | 29 | 26 | too few | +0.79% | | | |

No model made money, and none is told apart from following every event with no model at all: the
win rates sit inside one another's margins, and all three models lost in the second and the last
third of the fortnight. The sides they took say why. Of the 100 sampled events 59 were breakouts
and 41 breakdowns, and not one accepted answer went against the move: `gpt-5-mini` took the
move's side 99 times in 100, Mistral Small every time it answered, and minimal effort either
took it (34) or declined (66). Each model here is "follow every event" with its own levels and
its own willingness to act, and following is the row `research/EVENTS.md` found does not pay.

What separated them is how often they acted and what they asked for. Minimal effort lost least
by declining two events in three. Mistral Small lost most: it acted on every one at a median
confidence of 82%, set its target nearer than its stop (a median 1.3% away against 1.6%, where
both settings of `gpt-5-mini` asked for 2.9% against 1.5%), and named an entry range half as wide
as theirs, which the price had left before a fifth of its entries (21 of 94) could fill. The
three agreeing left 26 closed trades at +0.79%, which is too few to read. This is one fortnight
and one sample of it; what it does say is that these models, asked this question, add a filter
to a trade that loses, not a view of their own.

A day later the run was reopened from its record, for nothing, and read through the two tables
that pull a model's result apart. Net added up, with the closed trades in brackets; the last
three columns are net a trade:

| | With / against the move | Its calls, its levels | Same calls, fixed bracket | Events it left, followed | Against following | From its choice | From its levels |
|---|---|---|---|---|---|---|---|
| `openai/gpt-5-mini` | 68 / 0 | −9.70% (63) | −10.18% (68) | −7.69% (27) | +0.03% | +0.04% | −0.00% |
| `openai/gpt-5-mini@minimal` | 32 / 0 | −0.75% (30) | −0.93% (32) | −16.95% (63) | +0.16% | +0.16% | +0.00% |
| `mistralai/mistral-small-2603` | 94 / 0 | −25.37% (73) | −23.92% (94) | +6.05% (1) | −0.16% | −0.07% | −0.09% |

`gpt-5-mini` changed nothing. On the 68 events it acted on, its own entries, stops and targets
returned −9.70% and the fixed bracket −10.18%; the 27 it passed over lost the rule 0.28% a trade
against 0.15% on the ones it took, a gap 27 trades cannot show to be more than chance. Minimal
effort lost least, and all of that was which events it acted on: the bracket on its 32 calls lost
0.93%, as its own levels did, while following the 63 it declined lost 16.95%. That is +0.16% a
trade over 32 trades, which a fortnight cannot tell from luck either — and it is the one figure
here worth asking again on more events. Mistral Small did worse than the rule on both counts. Its
levels cost 0.09% a trade against the bracket on the same calls, and the whole of its −0.07% from
choice is one event: the one answer the validator refused was on an event the rule made 6.05% on.

How the trades ended says what the events themselves are:

| | Closed | At the target | At the stop | Time ran out | Never filled |
|---|---|---|---|---|---|
| Follow every event, no model | 95 | 26 (27%) | 56 (59%) | 13 (14%) | 0 |
| Fade every event, no model | 95 | 19 (20%) | 57 (60%) | 19 (20%) | 0 |
| `openai/gpt-5-mini` | 63 | 7 (11%) | 15 (24%) | 41 (65%) | 5 of 68 |
| `openai/gpt-5-mini@minimal` | 30 | 4 (13%) | 10 (33%) | 16 (53%) | 2 of 32 |
| `mistralai/mistral-small-2603` | 73 | 20 (27%) | 19 (26%) | 34 (47%) | 21 of 94 |

The fixed bracket was stopped six times in ten **whichever side it took**. Its target is twice as
far as its stop, so a price with no direction at all reaches the target first one time in three;
following did so 26 times in 82 and fading 19 in 76. What follows an event is movement, both
ways, with a lean toward continuing that is smaller than a round trip's cost. A coin tossed for
the side is expected to return −25.86% on these 95 events, between the two rows. And two trades
in three of `gpt-5-mini`'s ended on the clock: it asked for a target 2.9% away, held 67 minutes
on average, and the price seldom travels that far in that time.

So the two things worth paying to find out are whether a stronger model **chooses** events better
than these did, and whether any model does when it is shown what the rest of the market was
doing at that minute, which none of them was. Their levels, on this evidence, are not where a
model earns anything.

**The market around an event.** Every model above was shown one pair: its event and seven days of
its own candles. Whether it rose because everything rose, or rose alone, was not in the question,
and it is the first thing a person looking at a pump asks. An event can now be put as a second
question that has it (`shared/aiEventMarket.ts`):

- **A `market` block**: what BTCUSDT and ETHUSDT did over the same fifteen minutes, hour, four
  hours and day, up to the minute the event was read, and the pair's own return over each less
  theirs (`vsBtc`, `vsEth`). It is rebuilt in the main process from the candles sent with the
  question, as the event is, and nothing at or after the event's minute is read. Where either
  market's candles do not run unbroken to that minute the question is refused, not asked with
  half a market.
- **It is a separate question, `opportunity-v2`.** Its prompt is the first one with one paragraph
  more, saying what the block is and not what it means; both texts are pinned by a hash beside
  their version. The question about the pair alone is byte for byte what it was — a test holds
  the hash of its bytes from before the second existed — so no answer already bought moves, and
  the two questions are cached and billed apart.
- **The benchmark asks either.** *Question* on Events across the market chooses one. A sample
  fetched with the market holds both, because the pair-alone question is the same candles
  without Bitcoin's and ether's, so a card can set each model's answers to the two side by side,
  over the events it answered both ways. Bitcoin's and ether's candles are four public requests
  more an event. The Experiments list says which question each run asked.
- **Two labels, drawn by fixed lines and never by a model**, cut the results: whether Bitcoin's
  last four hours were rising, falling or flat (1% either way), and whether the event's move was
  made with the market — Bitcoin went the same way over the same fifteen minutes by at least half
  as much — or on its own. Results are also cut by how much the pair trades, by the two lines its
  slippage is charged by ($50M and $5M a day).
- **Ask and the watch still put the pair alone.** The second question replaces the first only if
  it is shown to do better on the same events, by a rule written down before the first run's
  results were read: for `openai/gpt-5-mini`, the model the watch asks, the question with the
  market has to return more a trade than the pair alone in each of the three parts of the period,
  and its win rate has to beat the other's by more than the 95% margin around it. Anything less is
  two questions that cannot be told apart, and the first one stays.

The first run of the second question, on 5 October 2026, put the 100 events of
`EXP-2026-1004-001` again, each with the market around it, to the same three models. The app
stated $0.84; it made 208 calls and cost $0.60 (`EXP-2026-1005-001`). OpenRouter rate-limited
Mistral Small after four answers, and again when its missing ones were asked a quarter of an hour
later, so it is left out: both settings of `gpt-5-mini` answered all 100 events both ways, and
these are the same events, the same candles and the same scoring, with only the question changed.

| | Question | Acted on | Closed | Won | Net, added up | A trade | First / second / last third |
|---|---|---|---|---|---|---|---|
| `openai/gpt-5-mini` | the pair alone | 73 | 68 | 28% ± 11 | −13.77% | −0.20% | −1.25% / −5.50% / −7.02% |
| `openai/gpt-5-mini` | with the market | 57 | 56 | 29% ± 12 | −19.71% | −0.35% | +4.69% / −8.94% / −15.46% |
| `openai/gpt-5-mini@minimal` | the pair alone | 34 | 32 | 28% ± 16 | −1.25% | −0.04% | +3.58% / −1.85% / −2.98% |
| `openai/gpt-5-mini@minimal` | with the market | 36 | 33 | 27% ± 15 | −6.14% | −0.19% | +3.02% / −5.78% / −3.39% |
| Follow every event, no model | | 100 | 100 | 31% ± 9 | −18.92% | −0.19% | |
| Fade every event, no model | | 100 | 100 | 31% ± 9 | −34.25% | −0.34% | |

Shown the market, `gpt-5-mini` acted on 57 events instead of 73 and lost more on them, and it
still took the move's side every time (57 with it, none against); minimal effort acted on about as
many as before and lost more too. By the rule above, the second question does not replace the
first — it did better in one third of the period of three, and the win rates sit inside each
other's margins — so Ask and the watch keep asking about the pair alone. The cuts by the market
around each event find no stretch where following paid either: a move made on its own lost 0.19%
a trade over 71 events and one made with the market 0.18% over 29; with Bitcoin flat over four
hours following lost 0.25% a trade (62), rising 0.11% (23), falling 0.06% (15). What these models
were shown changed how often they acted, not which side they took or how well they chose.

**Three frontier models on the same events** (5 October 2026, `EXP-2026-1005-003`): Claude
Sonnet 5.5, GPT-5.6 Sol and Gemini 3.1 Pro Preview, put the question about the pair alone — the
one that stays. The app stated $6.31; the run made 206 calls and cost $3.72, with the daily
budget raised for it so that no more than $8.85 could be spent, and put back to $5 afterwards.
Gemini 3.1 Pro's first six answers were all refused by the validator (a recommendation, a
confidence or a rationale missing or out of range), and the run stopped asking it, as a run does
after five refusals in a row; those six cost $0.23. A refused answer now keeps the start of what
the model sent on its ledger row (`answerExcerpt`), so the next one can be read without being
bought again. On the 95 events every other model answered:

| | Took a side | At 65%+ | Closed | Won | Net, added up | A trade | Per answer |
|---|---|---|---|---|---|---|---|
| `anthropic/claude-sonnet-5.5` | 9 | 0 | 0 | — | — | — | $0.018 |
| `openai/gpt-5.6-sol` | 40 | 35 | 30 | 17% ± 13 | −19.20% | −0.64% | $0.017 |
| `openai/gpt-5-mini` | 94 | 68 | 63 | 30% ± 11 | −9.70% | −0.15% | $0.0043 |
| `openai/gpt-5-mini@minimal` | 32 | 32 | 30 | 30% ± 16 | −0.75% | −0.02% | $0.0015 |
| `mistralai/mistral-small-2603` | 94 | 94 | 73 | 34% ± 11 | −25.37% | −0.35% | $0.0012 |
| Follow every event, no model | 95 | 95 | 95 | 31% ± 9 | −17.87% | −0.19% | |
| The five weighed by confidence | 49 | 49 | 40 | 33% ± 15 | −9.06% | −0.23% | |

Claude Sonnet 5.5 traded nothing. It named a side on ten of the hundred events, every time at 50%
confidence, and called no trade on the rest at a median of 60% — under the 65% this app acts on,
every time. GPT-5.6 Sol acted on 37, every one of them on the move's side like the others, and
lost the most a trade of any model here: its choice of events cost 0.22% a trade against
following everything, and its levels another 0.22%; it was stopped out in 14 of its 30 closed
trades, `gpt-5-mini` in 15 of 63. Neither is told apart from following every event, let alone
from a model a quarter of the price, so no frontier model goes on the watch: it keeps asking
`gpt-5-mini`. On this question a frontier model adds caution, or a costlier version of the same
bet.

**Model routing.** A cheap model can be asked every fifteen minutes for a few dollars a month. A
frontier model asked the same way costs several times that, and nearly all of it buys the answer
"hold". A route asks the default model at every decision and passes the decision on to a second
model only when a rule says so; the second model's answer is then the decision. It is set on
Settings › **AI** and is off until someone sets it.

- **Two rules.** *When the first model wants to open or close a position*: nothing is traded on
  its word alone — it screens, the second decides. *When it answers with less than 65%
  confidence*: what it is sure of stands, a confident entry included, and the second model takes
  the rest. Both read the one confidence gate the position machine already has.
- **The second model is asked the same question**, and is not told what the first said: the same
  context under the same prompt, so its answer is filed under the key any other call to that
  model about that candle uses. A route never pays for an answer a benchmark, a backtest or
  Analyze already bought, and they never pay for one a route bought. Nothing downstream changes:
  the position machine, its stop and the engine read a routed decision like any other.
- **Only an answer is passed on.** A call that never reached the first model stays a failure,
  uncached and asked again. It is not handed to the second model, whose answer would be replaced
  by the first's as soon as that one could be reached.
- **It can be judged before it is switched on.** A routed decision is a function of two ordinary
  answers, so AI Benchmark works out what a route between any two of its models would have
  done — how many decisions it passed on, its entries, hit rate, held-four-hours return and cost
  per decision — from answers it already holds, asking nothing. Every question in a benchmark is
  asked with the account flat, so that table shows how a route would have chosen entries, not
  exits.
- **Where it applies** is a GPT Intraday backtest and a bot being switched on, and both say so
  first: the confirmation names both models, the rule, and each model's share of the ceiling. The
  second model's share is every decision still open, because which ones the first will pass on is
  not known until it has answered. A bot is pinned to the route it was switched on with, and
  every request it makes names that route or says it has none — so a bot switched on before
  routes existed, or one already running when the setting changes, goes on asking one model. The
  chart, Analyze, a benchmark's own calls and entry confirmations always ask one model.

`research/gptroute.ts` measured what a second opinion buys, the way `gptneed.ts` and
`gptcadence.ts` measured the bar itself: two synthetic signals of the same known accuracy, the
second asked only when the first wants to trade, through the shipped rule, strategy, engine and
fees over three years of BTCUSDT. The one new knob is how alike the two are: the share of
passed-on decisions on which the second model simply makes the first one's call, right or wrong.
Lowest accuracy of each model that does not lose money:

| The second model is | Asked every hour, first acts on 25% | every hour, acts every time | every 4 hours, 25% | every 4 hours, every time |
|---|---|---|---|---|
| not asked (one model alone) | 72% | 88% | 68% | 67% |
| wrong independently of the first | 62% | 66% | 58% | 59% |
| half alike | 67% | 79% | 63% | 64% |
| 90% alike | 71% | 87% | 68% | 66% |
| the same opinion, asked twice | 72% | 88% | 68% | 67% |

A second opinion is worth exactly as much as its mistakes differ from the first model's. Two
models that are each right 60% of the time are right 69% of the time on the trades both want if
they err independently, 61% if the second makes the first's call nine times in ten, and 60% if it
is the same opinion — at which point the route has changed nothing but the bill, 1.1 to 1.5 calls
a decision. Two models reading the same seven days of candles are unlikely to be independent,
which is why AI Benchmark shows how often each pair made the same call beside what a route
between them would have done. The rule that passes on what the first model is unsure of is not
in this table: it turns on how a model's stated confidence relates to its being right, which a
synthetic signal cannot say and a real benchmark can.

**A panel of agents.** One model asked one question gives one answer. A panel splits the question
three ways: a **trend** analyst says what the regime is, a **momentum** analyst says whether
anything is moving on the base interval right now, and a **risk** analyst says whether a long is
attractive given what the account holds. A fourth call makes the **decision**: it is shown the
same snapshot again with the three reports on the end, and answers in the shape every other
signal has. Four calls to one model instead of one.

- **It is a decider, named like a model**: `panel:` in front of the model it runs on. Its answer
  is an ordinary decision, so the validator, the position machine, the tape, a benchmark's scoring
  and a route treat it exactly as they would a model's.
- **An analyst is not asked whether to trade**, and its report has no field to say so in — three
  reports with a "buy" in each would be a vote, not a division of labour. The decision is told
  the reports are evidence to check against the snapshot, not instructions.
- **Where it can be chosen** is where its price is stated first: Analyze (the button carries the
  cost of all four calls), a benchmark (ticked beside its own model, marked "4 calls an answer"),
  and the second step of a route, where it is asked only about the decisions the first model
  passes on. It cannot be made the default model and is never "enabled", so the chart, an entry
  review and every bot switched on before it existed go on costing one call a question.
- **Each of the four calls is cached, budgeted and recorded on its own**, under the model it was
  made to. They are made one after another, so a run still passes the daily budget by at most
  one call, and a panel the budget stops half-way keeps the reports it has and resumes with the
  rest.
- **A panel that cannot hear from an analyst does not decide.** An analyst that could not be
  reached makes the decision a failure, asked again next time. An analyst whose answer the
  validator refused makes it a refused answer — cached, treated as a hold — and the decision is
  not asked for at all.
- **It can be measured against the model it runs on.** Ticked together in a benchmark, the two
  are asked the same questions and scored side by side, and the route table then shows "the
  model, then its own panel when it wants to trade" from those same answers at no further cost.

**What it costs, and what bounds that.** Every call bills the user's own OpenRouter credits, so:

- Each path that can spend asks first, naming the model and an estimate — a backtest before it
  runs, a bot before it is enabled, the chart overlay by staying off until switched on. A stopped
  GPT Intraday bot fetches nothing at all. A confirmed backtest reads its cache first, so a rerun
  of something already paid for never reaches the question.
- A **daily AI budget** (default $1.00, held in `aiConfig.json`, checked in the main process
  before every paid call) stops whatever is running when it is reached. `0` switches AI calls off.
  It is checked before each call rather than reserved, so a run passes it by the calls already in
  the air: one for a backtest or a bot, up to four for a benchmark. A panel's four calls are made
  one at a time, so it changes neither figure.
- Every answer is cached under a hash of the question and the model, so a rerun is free and a run
  stopped by the budget resumes where it left off. A call that never got an answer is *not*
  cached — a failure must be asked again, or one bad afternoon is cached for good — while an
  answer the validator refused *is*, because the model was paid for it either way.
- A refused key, an empty balance or an unknown model stops a run on its first call instead of
  being retried for every candle, and five failed decisions in a row stop it too.
- **A provider that says to wait is waited for.** A call refused for rate (429), for time (408) or
  by a provider that is down (5xx) is tried twice more, after a pause that doubles — and when the
  refusal says how long to wait (Retry-After) it is waited for, up to 30 seconds. One that asks for
  longer fails at once rather than holding a run up, and its question is asked again the next time
  the run is. None of these was billed: a call that was never answered costs nothing.
- **No model is asked more than so many times a minute** (Settings › AI › Pace: 10, 20, 30 or
  60; 30 unless changed), whoever asks — a benchmark, the watch, a bot or a click — held in the
  main process where every call is made. A call over the pace waits for its place; nothing is
  refused. A benchmark asks four questions at once and a fast model answers each in two seconds,
  which is a hundred and twenty calls a minute, and on 5 October 2026 OpenRouter rate-limited
  Mistral Small after four answers, twice (`shared/aiPace.ts`). A benchmark's confirmation never
  states a time shorter than the pace allows.
- **Every answer says which model gave it.** A name like `openai/gpt-5-mini` can be pointed at a
  newer model on any day, so each call's ledger row keeps the version OpenRouter says answered
  (`servedModel`), and a recorded experiment keeps, for each model it asked, the versions that
  answered it; the Experiments list shows them where they say more than the name.
- So do five *refused* answers in a row, and those matter more: a refused answer was reached,
  answered and billed. A model listed as taking a strict schema can still fail to fill this one —
  `google/gemini-2.5-flash` sent back four tokens the validator refused on its first real call —
  and nothing else would stop a run paying for every one of them. A tape stops before buying the
  sixth, and stops in the same place for nothing when it is run again; a benchmark stops asking
  that model and carries on with the others.
- A decision is asked for once however many parts of the app want it at the same moment. One
  running bot is polled by its card, its detail view, the Positions page and the portfolio
  scheduler.
- A bot keeps the model it was switched on with, and the route if it had one. Changing the
  default or the route does not move a running bot onto another model, or start it asking two.

**What a call has actually cost.** The first real calls (`openai/gpt-5-mini`, October 2026) took 9
to 13 seconds and about $0.003 each: some 2,900 tokens in and 800 to 1,100 out, nearly all of the
output being the model's reasoning, which is billed as output. A tape asks one question at a time,
so 672 decisions on that model is about $2 and two and a half hours, and it reaches the default
daily budget about half-way: the run stops there, and resumes from the cache once the budget allows.
Against a faked transport every call had taken milliseconds, so nothing had ever shown it. A
backtest's and a benchmark's confirmation now state how long the run will take beside what it
will cost, from the pace that model has answered at here, and say so when it has no pace yet.

Every call is one line in `aiLedger/calls-YYYY-MM.jsonl`: the model, the versions of the prompt,
context and schema, what it cost, and what it said. A panel's decision is four lines, each marked
with its part; the three analysts' lines carry a report and nothing to score. Outcomes are **not**
stored — they are recomputed from candles whenever AI Decisions › Signals is opened, like every other
simulated figure here.

Each prompt is pinned to its version by `tests/aiPromptVersions.test.ts`, which holds a hash of
every prompt text and schema beside the version it is cached under and fails when one is edited
without the other.

**What this does not show** is that any model is worth trading on. `research/gptneed.ts` measured
what a 15-minute signal needs before GPT Intraday makes money at all: roughly 72–75% of its calls
right at a four-hour horizon, with a coin flip losing 89–100% of the account to the fee. A
seven-day backtest closes eight or nine trades, far too few to place a model on that scale. The
Signals view scores every *decision* rather than every trade, which is what makes the question
answerable at a price worth paying, and it withholds a hit rate below thirty scored calls.

A benchmark answers a narrower question than it may look: which model's calls were better on one
market over one stretch, each call judged alone at four hours. It is not a backtest of the bot,
whose results also depend on its stop and on when the model later says sell.

Two real benchmarks on a clock have been run, and the second took back what the first seemed to
say. Both are on BTCUSDT, one decision every four hours, ending 3 October 2026.

The first was `openai/gpt-5-mini` alone over 30 days: 180 decisions, $0.59. It said buy 40 times
and was right at four hours on 16 of them — 40% ± 15, against 28% ± 7 for buying on every one of
those candles. Its 16 buys at 65% confidence or more, each held four hours, made +4.9% after
costs, against +4.2% for simply holding throughout.

The second ran 90 days, 540 decisions, with two cheaper competitors beside it. Scored on the 537
decisions all three answered:

| | Buys | Right at 4h | 65%+ buys, each held 4h | Median wait | Per answer |
|---|---|---|---|---|---|
| `openai/gpt-5-mini` | 139 | 32% ± 8 | −4.2% (47 trades, 17 won) | 13 s | $0.0033 |
| `openai/gpt-5-mini@minimal` | 156 | 28% ± 7 | −10.2% (106 trades, 36 won) | 2.2 s | $0.0010 |
| `mistralai/mistral-small-2603` | 9 | too few | −0.8% (9 trades, 1 won) | 1.7 s | $0.0007 |
| Buy every candle, no model | 537 | 30% ± 4 | −63.5% | | |

Buying once and holding made +33.1%. Over three times the sample, the model's buys were right as
often as the market's own candles were, and trading on them lost money in a quarter where holding
made a third. The good month is the last third of those ninety days; in the sixty days before it
the same model was right on 28% ± 9 of its buys against the market's 31% ± 5. Nothing here has
shown an edge, and the first result is a caution about reading one month of forty calls.

What the cheaper ways of asking did:

- **Minimal effort** is a third of the price and six times faster, and its hit rate is not told
  apart from the default's. What differs is how often it is confident: it took 106 entries where
  the default took 47, and lost more than twice as much.
- **Low effort** was asked the last 30 days only (178 decisions compared, $0.32): 33% ± 15 on 40
  buys, where the default made 40% ± 15 on its 40, and −5.6% on 19 entries. One month does not
  tell them apart either.
- **Mistral Small** fills the schema every time and almost never says buy: nine times in 537
  decisions. A model that abstains costs little and tells nothing.

OpenRouter began refusing Mistral Small for rate (429) part-way through the 90-day run. The run
dropped it after three failures in a row and carried on with the others, as it is built to, and a
second run bought the answers it had missed: the two together cost $2.48. Until that second run
AI Benchmark could compare only the 394 decisions all three had answered — the oldest
sixty-six days, which is a different stretch of market from the ninety the run was asked for, and
one in which the default model's entries lost 9.7%. The table's header says how many decisions
are compared and of how many. That is the number to read first.

A route has now been measured once, from those answers and for nothing. `gpt-5-mini` passing each
entry it wants to itself at minimal effort took 37 of its 47 entries and came out at 0.0% instead
of −4.2%: of the ten entries the second opinion removed, eight were losers. That is what a second
opinion is for. It is also one quarter, on one market, between two settings of the same model —
the pair whose mistakes are least likely to differ (`research/gptroute.ts`) — and breaking even
is not a result to trade on. Passing on the decisions it was unsure of did the opposite: 114
entries and −13.7%.

A panel is four times the price of the model it runs on, and nothing here says it is any better.
It is the same model reading the same snapshot, asked three narrower questions and then a fourth,
and `research/gptroute.ts` is the measurement that applies: more opinions help only as far as
their mistakes differ, and a panel's analysts share everything but their instructions. Its four
prompts have been put to a real model once — one decision on `openai/gpt-5-mini`: four accepted
answers, about a cent and 42 seconds — which shows they can be answered, not that the answers are
worth four times the price. The benchmark is where to find out, at four calls an answer — which is
why a panel can be ticked there and cannot be made the default.

AI confirmation has the opposite problem and no way round it: it is cheap because it asks rarely,
and for the same reason it is slow to judge. Trend Regime opens two or three positions in ninety
days, so a backtest of that length produces two or three reviews, and thirty of them is years of
one market or many markets side by side. Nothing has been measured yet about whether any model's
vetoes help.

### Credentials / API Keys

Connections › **Exchange API keys** lets you add a Binance API key/secret. Adding one
makes exactly one authenticated, read-only call (`GET /account`, to list balances) purely to
verify the key is valid before it's ever persisted — a key that fails verification is never
stored. Keys are encrypted at rest via Electron's `safeStorage` (OS keychain / DPAPI) in a
separate `credentials.json`, isolated from `settings.json` so a bug in general settings
persistence can never touch a secret. "No key, no live mode, ever": every live-trading code path
in this app requires a verified credential first.

## Live Trading — Real Money

**The path to live** (since 8 October 2026; the second V3 document's §56). Live Trading opens with a
read-only checklist of the document's safe workflow, each step read from what is on file
(`shared/livePath.ts`): a Binance key stored, and tested; paper trading in use (a funded paper account,
or the watch's paper trades on); the 1-hour and 12-hour test runs, read on a click against the
session report's gates; a position made from a call's filled-in form and placed by a person (named
as the form names it, or carrying the recommendation's entry range on paper); and the session armed.
It says how many are done and which is next, and opens and arms nothing: the key is on Connections,
the report on Performance, arming on the bar.

A verified Binance key unlocks live mode for five of the eight executor types. Each shipped as its
own reviewed, tested pass rather than as one big switch:

| Executor | What it does with real money |
|---|---|
| **Order** | One market or plain GTC limit order. Never exits on its own. |
| **Position** | A market entry, then an unattended watcher that exits automatically on take-profit, stop-loss, trailing stop or time limit — a real sell, with no per-exit confirmation. |
| **DCA** | A ladder of real resting limit orders. Once any level fills, one shared watcher exits the whole position from the average fill price. |
| **TWAP** | Buy-only. Splits one order into timed market slices placed by a main-process loop that keeps running whether or not a window is open. |
| **Grid** | Buy-only, and *not* full Grid: a bounded ladder of resting orders sharing **one** exit, which stops for good once it exits rather than cycling per level. The in-app warning says so before you confirm. |

Everything else stays paper-only: **XEMM, Arbitrage and Market Making** (they need cross-exchange
custody or short-selling, neither of which this app has), every non-Binance exchange, sell-side
DCA/TWAP/Grid, and the `limit_maker` / `limit_chaser` order types.

### Safety gates

Every real order and every real cancel/close passes through `electron/services/liveTradingService.ts`
— checked server-side (main process), immediately before the network call, never cached and never
trusted from the renderer:

| Gate | What it does |
|---|---|
| **Hard order-size ceiling** | An absolute, code-only constant (`HARD_MAX_ORDER_QUOTE`) no UI, setting, or IPC call can exceed — raising it requires changing the source and rebuilding. |
| **Max order size** | User-configurable, clamped server-side to the hard ceiling on every read/write. |
| **Daily cap** | A running total of live order notional placed today (UTC). A resting limit order reserves its full notional the moment it's placed (capital is committed then, not only once it fills) and refunds whatever doesn't end up executing once it resolves. |
| **Daily loss limit** | A true realized-P&L limit, backed by the live position ledger below — breaching it **auto-disarms** the session the instant the breaching fill is recorded, not on the next order attempt. |
| **Kill switch** | Persisted, stays engaged until manually released, blocks arming outright while engaged. |
| **Session-arm** | In-memory only, never persisted — resets to *off* on every app launch. Separate from the kill switch: this is the ordinary daily on/off, the kill switch is the emergency stop. |
| **Exchange health** (since 8 October 2026; the V4 document's §92-93) | The main process measures the data host once a minute with one public request for the time, and keeps the live-price socket's state and the key's last test beside it (`shared/exchangeHealth.ts`, `electron/services/exchangeHealthService.ts`). A **new** real position is refused while the stream has delivered nothing for a minute and REST has failed three reads running, the clock is over five seconds off Binance's, REST has taken over five seconds three reads running, or the key's last test failed; the bar says LIVE TRADING PAUSED and why, and Live Trading has the figures. A closing order is never refused by it: an open position keeps its protection. |

One gate is not user-facing and sits below all of these: **a signed request can only ever be sent
to a host that implements the trading routes.** Market data resolves from a wider list that
includes `data-api.binance.vision`, Binance's public data mirror — it is not geo-blocked, so it is
often the only host that answers, but it has no signed routes at all (`/account` returns 404, and
so would `/order`). Data and trading therefore resolve from separate lists with separate memos. In
a region where only the mirror is reachable, `resolveTradingEndpoint()` refuses outright rather
than handing back a host that would 404 a real, signed order in a way that reads like a bad API
key. `binanceFutures.ts` has always kept its own host for the same reason; spot now matches it.

Since 6 October 2026 market data also survives its host going quiet mid-session
(`fetchMarketData` in `binance.ts`). In a one-hour run of the app `api.binance.com` stopped
accepting connections for six minutes, and every candle request in them failed, because the data host
is chosen once and kept. Now:
- **A request that gets no answer, or a server error,** is asked once more of the other host serving
  binance.com's market: the exchange's own host and its public mirror stand in for each other.
- **The other host is kept** for the rest of the session once it answers with data. A 4xx is the
  host's answer and is not asked elsewhere; a rate limit is not a reason to ask another host.
- **binance.us is never tried** once a session has begun. It is a different market, and a host whose
  silence can take the process's other requests down with it.
- **When both are down,** the other host is asked at most once a minute, so each request fails in the
  time one host takes, not two.

Signed requests are untouched: they resolve their own host. Checked in the app with `api.binance.com`
cut off: the next candle request came from the mirror, and so did the following 65 requests, with the
scanner's pass finishing as usual.

**Closing or cancelling is never blocked by any of the above** (only by session-arm/kill-switch for
closes, and by *nothing at all* for cancels) — those gates exist to bound how much *new* risk a
single action can create, and closing/cancelling only ever reduces risk. Blocking either would risk
trapping someone in a losing position or a stale order at exactly the moment they most need out.

### Unattended loops (they run with no window open)

Two main-process loops act on real money without any UI attached, and keep running as long as the
app process is alive:

- **`livePositionWatchersService.ts`** evaluates every live Position/DCA/Grid exit barrier on a 5s
  tick and places the closing sell itself when one trips. One watcher per symbol+exchange. If it
  repeatedly fails to fetch a price it is *not* protecting anything, so consecutive failures are
  surfaced on the executor card rather than only logged — a stop-loss that has quietly stopped
  being evaluated is the worst possible silent failure here.
- **`liveTwapService.ts`** places each remaining TWAP slice on its own schedule. If that schedule
  falls behind real time (the app was closed, or the machine slept), the cadence resumes from now
  instead of firing the whole backlog back-to-back — otherwise an interrupted TWAP would place its
  entire remaining notional within a minute, the exact opposite of its purpose.

Both skip a tick while their previous one is still in flight, so a slow network call cannot cause
a duplicate order.

### Live position ledger

`electron/services/livePositionsService.ts` tracks net accumulated holdings per symbol (spot,
long-only) in its own `livePositions.json`, independent of the paper `HeldPosition` Inventory —
built from live BUY fills, reduced or closed by live SELL fills, using the same weighted-average
cost-basis accounting as the Market Making executor. A live position can be closed fully or
partially (real market sell, sized to the exact tracked quantity — never "however much $X buys",
to avoid drifting from the ledger); closed positions feed the **Live Trade History** table and the
daily loss-limit gate above.

### Live order ledger (limit orders)

A market order resolves synchronously; a limit order rests until it fills, gets cancelled, or
expires. `electron/services/liveOrdersService.ts` is the source of truth for every resting order
(own `liveOrders.json`), polled every 5s by `LiveOrderScheduler` (a headless component mounted in
`App.tsx`, same shape as `RoutineScheduler`) — deliberately polling rather than an authenticated
websocket user-data-stream (listenKey lifecycle, keep-alive renewal, reconnect handling), which
would be disproportionate infrastructure for a tool with no sub-second latency requirement. The
ledger survives app restarts, so an order still resting when the app closes is picked up correctly
next launch with no reconciliation logic beyond "poll every open record." The Execution view's
existing generic **Stop** button doubles as the real cancel action for a resting live order.

## Architecture

```
electron/main.ts  (main process)
      │  creates BrowserWindow, registers IPC handlers
      ▼
electron/preload.ts  ── contextBridge ──▶  window.api.*  (renderer)
      │
      ├── settings.get() / settings.set(patch)     → electron/services/settingsService.ts
      ├── credentials.list() / set() / test()       → electron/services/credentialsService.ts
      ├── market.*  (symbols, candles, tickers)      → electron/services/marketService.ts
      │                                                   + electron/services/exchanges/*
      │             (live prices: liveInterest, liveState, liveBook) → electron/services/liveMarketService.ts
      ├── scanner.*  (what is moving, events)         → electron/services/marketScannerService.ts
      │                                                   (public market data; no key, model or order)
      ├── research.*  (the market studied at launch)   → electron/services/marketResearchService.ts
      │                                                   (public market data and CoinGecko's free list)
      ├── news.*  (Binance's announcements)           → electron/services/newsService.ts
      │                                                   (two public lists; no key, model or order)
      ├── feed.*  (four news feeds, reactions, Open, history) → electron/services/newsFeedService.ts
      │                                                   (free RSS and Binance's list; no key, model or order)
      ├── ai.*  (key, models, budget, signals, ledger) → electron/services/aiSignalService.ts
      │                                                   + openRouterClient.ts + aiConfigService.ts
      │                                                   + aiLedgerService.ts  (no route to an order)
      ├── liveTrading.*  (gates, positions, orders)   → electron/services/liveTradingService.ts
      │                                                   + livePositionsService.ts + liveOrdersService.ts
      └── executors.placeLiveOrder / placeLiveLimitOrder → electron/ipc/handlers/liveTradingHandlers.ts
                                                          → electron/services/exchanges/binanceTrading.ts
```

- **`shared/ipc.ts`** is the single source of truth for every type and channel name that crosses
  the main/renderer boundary — imported by both `electron/` and `src/`, so the two sides can never
  silently drift out of sync.
- **Settings persistence**: `settings.json` in the OS user-data folder holds everything
  non-secret — theme, bots, bot runs, executors, routines, held positions, controllers. It's a
  flat JSON file, loaded once and cached in the main process, written back on every `settings.set`
  patch.
- **Credentials persistence**: a separate, encrypted `credentials.json` — see
  [Credentials](#credentials--api-keys).
- **Live-trading persistence**: three more files, each its own concern so a bug in one can never
  weaken another's guarantee — `liveTrading.json` (safety-gate state), `livePositions.json` (the
  position ledger), `liveOrders.json` (resting limit orders). None of it lives in `settings.json`.
- **Deterministic replay, everywhere**: bots, executors, routines, and the backtest page all use
  the *same* pattern — fetch historical candles for the exact window that matters, run a pure
  function over them, throw the result away and recompute from scratch on the next poll. Nothing
  simulated is ever persisted mid-flight. This is why a paper position surviving an app restart,
  or a bot resuming after being re-enabled, always reflects exactly what the real market did,
  never a stale cached guess.
- **Session-only reports**: Routine reports and Controller snapshots are *not* written to
  `settings.json` (they'd grow it unboundedly over a long session) — they live in a small
  `useSyncExternalStore`-backed store (`routineStore.ts` / `controllerStore.ts`) and reset when
  the app closes, the same tradeoff the Trade page's session order history makes.
- **Headless schedulers**: `RoutineScheduler`, `ControllerScheduler`, and `LiveOrderScheduler` are
  `return null` components mounted once in `App.tsx`, so their `setInterval`s keep firing
  regardless of which page is active. `OpportunityScheduler` is the same kind of component with no
  timer of its own: it runs the [watch](#ai-signals--paper-only) each time the scanner reports a
  pass. `NewsScheduler` acts on a delisting each time the news reader reports one ([the notice and
  the rule's paper short](#binances-announcements-on-discovery)), and looks at those shorts once a
  minute to settle one that has closed. `PaperDigestScheduler` looks every five minutes whether a
  UTC day has ended, and tells it once ([the daily digest](#ai-signals--paper-only)).
  `PaperPauseScheduler` reads the app's own paper trades once a minute and writes down a pause
  when a losing run has reached it, telling it once ([the pause](#ai-signals--paper-only)).
  `NewsAlertScheduler` gives each fresh story the feed reads a severity, and looks at Bitcoin's
  last hour once a minute, for the notices, the sidebar count and the banner ([the
  alerts](#news--market-events)); it writes nothing.
  `RoutineScheduler`/`ControllerScheduler` poll their own
  settings slice every 10s to notice config changes made on the page component (there's no
  cross-component push channel); `LiveOrderScheduler` polls every open live limit order via the
  main process every 5s and patches the matching executor's status directly.
- **Charts are a parallel theming system**: `lightweight-charts` renders to canvas, so it can't
  read CSS custom properties. `src/theme/palette.ts`'s `CHART_PALETTE` is the canvas-side source
  of truth that mirrors `index.css`'s `:root` tokens for each of the three themes; every chart
  component re-subscribes via `useTheme()` and rebuilds when it changes.
- **AI persistence**: five more files, none of them in `settings.json` — `aiCredentials.json` (the
  OpenRouter key, encrypted the same way as exchange keys), `aiConfig.json` (enabled models and
  the daily budget, owned by the main process for the reason `liveTrading.json` is: a spending
  limit the renderer could rewrite through a settings patch is a limit in name only),
  `aiModels.json` (the cached price list), `aiSignalCache/` (one file per answered decision) and
  `aiLedger/` (the append-only call history).
- **`backend/`** is a minimal, unused standalone Express service (one `/health` route). AI calls
  are made from the Electron main process, where the key can sit in the OS keychain; nothing in
  the app talks to `backend/`.
- **`architecture.txt` / `architecture-pro.txt`** are aspirational system-design diagrams for a
  much larger target platform (quant signal engine, AI decision layer, risk/execution engines,
  observability, a backtest→paper→live research loop). They predate this app's actual feature set
  and describe where the project could eventually go, not what's built — treat them as a vision
  doc, not documentation of the current system.

## Core Strategy & Simulation Logic

### Strategies

> **[STRATEGIES.md](STRATEGIES.md) explains the three shipped strategies as mathematics** — the
> expectancy equation they are built around, why a 24% win rate is profitable, why the fee sets
> the trade budget before any indicator is chosen, the formulas for each rule, and why compounding
> reverses the comparison against buy-and-hold. Start there if you want to know *why* they work
> rather than *whether* they did.

`src/backtest/engine.ts`'s `runBacktest(candles, strategyId, options)` is pluggable: execution
(position tracking, fees, the equity curve, and the full stats panel) is shared and untouched
regardless of strategy — only entry/exit/stop logic, defined per strategy in
`src/backtest/strategies/`, changes. `STRATEGIES` in that folder's `index.ts` is the registry;
adding a new one is a self-contained file implementing `generateSignals(candles) →
{entries, exits, stopPrices, warmupBars}`. All six ship long-only, spot (no shorting, no
leverage):

| Strategy | Entry | Exit |
|---|---|---|
| **EMA Crossover + ATR Stop** | EMA(20) crosses above EMA(50) while price is above EMA(200) — a regime filter added after backtesting showed the un-filtered crossover's profit was almost entirely concentrated in the 2023–24 bull run (5 of 6 tested assets were flat-to-negative since). | Stop-loss at `close − ATR(14)×2` (set at entry, checked against every candle's low — a gap-down fills at the worse of open/stop like a real stop order would), or a bearish EMA(20/50) cross. |
| **RSI Mean-Reversion** | RSI(14) crosses up through 30 (oversold) while price is above EMA(100) — same "regime filter gates entries only" shape as the EMA strategy, so it buys dips in an uptrend rather than a falling knife in a downtrend. | RSI crossing back above 70 (overbought), or the same ATR(14)×2 stop. |
| **Bollinger Breakout** | Close breaks above the Bollinger Band(20, 2) upper band. | Close back below the middle band (the breakout failed/reverted), or the same ATR(14)×2 stop. |
| **Trend Regime Ensemble** | Price is above *all four* of the 20/30/50/80-**day** moving averages. The lookbacks are in days and converted using the candles' own spacing, so the strategy means the same thing on 3m as on 4h — written as bar counts, "20 days of 15m" would silently become 4 days of 3m, a scale at which the measured edge is zero. | Price falls below at least three of the four. The gap between a unanimous entry and a near-unanimous exit is deliberate hysteresis; entering and exiting on one line means crossing it repeatedly and paying the fee each time. A `close − ATR(14)×10` stop is set at entry as a disaster stop only — the regime exit is the risk control, and a *tighter* stop measurably reduced returns without improving drawdown. |
| **Short-Term Channel Breakout** | Price sits at or above 95% of the way up its 2/3/5/8-**day** high-low ranges, averaged across the four. Averaging the *position within* each channel is deliberate: Donchian channels are nested, so voting on whether price breaks k of the four highs is only "breaks the k-th slowest high" and re-picks a single lookback under another name. | Price falls back to the bottom quarter of those same ranges. The wide 0.95/0.25 gap is the hysteresis that keeps the fee bill survivable at this speed, and a `close x 0.5` disaster stop is set at entry because the engine will not open a position without one. |
| **Short-Term Channel + Trend Regime** | The same breakout as the row above, except an entry is refused unless all four of Trend Regime Ensemble’s 20/30/50/80-**day** averages agree price is above trend. The vote is read through the *same* exported `regimeAgreement()` the regime strategy itself acts on, so a change to one can never leave the other behind. | Unchanged — exits and the disaster stop pass straight through from the ungated strategy. Gating exits as well was measured and was worse on every symbol but one, because an exit blocked by a falling regime is blocked exactly when it is needed. |

The last three are the only ones built against intraday candles, and they exist because the
other three lose money on them. The reason is arithmetic rather than tuning: a round trip costs
0.24% (0.1% fee per side, plus 2bps of slippage per fill) while the average 15m bar moves 0.16%,
so 500 round trips burn 70% of an account and 2,000 burn 99% — Bollinger Breakout takes 2,059
trades over 3 years of BTCUSDT 15m and pays $12,550 of fees on $10,000. Trend Regime Ensemble is
built around a trade budget first: ~10 trades a year.
Measured on 3 years of Binance data (2023-08 → 2026-08), with the final year held out of every
tuning decision:

| Series | Tuning window | **Held-out year** | Buy & hold, same year | Full 3 years | B&H 3 years |
|---|---|---|---|---|---|
| BTCUSDT 15m | +147.6% | **+15.8%** | −29.4% | **+186.7%** | +121.7% |
| ETHUSDT 15m | +216.0% | **−10.9%** | −45.5% | **+217.2%** | +26.1% |
| SOLUSDT 15m | +174.8% | **−3.8%** | −48.2% | **+164.5%** | +76.8% |
| BTCUSDT 3m | +155.8% | **+16.5%** | −29.2% | **+198.1%** | +122.3% |
| ETHUSDT 3m | +177.4% | **−19.7%** | −45.4% | **+165.7%** | +26.5% |

Month by month over the same three years, which is the shape that matters more than the total:

| 15m series | Up months | Down months | Flat (in cash) | Worst losing streak | Max drawdown |
|---|---|---|---|---|---|
| BTCUSDT | 14 | 13 | 10 | 3 months | −26.7% (B&H −53.8%) |
| ETHUSDT | 10 | 14 | 13 | 2 months | −41.2% (B&H −69.3%) |
| SOLUSDT | 14 | 14 | 9 | 2 months | −43.8% (B&H −79.4%) |

Roughly as many losing months as winning ones, and it still compounds to +165–217%, because the
losers are small and the flat months are deliberate. The flat months are where the design pays
for itself: on BTC it sat in cash through 2025-11 (buy & hold −17.5%), 2026-02 (−15.6%) and
2026-06 (−20.6%). The same rule that produces those also gives back a few percent in a month that
chops sideways — that is the trade, and it cannot be had one-sided.

Read the rest honestly. It loses money on three of the five held-out years — it beats buy & hold
there by sitting in cash, not by being right. Win rate is 20–33%: most trades are small losses
paid for by a few large winners, which is what trend-following is and is uncomfortable to hold.
The held-out year contains ~10 trades per series, so its confidence interval is wide. It also
underperforms buy & hold in a straight bull market, on purpose — the case for it is drawdown and
what happens when a trend ends, not raw return. Every figure above is net of both the 0.1%-per-side
fee and the 0.02%-per-side slippage in `shared/fees.ts`; it is not, however, net of the market
impact of an order large relative to the book, which nothing here models.

It is at least insensitive to fill timing, which is the one thing a backtest can check cheaply and
the one an intraday strategy most often fails. Delaying every fill by one, two or four whole
15-minute bars after the signal moves the three-year result by a few points in either direction
and sometimes improves it — the edge does not depend on trading the close it just saw. A signal
that needed that precision would be a signal made of noise.

Since that table was written the strategy has been tested far more widely — 8 symbols, 5
timeframes and up to 9 years, the whole of Binance's history for these pairs. The single most
useful result is the one below, because **none of this period informed any parameter**: the
lookbacks and thresholds were chosen on 2023-08 → 2025-08 BTC/ETH/SOL 15m data, and six of these
eight symbols were never looked at at all while choosing them.

| Pure out-of-sample, 2017-08 → 2023-08, daily | Strategy | Buy & hold | Max DD | B&H DD |
|---|---|---|---|---|
| BTCUSDT | **+1,575%** | +254% | −50.6% | −83.2% |
| ETHUSDT | **+2,216%** | +457% | −57.6% | −94.0% |
| BNBUSDT | **+5,763%** | +1,541% | −45.5% | −76.1% |
| ADAUSDT | **+1,909%** | +80% | −63.4% | −91.8% |
| DOGEUSDT | **+5,195%** | +2,470% | −81.4% | −92.3% |
| LTCUSDT | **+104%** | −69% | −72.4% | −89.2% |
| LINKUSDT | +90% | +955% | −82.8% | −90.2% |
| XRPUSDT | +5% | +18% | −72.4% | −83.2% |

Profitable on 8 of 8, beating buy & hold on 6 of 8, across a window containing the 2018 bear
(−84% on BTC), the March 2020 crash, the 2021 bull and the 2022 bear. It holds across timeframes
too — on that same window BTCUSDT returns +1,468% at 1h, +2,247% at 4h and +1,575% at 1d, with
Sharpe between 1.16 and 1.42. Year by year on BTCUSDT it is profitable in 7 of 10 calendar years,
and it beat buy & hold in **every** losing one (2018 −20% against −72%, 2022 −41% against −65%).

Where it fails is worth stating as plainly as where it works: XRPUSDT and LINKUSDT. Both chop
rather than trend, and a trend strategy on a choppy asset pays the fee repeatedly for nothing.
LTCUSDT is profitable only over this earlier window and loses money across the full 9 years.

### Negative results, kept because they cost something to learn

**Tuning harder made it worse.** A faster lookback set (10/15/25/40) was tried to fix the late
re-entry visible in the monthly table. It beat the shipped set on the tuning window, on all three
symbols, and won 7 of 9 walk-forward sub-windows — then performed **worse** on the held-out year.
Walk-forward validation *inside* the tuning window did not predict out-of-sample behaviour.

**Leverage is a trap, and looks like the opposite on short samples.** On BTCUSDT daily over the
last 3 years, 5x returns +774% and survives. Over the full 9 years the same 5x is **liquidated on
its first trade and ends at −100%**. Even 3x, which technically finishes at +16,901%, does so
through a −91.9% drawdown that nobody holds through. (Both windows in `fair.ts` end wherever the
candles end, so those two return figures move as the candle set is extended — they are quoted
against candles through 2026-08-28. The liquidation and the drawdown do not move.) Leverage does not improve risk-adjusted
return at all here: CAGR ÷ max drawdown stays flat near 1.5 from 1x to 3x, so all it buys is a
bigger number attached to a position you cannot keep.

**Diversifying barely helps, because crypto falls together.** The same strategy blended
equal-weight across BTC+ETH+BNB cuts max drawdown only from −50.6% to −45.6%. That is not enough
of a reduction to justify leverage on top, which is what a genuinely diversified book would buy.

**Three attempts to raise profit from the 36-month study, all rejected.** The diagnosis was real
and the fixes were not (`research/diag.ts`, then `sweeptrail.ts`, `sweepcool.ts`, `sweepstop.ts`,
`oostop.ts`). Measured on the training window across three symbols:

| Measured problem | Fix tried | What happened |
|---|---|---|
| Winners bank only ~40% of the peak gain they reach, and half of all losing trades had been up more than 3% first | Give-back trailing exit, swept over 7 arming thresholds x 9 give-back widths | Worse than baseline nearly everywhere for Trend Regime; the best cells are spikes, not plateaus, and their neighbours sit below baseline. For Short-Term Channel the apparent +50pp came from **one extra trade out of 151** |
| Trades re-entered within a day of the last exit win 26% of the time against 46% for those entered after ten days | Re-entry cooldown, 6h to 10 days, both after any exit and after losing exits only | Never beat baseline for either strategy at any length, and got steadily worse beyond 5 days. A bucket of trades with a poor win rate is not the same as a bucket worth removing: skipping a re-entry also forfeits whatever followed it |
| Short-Term Channel's stop had never fired once in 151 trades; its worst trade lost 15.9% | A stop that actually binds, swept 2%–20% below entry | Passed the training window (+205% → +247% mean) but **the gain was one symbol**: BTC +4pp, ETH +4pp, SOL +118pp. On the held-out year it changed **nothing at all** — no trade ever fell 8% from entry, so all three symbols returned exactly what they did before |

The common thread is sample size, and it was measurable in advance: Trend Regime's best 3 trades
out of 59 are 53% of its gross profit. Every intervention above changed a handful of trades, and
the effect on the total was decided by *which* handful. The engine grew two options along the way
(`trailing` and `reentryCooldown`) and nothing in the app passes either — they are kept, inert and
tested, only so the negative results stay reproducible.

**Concurrent positions do not help either, and not for the reason it looks like.** The engine holds
one all-in position at a time, so it reaches 59 of Trend Regime's 686 distinct entry events on the
training window and 151 of Short-Term Channel's 2,178 (`research/conc.ts`). Those counts are of
*rising edges*: the entry condition is a regime state, true on 45% of all bars, so counting every
true bar reports 95,651 "signals" for a strategy that takes 59 trades — a second position opened on
the next bar is not a second opportunity, it is leverage on the first. The unreachable entries are
profitable on average, but less so than the ones taken: **+6.87% against +11.17%**.

`research/slots.ts` simulates N concurrent slots under two sizing rules. It is checked against the
real engine at N = 1 before anything else it prints is believed, and reproduces it exactly —
`$0.000000` disagreement on $10,000, all six strategy/symbol runs.

| Sizing rule | Trend Regime, 1 → 8 slots | Short-Term Channel, 1 → 8 slots |
|---|---|---|
| Capital reserved per slot | +353% → +211%, monotonically worse | +205% → +127%; only N=2 beats on the mean, and it is worse on 2 of the 3 symbols |
| Always fully invested, trimming to fund each new slot | +353% → +330%, fees $3,445 → $7,897 | +205% → +158%, fees $6,918 → $15,165 |

Reserving capital cuts the share of the account actually invested from **54% to 38%** — adding
slots puts *less* money to work, not more. Removing that drag by trimming exposes the other half of
the answer: on a single symbol, N equal fully-invested positions are economically one position of
the same size, differing only in that each slot keeps its own stop. That laddered stop buys
nothing — max drawdown moves from −41.2% to −41.6% — while the trimming pays the fee twice on the
same coins. Nothing here was scored on the holdout, because only what survives training is.

### The bear-market question, and why the premise was half wrong

The complaint was direct: these strategies make money in a bull market and lose it in a bear one.
The first half of the answer is that this is true, and the second half is that the losses are not
where the complaint puts them.

**The premise, confirmed.** Median across eight symbols, each calendar year run in isolation on
daily candles with warmup carried in from before it (`research/bear.ts`):

| | 2018 | 2021 | 2022 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|
| Trend Regime | −22.0% | +148.5% | **−32.5%** | +34.2% | −7.1% | +4.6% |
| Short-Term Channel | −22.7% | +100.9% | **−33.8%** | +43.2% | −16.0% | −7.9% |
| buy & hold | −77.5% | +326.9% | −66.8% | +57.1% | −24.0% | −17.8% |

2022 loses on **8 of 8 symbols** for both strategies. Every losing year still beats holding, by a
wide margin, but a smaller loss is still a loss.

**Where the money actually goes, which is not the bear.** Decomposing each strategy's return by
market regime — bull, chop and deep bear, labelled per symbol from a *running* peak so the label at
each bar is one a live system could also have computed — gives a different answer than the calendar
does. Contributions are in **log returns**, stated as the return each regime's bars alone would have
produced. An earlier cut of this summed dollar changes instead and reported +$6.3M from bull bars
against −$2.6M from chop; both numbers were real and neither meant anything, because on an account
compounding from $10,000 to millions a dollar total reports *when* a regime happened, not how the
strategy behaved in it.

| Trend Regime, median of 8 symbols | bull | chop (10–35% off peak) | deep bear (>35% off) |
|---|---|---|---|
| strategy | +5,295.9% | **−56.8%** | +8.5% |
| symbols losing money there | 0 of 8 | **6 of 8** | 3 of 8 |
| buy & hold, same bars | +8,443.5% | −63.3% | ≈ −90% |

The deep bear is already handled: the strategy sits in cash and contributes roughly nothing while
holding the coin loses about 90%. That is a long-only trend follower doing exactly its job. The
damage is in the **chop band** — the 10–35% zone below the running peak where tops form, where a
breakout is really a bounce, and where the strategy buys it, pays 0.24%, and does it again.

**Shorting was measured and rejected.** It is the only mechanism that can *profit* rather than
merely abstain, so it was tested before anything cheaper. `research/shortside.ts` mirrors each
strategy's own thresholds through the middle and adds **no new constants** — Trend Regime shorts
when 0 of 4 averages agree and covers at 3 of 4; Short-Term Channel shorts at channel position
≤ 0.05 and covers at ≥ 0.75 — so there was no parameter that could be fitted and the result can be
read on all of history. The simulator reproduces the engine exactly with the short leg off
(`$0.000000` disagreement on $10,000, all sixteen series) before any of it is believed.

| Full history, 8 symbols, daily | long only | long + short |
|---|---|---|
| Trend Regime, median | +3,736.1% | +1,136.4% |
| Trend Regime, worst symbol | −30.2% | −94.7% |
| Short-Term Channel, median | +615.9% | −23.7% |
| Short-Term Channel, worst symbol | −37.4% | −91.4% |

Short P&L is negative on **all sixteen** strategy/symbol runs. It improved 1 of 8 symbols for Trend
Regime and 0 of 8 for Short-Term Channel. The short leg does win the years it was added for — 2018
goes from −22.0% to +5.3% and 2022 from −32.5% to −23.8% for Trend Regime — and loses far more
everywhere else, because it occupies the engine's single position slot and spends the rest of the
decade fighting the drift. Funding is charged as a *cost* on the short side rather than the credit a
real perp usually pays, so the true figure is slightly better than this and nowhere near enough.

**Four entry filters, all rejected.** If the loss is chop rather than bear, the cheap fix is to
decline entries inside a drawdown that will not resolve upward. `research/chop.ts` selects on
2017–2021 and scores once on 2022–2026, at 1h across eight symbols: a confirmation delay, a
drawdown-from-peak gate at 10/20/35%, a volatility gate swept over seven thresholds, and a
rising-averages requirement. Nothing survived. The closest miss is worth recording because it nearly
shipped: the volatility gate improved Short-Term Channel's worst case on the design window at both
1h and 4h across seven of seven swept thresholds — a plateau, not a peak — and on a **six**-symbol
holdout it turned the worst symbol from −7.6% to +8.7% with every symbol profitable. It was
implemented, and then reverted, because the six-symbol set was an artifact of which downloads had
finished: on all eight it is worse on median at both intervals, and at 4h worse on median, worst case
*and* losing symbols (5 of 8 against 3 of 8). The lesson is the one this directory keeps re-learning
— a result that depends on which symbols were in the sample is a result about the sample.

**One entry filter did survive, and the protocol is what makes that believable.** The chop band is
where Short-Term Channel loses — and Trend Regime already has a rule for it, which is that it stops
trading. Over 36 independent months it takes no position at all in 6 to 14 of them, and Short-Term
Channel's average return in exactly those idle months is **negative on all eight symbols** (−3.1% to
−9.3%), against a higher average in the months the regime is active on all eight. That kills the
obvious idea before it is built — running both strategies so one covers the other's quiet months —
because the two are *positively* correlated, so pairing them concentrates the bad months rather than
diversifying them. It also names the cheap fix: let the channel trade, but not while the regime says
no.

`research/enhance.ts` swept that against sixteen other candidates under a rule fixed before any
result was seen: selection on BTC/ETH/SOL/ADA, confirmation on BNB/LINK/LTC/XRP, which took no part
in choosing anything. Sixteen died — every give-back exit width and every re-entry cooldown length,
both of them features the engine already implements and `research/diag.ts` already justified on
three symbols. The gate is the one that held. 36 independent months, $10,000 each, 15m, run through
the shipped strategy rather than a research copy of it:

| 36 months x $10,000 | BTC | ETH | SOL | ADA | BNB | LINK | LTC | XRP |
|---|---|---|---|---|---|---|---|---|
| Short-Term Channel | $6,871 | $10,104 | $17,958 | $15,976 | $2,551 | $6,481 | −$5,903 | **$17,053** |
| + regime gate | **$10,536** | **$11,867** | **$18,518** | **$18,102** | **$2,978** | **$9,129** | **−$3,947** | $15,345 |
| worst month, ungated | −13.5% | −15.9% | −29.3% | **−13.7%** | −18.2% | −23.3% | −17.0% | −24.1% |
| worst month, gated | **−8.7%** | **−11.5%** | **−12.6%** | −14.8% | −18.2% | **−18.2%** | **−14.3%** | **−17.5%** |
| trades/month | 2.3 → 1.5 | 2.2 → 1.3 | 2.3 → 1.4 | 2.1 → 1.0 | 2.6 → 1.9 | 2.4 → 1.4 | 2.5 → 1.5 | 2.2 → 1.3 |

Profit improves on 7 of 8; the worst month improves on 6, ties on 1 and worsens on 1, for about 40%
fewer trades. **XRP loses profit under the gate and is not excepted**, and neither is ADA's slightly
worse floor — a per-symbol carve-out fits the rule to the data that produced it, which is exactly
what the volatility gate above was reverted for. The threshold is not tuned either: 4-of-4 is
`trendRegimeEnsemble`'s own `ENTER_VOTE_FRACTION`, read through the *same* exported
`regimeAgreement()` the regime strategy acts on. 2-of-4 and 3-of-4 score better on subsets but rank
inconsistently across symbols, and choosing one would add a free parameter fitted on the same data
used to justify it; 4-of-4 adds none.

**Total profit is the weaker claim, and it should not be the headline.** Net across all 288
symbol-months the gate is worth $11,436 — and the best **five** months carry 86% of that. By count
it is a coin flip: 108 months helped, 104 hurt, 76 unchanged, median effect exactly $0. A dollar
total over strategies whose mean is carried by a handful of enormous months is decided by what
happens in about five of them, which is the same five-observation problem this directory has
retracted results for twice already. Applying that standard to a result I found is the point.

**What survives is a rule about the distribution, not the total** (`research/shape.ts`). Sort all
288 months by what the *ungated* strategy did and cut into fifths:

| months, sorted by ungated result | ungated | gated | effect | helped / hurt |
|---|---|---|---|---|
| worst fifth | −12.3% | **−6.5%** | **+5.8%** | 39 / 10 |
| 2nd | −4.8% | **−2.3%** | **+2.4%** | 40 / 8 |
| middle | −1.2% | −1.9% | −0.7% | 18 / 22 |
| 4th | +3.3% | +1.5% | −1.8% | 7 / 32 |
| best fifth | +26.1% | +22.5% | −3.6% | 4 / 31 |

The effect falls monotonically across every bucket, and the votes are lopsided in *opposite*
directions at the two ends — 80 helped against 18 hurt in the bottom two fifths, 11 against 61 in
the top two. That is 288 months agreeing, not five. So the gate is a **risk trade, not a profit
engine**: it gives up about 3.6 points in the best fifth of months to save about 5.8 in the worst
fifth. Total profit improved here because over 2023–2026 the bad tail was fatter than the good tail
was thin — a fact about this window, where the risk transfer is a fact about the rule. Expect the
smaller drawdown to repeat; do not count on the extra dollars.


**The comparison that decides whether to use it is against Trend Regime, not against the strategy it
gates** — and that one is not a win. Same 36 independent months, 8 symbols, 15m:

| | mean month | sd | mean/sd | median worst month | median in-month drawdown | total profit |
|---|---|---|---|---|---|---|
| Trend Regime Ensemble | 3.38% | 23.6% | 0.143 | −19.2% | −9.1% | **$97,443** |
| Short-Term Channel | 2.47% | 19.4% | 0.127 | −17.6% | −10.1% | $71,092 |
| Short-Term Channel + Regime | 2.87% | **17.5%** | **0.164** | **−14.6%** | **−6.8%** | $82,527 |

Two things follow, and they point in different directions.

*Against its own parent the gate simply wins.* It is better on all six columns, better on total profit
on 7 of 8 symbols individually, and better on the worst month on 6 with 1 tie. There is no case for
running Short-Term Channel in preference to the gated version — which is why the ungated strategy is
kept only for continuity with bots already using it.

*Against Trend Regime it is a different product, not a better one.* Trend Regime earns **$14,916
more** across the eight symbols and wins on 6 of 8 individually. What the gated strategy buys is
risk: a smaller worst month on **8 of 8**, a quarter off the median in-month drawdown, and the best
risk-adjusted return of the three. Their monthly returns also correlate **0.70 to 0.97**, so this is
not a diversifier to run alongside Trend Regime — it is an alternative to it. If the goal is the
largest number at the end, Trend Regime is still the answer; if it is surviving the bad months,
this is.


The cost is warm-up. The gate reads an 80-day average, so this needs the regime's 80 days rather
than the channel's 8. Driven in the running app, the Backtest page's default 90-day range reports
79 days of warm-up and 7,680 candles of it, leaving about **twelve** tradeable days against the
ungated strategy's eighty-four — 2 closed trades on BTC-USDT against the ungated strategy's 7.
It therefore ships as a **separate** strategy (`short-term-channel-regime`) rather than a change to
the existing one, so bots already running Short-Term Channel behave exactly as before and the two
can be compared side by side.


**Entry rules and exit rules are not independently swappable, which was worth one experiment to
establish** (`research/cross.ts`). Trend Regime and Short-Term Channel each pair their own entry
with their own exit, and the gated strategy pairs the channel's entry with the channel's exit. Two
cells of that grid had never been run, and the interesting one looked promising on its face: Trend
Regime's entry earns the most money and the channel's exit appears to cut the most risk, so pairing
them should keep the money at lower risk.

It does the opposite, by a wide margin. Trades per month, against 1.2–2.3 for Trend Regime:

| cell | trades / month | total profit, 8 symbols |
|---|---|---|
| regime entry → channel exit | **29.9 – 72.4** | −$2,860 to −$43,432 |
| channel entry → regime exit | 6.9 – 14.4 | +$22,639 to −$21,445 |

Both were rejected 0 of 4 at discovery. The cause is the observation `research/conc.ts` already made
about entry counts: Trend Regime's entry condition is a **state**, true on about 45% of all bars,
not an event. What turns it into 1.5 trades a month is its own slow exit — it gets in and stays in.
Give it a fast exit and it leaves on the first dip, finds the state still true on the next bar, and
buys again; fifty-four round trips a month at 0.24% is roughly 13% of the account per month in costs
alone. The mirror cell fails the mirror way — a breakout held until the regime breaks sits through
drawdowns the channel would have exited, and LTC's worst month reaches −57.6%.

A state-based entry needs a slow exit and an event-based entry needs a fast one. This is also why
`shortTermChannelRegime` gates the channel's *entry* and leaves its exit untouched, a decision its
header defends on measured grounds and which this grid now explains from the other side.


**A bot re-downloaded its whole warm-up window every minute, and now does not.** `useDryRun` polls
every 60 seconds, and each poll re-fetched the full range the strategy needs to be warm. Trend
Regime looks back 80 days — 7,800 bars at 15m — so one bot pulled 7,800 candles a minute, paged
1,000 at a time, to learn about at most one new bar. Eight REST calls a minute, per bot, forever,
for four candles an hour of actual news.

`src/bots/candleCache.ts` keeps the series and fetches only the tail, and several bots on the same
symbol and interval now share one copy. The refetch deliberately **overlaps by one bar**: the newest
candle an exchange returns is still forming, and appending strictly after it would freeze a partial
bar forever — a strategy reading a close that never moves again, which looks like nothing at all
going wrong. A cancelled fetch is kept rather than discarded, because `fetchHistoricalRange` pages
forward and stops early, so a cancelled result is a contiguous prefix and never a series with a hole
in it.

The tests pin the only thing that must not change — that cached and uncached polls return identical
candles — and were checked by mutation: reverting the one-bar overlap fails four of the nine.


### What one month actually looks like, since one month is the goal

Every other table here reports a total or a mean over 36 or 48 months. Someone deploying $10,000 for
**one** month does not receive the mean, and on a distribution this skewed the mean is a poor
description of it. `research/onemonth.ts` prints the distribution instead — 658–660 independent
symbol-months per strategy, pooled across both eras and all eight symbols at 15m:

| one month, $10,000 | p5 | p25 | median | p75 | p95 | mean | lose >10% | flat | gain >10% |
|---|---|---|---|---|---|---|---|---|---|
| Trend Regime | −18.3% | −6.9% | +0.0% | +4.8% | +43.6% | +5.1% | 16% | 26% | 20% |
| Short-Term Channel | −14.3% | −6.1% | −0.8% | +7.4% | +35.4% | +4.0% | 14% | 10% | 21% |
| Channel + Regime | −12.9% | −4.5% | +0.0% | +3.9% | +31.2% | +3.7% | 9% | 30% | 16% |

**The median month is roughly zero on all three.** The positive mean comes from the right tail, not
from most months being good: about a fifth of months gain more than 10%, about a seventh lose more
than 10%, and the rest do very little. A quarter to a third are flat because the strategy took no
position at all. A single month is close to a coin flip with a long right tail; the edge only
appears over many of them.

Pooling is legitimate here only because nothing is being selected — this describes results already
produced, it does not fit a rule to them.

### When they lose, and why three attempts to predict it failed

The question was direct: these strategies make money sometimes and lose it other times, so read the
market first and decide whether to run them at all. `research/beta.ts` answers the first half, and in
doing so explains why most of the second half was never going to work.

Bucket every independent month by what **simply holding the coin** did in that same month, measured
over the identical bars the strategy traded:

| mean strategy month | bh < −20% | −20..−10 | −10..0 | 0..+10 | +10..+20 | bh > +20% |
|---|---|---|---|---|---|---|
| Trend Regime | −6.2% (95) | −5.5% (102) | −6.4% (127) | −2.9% (121) | +3.6% (72) | **+38.6% (141)** |
| Short-Term Channel | −7.2% (97) | −5.3% (102) | −4.1% (127) | −0.9% (121) | +4.4% (72) | **+29.8% (141)** |
| Channel + Regime | −2.4% (95) | −3.3% (102) | −3.3% (127) | −1.7% (121) | +1.1% (72) | **+25.2% (141)** |

Two numbers carry the finding. **Trend Regime was profitable in 1 of the 323 months where holding
lost money** — not a tendency, essentially never. And **all three lose money on average even when the
market rises 0–10%**: the mean is produced entirely by the 141 months where holding gained more than
20%. They need a strong up-month, not merely a positive one.

| | correlation with holding | up capture | down capture | ratio | profitable when bh < 0 |
|---|---|---|---|---|---|
| Trend Regime | 0.89 | 56% | 41% | 1.38 | 1 of 323 (0%) |
| Short-Term Channel | 0.85 | 47% | 36% | 1.29 | 60 of 325 (18%) |
| Channel + Regime | **0.80** | 36% | **21%** | **1.75** | 25 of 323 (8%) |

**What that makes them.** Not all-weather systems, and not market-neutral: long crypto with the shape
changed — roughly half the upside, roughly a third of the downside. Capture ratio is the honest
measure of whether that trade is worth making, and it is where the gated strategy is clearly best.
It is also the correction to a reading the bear-market table above invites. The +8.5% Trend Regime
contributes across deep-bear *bars* is not profit earned from falling markets: measured a calendar
month at a time it made money in 1 of 323 of them. It sits out of bear markets rather than shorting
them — a much smaller claim, and the accurate one.

**And it is why predicting a bad month kept failing.** A monthly result this close to a function of
the market's direction cannot be forecast without forecasting that direction — which is not a
strategy-tuning problem. Two rules were pre-registered against the eight discovery symbols and both
were rejected: `research/GONOGO.md` (ADX plus prior month, which **inverted** out of sample) and
`research/PRIORMONTH.md` (prior month ≤ 0, which failed on 2019–2023). Both are recorded as failures
rather than re-cut until something passed.

### The one market reading that survived, and why it ships as a readout

ADX's record was not weakly positive, it was **inconsistent** — two cuts strongly for, one clean
holdout against — and inconsistency is the one thing more data can resolve where a weak effect
cannot. So a single rule was fixed in `research/ADX.md`, committed to git while the data was still
downloading, and scored **once** against six symbols that had taken no part in any result in this
repository (DOGE, TRX, ETC, XLM, VET, EOS).

**The rule.** Run the strategy in a calendar month only if Wilder's ADX(14), computed on daily bars
closing strictly before the 1st, is ≤ 20. One condition, and the threshold is Wilder's own published
boundary for "no meaningful trend" rather than a cut fitted here. `ADX ≤ 25` is the other published
boundary and was deliberately *not* tested, because testing both doubles the chance of a false pass.

**Result: confirmed on all three pre-registered conditions.** 453 symbol-months, both eras:

| pooled, both eras | months | baseline mean | ADX ≤ 20 months | rule mean | baseline losses | rule losses |
|---|---|---|---|---|---|---|
| Trend Regime | 453 | +5.97% | 130 | **+10.83%** | −$207,061 | **−$41,999** |
| Short-Term Channel | 453 | +4.88% | 130 | **+5.40%** | −$213,352 | **−$72,042** |
| Channel + Regime | 453 | +5.17% | 130 | **+7.37%** | −$137,170 | **−$34,673** |

Higher mean on 3 of 3 pooled; higher on 3 of 3 within *each* era separately; summed dollar losses
smaller on 3 of 3, cut by 66–80%.

**Three things have to be said next to it, and the app says all three.**

- **The win rate goes DOWN** — 28% → 25%, 42% → 36%, 30% → 28%. This was not a criterion and it
  should have been. The rule does not select months that win more often; it selects months whose
  winners are larger and whose losers are smaller. That is consistent with `beta.ts`: a low ADX marks
  a market that has not already made its move, and those months still fail when the market falls.
- **Total profit falls**, as stated in advance. The rule deploys in 130 of 453 months — 29%. Sitting
  out the other 71% removes profit. It is a gain only if the capital genuinely sits in cash while it
  waits and costs nothing there. **That condition has since been tested and the rule fails it** — see
  below.
- **One earlier cut still contradicts it and is not explained away** — four symbols in 2023–26, where
  it inverted. Fourteen symbols across seven years now support it and four symbols in one era do not.

**So it ships as a panel, not a gate.** `src/backtest/marketConditions.ts` computes the reading and
`MarketConditionsCard` renders it under the Backtest configuration: the ADX number, the posture, and
what that posture has historically meant *for the selected strategy*, with both caveats in the card.
The expectations quoted are from the six held-out symbols rather than the fuller fourteen, because
the fuller set includes the data the rule was found on and would flatter it. Strategies with no
measured expectation get no panel rather than a panel with an empty half.

Nothing in the engine or in any strategy consults it. A result with a live exception belongs in front
of an operator, not wired silently into a position size — and the copy is constrained to payoff
rather than odds, with a test asserting the summary never matches
`/safer|more likely|will rise|win rate|probability/i`. The ADX itself uses Wilder's smoothing
(α = 1/n), not an EMA; substituting an EMA is a common silent error that produces a plausible curve
with every value shifted, which would move readings across the boundary this whole readout turns on,
so a test pins the *size* of the gap between a trending and a quiet series rather than only its sign.

**Shipping it as a panel rather than a gate turns out to have been the right call for a reason
nobody had measured.** `research/vshold.ts` scores the rule the way an operator would actually use
it — deploy when ADX ≤ 20, sit in **cash earning nothing** otherwise, which is the exact condition
flagged above and the conservative reading of it, since real cash earns a deposit rate. Same six
held-out symbols, 488 symbol-months, each strategy at its own interval, and the account is chained
rather than restarted each month:

| $10,000 chained, six held-out symbols | mean month | sd | worst | ends with | median symbol | beats holding |
|---|---|---|---|---|---|---|
| simply holding | **+7.04%** | 52.5 | −45.3% | $94,810 | $19,460 | — |
| Trend Regime, every month | +5.99% | 45.8 | −40.7% | **$165,625** | **$38,430** | **5 of 6** |
| Trend Regime, ADX ≤ 20 only | +2.98% | 29.6 | **−29.8%** | $44,960 | $29,961 | 4 of 6 |

**Gating costs about two-thirds of the compounded result** — $44,960 against $165,625, and the same
direction on both channel strategies ($18,312 vs $138,577; $28,784 vs $167,419). The rule really does
pick better months, exactly as measured; it just cannot pick enough of them. Sitting out 72% of the
months means sitting out most of the compounding, and the deployed months are not good enough by a
wide enough margin to make that back. A readout that informs an operator is worth having. The same
reading wired to a switch would have cost money.

Note also that the *same* table reproduces the compounding finding from the shipped-configuration
section below on a completely different symbol set and a longer window: holding wins the mean month
(+7.04% against +5.99%) and loses the compounded account on five of six symbols.


### Which candle interval, measured rather than assumed

This one is a positive result, and it changed the app. The question was whether to run faster than
15m — 3m or similar. The answer is no, and the reason generalises.

`research/ivfair.ts` pins the window by **tradeable time**: every interval starts trading at the
same wall-clock instant and each carries its own warmup from before it. Slicing from the same *date*
instead gives the coarser interval a longer tradeable window and a different buy & hold anchor,
which is the trap `research/README.md` already records being fallen into twice.

BTCUSDT, 2021-06 → 2026-08, the same strategy at every bar size:

| interval | Trend Regime | Sharpe | fees | Short-Term Channel | Sharpe | fees |
|---|---|---|---|---|---|---|
| 3m | **+417.3%** | 1.13 | $3,294 | +120.5% | 0.65 | $5,067 |
| 5m | +398.2% | 1.11 | $3,040 | +124.5% | 0.66 | $5,096 |
| 15m | +398.0% | 1.12 | $2,614 | **+129.6%** | **0.68** | $4,877 |
| 1h | +408.2% | **1.14** | $2,312 | +101.7% | 0.60 | $4,249 |
| 4h | +344.7% | 1.06 | $1,934 | +86.1% | 0.55 | $3,582 |
| 1d | +211.5% | 0.82 | $1,117 | −15.0% | 0.05 | $1,388 |

**Finer is not better between 1d and 15m, and the mechanism says why.** Both strategies define their
lookbacks in *days*, so shrinking the bar does not change what the strategy means — a 20-day average
is 20 days at every interval. It changes two things only: the rule is checked more often, and it
crosses its own hysteresis band more often. The first is worth something small; the second costs
0.24% every time.

**3m posts the highest single number in that table.** On BTCUSDT alone that looked like noise safe to
dismiss: Trend Regime's entire range from 3m to 1h is +398% to +417% — a 19-point spread across 43 to
63 trades, with Sharpe flat at 1.11–1.14 the whole way down — bought for 42% more in fees than 1h
($3,294 against $2,312). Two more symbols made that picture worse rather than clearer.

**At 3m nothing is settled, on either strategy, and two successive attempts to say otherwise here
were both wrong.** 3m history exists for three symbols only, so this is a three-symbol result against
the eight-symbol one below — and it does not converge.

| 3m against 15m | BTCUSDT | ETHUSDT | SOLUSDT |
|---|---|---|---|
| Trend Regime at 3m | **+417.3%** (S 1.13) | +171.5% (S 0.68) | **+749.9%** (S 0.94) |
| Trend Regime at 15m | +398.0% (S 1.12) | **+325.6%** (S 0.90) | +603.1% (S 0.89) |
| Short-Term Channel at 3m | +120.5% (S 0.65) | **+189.2%** (S 0.73) | +2,062.8% (S 1.25) |
| Short-Term Channel at 15m | **+129.6%** (S 0.68) | +164.5% (S 0.68) | **+2,216.2%** (S 1.27) |

3m wins two of three for Trend Regime and one of three for Short-Term Channel, with the losing cases
enormous in both directions — Trend Regime is 154 points worse at 3m on ETH and 147 points better on
SOL. A sign that flips per symbol at that magnitude is variance, not signal.

**The fee mechanism is real but does not decide it, and an earlier version of this section claimed it
did.** The two strategies genuinely differ in interval sensitivity, and the measurement is clean:
going 15m to 3m, Short-Term Channel's trade count moves +6%, +6% and +4% across the three symbols —
it enters when price breaks a channel, and breakouts happen at a rate set by the price, not by how
often the rule is evaluated. Trend Regime's moves +29%, +78% and +45%, because it is a hysteresis
strategy and finer sampling catches more marginal threshold crossings, each costing 0.24%.

The prediction drawn from that — therefore 3m must hurt Trend Regime — is refuted by SOLUSDT, where
3m carries **96% higher fees** ($8,991 against $4,594) and still returns 147 points more with better
Sharpe and better drawdown. Fee drag at 3m is real and is swamped by where the extra bars happen to
put the entries. That is worth stating as a limit on the whole "finer is worse" argument above: it
holds firmly from 1d up to 15m, and it stops being predictive below 15m.

**5m, unlike 3m, is settled.** Three symbols, six head-to-head comparisons against 15m, and finer
takes none of them — Trend Regime +398.2% against +398.0% on BTC (a dead heat), +585.9% against
+603.1% on SOL, +251.0% against +325.6% on ETH, with Short-Term Channel behind on all three.

`preferredInterval` stays at the measured values regardless. They rest on the eight-symbol comparison
below, which is a far stronger base than three symbols, and nothing above displaces it. But the fine
end of the range is open, and it is open on both strategies rather than one.

The two strategies land on **different** intervals, which is the whole reason this is now a
per-strategy field. Confirmed on a longer window (2018-01 → 2026-08, median and worst of BTC/ETH/SOL):

| interval | Trend Regime median / worst / DD | Short-Term Channel median / worst / DD |
|---|---|---|
| 15m | +4,494.6% / +4,470.0% / −53.9% | **+2,584.1% / +1,411.9% / −44.0%** |
| 1h | **+5,787.1% / +4,302.9% / −51.6%** | +1,725.2% / +1,270.1% / −47.6% |
| 4h | +4,489.7% / +3,918.1% / −49.4% | +1,356.4% / +937.3% / −46.5% |
| 1d | +2,258.3% / +1,798.3% / −54.1% | +780.0% / +226.9% / −61.1% |

That table is three symbols, and three symbols is how the volatility gate nearly got itself shipped.
Re-asked on **eight** (2021-06 → 2026-08, the window every symbol covers), the median disagrees with
the head-to-head, and the head-to-head is the one telling the truth:

| Short-Term Channel | ADA | BNB | BTC | ETH | LINK | LTC | SOL | XRP |
|---|---|---|---|---|---|---|---|---|
| 15m | **+49.8%** | **+26.3%** | **+129.6%** | **+164.5%** | **−29.7%** | **−64.0%** | **+2,216.2%** | +38.7% |
| 1h | +47.1% | +2.9% | +101.7% | +70.2% | −30.4% | −85.7% | +1,681.3% | **+120.6%** |

15m wins **seven of eight**, and its worst case is 22 points better (−64.0% against −85.7%). Yet the
eight-symbol *median* prefers 1h, +58.7% to +44.3% — decided entirely by XRP, the single symbol 1h
wins, landing where it moves the middle of the sort. A median across eight symbols can still be a
statistic about one of them. `15m` stands, on better evidence than it shipped with.

Trend Regime is the honest opposite. Same eight symbols, same window:

| Trend Regime | ADA | BNB | BTC | ETH | LINK | LTC | SOL | XRP |
|---|---|---|---|---|---|---|---|---|
| 15m | **−4.0%** | +38.4% | +398.0% | **+325.6%** | −35.5% | **−51.6%** | **+603.1%** | +91.0% |
| 1h | −29.4% | **+97.6%** | **+408.2%** | +291.4% | **+2.7%** | −54.8% | +489.7% | **+180.6%** |

Four-all, and Sharpe splits four-all too. `1h` shipped on that basis — an aggregate call rather than
a sweep: it wins the median on both windows (+139.1% against +64.7% here), the median drawdown
(−68.2% against −75.0%) and the fee bill, while losing outright on half the symbols taken one at a
time. **That is the thinnest evidence any shipped default here rested on, and re-asking it on 780
independent months moved it to 4h — see the subsection after next.** The eight numbers above are
eight observations; a four-all split across them is not a decision, it is an absence of one.

**What changed in the app.** `StrategyDefinition` gained a `preferredInterval`, because the app had
three hardcoded and mutually inconsistent answers: the Backtest page opened on 15m, a bot's paper dry
run polled 4h for every strategy, and Routines used `DEFAULT_INTERVAL`. A bot could therefore be
created from a backtest at one bar size and then paper-traded at another — the run that justified the
bot was a run of something else. Choosing a strategy now moves the interval with it, unless the user
sets the interval themselves.

Existing bots on either trend strategy will show a different paper P&L than before, because the
figure is recomputed against finer candles. That is the intended correction rather than a regression,
but it is a visible change to a number people have been watching.


**Re-asked a month at a time, and Trend Regime moved to 4h.** Everything above is *continuous
compounding* — one number per symbol, ending where the data ends, so eight symbols is eight
observations. `research/INTERVAL.md` re-ran the question as **65 independent $10,000 months**
(2021-04 → 2026-08, the window 3m data also covers, so every interval scores the **identical**
months) across the same eight symbols, split four for choosing and four held out. That is 780
observations per interval per strategy instead of eight, and it moved one of the two answers.

| mean month ÷ sd of months | 3m | 15m | 1h | 4h | 1d |
|---|---|---|---|---|---|
| Trend Regime — selection | 0.142 | 0.134 | 0.132 | **0.152** | 0.147 |
| Trend Regime — held out | 0.053 | 0.063 | 0.093 | **0.100** | 0.071 |
| Short-Term Channel — selection | **0.203** | 0.191 | 0.168 | 0.154 | 0.121 |
| Short-Term Channel — held out | **0.079** | 0.074 | 0.060 | 0.055 | 0.054 |
| Channel + Regime — selection | **0.187** | 0.181 | 0.164 | 0.153 | 0.130 |
| Channel + Regime — held out | **0.087** | 0.075 | 0.073 | 0.065 | 0.074 |

**Every strategy's best interval is the same in both halves** — roughly a 1-in-125 coincidence if
none of them had a real preference.

For Trend Regime, 4h wins on profit and on losses at the same time rather than trading one against
the other:

| Trend Regime | mean | mean/sd | total profit | summed losses | fees | trades/mo | worst |
|---|---|---|---|---|---|---|---|
| selection, 1h | +3.28% | 0.132 | $85,396 | −$110,736 | $5,802 | 1.13 | −41.19% |
| selection, **4h** | **+3.70%** | **0.152** | **$96,277** | **−$100,511** | **$5,073** | 0.98 | **−33.81%** |
| held out, 1h | +2.20% | 0.093 | $57,161 | −$102,864 | $6,961 | 1.37 | **−26.43%** |
| held out, **4h** | **+2.38%** | **0.100** | **$61,883** | **−$101,351** | **$6,067** | 1.19 | −27.25% |

Six of six columns on selection, five of six on the held-out four; the single worst month is 0.8
points worse there and is **not excepted**, because a change accepted on five columns and reverted
on the sixth is fitted to whichever column disagreed. **1d was run as well and is worse than 4h on
both halves**, which is what makes this believable — 4h is an *interior peak*, not the leading edge
of a monotonic drift that would have meant the ladder simply stopped too early.

**The pre-registered criterion said "no change", and it was the wrong criterion.** It pooled the
three strategies into one ranking, which can only answer "one bar size for everything" — and since
these three want *opposite* bar sizes, pooling averages the answer into a flat row. `preferredInterval`
is a per-strategy field; the unit of analysis should have matched it. The per-strategy table was
written into `research/interval.ts` before anything was scored, so this is a criterion corrected in
the open rather than a result found by re-cutting.

**3m wins both channel strategies in both halves and still cannot ship.** `Interval` in
`shared/ipc.ts` is `'1m' | '15m' | '1h' | '4h' | '1d' | '1w'`; 3m is not a member, and adding it
means changing the type, `INTERVALS`, `INTERVAL_SECONDS` and every exchange adapter, because
`korbit.ts` and `kraken.ts` declare non-partial `Record<Interval, …>` maps with no aggregation path.
For 0.074 → 0.079 mean/sd on the held-out four that is not worth its plumbing — recorded as
measured-and-declined so nobody re-derives it. **The fee figure first written here, 18%, was wrong**:
it pooled all three strategies, including the one moving to 4h rather than 3m, and Trend Regime is
exactly the strategy whose fee bill explodes on a finer bar. Across only the two strategies that
would actually move, 3m costs **5.2% more in fees** ($38,618 → $40,623 over eight symbols). So the
honest reason to decline is the plumbing alone, not the plumbing plus a fee penalty that mostly
belonged to a strategy going the other way. This also finally settles the
"at 3m nothing is settled" paragraph above: on 780 months rather than three symbols, 3m *is* the best
bar size for the two channel strategies and the *worst* for Trend Regime. The old three-symbol
result was not noise about 3m, it was two opposite real effects averaged together.

**One thing had to move with it.** The Market Conditions card states what an ADX reading has meant
for each strategy, and those figures were measured at 15m — quoting them beside a 4h backtest would
be a mismatch nothing on screen would reveal. `research/expect.ts` re-measures each strategy at its
own interval on the same six held-out symbols; the ADX result survives almost untouched
(**+10.70% against a +5.99% baseline at 4h**, versus +10.83/+5.97 at 15m). `MEASURED_EXPECTATIONS`
now carries its interval and a test pins it to `preferredInterval`. The same script checks the
shipped Wilder ADX against the research implementation on every month it scores — 1,465 decisions,
zero difference.

### What the shipped configuration actually does, against simply holding the coin

The decision above leaves the three strategies on **different** bar sizes, which means every table
before it — all of which hold the interval fixed so the strategies can be compared to each other —
describes a configuration that no longer ships. `research/shipped.ts` scores the three as they ship.
It reads each interval from the strategy definition rather than from a constant of its own, so the
script cannot outlive an edit to the strategy. 520 independent $10,000 months each: 65 months
(2021-04 → 2026-08) × 8 symbols.

| as shipped | months | mean | median | sd | mean/sd | worst | best | profit | losses | flat |
|---|---|---|---|---|---|---|---|---|---|---|
| Trend Regime Ensemble (**4h**) | 520 | **+3.04%** | +0.00% | 24.1 | 0.126 | −33.8% | +247.9% | **$158,160** | −$201,861 | 27% |
| Short-Term Channel (**15m**) | 520 | +2.62% | −1.00% | 20.1 | **0.130** | −42.3% | +210.3% | $136,016 | −$194,112 | 1% |
| Channel + Regime (**15m**) | 520 | +2.36% | +0.00% | **18.7** | 0.126 | −43.1% | +189.7% | $122,694 | **−$141,629** | 28% |

**Holding beats all three on the mean month, and nothing in this repository had said so plainly.**
The anchor is the one each run recorded per month — first close to last close over the *same bars*
the strategy traded — so it is the alternative that was genuinely available inside the run, not a
calendar-month return borrowed from elsewhere.

| vs holding, identical months | mean | holding | **geo mean** | **holding** | sd | holding | worst | holding | strategy wins on |
|---|---|---|---|---|---|---|---|---|---|
| Trend Regime Ensemble (4h) | +3.04% | **+3.19%** | **+1.26%** | +0.02% | 24.1 | 30.0 | **−33.8%** | −56.6% | 3 of 8 symbols |
| Short-Term Channel (15m) | +2.62% | **+3.15%** | **+1.30%** | −0.07% | 20.1 | 30.3 | **−42.3%** | −56.6% | 3 of 8 symbols |
| Channel + Regime (15m) | +2.36% | **+3.15%** | **+1.25%** | −0.07% | 18.7 | 30.3 | **−43.1%** | −56.6% | 3 of 8 symbols |

**And then the mean turns out to be the wrong statistic.** Every result in this repository is an
average over *independent* months, each starting at $10,000. Nobody deploys that way. Leave the
money in and you get the **product** of the monthly returns, not their average — and on a
distribution this skewed the product is far below what the mean implies, because a +50% month and a
−50% month average to zero and compound to −25%. That drag scales with variance, and **holding is
the more volatile line on every symbol**, so it loses far more to it. The geometric mean column
above is the reconciliation: holding's is **+0.02% and −0.07% a month — essentially zero — against
+1.25% to +1.30% for the strategies.** Holding's +3.15% average month is real and no single account
ever receives it.

Chained out over the 65 months, per symbol, that is not close:

| $10,000, never topped up | BTC | ETH | SOL | ADA | BNB | LINK | LTC | XRP | beats holding |
|---|---|---|---|---|---|---|---|---|---|
| Trend Regime Ensemble (4h) | $32,450 | $36,260 | $122,676 | $6,902 | $36,803 | $8,036 | $3,984 | $57,861 | **8 of 8** |
| *holding, over the 4h months* | $14,846 | $12,560 | $53,365 | $1,761 | $23,388 | $4,309 | $2,145 | $28,775 | |
| Short-Term Channel (15m) | $24,143 | $37,327 | $233,724 | $22,161 | $19,284 | $8,261 | $4,204 | $26,491 | **7 of 8** |
| Channel + Regime (15m) | $27,478 | $30,819 | $154,168 | $21,567 | $16,174 | $9,211 | $7,155 | $20,836 | **6 of 8** |
| *holding, over the 15m months* | $13,193 | $12,466 | $52,190 | $1,643 | $22,335 | $3,787 | $2,335 | $24,577 | |

So both statements are true and they answer different questions. **Deploy a fresh $10,000 every
month and withdraw the profit, and holding wins.** **Leave one account running, which is what
anyone actually does, and all three win** — Trend Regime at 4h on all eight symbols. The shape
advantage is not a consolation prize for giving up return; past the first month it *is* the return.

Three things keep that from being a stronger claim than it is. Chaining independent months assumes
a month's percentage return does not depend on the balance it started with, which holds for these
strategies — one all-in position at a time, proportional fees — and would not hold for anything with
a fixed position size or a minimum order value. The independent-month design also **forces a flat
position at every month boundary**, so the chained figure models an account that closes out monthly
and re-enters; a continuously-run account would differ. That asymmetry runs against the strategies —
holding's chain is genuinely continuous while theirs pays an extra exit and re-entry twelve times a
year — so their advantage here is understated rather than flattered. And a compounded result over
five years is one path, not a distribution: it is dominated by whether the strategy was in the
market for two or three specific months.

This is the summary-statistic form of what `research/beta.ts` found bar by bar above.

**And they lose to holding specifically on the coins that rose the most**, which is what a trend
follower with a stop does. Mean month by symbol:

| mean month | BTC | ETH | SOL | ADA | BNB | LINK | LTC | XRP |
|---|---|---|---|---|---|---|---|---|
| Trend Regime Ensemble (4h) | **+2.3%** | **+2.9%** | +7.7% | **+1.9%** | +3.2% | +0.6% | −0.9% | +6.6% |
| *holding, over the 4h months* | +1.9% | +2.6% | +8.9% | +1.4% | +3.3% | +1.1% | −0.8% | +7.1% |
| Short-Term Channel (15m) | **+1.9%** | **+2.7%** | +7.6% | **+2.7%** | +1.5% | +0.4% | −0.9% | +5.1% |
| Channel + Regime (15m) | **+1.9%** | +2.2% | +6.5% | **+2.4%** | +1.1% | +0.4% | **−0.1%** | +4.4% |
| *holding, over the 15m months* | +1.8% | +2.6% | +9.0% | +1.4% | +3.3% | +0.9% | −0.6% | +7.0% |

Holding gets a row per interval rather than one row for the table, because the two bar sizes do not
cover quite the same bars and so do not hand the strategy quite the same coin to beat — BTC returns
+1.94% a month over the 4h months and +1.75% over the 15m ones. Bold marks where the strategy beat
its own anchor: **BTC, ETH and ADA** for the two that trade the trend, **BTC, ADA and LTC** for the
gated one. The gap is largest on the three biggest risers — SOL, XRP and BNB — which is the shape of
a stop working as designed: it takes the strategy out of a move that then keeps going. LINK and LTC
are the counter-examples that keep this from being a tidy rule; on those they simply did worse, with
no large move to be stopped out of.

**Two of the eight symbols carry about half the mean.** SOL and XRP are visibly the top pair above,
so removing them is a crude but honest test of whether the edge is broad. It does not fully survive:

| SOL and XRP removed | mean, 8 | mean, 6 | change | mean/sd | profit, 8 | profit, 6 |
|---|---|---|---|---|---|---|
| Trend Regime Ensemble (4h) | +3.04% | +1.67% | **−45%** | 0.096 | $158,160 | $65,142 |
| Short-Term Channel (15m) | +2.62% | +1.38% | **−47%** | 0.104 | $136,016 | $53,784 |
| Channel + Regime (15m) | +2.36% | +1.33% | **−44%** | 0.111 | $122,694 | $51,762 |

The remaining six still return a positive mean and still make money, so the edge is not *only* those
two coins — but anyone planning on +3.0% a month should plan on **+1.7%** if the next few years do
not hand them two more like them.

**Which of the three, decided on the four symbols that took no part in choosing anything.** The
pooled mean/sd column makes them look tied (0.126 / 0.130 / 0.126) and is partly in-sample, since
four of those eight symbols chose the bar size. On BNB/LINK/LTC/XRP the tie breaks:

| held-out four | mean | mean/sd | worst | profit | losses |
|---|---|---|---|---|---|
| Trend Regime Ensemble (4h) | **+2.38%** | **0.100** | **−27.3%** | **$61,883** | −$101,351 |
| Channel + Regime (15m) | +1.45% | 0.075 | −43.1% | $37,823 | **−$83,485** |
| Short-Term Channel (15m) | +1.52% | 0.074 | −42.3% | $39,625 | −$106,777 |

**Most money, Trend Regime at 4h; smallest losses, the gated channel at 15m. Nothing wins both** —
`shipped.ts` prints that verdict from the numbers rather than leaving it as a sentence that can drift
away from them.

### The fast one: Short-Term Channel Breakout

Added after a request for a strategy that trades more often. The first attempt at one failed and
is recorded in `research/SHORT-TERM.md`; the reason it failed is the useful part. That study
measured **mean forward return at a fixed horizon** after a condition (dips, volume spikes,
volatility quartiles, hour of day) and found nothing clearing the 0.240% round trip. The test was
structurally blind to what it was looking for: a trend follower does not earn a positive mean at a
fixed horizon, it earns from an asymmetric exit over a *variable* holding period. Every strategy
here wins under half its trades. So "nothing works short-term" was a statement about the
instrument, not the market.

Re-measured as a trend sweep (`research/tscan.ts`), the picture inverts. Net-after-fees by
lookback, BTCUSDT 15m, two training years, no hysteresis band:

| Lookback | Net | Trades |
|---|---|---|
| 0.25 day | **−99.98%** | 3,858 |
| 1 day | −96.96% | 1,793 |
| 3 days | −78.54% | 972 |
| 8 days | −32.45% | 556 |
| 20 days | +61.00% | 279 |

Add a 1.5% band and the *same* sweep is profitable from a quarter-day lookback (+32.9%, 127
trades), because the band cuts the trade count fivefold. **The binding constraint was never the
trend horizon — it is the trade count**, and hysteresis buys most of the horizon back. That is the
whole reason a short-term strategy is possible here at all.

The shipped configuration is `[2,3,5,8]` days at 0.95/0.25 — Trend Regime Ensemble's own
`[20,30,50,80]` shape moved one decade down. It is mid-plateau, not a peak: across 36 parameter
combinations × 8 symbol/timeframe blocks, **all 288 cells were profitable** on the tuning window,
so there was no sharp optimum to find. On the 2017-2023 window, which no parameter here has seen:

| Pure out-of-sample, 2017-08 → 2023-08 | Strategy | Buy & hold | Max DD | B&H DD | Trades |
|---|---|---|---|---|---|
| BTCUSDT 1h | **+1,294%** | +252% | −35.6% | −83.9% | 117 |
| BTCUSDT 4h | **+945%** | +260% | −40.4% | −83.9% | 107 |
| ETHUSDT 1h | **+2,448%** | +447% | −50.5% | −94.3% | 125 |
| ETHUSDT 4h | **+1,931%** | +447% | −46.7% | −94.1% | 116 |

Four to five times buy & hold on roughly half its drawdown, and positive in three of four eras
including both bears (2017-2019 +46.5% against −50.0%; 2021-2023 +5.1% against −54.8%).

**It does not beat the slow strategy, and is not meant to.** Over those same six years Trend
Regime Ensemble returns +1,443% against +1,294% on BTCUSDT 1h, and +2,221% against +945% on 4h —
a slow trend follower holds a bull run for months while this one is shaken out by its own 5-day
channel and pays to re-enter. What the fast one buys is drawdown and regime coverage: −35.6%
against the slow strategy's −60.6% on BTCUSDT 1h, a higher Sharpe there (1.28 vs 1.17), and
+46.5% against the slow strategy's −16.4% through the 2017-2019 bear — the one window where the
slow strategy fails outright. It also warms up in 8 days rather than 80, so it produces real
trades on the Backtest page's default 90-day range.

**The held-out year was negative**: −12.1% on BTCUSDT 15m, −12.8% on ETH, −19.4% on SOL, against
buy & hold at −29.3%/−45.4%/−47.8%. It lost about half of what holding lost in a year crypto fell
hard, which is a long-only trend follower working as designed — but it is a loss, and a year like
that is a normal outcome rather than a malfunction. Month by month over the full three years on
BTCUSDT 15m: 18 up, 18 down, 1 flat, +69.5% net, with the top three months producing 56% of all
gains.

**More trades is strictly worse after costs**, which is the honest answer to "trade more often".
Worst-case net across the eight symbol/timeframe blocks, by trading frequency:

| Trades/year | Worst-case net |
|---|---|
| 56 | +37.5% |
| 43 | +45.0% |
| 33 | +57.7% |
| **24 (shipped)** | **+76.0%** |
| 15 | +80.8% |

Tested at the same breadth as the slow strategy — nine symbols, full history, six of which were
never looked at while choosing a parameter — it is **profitable on 8 of 9 and beats buy & hold on
7 of 9 at 4h** (8 of 9 and 5 of 9 at 1d). LTCUSDT is the single loss, at −66% against buy & hold's
−77%, and it is the same asset the slow strategy struggles on.

### Which of the two to use

Run head to head on identical windows — both padded to the same 81-day lead, or the faster one
silently gains 72 extra tradeable days and a different benchmark:

| 4h, full history | Short-term | Slow | Buy & hold | Short DD | Slow DD |
|---|---|---|---|---|---|
| BTCUSDT | +1,346% | **+7,287%** | +990% | −43% | −47% |
| ETHUSDT | +3,066% | **+10,843%** | +727% | −50% | −57% |
| BNBUSDT | +1,952% | **+12,151%** | +5,581% | −55% | −44% |
| ADAUSDT | +929% | **+2,473%** | +43% | −70% | −77% |
| DOGEUSDT | +5,662% | **+10,185%** | +3,907% | −78% | −90% |
| LTCUSDT | −66% | **+73%** | −77% | −91% | −78% |
| LINKUSDT | +512% | **+2,198%** | +1,896% | −85% | −80% |
| XRPUSDT | **+998%** | +527% | +206% | −76% | −70% |
| SOLUSDT | **+12,664%** | +9,161% | +6,561% | −60% | −84% |

**The slow strategy wins 7 of 9 at 4h and 5 of 9 at 1d.** It is the better performer and should be
the default. The fast one wins on a minority — SOL and XRP at both timeframes, plus LTC and LINK
at 1d — and its two systematic advantages are elsewhere:

- **Deep bear markets.** Year by year on BTCUSDT 4h, 2018: −1.0% against the slow strategy's
  −35.1% and buy & hold's −72.4%. In 2022 they tie (−27% vs −29%). Across the other seven years
  the slow strategy wins every one, so this is a narrow but real specialisation, not a general
  edge.
- **Warm-up.** 8 days against 80, so it produces real trades on the Backtest page's default
  90-day range and reaches a verdict on a new symbol in a week rather than a quarter.

**Running both does not beat picking the better one.** Two independent sleeves at half capital
each — exactly what two bots at $5,000 apiece does — lands between the two on return in all four
tested series, and its return-per-unit-of-drawdown is never the best of the three. It does buy a
little genuine diversification: on BTCUSDT 4h the blend's −38.4% drawdown is lower than either
strategy alone. That is worth something if you do not know which regime is coming, and it is not
worth much.

**A second window agrees, and answers the question the table above cannot.** The figures above are
full history at 4h, which is one sample per symbol and ends where the data ends. Re-run on 15m
candles over the 36 months 2023-09 → 2026-08 (`research/m15.ts`), the useful statistic is the
*worst* 12-month window out of the 25 in that span — what happens if you start at the wrong moment,
which is the only starting point nobody can rule out:

| 15m, worst of 25 rolling 12-month windows | Trend Regime | Short-term | Buy & hold |
|---|---|---|---|
| BTCUSDT | **−5.9%** | −26.6% | −45.7% |
| ETHUSDT | **−9.1%** | −23.1% | −50.0% |
| SOLUSDT | **−24.0%** | −40.6% | −57.7% |

The gap between the two strategies is wider than the gap between the better one and not trading at
all. Over the whole 36 months Trend Regime beat buy & hold on all three symbols (+261%/+266%/+564%
against +204%/+52%/+416%); the short-term strategy beat it only on ETH. The window is not the bull
market it looks like from here either — buy & hold lost money in the final twelve months on every
symbol (BTC −27%, ETH −43%, SOL −49%), and that is the year Trend Regime finished roughly flat.

**Bar size barely matters to Trend Regime on one symbol, which is why one symbol was the wrong way
to ask.** It is built on 20/30/50/80-day averages, so 15m candles do not make it faster — they make
it re-express the same slow view across sixteen times as many bars. BTCUSDT over those 36 months:
+261.1% at 15m for $1,584 of fees, +263.8% at 1h for $1,371, +219.1% at 4h for $1,170, +202.5% at
1d for $857 — a spread well inside the noise of a strategy that takes about thirty trades in three
years, which is exactly what "barely matters" meant.

It stops looking like noise at 780 observations. Re-asked as 65 independent months across eight
symbols (`research/INTERVAL.md`), 4h beats 1h on mean, mean/sd, total profit, summed losses *and*
fees, on the four symbols used to choose and on the four held back. **Trend Regime now ships at
4h**; the one-symbol continuous run above could not have found that, and the section on candle
intervals sets out why.

### The other three strategies are not broken — they are on the wrong timeframe

Run on 15m they lose badly (Bollinger −98%, EMA Crossover −45% over 3 years). Run on **4h over the
same 2017-2023 window, EMA Crossover returns +923% and Bollinger +637%.** Their indicators are
defined in bars, so EMA(200) is 33 days on 4h — inside the trend band where the edge lives — and
2 days on 15m, where it measurably does not exist. That is the same finding the lookback table
above records, seen from the other side, and it is why Trend Regime Ensemble defines its
lookbacks in days instead. It still wins on 4h (+2,247% on 36 trades against EMA's +923% on 63),
but the gap is a fair fight there rather than a rout.

Every trade pays a flat 0.1% fee on both entry and exit notional, defined once in `shared/fees.ts`
and applied by the backtest engine *and* the executor paper simulations alike — so a Grid or DCA
card reports what an account would actually keep, not a gross figure. This matters most where
margins are thin: at Grid's default 0.5% take-profit per level a round trip costs ~40% of the
gross, and a spread capture pays two fees, which is why the XEMM/Arbitrage thresholds default
above their ~0.2% break-even. A **Compare Strategies**
view on the Backtest page runs all four over the same candle range and ranks them (net %, win
rate, max drawdown, Sharpe, profit factor), so picking one is evidence-based. The result of any
single run includes a full stats panel (Sharpe/Sortino/Calmar/Omega ratios, drawdown, profit
factor, win rate, streaks, a monthly P&L breakdown with losing-month/consecutive-losing-month
counts, and "top 3 months' share of total profit" — a concentration check on whether the edge is
broad or a few outlier months). The original EMA strategy was ported from a reference Freqtrade
(Python) strategy into this project's TypeScript engine.

### Bots

A Bot is one continuous dry-run of its chosen strategy against an exchange/symbol on 4h candles,
polled every 60s (`src/bots/useDryRun.ts`). It re-runs `runBacktest` over a window that always
reaches back to when the bot was enabled (plus 220 candles of indicator warmup) — never a fixed
lookback — so a bot left running a long time doesn't quietly drop its own older paper trades once
they'd scroll outside a fixed window. `forceCloseAtEnd` is off, so an open position is reported as
an open position, not a synthetic closed trade.

### Routines & Controllers

Routines re-run `runBacktest` with their own chosen strategy over a fixed 90-day window on a
schedule; Controllers don't run a strategy themselves — they aggregate realized+unrealized P&L
(`computeExecutorPnl` in `src/executors/computeSnapshot.ts`) across a named group of
already-running executors and enforce risk limits against it.

## Tech Stack

- **Shell**: Electron 33
- **UI**: React 18 + TypeScript, Vite (via `electron-vite`)
- **Charts**: `lightweight-charts`, `technicalindicators`
- **IPC**: typed channels defined in `shared/ipc.ts`, wired up in `electron/ipc`
- **AI**: OpenRouter's OpenAI-compatible chat-completions API, called from the main process with
  plain `fetch` — no SDK (see [AI signals](#ai-signals--paper-only))
- **Secondary backend**: Node.js + Express (`backend/`) — currently just a health-check stub, not
  used by the running app (see [Architecture](#architecture))

## Supported Exchanges

Binance, Coinbase, Kraken, Bithumb, Upbit, Coinone, Korbit, GOPAX — see
`electron/services/exchanges/`. All eight have market-data adapters for paper trading. Binance
alone has a trading adapter (`binanceTrading.ts`) — balance verification, market/limit order
placement, order query/cancel — and it's the only exchange the live-mode Order Executor can use;
every other exchange stays paper-only.

## Project Structure

```
electron/                    Electron main process
  main.ts                    App entry point
  preload.ts                 contextBridge → window.api
  ipc/handlers/               One handler module per IPC surface (app, settings, market, scanner,
                               news, credentials, ai, liveTrading, backtest)
  services/                  settingsService, credentialsService, marketService,
                               liveTradingService (safety gates), livePositionsService (ledger),
                               liveOrdersService (resting limit orders)
                             marketScannerService (the once-a-minute read of every watched pair,
                               its events file, and scans of history), newsService (Binance's
                               announcement lists, once a minute while on, each article kept once),
                               newsRecordService (the news rules and two near misses scored since
                               the studies, from Binance's lists and Upbit's, kept once),
                               jsonlStore (append-only month files, shared with the AI call ledger),
                               marketResearchService (the market studied at launch and every ten
                               minutes), liveMarketService (one public socket: the live book and
                               minute of the pairs shown and the app's own paper trades),
                               newsFeedService (four free news feeds every three minutes, each
                               story kept once, and what the price did after it),
                               aiAdditionsService (the AI additions' calls, within their limits
                               and the budget; the news analyst and the conclusion to "Why did it
                               move?" asking by themselves; the conclusion's evidence rebuilt from
                               public candles; the exit check, on the app's own open paper trades
                               read from the executors on file; the reviewer's triggers worked out
                               from the ledger and the news)
                             AI, with no import path to any of the live services above:
                               openRouterClient (the only file that knows OpenRouter's wire format),
                               aiSignalService (the paid path, cache, retries), aiPrompt,
                               aiConfigService (models, daily budget, the watch's setting),
                               aiLedgerService (call history), aiCredentialsService (the key),
                               aiWatchService (the watch's limits, checked before each of its calls)
    exchanges/                Per-exchange REST/WS connectors + aggregate.ts; binanceTrading.ts
                               (the only real order-placement/query/cancel adapter)

backend/                     Standalone Express service (currently unused by the app — see Architecture)

shared/                       Code both processes run, so they cannot disagree about it
  ipc.ts                      Every IPC type/channel — the main/renderer contract
  aiSignal.ts                 The signal contract, the answer validator, the position machine
  aiContext.ts                What a model is shown: built from a fixed window, never the future
  aiConfirm.ts                A model reviewing a strategy's entry: the request, and what confirms
  aiOutcome.ts                Scoring a call against the candles that followed it
  aiBenchmark.ts              Several models on the same questions: the sample, and the comparison
  aiRoute.ts                  Two models for one decision: when the second is asked, and what it decides
  aiPanel.ts                  A panel of agents for one decision: its name, its reports, their validator
  aiProposal.ts               A call to buy as an order FORM a person submits: what it may carry, and what it may not
  aiOpportunity.ts            A recommendation on an event: entry range, stop, target and two clocks; its validator; what several answers add up to
  aiOpportunityOutcome.ts     What a recommendation would have earned: the entry, the exit, fees, slippage and latency
  aiEventBenchmark.ts         Several models on the same events: the sample, the comparison, the rows that are not models
  aiExperiment.ts             A benchmark run kept as a run: its events, its models, its versions, and what the ledger says it cost
  aiWatch.ts                  Events put to models without a click: the setting, what it takes up, its daily limit, the breaker, what it costs, its notice
  aiWatchPaper.ts             Paper positions the watch opens by itself: the setting, what a call becomes, and its limits
  paperRisk.ts                The paper trades the app opens by itself, the watch's and the news rules': sized by what their stop would lose, and capped in what they stake together
  paperDigest.ts              The daily notice of what those trades did the day before, each closed one in what it risked at its stop
  paperPause.ts               The losing run in R that pauses those trades, the watch's and the news rules' each on its own record, until they are resumed
  appDefaults.ts              What a fresh install starts with (each store's heal function is its resolver), and the risk level in a word
  alerts.ts                   Whether desktop notices are raised at all, and with sound; how loud a story or Bitcoin's hour is (INFO, WATCH, HIGH, CRITICAL)
  paperRCurve.ts              Those trades as a running total in R, one line for the watch and one for the news rules, for Performance
  aiEventMarket.ts            The market around an event: Bitcoin's and ether's returns to its minute, the pair's less theirs, two labels
  aiPace.ts                   How fast one model is asked: the most calls a minute, and how long the next one waits
  aiEffort.ts                 A model asked at a lower reasoning effort, as a model of its own: its id, and where it is taken apart
  aiCost.ts, aiLedger.ts      Budget and estimate arithmetic; the call record and its parser
  tradeLifecycle.ts           One trade's whole story: the event, the answers, the paper position, its fill and its end, joined by their ids
  marketEvent.ts              The event detector: a pair's reading from twelve hours of 1-minute candles, and what raises an event
  marketScanner.ts            The scanner's settings, what a pass reports, and which pairs are watched
  marketResearch.ts           What the app studies as it opens: the liquid pairs, a day's and a week's movers, trending, the market's status and its regime
  liveMarket.ts               The live price against a recommendation: spread, age, an execution score, and enterable, waiting or invalidated
  opportunityScore.ts         The signal score of an opportunity: seven parts by fixed weights and three penalties, shown part by part
  aiHelp.ts                   "Does AI help?": quant, AI, hybrid and holding side by side, and three verdicts by a 95% margin and a 30-trade floor
  paperExposure.ts            A pair's hourly correlation with Bitcoin, and the cap on what the app's own paper trades stake on one side on pairs that track it
  newsTitles.ts, news.ts      Which kind of news a Binance title is, and which coins it names (the study's patterns); what the reader keeps of each article, and what each kind did
  newsFeed.ts                 The news feeds read: RSS, a story's coins, kind, credibility and impact, the same story from several sources, what the price did after, and what each kind has done
  aiAdditions.ts              The AI additions: each one's switch, daily limit and prompt version; the news analyst's question and answer; the conclusion to "Why did it move?" with its evidence and citations; the exit check's triggers, question and verdict; and the reviewer's, checked
  aiExit.ts                   What the exit check's EXIT writes on one of the app's own paper trades (its time limit brought forward, nothing else), and what those trades came to against their plans
  shadowReport.ts             The session report: what the app did over a span, and the V3 document's gates for its 1-hour and 12-hour test runs
  moveExplanation.ts          "Why did it move?": a pair's move against Bitcoin's, its volume and the news that names it, labelled KNOWN, PROBABLE, POSSIBLE or UNKNOWN by fixed rules
  newsActions.ts              What a delisting or a Monitoring Tag does: the notice to a holder, the kind's paper short, and when it is raised for the models and may be asked about
  newsRules.ts, newsRecord.ts The studies' bracket and four-hour hold as arithmetic, shared with research/announcementStudy.ts; the record of the two rules and the two near misses since the studies
  upbitTitles.ts              Which kind of notice an Upbit title is, and which coins it names (the Upbit study's patterns), for the near miss on record
  indicators.ts, atr.ts, …    Indicator and fee arithmetic shared with the strategies

src/                          React renderer app
  App.tsx                     Page router + mounts the headless schedulers
  navigation/pages.ts          The sidebar's four groups, the Page union, and the views of the pages that have them

  The pages, one folder each, put together from the components below where they are:
  overview/                   Overview: the market's status (MarketStatusStrip), the market, what can be acted on, what you hold
                              (portfolioValueLine.ts: the value, and what was made rather than put in), safety
  status/                     What the status bar and Overview say: the trading mode, the watch's mode, a key's state
  opportunities/              Opportunities
  ai-decisions/               AI Decisions (Analyze, Signals)
  performance/                Performance; PaperRCurveCard (the app's own paper trades in R),
                              ExitCheckCard (the exit check's exits against the plans they cut short),
                              and sessionReport.ts + SessionReportCard (the session report, read
                              from the records and the minutes, saved as JSON or CSV)
  trading/                    Paper Trading, Live Trading
  strategies/                 Strategies (Active Runs, Execution)
  research/                   Backtest & Research (Backtest, Automation)
  ai-benchmark/               AI Benchmark
  risk/                       Risk & Safety: the live trading limits card, and the size of the paper
                              trades the app opens by itself and the losing run that pauses them
                              (PaperRiskCard); PaperDigestScheduler (the daily notice of what they
                              did, headless); PaperPauseScheduler (writes the pause down, headless)
  connections/                Connections, and the exchange keys card

  portfolio/                  The portfolio's summary, chart and holdings, for Overview and Performance
  account/                    The paper account (Paper Trading) and the real balances (Live Trading)
  trade/                      Manual paper order ticket
  bots/                       Bot cards, detail view, Active/Runs/Archived tabs, dry-run hook
  executors/                  All 8 executor types: engine, spreadEngine, forms, cards, detail views
  controllers/                Controller store, headless scheduler, page
  livetrading/                LiveTradingBar (arm/kill-switch bar), LiveOrderScheduler (headless
                               poller for resting limit orders) — see Live Trading
  positions/                  Open paper positions; the app's own paper trades with their THESIS
                               STATUS (thesisMeasure.ts, useThesisReadings.ts); Live Positions +
                               Live Trade History (real money); Inventory (handed-over paper positions)
  agents/                     The AI views the AI pages and Settings are made of: Analyze, Opportunities,
                              Signals, Benchmark, Models and Usage;
                              opportunities.ts (an event's candles, the feed, and what each answer did);
                              benchmark.ts (the loop that asks for a benchmark's missing answers);
                              eventBenchmark.ts (the free half of a benchmark on events: the sample,
                              what is held, and the candles that score it);
                              opportunityWatch.ts + OpportunityScheduler (the watch at work, headless);
                              watchPaperTrade.ts (the one file of the watch's that writes: its paper
                              trades, opened, closed sooner on the exit check's EXIT, and settled);
                              exitCheck.ts + ExitCheckScheduler (the exit check at work, headless:
                              reads, asks and hands an EXIT to the writer);
                              paperRefusals.ts (this session's refused paper trades, for the
                              session report);
                              opportunityTable.ts + OpportunityTableCard (the Opportunities table: what
                              is on offer and the last hour's other events, with their scores);
                              quantState.ts + AiHelpCard (the two strategies' state at each event, read
                              from their own exports, and "Does AI help?");
                              liveBoard.ts (the watch's answers joined to their events, for the leaderboard);
                              journal.ts (every recommendation as a line, its filters and its spreadsheet);
                              watchTradeRecords.ts + TradeTimeline (one trade's records, read by
                              their ids, and its timeline)
  routines/                   Scheduled-backtest store, headless scheduler, page
  dashboard/                  Markets page (chart + ticker), and MoversCard
  backtest/                   Execution engine, results UI, Charts + Strategy Comparison views,
                              CSV/JSON/PNG export; aiConfirmation.ts (a strategy replayed with a
                              model allowed to veto each trade)
    strategies/                Pluggable strategy registry — see Strategies
  explorer/                   The market scanner's page (Discovery): what is moving now, the events
                              raised, and what the price did after each (eventOutcomes.ts);
                              NewsFeedCard (the News & Market Events tab: the feeds' stories, their
                              filters, and what each kind did); NewsCard (Binance's announcements
                              as the reader has read them); NewsRecordCard (the news rules and two
                              near misses since the studies, scored)
  news/                       What a delisting does, headless: NewsScheduler (the notice and the
                              rule's paper short) and newsPaperShort.ts (the one file that writes
                              those shorts, paper by a literal, and closes one sooner on the exit
                              check's EXIT). The alerts: NewsAlertScheduler
                              (headless), alertStore.ts (this session's, for the count and the
                              banner) and AlertBanner. "Why did it move?": WhyItMoved, and
                              WhyItMovedHost with its WhyButton; useNewsFeed
  settings/                   Settings: EssentialsCard (the six settings), then under Advanced the
                              Configuration Center: General, Market (the scanner, and
                              NewsSettingsCard: the news reader and what a delisting does) and AI

  charts/                     Shared chart component
  components/                 Card, StatCard, EquityCurveChart, exchange/symbol pickers, etc.
  theme/                      ThemeContext + CHART_PALETTE (canvas-side theme tokens)
  hooks/                      Small shared hooks (e.g. useLastPrice, useMarketResearch)
  ai/                         Renderer side of one AI decision: fetch its window, price it, ask
  utils/                      Formatting helpers

scripts/                      Packaging/signing helper scripts
docs/INVENTORY.md             Every page, setting, scheduler and IPC channel, and where each went in the sidebar's layout
```

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Install

```bash
npm install
```

### Run in development

```bash
npm run dev
```

Launches the Electron app with Vite hot-reload via `electron-vite dev`.

### Type checking, linting & tests

```bash
npm run typecheck
npm run lint
npm test          # vitest, single run
npm run test:watch
```

The suite covers the money-critical logic specifically: the fee model, Grid's stop-price freeze,
TWAP slice scheduling under an interrupted schedule, Binance step/tick rounding, the daily-cap
day boundary, atomic store writes under concurrency, and price formatting. Each case exists
because the corresponding bug was real.

## Building

```bash
npm run build          # electron-vite build
npm run build:win      # Windows build with code signing (scripts/build-win-signed.js)
npm run build:mac      # macOS build
npm run build:linux    # Linux build
```

Build output is written to `out/`, packaged artifacts to `release/` (see the `build` config in
`package.json`, powered by `electron-builder`).
