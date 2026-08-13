# TraderSpider

A desktop trading dashboard built with Electron, React, and TypeScript. It streams live market
data from eight exchanges, runs a pluggable library of validated technical-analysis strategies,
and provides a full paper-trading workspace — bots, multi-type strategy executors, portfolio
views, and scheduled backtests — modeled on Hummingbot's [Condor](https://condor.hummingbot.org)
dashboard, adapted to run entirely inside a single Electron process with no server backend.

**Everything in this app is simulated.** Every bot, executor, and position replays real market
data through deterministic paper-trading logic — no order is ever placed on a real exchange. The
one exception is read-only: Settings can verify a Binance API key/secret against a real balance
call, purely to prove the key works, but nothing in the app is wired to use it for trading (see
[Credentials](#credentials--api-keys) below).

## Table of Contents

- [Features](#features)
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
| **Positions** | Live paper positions for active bots, plus an **Inventory** table of positions handed over from stopped executors (see [Position Handover](#position-handover--inventory)). |
| **Agents** | An interactive tester for `requestAiSignal()` — currently a stub returning `hold`/confidence 0 for every symbol (see [AI Assistant](#ai-assistant--stub)). Not a real LLM agent; Condor's actual Trading Agents (LLM + MCP tools) are out of scope for this app (no backend to host them). |
| **Routines** | Recurring backtests on a saved exchange/symbol/interval/schedule, re-run on a client-side timer while the app is open. Each run produces a session-only report (equity curve, stats) — Condor's routines are server-scheduled Python workflows; this is the closest honest adaptation without a backend. |
| **Market** | The original dashboard: candlestick chart with indicators, symbol search, live ticker. |
| **Backtest** | Runs a chosen strategy over a historical range and shows full stats, equity curve vs. buy-and-hold benchmark, monthly breakdown, and a trade log — plus a **Compare Strategies** view that ranks every registered strategy against the same candle range. |
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
| **Grid** | Divides a price range into levels spaced by a %; a level fills when price touches it, and closes (booking P&L) when it reaches its own take-profit target, freeing it to refill. |
| **DCA** | A configurable ladder of buy/sell levels at % offsets from a base price; tracks a running volume-weighted average entry and exits the whole position on take-profit / stop-loss / a time limit. |
| **TWAP** | Slices a total order into equal pieces over a duration, executing one slice per interval at that candle's close; tracks cumulative VWAP and progress. |
| **Position** | The Triple Barrier Method: one entry (at a set price or at market), then exits on whichever comes first — take-profit, stop-loss, a trailing stop (with its own activation/trail %), or a time limit. |
| **Order** | A single order with one of four fill strategies: `market`/`limit_chaser` fill immediately at the next candle's open (chasing the best price isn't modelable without a real order book, so it's approximated as an immediate market fill); `limit`/`limit_maker` fill the first time price touches the limit. |
| **XEMM** | Cross-exchange market making: monitors a *buying market* and a *selling market* simultaneously; when the spread crosses a minimum-profitability threshold in that direction, books a capture. Edge-triggered (re-arms only once the spread retreats) so a spread that stays wide doesn't produce unrealistic repeated captures. |
| **Arbitrage** | Like XEMM but bidirectional — captures the spread whichever way it's skewed, since arbitrage isn't tied to a fixed maker/taker leg. |
| **Market Making** | Classic two-sided quoting: places a bid/ask around the live price at a fixed spread, refreshed on an interval. Optional inventory-skew management biases the quoted mid price back toward a target inventory as fills drift holdings away from it. Fills are tracked with a running average-cost basis, so P&L splits correctly into realized (closed/reduced exposure) and unrealized. |

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
persistence can never touch a secret. **No code path in this app places a real order** — the
credential system exists as groundwork for a possible future live-trading mode, not a feature you
can use yet.

## Architecture

```
electron/main.ts  (main process)
      │  creates BrowserWindow, registers IPC handlers
      ▼
electron/preload.ts  ── contextBridge ──▶  window.api.*  (renderer)
      │
      ├── settings.get() / settings.set(patch)     → electron/services/settingsService.ts
      ├── credentials.list() / set() / test()       → electron/services/credentialsService.ts
      └── market.*  (symbols, candles, tickers)      → electron/services/marketService.ts
                                                          + electron/services/exchanges/*
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
- **Headless schedulers**: `RoutineScheduler` and `ControllerScheduler` are `return null`
  components mounted once in `App.tsx`, so their `setInterval`s keep firing regardless of which
  page is active. Each polls its own settings slice every 10s to notice config changes made on the
  page component (there's no cross-component push channel), then keeps one timer per active
  routine/controller at its own schedule.
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
{entries, exits, stopPrices, warmupBars}`. All three ship long-only, spot (no shorting, no
leverage):

| Strategy | Entry | Exit |
|---|---|---|
| **EMA Crossover + ATR Stop** | EMA(20) crosses above EMA(50) while price is above EMA(200) — a regime filter added after backtesting showed the un-filtered crossover's profit was almost entirely concentrated in the 2023–24 bull run (5 of 6 tested assets were flat-to-negative since). | Stop-loss at `close − ATR(14)×2` (set at entry, checked against every candle's low — a gap-down fills at the worse of open/stop like a real stop order would), or a bearish EMA(20/50) cross. |
| **RSI Mean-Reversion** | RSI(14) crosses up through 30 (oversold) while price is above EMA(100) — same "regime filter gates entries only" shape as the EMA strategy, so it buys dips in an uptrend rather than a falling knife in a downtrend. | RSI crossing back above 70 (overbought), or the same ATR(14)×2 stop. |
| **Bollinger Breakout** | Close breaks above the Bollinger Band(20, 2) upper band. | Close back below the middle band (the breakout failed/reverted), or the same ATR(14)×2 stop. |

Every trade pays a flat 0.1% taker fee on both entry and exit notional. A **Compare Strategies**
view on the Backtest page runs all three over the same candle range and ranks them (net %, win
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
`electron/services/exchanges/`. Live order placement exists for none of them; Binance alone has a
read-only balance-verification adapter for the Credentials feature.

## Project Structure

```
electron/                    Electron main process
  main.ts                    App entry point
  preload.ts                 contextBridge → window.api
  ipc/handlers/               One handler module per IPC surface (app, settings, market, credentials)
  services/                  settingsService, credentialsService, marketService
    exchanges/                Per-exchange REST/WS connectors + aggregate.ts

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
  positions/                  Open positions + Inventory (handed-over positions)
  agents/                     AI-signal tester (stub backend)
  routines/                   Scheduled-backtest store, headless scheduler, page
  dashboard/                  Market page (chart + ticker)
  backtest/                   Execution engine, results UI, Strategy Comparison view
    strategies/                Pluggable strategy registry (EMA/RSI/Bollinger) — see Strategies
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

### Type checking & linting

```bash
npm run typecheck
npm run lint
```

## Building

```bash
npm run build          # electron-vite build
npm run build:win      # Windows build with code signing (scripts/build-win-signed.js)
npm run build:mac      # macOS build
npm run build:linux    # Linux build
```

Build output is written to `out/`, packaged artifacts to `release/` (see the `build` config in
`package.json`, powered by `electron-builder`).
