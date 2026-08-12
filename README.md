# TraderSpider

A desktop trading bot / market dashboard built with Electron, React, and TypeScript. It streams live market data from multiple exchanges, renders charts and indicators, and provides a workspace for building, dry-running, and backtesting trading bots.

## Features

- **Live market dashboard** – ticker, symbol search, and multi-exchange price feeds.
- **Charting** – candlestick charts (via `lightweight-charts`) with technical indicators.
- **Bots** – create bots, inspect bot details, and dry-run them before going live.
- **Backtesting** – run a strategy against historical data and review results/logs.
- **AI assistant** – contextual market/trade analysis (`src/ai`).
- **Explorer** – browse market/exchange data.
- **Settings** – manage exchange API credentials and app settings.

Supported exchanges: Binance, Bybit-style aggregation, Coinbase, Kraken, Bithumb, Coinone, Gopax, Korbit, Upbit (see `electron/services/exchanges`).

## Tech Stack

- **Shell**: Electron 33
- **UI**: React 18 + TypeScript, Vite (via `electron-vite`)
- **Charts**: `lightweight-charts`, `technicalindicators`
- **Backend service**: Node.js + Express (`backend/`), for market data/health endpoints
- **IPC**: typed channels defined in `shared/ipc.ts`, wired up in `electron/ipc`

## Project Structure

```
electron/            Electron main process
  main.ts             App entry point
  preload.ts           Preload/bridge script
  ipc/                IPC channel registration and handlers
  services/           Exchange connectors, credentials, market & settings services

backend/              Standalone Express backend service
  src/server.ts
  src/routes/

src/                  React renderer app
  App.tsx
  dashboard/          Main dashboard + market ticker
  charts/             Chart components
  bots/               Bot creation, detail view, dry-run logic
  backtest/           Backtesting engine and UI
  explorer/           Data explorer page
  settings/           Settings panel
  ai/                 AI assistant client
  components/         Shared UI components (indicators, time tools, etc.)
  navigation/          App page/routing definitions

shared/               Types/contracts shared between main and renderer (IPC)
scripts/              Packaging/signing helper scripts
```

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Install

```bash
npm install
cd backend && npm install
```

### Run in development

```bash
npm run dev
```

This launches the Electron app with Vite hot-reload via `electron-vite dev`.

To run the standalone backend service separately:

```bash
cd backend
npm run dev
```

### Type checking & linting

```bash
npm run typecheck
npm run lint
```

## Building

```bash
npm run build          # electron-vite build
npm run build:win       # Windows build with code signing (scripts/build-win-signed.js)
npm run build:mac       # macOS build
npm run build:linux     # Linux build
```

Build output is written to `out/`, packaged artifacts to `release/` (see the `build` config in `package.json`, powered by `electron-builder`).

## Architecture

See [architecture.txt](architecture.txt) and [architecture-pro.txt](architecture-pro.txt) for the data flow and target system design (market data → strategy/AI analysis → risk management → execution → journaling).
