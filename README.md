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
| **Bots** | **Active** / **Runs** / **Archived** tabs. A bot is a single continuous dry-run of a [chosen strategy](#strategies) against one exchange/symbol. Disabling a bot records a `BotRun` (trades, win rate, net %) under **Runs**; removing a bot **Archives** it (kept, not deleted) rather than hard-deleting. |
| **Executors** | Eight paper-trading strategy types, each running independently against live candles — see [Executors](#executors) below. |
| **Controllers** | Groups executors under shared risk controls (global stop-loss / take-profit / max drawdown) with an automatic P&L snapshot every 5 minutes; a breach auto-stops every attached executor. Adapts Condor's Controller concept, which normally supervises executors inside a Hummingbot bot container. |
| **Positions** | Live paper positions for active bots; a **Live Positions** table of real Binance holdings from live-mode Order Executor fills, closable (fully or partially) for real; a **Live Trade History** table of realized P&L from closed live positions; an **Inventory** table of positions handed over from stopped paper executors (see [Position Handover](#position-handover--inventory)). |
| **Agents** | An interactive tester for `requestAiSignal()` — currently a stub returning `hold`/confidence 0 for every symbol (see [AI Assistant](#ai-assistant--stub)). Not a real LLM agent; Condor's actual Trading Agents (LLM + MCP tools) are out of scope for this app (no backend to host them). |
| **Routines** | Recurring backtests on a saved exchange/symbol/interval/schedule, re-run on a client-side timer while the app is open. Each run produces a session-only report (equity curve, stats) — Condor's routines are server-scheduled Python workflows; this is the closest honest adaptation without a backend. |
| **Market** | The original dashboard: candlestick chart with indicators, symbol search, live ticker. |
| **Backtest** | Runs a chosen strategy over a historical range and shows full stats, equity curve vs. buy-and-hold benchmark, monthly breakdown, and a trade log. A **Charts** tab replays each trade against the candles — entry and exit arrows labelled with fill price and return, the held position shaded by outcome, and UTC times throughout. A **Compare Strategies** view ranks every registered strategy over the same candles. Both views export: CSV or JSON for the numbers, and a single PNG carrying the price chart with every trade marked above the portfolio curve against buy & hold. |
| **Explorer** | Placeholder — not yet built. |
| **Settings** | Appearance (Dark / Light / Colorblind-safe themes) and [Credentials](#credentials--api-keys). |

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

### AI Assistant — stub

`src/ai/aiClient.ts`'s `requestAiSignal()` is an explicit placeholder (`// Placeholder — wire up to
backend/ AI service`) — it always returns `{ confidence: 0, recommendation: 'hold' }`. The Agents
page exists to exercise this interface, not to demonstrate a working model.

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
- **`backend/`** is a minimal, currently-unused standalone Express service (one `/health` route).
  It's the intended future home for a real AI service behind `aiClient.ts`, not something the app
  talks to today.
- **`architecture.txt` / `architecture-pro.txt`** are aspirational system-design diagrams for a
  much larger target platform (quant signal engine, AI decision layer, risk/execution engines,
  observability, a backtest→paper→live research loop). They predate this app's actual feature set
  and describe where the project could eventually go, not what's built — treat them as a vision
  doc, not documentation of the current system.

## Core Strategy & Simulation Logic

### Strategies

`src/backtest/engine.ts`'s `runBacktest(candles, strategyId, options)` is pluggable: execution
(position tracking, fees, the equity curve, and the full stats panel) is shared and untouched
regardless of strategy — only entry/exit/stop logic, defined per strategy in
`src/backtest/strategies/`, changes. `STRATEGIES` in that folder's `index.ts` is the registry;
adding a new one is a self-contained file implementing `generateSignals(candles) →
{entries, exits, stopPrices, warmupBars}`. All five ship long-only, spot (no shorting, no
leverage):

| Strategy | Entry | Exit |
|---|---|---|
| **EMA Crossover + ATR Stop** | EMA(20) crosses above EMA(50) while price is above EMA(200) — a regime filter added after backtesting showed the un-filtered crossover's profit was almost entirely concentrated in the 2023–24 bull run (5 of 6 tested assets were flat-to-negative since). | Stop-loss at `close − ATR(14)×2` (set at entry, checked against every candle's low — a gap-down fills at the worse of open/stop like a real stop order would), or a bearish EMA(20/50) cross. |
| **RSI Mean-Reversion** | RSI(14) crosses up through 30 (oversold) while price is above EMA(100) — same "regime filter gates entries only" shape as the EMA strategy, so it buys dips in an uptrend rather than a falling knife in a downtrend. | RSI crossing back above 70 (overbought), or the same ATR(14)×2 stop. |
| **Bollinger Breakout** | Close breaks above the Bollinger Band(20, 2) upper band. | Close back below the middle band (the breakout failed/reverted), or the same ATR(14)×2 stop. |
| **Trend Regime Ensemble** | Price is above *all four* of the 20/30/50/80-**day** moving averages. The lookbacks are in days and converted using the candles' own spacing, so the strategy means the same thing on 3m as on 4h — written as bar counts, "20 days of 15m" would silently become 4 days of 3m, a scale at which the measured edge is zero. | Price falls below at least three of the four. The gap between a unanimous entry and a near-unanimous exit is deliberate hysteresis; entering and exiting on one line means crossing it repeatedly and paying the fee each time. A `close − ATR(14)×10` stop is set at entry as a disaster stop only — the regime exit is the risk control, and a *tighter* stop measurably reduced returns without improving drawdown. |
| **Short-Term Channel Breakout** | Price sits at or above 95% of the way up its 2/3/5/8-**day** high-low ranges, averaged across the four. Averaging the *position within* each channel is deliberate: Donchian channels are nested, so voting on whether price breaks k of the four highs is only "breaks the k-th slowest high" and re-picks a single lookback under another name. | Price falls back to the bottom quarter of those same ranges. The wide 0.95/0.25 gap is the hysteresis that keeps the fee bill survivable at this speed, and a `close x 0.5` disaster stop is set at entry because the engine will not open a position without one. |

The last two are the only ones built against intraday candles, and they exist because the
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
last 3 years, 5x returns +804% and survives. Over the full 9 years the same 5x is **liquidated on
its first trade and ends at −100%**. Even 3x, which technically finishes at +17,343%, does so
through a −91.9% drawdown that nobody holds through. Leverage does not improve risk-adjusted
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

Four-all, and Sharpe splits four-all too. `1h` still stands, but as an aggregate call rather than a
sweep: it wins the median on both windows (+139.1% against +64.7% here), the median drawdown (−68.2%
against −75.0%) and the fee bill, while losing outright on half the symbols taken one at a time. That
is worth saying plainly, because a per-symbol interval override is a reasonable thing to want on this
strategy and not on the other one.

**What changed in the app.** `StrategyDefinition` gained a `preferredInterval`, because the app had
three hardcoded and mutually inconsistent answers: the Backtest page opened on 15m, a bot's paper dry
run polled 4h for every strategy, and Routines used `DEFAULT_INTERVAL`. A bot could therefore be
created from a backtest at one bar size and then paper-traded at another — the run that justified the
bot was a run of something else. Choosing a strategy now moves the interval with it, unless the user
sets the interval themselves.

Existing bots on either trend strategy will show a different paper P&L than before, because the
figure is recomputed against finer candles. That is the intended correction rather than a regression,
but it is a visible change to a number people have been watching.

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

**Bar size barely matters to Trend Regime, and 15m costs the most.** It is built on 20/30/50/80-day
averages, so 15m candles do not make it faster — they make it re-express the same slow view across
sixteen times as many bars. BTCUSDT over those 36 months: +261.1% at 15m for $1,584 of fees,
+263.8% at 1h for $1,371, +219.1% at 4h for $1,170, +202.5% at 1d for $857. **1h is the cheapest
way to run it**, and the differences in return are inside the noise of a strategy that takes about
thirty trades in three years.

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
                               credentials, liveTrading)
  services/                  settingsService, credentialsService, marketService,
                               liveTradingService (safety gates), livePositionsService (ledger),
                               liveOrdersService (resting limit orders)
    exchanges/                Per-exchange REST/WS connectors + aggregate.ts; binanceTrading.ts
                               (the only real order-placement/query/cancel adapter)

backend/                     Standalone Express service (currently unused by the app — see Architecture)

shared/ipc.ts                 Every IPC type/channel — the main/renderer contract

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
  agents/                     AI-signal tester (stub backend)
  routines/                   Scheduled-backtest store, headless scheduler, page
  dashboard/                  Market page (chart + ticker)
  backtest/                   Execution engine, results UI, Charts + Strategy Comparison views,
                              CSV/JSON/PNG export
    strategies/                Pluggable strategy registry — see Strategies
  explorer/                   Placeholder page
  settings/                   Appearance + Credentials

  charts/                     Shared chart component
  components/                 Card, StatCard, EquityCurveChart, exchange/symbol pickers, etc.
  theme/                      ThemeContext + CHART_PALETTE (canvas-side theme tokens)
  hooks/                      Small shared hooks (e.g. useLastPrice)
  ai/                         AI client stub
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
