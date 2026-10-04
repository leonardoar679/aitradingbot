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

The sidebar's page order roughly mirrors Condor's own information architecture.

| Page | What it does |
|---|---|
| **Portfolio** | Total value, active-bot count, bot P&L, and system-status stat cards; an equity-evolution chart (value/composition toggle, 1D/1W/1M/3M ranges); a top-holdings list. |
| **Trade** | A manual paper order ticket — market/limit, live last price, session-only order history. Analogous to Condor's `/trade` (direct exchange trading without an executor). |
| **Bots** | **Active** / **Runs** / **Archived** tabs. A bot is a single continuous dry-run of a [chosen strategy](#strategies) against one exchange/symbol, optionally with a model asked to [confirm each entry](#ai-signals--paper-only). Disabling a bot records a `BotRun` (trades, win rate, net %) under **Runs**; removing a bot **Archives** it (kept, not deleted) rather than hard-deleting. |
| **Executors** | Eight paper-trading strategy types, each running independently against live candles — see [Executors](#executors) below. |
| **Controllers** | Groups executors under shared risk controls (global stop-loss / take-profit / max drawdown) with an automatic P&L snapshot every 5 minutes; a breach auto-stops every attached executor. Adapts Condor's Controller concept, which normally supervises executors inside a Hummingbot bot container. |
| **Positions** | Live paper positions for active bots; a **Live Positions** table of real Binance holdings from live-mode Order Executor fills, closable (fully or partially) for real; a **Live Trade History** table of realized P&L from closed live positions; an **Inventory** table of positions handed over from stopped paper executors (see [Position Handover](#position-handover--inventory)). |
| **Agents** | The AI workspace: ask a model about a market, see how each model's past calls turned out, put the same questions to several models and score them side by side, choose which models may be asked, and see what asking has cost — see [AI signals](#ai-signals--paper-only). Paper only. Not Condor's Trading Agents (an LLM driving MCP tools): a model here is handed a market snapshot and returns one JSON decision, and is given no tools at all. |
| **Routines** | Recurring backtests on a saved exchange/symbol/interval/schedule, re-run on a client-side timer while the app is open. Each run produces a session-only report (equity curve, stats) — Condor's routines are server-scheduled Python workflows; this is the closest honest adaptation without a backend. |
| **Market** | The original dashboard: candlestick chart with indicators, symbol search, live ticker. |
| **Backtest** | Runs a chosen strategy over a historical range and shows full stats, equity curve vs. buy-and-hold benchmark, monthly breakdown, and a trade log. A **Live** tab monitors the same route continuously — see [Live strategy monitor](#live-strategy-monitor) below. A **Charts** tab replays each trade against the candles — entry and exit arrows labelled with fill price and return, the held position shaded by outcome, and UTC times throughout. A **Compare Strategies** view ranks every registered strategy over the same candles. An optional tick box has a model [confirm each entry](#ai-signals--paper-only) and sets the strategy beside itself with the vetoed trades removed. Both views export: CSV or JSON for the numbers, and a single PNG carrying the price chart with every trade marked above the portfolio curve against buy & hold. |
| **Explorer** | Placeholder — not yet built. |
| **Settings** | Appearance (Dark / Light / Colorblind-safe themes) and [Credentials](#credentials--api-keys). |

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
| **Position** | The Triple Barrier Method: one entry (at a set price or at market), then exits on whichever comes first — take-profit, stop-loss, a trailing stop (with its own activation/trail %), or a time limit. |
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
cadence is the cached answer at the others, and on the Benchmark tab.

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
entries, described next; an **AI signals** overlay on the Market chart, off by default; and the
**Agents** page:

| Tab | What it does |
|---|---|
| **Analyze** | One market, one model, one click, one call — or four, when what is picked is a panel of agents on a model. The button states the cost of the whole click before it is pressed, and reads "cached, free" when the answer is already held. Answers from different models for the same candle stack into a comparison. A call to buy can be turned into an order form — see *From a call to an order, by hand*. |
| **Signals** | Every answered call, scored against the candles that followed: the move after 1h, 4h and 1d, which of the model's own levels was touched first, and whether the call was right. Per model: act rate, hit rate, and hit rate by confidence. |
| **Benchmark** | The same questions put to every model you tick, and to a panel of agents beside its own model, with the answers scored side by side and what a route between two of them would have done — described below. |
| **Models** | OpenRouter's catalogue with prices. Only models that can be held to a strict JSON schema can be enabled. Also where a route to a second model, or to a panel, is set — described below. |
| **Usage** | Calls, tokens, dollars and latency per model, and the daily budget. |

**The key.** An OpenRouter key — made at openrouter.ai/keys, and starting `sk-or-` — is entered on
the Agents page. Until one is stored a card asking for it sits above every tab; afterwards
**API key** on the tab row opens the same card to replace, test or remove it, and Settings carries
it too. Saving a key asks OpenRouter a free question about the key itself and spends nothing, and
a value that is plainly some other secret is refused before it is sent anywhere to be checked.

**From a call to an order, by hand.** A call to buy that this app would act on — answered,
accepted, at 65% confidence or more — carries a **Prepare an order from this call** button on the
Analyze tab for as long as its candle is open. The button opens the New Executor form as a
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

**Model benchmark.** The Signals tab scores whatever each model happened to be asked, and those are
different candles for every model: a better hit rate there can mean an easier week. Agents →
**Benchmark** fixes the questions first and asks every ticked model all of them.

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

**Model routing.** A cheap model can be asked every fifteen minutes for a few dollars a month. A
frontier model asked the same way costs several times that, and nearly all of it buys the answer
"hold". A route asks the default model at every decision and passes the decision on to a second
model only when a rule says so; the second model's answer is then the decision. It is set on
Agents → **Models** and is off until someone sets it.

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
  answers, so the Benchmark tab works out what a route between any two of its models would have
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
which is why the Benchmark tab shows how often each pair made the same call beside what a route
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

Every call is one line in `aiLedger/calls-YYYY-MM.jsonl`: the model, the versions of the prompt,
context and schema, what it cost, and what it said. A panel's decision is four lines, each marked
with its part; the three analysts' lines carry a report and nothing to score. Outcomes are **not**
stored — they are recomputed from candles whenever the Signals tab is opened, like every other
simulated figure here.

Each prompt is pinned to its version by `tests/aiPromptVersions.test.ts`, which holds a hash of
every prompt text and schema beside the version it is cached under and fails when one is edited
without the other.

**What this does not show** is that any model is worth trading on. `research/gptneed.ts` measured
what a 15-minute signal needs before GPT Intraday makes money at all: roughly 72–75% of its calls
right at a four-hour horizon, with a coin flip losing 89–100% of the account to the fee. A
seven-day backtest closes eight or nine trades, far too few to place a model on that scale. The
Signals tab scores every *decision* rather than every trade, which is what makes the question
answerable at a price worth paying, and it withholds a hit rate below thirty scored calls.

A benchmark answers a narrower question than it may look: which model's calls were better on one
market over one stretch, each call judged alone at four hours. It is not a backtest of the bot,
whose results also depend on its stop and on when the model later says sell.

One real benchmark has been run, and it is a data point rather than a finding: `openai/gpt-5-mini`
on BTCUSDT, 180 decisions four hours apart over the 30 days to 3 October 2026, for $0.59. It said
buy 40 times and was right at four hours on 16 of them — 40% ± 15, against 28% ± 7 for buying on
every one of those candles. That is better than the market's own rate on that month and a long way
short of the 67–75% a bot needs. Its 16 buys at 65% confidence or more, each held four hours, made
+4.9% after costs, against +4.2% for simply holding throughout: sixteen trades, on one market, in
one month.

A route is still unmeasured. Whether a second opinion improves a cheap model's calls, or
only removes its good entries along with its bad ones, is what the Benchmark tab's route table is
for — and that table has nothing to work from until two models have been benchmarked for real.

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

Settings → **Live Trading — API Credentials** lets you add a Binance API key/secret. Adding one
makes exactly one authenticated, read-only call (`GET /account`, to list balances) purely to
verify the key is valid before it's ever persisted — a key that fails verification is never
stored. Keys are encrypted at rest via Electron's `safeStorage` (OS keychain / DPAPI) in a
separate `credentials.json`, isolated from `settings.json` so a bug in general settings
persistence can never touch a secret. "No key, no live mode, ever": every live-trading code path
in this app requires a verified credential first.

## Live Trading — Real Money

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

One gate is not user-facing and sits below all of these: **a signed request can only ever be sent
to a host that implements the trading routes.** Market data resolves from a wider list that
includes `data-api.binance.vision`, Binance's public data mirror — it is not geo-blocked, so it is
often the only host that answers, but it has no signed routes at all (`/account` returns 404, and
so would `/order`). Data and trading therefore resolve from separate lists with separate memos. In
a region where only the mirror is reachable, `resolveTradingEndpoint()` refuses outright rather
than handing back a host that would 404 a real, signed order in a way that reads like a bad API
key. `binanceFutures.ts` has always kept its own host for the same reason; spot now matches it.

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
next launch with no reconciliation logic beyond "poll every open record." The Executors page's
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
  regardless of which page is active. `RoutineScheduler`/`ControllerScheduler` poll their own
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
  ipc/handlers/               One handler module per IPC surface (app, settings, market,
                               credentials, ai, liveTrading, backtest)
  services/                  settingsService, credentialsService, marketService,
                               liveTradingService (safety gates), livePositionsService (ledger),
                               liveOrdersService (resting limit orders)
                             AI, with no import path to any of the live services above:
                               openRouterClient (the only file that knows OpenRouter's wire format),
                               aiSignalService (the paid path, cache, retries), aiPrompt,
                               aiConfigService (models, daily budget), aiLedgerService (call
                               history), aiCredentialsService (the key)
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
  aiCost.ts, aiLedger.ts      Budget and estimate arithmetic; the call record and its parser
  indicators.ts, atr.ts, …    Indicator and fee arithmetic shared with the strategies

src/                          React renderer app
  App.tsx                     Page router + mounts the headless schedulers
  navigation/pages.ts          Sidebar nav items / Page union

  portfolio/                  Portfolio page, equity chart, holdings list
  trade/                      Manual paper order ticket
  bots/                       Bot cards, detail view, Active/Runs/Archived tabs, dry-run hook
  executors/                  All 8 executor types: engine, spreadEngine, forms, cards, detail views
  controllers/                Controller store, headless scheduler, page
  livetrading/                LiveTradingBar (arm/kill-switch bar), LiveOrderScheduler (headless
                               poller for resting limit orders) — see Live Trading
  positions/                  Open paper positions; Live Positions + Live Trade History (real
                               money); Inventory (handed-over paper positions)
  agents/                     The AI workspace: Analyze, Signals, Benchmark, Models and Usage tabs;
                              benchmark.ts (the loop that asks for a benchmark's missing answers)
  routines/                   Scheduled-backtest store, headless scheduler, page
  dashboard/                  Market page (chart + ticker)
  backtest/                   Execution engine, results UI, Charts + Strategy Comparison views,
                              CSV/JSON/PNG export; aiConfirmation.ts (a strategy replayed with a
                              model allowed to veto each trade)
    strategies/                Pluggable strategy registry — see Strategies
  explorer/                   Placeholder page
  settings/                   Appearance + Credentials

  charts/                     Shared chart component
  components/                 Card, StatCard, EquityCurveChart, exchange/symbol pickers, etc.
  theme/                      ThemeContext + CHART_PALETTE (canvas-side theme tokens)
  hooks/                      Small shared hooks (e.g. useLastPrice)
  ai/                         Renderer side of one AI decision: fetch its window, price it, ask
  utils/                      Formatting helpers

scripts/                      Packaging/signing helper scripts
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
