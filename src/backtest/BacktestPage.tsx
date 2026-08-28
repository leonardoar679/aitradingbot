import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Zap } from 'lucide-react'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { BacktestRunningView, type RunningState } from './BacktestRunningView'
import { BacktestResultsView, type ResultsGeneralInfo } from './BacktestResultsView'
import { BacktestChartsView } from './BacktestChartsView'
import { StrategyComparisonView } from './StrategyComparisonView'
import { runBacktest, DEFAULT_STARTING_BALANCE, type BacktestResult } from './engine'
import { MAX_LEVERAGE, MIN_LEVERAGE, isUsableLeverage, liquidationDistancePct } from '../../shared/perp'
import { availableBalance } from '../account/paperAccount'
import { committedFor } from '../account/accountCommitments'
import { describeRangeProblem, describeEmptyRange } from './rangeProblem'
import { describeError } from '../utils/ipcError'
import { STRATEGIES, DEFAULT_STRATEGY_ID, getStrategy } from './strategies'
import { replayExecutor, type ExecutorReplayResult } from './executorReplay'
import { ExecutorBacktestView } from './ExecutorBacktestView'
import { replayController, type ControllerReplayResult } from './controllerReplay'
import { ControllerBacktestView } from './ControllerBacktestView'
import {
  EXCHANGES,
  INTERVALS,
  INTERVAL_SECONDS,
  type Candle,
  type ControllerConfig,
  type Exchange,
  type ExecutorConfig,
  type Interval,
  type PaperAccount,
  type SymbolInfo
} from '../../shared/ipc'

type Tab = 'configuration' | 'progress' | 'charts' | 'compare'

/** A saved executor selected in the strategy dropdown, encoded so one field can carry either
 * kind of run. Executors and signal strategies are genuinely different things -- see
 * executorReplay.ts -- so they produce different result shapes rather than being forced into one. */
const EXECUTOR_PREFIX = 'executor:'

export function executorIdFromStrategyId(strategyId: string): string | null {
  return strategyId.startsWith(EXECUTOR_PREFIX) ? strategyId.slice(EXECUTOR_PREFIX.length) : null
}

/** A saved controller, encoded the same way. A controller supervises executors that may trade
 * different markets, so its run takes its symbols from them and ignores the Symbol picker. */
const CONTROLLER_PREFIX = 'controller:'

export function controllerIdFromStrategyId(strategyId: string): string | null {
  return strategyId.startsWith(CONTROLLER_PREFIX) ? strategyId.slice(CONTROLLER_PREFIX.length) : null
}

type RunState =
  | RunningState
  | {
      status: 'executor-done'
      executor: ExecutorConfig
      replay: ExecutorReplayResult
      candles: Candle[]
      elapsedSec: number
    }
  | {
      status: 'controller-done'
      controller: ControllerConfig
      replay: ControllerReplayResult
      elapsedSec: number
    }
  | {
      status: 'done'
      result: BacktestResult
      candles: Candle[]
      elapsedSec: number
      generalInfo: ResultsGeneralInfo
      logLines: string[]
    }

interface TradingRouteRow {
  symbol: string
  interval: Interval
  strategyId: string
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function defaultTradingRoute(symbol: string): TradingRouteRow {
  return { symbol, interval: '15m', strategyId: DEFAULT_STRATEGY_ID }
}

function fieldStyle(): React.CSSProperties {
  return {
    background: 'var(--bg-app)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    padding: '0.6rem 0.75rem',
    color: 'var(--text-primary)',
    fontSize: '0.85rem'
  }
}

function tabButtonStyle(active: boolean): React.CSSProperties {
  return {
    background: 'transparent',
    border: 'none',
    padding: '0.7rem 1rem',
    fontSize: '0.85rem',
    fontWeight: active ? 700 : 500,
    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    cursor: 'pointer',
    borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`
  }
}

function SectionHeader({
  label,
  actions
}: {
  label: string
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '1.6rem 0 0.9rem' }}>
      <span style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <div style={{ flex: 1, borderBottom: '1px dashed var(--border)' }} />
      {actions}
    </div>
  )
}

export function BacktestPage(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('configuration')
  const [runLabel, setRunLabel] = useState<string | null>(null)
  const [runState, setRunState] = useState<RunState | null>(null)
  const runIdRef = useRef(0)
  const activeFetchRequestIdRef = useRef<string | null>(null)
  const [exchange, setExchange] = useState<Exchange>(EXCHANGES[0].id)
  const [symbols, setSymbols] = useState<SymbolInfo[]>([])
  const [symbolsLoading, setSymbolsLoading] = useState(false)
  /** SymbolSearch already learned this lesson; this page loads its symbols separately and did
   * not. A failed list left the Route dropdown with zero options, no message anywhere on the
   * page, and Start still enabled -- because the symbol lives in state (defaulted to the
   * exchange's own default) even when nothing can be shown for it. Verified by forcing
   * market:listSymbols to throw: optionCount 0, value "", Start disabled:false, no error text. */
  const [symbolsError, setSymbolsError] = useState<string | null>(null)
  const [symbolsReloadKey, setSymbolsReloadKey] = useState(0)
  const [tradingRoute, setTradingRoute] = useState<TradingRouteRow>(() =>
    defaultTradingRoute(EXCHANGES[0].defaultSymbol.symbol)
  )
  const [startDate, setStartDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 90)
    return isoDate(d)
  })
  const [endDate, setEndDate] = useState(() => isoDate(new Date()))
  const [splitDate, setSplitDate] = useState('')
  const [startingCapital, setStartingCapital] = useState(String(DEFAULT_STARTING_BALANCE))
  const [leverageInput, setLeverageInput] = useState('')
  /** Once the user types their own number, the account must stop overwriting it -- otherwise
   * switching to a different pair to compare silently replaces the amount they chose. State
   * rather than a ref because the caption has to stop claiming the number came from the account. */
  const [capitalTouched, setCapitalTouched] = useState(false)
  const [account, setAccount] = useState<PaperAccount | null>(null)
  const [accountExecutors, setAccountExecutors] = useState<ExecutorConfig[]>([])
  const [accountControllers, setAccountControllers] = useState<ControllerConfig[]>([])
  // Spread executors (XEMM, Arbitrage) price two markets at once and are simulated by a different
  // engine entirely, so they are not offered here rather than being offered and then failing.
  const replayableExecutors = accountExecutors.filter((e) => e.type !== 'xemm' && e.type !== 'arbitrage')
  const [compareCandles, setCompareCandles] = useState<Candle[] | null>(null)

  // Labels for an exported comparison. Derived at render from the SAME pickers the comparison
  // fetch reads, rather than from the last single-strategy run's metadata -- those can differ,
  // because Compare Strategies fetches its own candles and the user may have changed the symbol
  // since the last Start.
  const comparisonMeta = useMemo(() => {
    const info = symbols.find((sym) => sym.symbol === tradingRoute.symbol)
    return {
      exchange: EXCHANGES.find((e) => e.id === exchange)?.name ?? exchange,
      symbol: info ? `${info.baseAsset}-${info.quoteAsset}` : tradingRoute.symbol,
      interval: INTERVALS.find((iv) => iv.id === tradingRoute.interval)?.label ?? tradingRoute.interval,
      startDate,
      endDate
    }
  }, [symbols, tradingRoute.symbol, tradingRoute.interval, exchange, startDate, endDate])
  const [compareLoading, setCompareLoading] = useState(false)
  const [compareError, setCompareError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.settings
      .get()
      .then((settings) => {
        if (cancelled) return
        setAccount(settings.paperAccount ?? null)
        setAccountExecutors(settings.executors ?? [])
        setAccountControllers(settings.controllers ?? [])
      })
      .catch((error: unknown) => {
        // A backtest does not need the account -- it only defaults the capital field from it.
        // Falling back to DEFAULT_STARTING_BALANCE beats blocking the page over bookkeeping.
        console.error('Failed to read the paper account for the starting capital default:', error)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setSymbolsLoading(true)
    setSymbolsError(null)
    window.api.market
      .listSymbols(exchange)
      .then((list) => {
        if (!cancelled) setSymbols(list)
      })
      .catch((error) => {
        console.error('Failed to load symbols:', error)
        if (!cancelled) setSymbolsError(describeError(error))
      })
      .finally(() => {
        if (!cancelled) setSymbolsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [exchange, symbolsReloadKey])

  function handleExchangeChange(next: Exchange): void {
    setExchange(next)
    const info = EXCHANGES.find((e) => e.id === next)
    setTradingRoute(defaultTradingRoute(info?.defaultSymbol.symbol ?? ''))
  }

  function updateTradingRoute(patch: Partial<TradingRouteRow>): void {
    setTradingRoute((prev) => ({ ...prev, ...patch }))
  }

  // Empty until the symbol list arrives, which is why the default-capital effect below waits for
  // it: defaulting against '' would charge the run to an asset the account has never held.
  const quoteAsset = symbols.find((sym) => sym.symbol === tradingRoute.symbol)?.quoteAsset ?? ''
  // AVAILABLE, not total. Money a running paper strategy is already holding cannot also be the
  // money this backtest starts with -- the Account page draws the same line.
  const accountAvailable =
    account !== null && quoteAsset !== ''
      ? availableBalance(account, quoteAsset, committedFor(accountExecutors, quoteAsset))
      : 0

  useEffect(() => {
    if (capitalTouched) return
    if (accountAvailable > 0) setStartingCapital(String(accountAvailable))
  }, [accountAvailable, capitalTouched])

  // Blank means spot, and blank is the default: someone who came here to test a strategy should
  // not have to opt out of leverage. Anything typed is validated rather than silently coerced --
  // resolveLeverage would quietly turn 500 into 1x and run a spot backtest under a 500x heading.
  const leverageValue = leverageInput.trim() === '' ? 1 : Number.parseFloat(leverageInput)
  const leverageProblem =
    !Number.isFinite(leverageValue) || !isUsableLeverage(leverageValue)
      ? `Leverage has to be a number between ${MIN_LEVERAGE} and ${MAX_LEVERAGE}. Leave it blank for no leverage.`
      : null
  const capitalValue = Number.parseFloat(startingCapital)
  const capitalProblem =
    !Number.isFinite(capitalValue) || capitalValue <= 0
      ? 'Starting capital has to be a number above 0 — every figure in the results is a share of it.'
      : null

  function handleStart(): void {
    const route = tradingRoute
    if (!route.symbol || capitalProblem !== null || leverageProblem !== null) return

    // Checked before anything is fetched: a blank or backwards range fetches zero candles
    // without erroring, and a zero-candle run still renders a complete results page.
    const rangeProblem = describeRangeProblem({ startDate, endDate })
    if (rangeProblem !== null) {
      setTab('progress')
      setRunState({ status: 'error', message: rangeProblem })
      return
    }

    const strategy = getStrategy(route.strategyId)
    // getStrategy falls back to the default for an id it does not know, and an executor id is
    // one of those -- so taking the label from it would head the whole run "EMA Crossover + ATR
    // Stop" while a grid was actually being replayed.
    const chosenExecutor = accountExecutors.find((e) => e.id === executorIdFromStrategyId(route.strategyId))
    const chosenController = accountControllers.find((c) => c.id === controllerIdFromStrategyId(route.strategyId))
    const strategyLabel = chosenExecutor ? `${chosenExecutor.name} (${chosenExecutor.type})` : strategy.name
    const symbolInfo = symbols.find((s) => s.symbol === route.symbol)
    const symbolLabel = symbolInfo ? `${symbolInfo.baseAsset}-${symbolInfo.quoteAsset}` : route.symbol
    const intervalLabel = INTERVALS.find((iv) => iv.id === route.interval)?.label ?? route.interval
    // A controller's markets come from its executors, so naming the Symbol picker in the label
    // would head the run with a market it may never have touched.
    setRunLabel(
      chosenController ? `${chosenController.name} (controller) • ${intervalLabel}` : `${strategyLabel} • ${symbolLabel} • ${intervalLabel}`
    )
    setTab('progress')
    setRunState({ status: 'running', done: 0, total: 1 })

    // Fetched from before the requested start by however much history the strategy needs to warm
    // up, so the range the user asked for is the range that gets MEASURED rather than the range
    // that gets partly spent warming indicators.
    //
    // Without this the default 90-day range was unusable for any slow strategy: Trend Regime
    // Ensemble warms up over 80 days, so it had ten days left to trade in and reported "0 trades"
    // -- indistinguishable, on screen, from a strategy whose rules never fire. A run whose result
    // is "this does not work" has to actually mean that.
    //
    // Only the fetch moves. `startSec` still bounds the reported window, because the engine
    // anchors both the trade list and the buy & hold benchmark at warmupBars.
    const requestedStartSec = Math.floor(new Date(`${startDate}T00:00:00Z`).getTime() / 1000)
    const warmupSec = strategy.warmupBarsFor(INTERVAL_SECONDS[route.interval]) * INTERVAL_SECONDS[route.interval]
    const startSec = requestedStartSec - warmupSec
    const endSec = Math.floor(new Date(`${endDate}T23:59:59Z`).getTime() / 1000)
    const runId = ++runIdRef.current
    const requestId = crypto.randomUUID()
    activeFetchRequestIdRef.current = requestId
    const startedAt = performance.now()

    const logs: string[] = []
    const log = (msg: string): void => {
      logs.push(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
    }
    log(`Starting fetch: ${exchange} ${route.symbol} ${route.interval}, range ${startDate} → ${endDate}`)
    log(`Starting capital: ${capitalValue.toLocaleString()} ${quoteAsset}`)

    if (chosenController) {
      void runControllerReplay(chosenController, { runId, startSec, endSec, interval: route.interval, startedAt, log })
      return
    }

    let lastLoggedDecile = -1
    // requestId scopes this to *this* fetch -- an unrelated bot poll or routine run fetching
    // candles at the same time gets its own id and never shows up here or gets cancelled by us.
    const unsubscribe = window.api.market.onHistoricalRangeProgress((progress) => {
      if (runIdRef.current !== runId || progress.requestId !== requestId) return
      const { done, total } = progress
      setRunState({ status: 'running', done, total })
      const pct = (done / Math.max(1, total)) * 100
      const decile = Math.floor(pct / 10)
      if (decile > lastLoggedDecile) {
        lastLoggedDecile = decile
        log(`Fetched ${done.toLocaleString()} / ${total.toLocaleString()} candles (${pct.toFixed(1)}%)`)
      }
    })

    window.api.market
      .fetchHistoricalRange(exchange, route.symbol, route.interval, startSec, endSec, requestId)
      .then((fetchResult) => {
        if (runIdRef.current !== runId) return
        if (fetchResult.cancelled) {
          log(`Fetch cancelled after ${fetchResult.candles.length.toLocaleString()} candles`)
          setRunState({ status: 'cancelled' })
          return
        }
        log(`Fetch complete: ${fetchResult.candles.length.toLocaleString()} candles`)
        const empty = describeEmptyRange({ candleCount: fetchResult.candles.length, startDate, endDate })
        if (empty !== null) {
          log(empty)
          setRunState({ status: 'error', message: empty })
          return
        }
        const executorId = executorIdFromStrategyId(route.strategyId)
        if (executorId !== null) {
          const chosen = accountExecutors.find((e) => e.id === executorId)
          if (!chosen) {
            const message = 'That executor no longer exists — it may have been deleted since this page loaded.'
            log(message)
            setRunState({ status: 'error', message })
            return
          }
          log(`Replaying executor: ${chosen.name} (${chosen.type})`)
          const replay = replayExecutor(fetchResult.candles, chosen, capitalValue)
          if (replay === null) {
            const message = 'No candles in that range, so there was nothing to replay.'
            log(message)
            setRunState({ status: 'error', message })
            return
          }
          log(`Replay complete: net ${replay.netProfit.toFixed(2)} (${replay.netProfitPct.toFixed(2)}%)`)
          setRunState({
            status: 'executor-done',
            executor: chosen,
            replay,
            candles: fetchResult.candles,
            elapsedSec: (performance.now() - startedAt) / 1000
          })
          setCompareCandles(fetchResult.candles)
          return
        }

        log(`Running strategy: ${strategy.name} — ${strategy.description}`)
        const result = runBacktest(fetchResult.candles, route.strategyId, { startingBalance: capitalValue, leverage: leverageValue })
        log(
          `Simulation complete: ${result.trades.length} trades, net P&L ${result.stats.totalNetProfit.toFixed(2)} (${result.stats.totalNetProfitPct.toFixed(2)}%)`
        )
        const elapsedSec = (performance.now() - startedAt) / 1000
        log(`Total elapsed: ${elapsedSec.toFixed(2)}s`)
        const generalInfo: ResultsGeneralInfo = {
          // The span the user asked to MEASURE, not the span fetched. The fetch reaches further
          // back so the strategy can warm up before the requested window opens, and reporting
          // that lead-in here would contradict the Starting Date shown three rows below it.
          periodDays: Math.round((endSec - requestedStartSec) / 86400),
          startDate,
          endDate,
          exchangeName: EXCHANGES.find((e) => e.id === exchange)?.name ?? exchange,
          symbolLabel,
          intervalLabel,
          strategyLabel,
          splitDate: splitDate && splitDate > startDate && splitDate < endDate ? splitDate : null,
          leverage: leverageValue
        }
        setRunState({ status: 'done', result, candles: fetchResult.candles, elapsedSec, generalInfo, logLines: logs })
        setCompareCandles(fetchResult.candles)
      })
      .catch((error: unknown) => {
        if (runIdRef.current !== runId) return
        log(`Error: ${error instanceof Error ? error.message : String(error)}`)
        setRunState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => {
        unsubscribe()
        if (activeFetchRequestIdRef.current === requestId) activeFetchRequestIdRef.current = null
      })
  }

  /** A controller run fetches one candle set per market its executors trade, rather than the one
   * market the Symbol picker names: a controller can supervise executors on different pairs, and
   * replaying them all against a single symbol's candles would silently price them wrong. */
  async function runControllerReplay(
    controller: ControllerConfig,
    ctx: { runId: number; startSec: number; endSec: number; interval: Interval; startedAt: number; log: (message: string) => void }
  ): Promise<void> {
    const attached = accountExecutors.filter((e) => controller.executorIds.includes(e.id))
    const marketSymbols = [...new Set(attached.filter((e) => e.type !== 'xemm' && e.type !== 'arbitrage').map((e) => e.symbol))]
    if (marketSymbols.length === 0) {
      const message =
        attached.length === 0
          ? 'That controller has no executors attached, so there is nothing to replay.'
          : 'Every executor attached to that controller prices two markets at once (XEMM or Arbitrage), which cannot be replayed here.'
      ctx.log(message)
      setRunState({ status: 'error', message })
      return
    }

    ctx.log(`Controller "${controller.name}": ${marketSymbols.length} market${marketSymbols.length === 1 ? '' : 's'} to fetch (${marketSymbols.join(', ')})`)

    let fetchedSymbols = 0
    let activeRequestId = ''
    const unsubscribe = window.api.market.onHistoricalRangeProgress((progress) => {
      if (runIdRef.current !== ctx.runId || progress.requestId !== activeRequestId) return
      setRunState({
        status: 'running',
        done: fetchedSymbols * progress.total + progress.done,
        total: progress.total * marketSymbols.length
      })
    })

    try {
      const candlesBySymbol: Record<string, Candle[]> = {}
      for (const symbol of marketSymbols) {
        activeRequestId = crypto.randomUUID()
        activeFetchRequestIdRef.current = activeRequestId
        const fetched = await window.api.market.fetchHistoricalRange(exchange, symbol, ctx.interval, ctx.startSec, ctx.endSec, activeRequestId)
        if (runIdRef.current !== ctx.runId) return
        if (fetched.cancelled) {
          ctx.log(`Fetch cancelled after ${fetched.candles.length.toLocaleString()} ${symbol} candles`)
          setRunState({ status: 'cancelled' })
          return
        }
        candlesBySymbol[symbol] = fetched.candles
        fetchedSymbols++
        ctx.log(`${symbol}: ${fetched.candles.length.toLocaleString()} candles`)
      }

      const replay = replayController(controller, accountExecutors, candlesBySymbol)
      if (replay === null) {
        const message = 'None of that controller’s executors could be replayed over this range — no candles came back for their markets.'
        ctx.log(message)
        setRunState({ status: 'error', message })
        return
      }
      ctx.log(
        replay.breach === null
          ? `Replay complete: no limit crossed, net ${replay.finalPnlQuote.toFixed(2)} (${replay.finalPnlPct.toFixed(2)}%)`
          : `Replay complete: ${replay.breach.breach.kind} at ${new Date(replay.breach.atTime * 1000).toISOString()}, net ${replay.finalPnlQuote.toFixed(2)} (${replay.finalPnlPct.toFixed(2)}%)`
      )
      setRunState({ status: 'controller-done', controller, replay, elapsedSec: (performance.now() - ctx.startedAt) / 1000 })
    } catch (error: unknown) {
      if (runIdRef.current !== ctx.runId) return
      const message = error instanceof Error ? error.message : String(error)
      ctx.log(`Error: ${message}`)
      setRunState({ status: 'error', message })
    } finally {
      unsubscribe()
      if (activeFetchRequestIdRef.current === activeRequestId) activeFetchRequestIdRef.current = null
    }
  }

  function handleCancel(): void {
    runIdRef.current++
    if (runState?.status === 'running' && activeFetchRequestIdRef.current) {
      void window.api.market.cancelHistoricalRange(activeFetchRequestIdRef.current)
    }
    setTab('configuration')
    setRunLabel(null)
    setRunState(null)
  }

  // Reuses candles already fetched by the last single-strategy run when available — only
  // fetches fresh if the user hasn't run anything yet this session.
  async function handleCompare(): Promise<void> {
    const route = tradingRoute
    if (!route.symbol) return
    setTab('compare')
    if (compareCandles) return

    setCompareLoading(true)
    setCompareError(null)
    const startSec = Math.floor(new Date(`${startDate}T00:00:00Z`).getTime() / 1000)
    const endSec = Math.floor(new Date(`${endDate}T23:59:59Z`).getTime() / 1000)
    try {
      const fetchResult = await window.api.market.fetchHistoricalRange(exchange, route.symbol, route.interval, startSec, endSec)
      if (!fetchResult.cancelled) setCompareCandles(fetchResult.candles)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('Failed to fetch candles for strategy comparison:', error)
      setCompareError(message)
    } finally {
      setCompareLoading(false)
    }
  }

  return (
    <>
      <PageHeader title="Backtest" subtitle="Configure a strategy backtest against historical exchange data" />

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
        <button style={tabButtonStyle(tab === 'configuration')} onClick={() => setTab('configuration')}>
          Configuration
        </button>
        {runLabel !== null && (
          <button style={tabButtonStyle(tab === 'progress')} onClick={() => setTab('progress')}>
            {runLabel}
          </button>
        )}
        {runState?.status === 'done' && (
          <button style={tabButtonStyle(tab === 'charts')} onClick={() => setTab('charts')}>
            Charts
          </button>
        )}
        {compareCandles !== null && (
          <button style={tabButtonStyle(tab === 'compare')} onClick={() => setTab('compare')}>
            Compare Strategies
          </button>
        )}
      </div>

      {tab === 'progress' && runState && runState.status === 'controller-done' && (
        <Card title="Controller Replay">
          <ControllerBacktestView controller={runState.controller} result={runState.replay} />
        </Card>
      )}

      {tab === 'progress' && runState && runState.status === 'executor-done' && (
        <Card title="Executor replay">
          <ExecutorBacktestView executor={runState.executor} result={runState.replay} />
        </Card>
      )}

      {tab === 'progress' && runState && runState.status === 'done' && (
        <Card title="Backtest results">
          <BacktestResultsView
            result={runState.result}
            candles={runState.candles}
            elapsedSec={runState.elapsedSec}
            generalInfo={runState.generalInfo}
            logLines={runState.logLines}
            onRerun={handleStart}
            onNewSession={handleCancel}
            onViewCharts={() => setTab('charts')}
          />
        </Card>
      )}

      {tab === 'charts' && runState?.status === 'done' && (
        <Card title="Trade charts">
          <BacktestChartsView candles={runState.candles} trades={runState.result.trades} />
        </Card>
      )}

      {tab === 'compare' && (
        <Card title="Strategy comparison">
          {compareLoading && <p style={{ color: 'var(--text-secondary)', margin: 0 }}>Fetching candles…</p>}
          {!compareLoading && compareError && <p style={{ color: 'var(--down)', margin: 0 }}>Error: {compareError}</p>}
          {!compareLoading && !compareError && compareCandles && (
            <StrategyComparisonView
              candles={compareCandles}
              startingBalance={capitalValue}
              meta={comparisonMeta}
            />
          )}
          {!compareLoading && !compareError && !compareCandles && (
            <p style={{ color: 'var(--text-secondary)', margin: 0 }}>No candle data loaded yet.</p>
          )}
        </Card>
      )}

      {tab === 'progress' && runState && runState.status !== 'done' && runState.status !== 'executor-done' && runState.status !== 'controller-done' && (
        <Card title="Backtest progress">
          <BacktestRunningView runState={runState} onCancel={handleCancel} />
        </Card>
      )}

      {tab === 'configuration' && (
        <Card title="Backtest configuration">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: '2rem', alignItems: 'start' }}>
            <div>
              <SectionHeader label="Exchange" />
              <select
                value={exchange}
                onChange={(e) => handleExchangeChange(e.target.value as Exchange)}
                style={{ ...fieldStyle(), width: '100%' }}
              >
                {EXCHANGES.map((ex) => (
                  <option key={ex.id} value={ex.id}>
                    {ex.name}
                  </option>
                ))}
              </select>

              {symbolsError !== null && (
                <p style={{ color: 'var(--down)', fontSize: '0.76rem', margin: '0 0 0.6rem', lineHeight: 1.45 }}>
                  Could not load the symbol list for this exchange ({symbolsError}). Only the
                  default symbol below is available until it loads.{' '}
                  <button
                    onClick={() => setSymbolsReloadKey((k) => k + 1)}
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--down)',
                      borderRadius: 'var(--radius-sm)',
                      color: 'var(--down)',
                      cursor: 'pointer',
                      fontSize: '0.72rem',
                      padding: '0.1rem 0.45rem'
                    }}
                  >
                    Retry
                  </button>
                </p>
              )}

              <SectionHeader label="Route" />
              <div style={{ display: 'flex', gap: '0.6rem', marginBottom: '0.6rem' }}>
                <select
                  value={tradingRoute.symbol}
                  onChange={(e) => updateTradingRoute({ symbol: e.target.value })}
                  style={{ ...fieldStyle(), flex: 1 }}
                >
                  {symbolsLoading && <option>Loading symbols...</option>}
                  {/* Without this the dropdown renders empty on a failed list while state still
                      holds a symbol -- the control showing blank for a backtest that would in
                      fact run against that symbol. */}
                  {!symbolsLoading && symbols.length === 0 && tradingRoute.symbol !== '' && (
                    <option value={tradingRoute.symbol}>{tradingRoute.symbol}</option>
                  )}
                  {!symbolsLoading &&
                    symbols.map((s) => (
                      <option key={s.symbol} value={s.symbol}>
                        {s.symbol}
                      </option>
                    ))}
                </select>
                <select
                  value={tradingRoute.interval}
                  onChange={(e) => updateTradingRoute({ interval: e.target.value as Interval })}
                  style={{ ...fieldStyle(), width: 90 }}
                >
                  {INTERVALS.map((iv) => (
                    <option key={iv.id} value={iv.id}>
                      {iv.label}
                    </option>
                  ))}
                </select>
                <select
                  value={tradingRoute.strategyId}
                  onChange={(e) => updateTradingRoute({ strategyId: e.target.value })}
                  style={{ ...fieldStyle(), flex: 1 }}
                >
                  {STRATEGIES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                  {replayableExecutors.length > 0 && (
                    <optgroup label="Your executors">
                      {replayableExecutors.map((e) => (
                        <option key={e.id} value={`${EXECUTOR_PREFIX}${e.id}`}>
                          {e.name} ({e.type})
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {accountControllers.length > 0 && (
                    <optgroup label="Your controllers">
                      {accountControllers.map((c) => (
                        <option key={c.id} value={`${CONTROLLER_PREFIX}${c.id}`}>
                          {c.name} ({c.executorIds.length} executor{c.executorIds.length === 1 ? '' : 's'})
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>

              {controllerIdFromStrategyId(tradingRoute.strategyId) !== null && (
                <p style={{ margin: '0.4rem 0 0', fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  A controller takes its markets from the executors attached to it, so the Symbol above is ignored and
                  the Starting Capital is not used — its limits are measured against the capital those executors
                  allocate, exactly as they are in the running app.
                </p>
              )}

              <SectionHeader label="Duration" />
              <div style={{ display: 'flex', gap: '0.6rem' }}>
                <input
                  type="date"
                  value={startDate}
                  max={endDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  style={{ ...fieldStyle(), flex: 1, colorScheme: 'dark' }}
                />
                <input
                  type="date"
                  value={endDate}
                  min={startDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  style={{ ...fieldStyle(), flex: 1, colorScheme: 'dark' }}
                />
              </div>

              <SectionHeader label="Out-of-Sample Split (optional)" />
              <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: '0 0 0.6rem' }}>
                Splits the results into a period before this date and a period after it, so you can check whether
                performance held up on data the strategy wasn't looked at first.
              </p>
              <input
                type="date"
                value={splitDate}
                min={startDate}
                max={endDate}
                onChange={(e) => setSplitDate(e.target.value)}
                style={{ ...fieldStyle(), width: '100%', colorScheme: 'dark' }}
              />

              <SectionHeader label="Starting Capital" />
              <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: '0 0 0.6rem' }}>
                {accountAvailable <= 0
                  ? 'What the simulation starts with. Every result is a share of this number, so the same percentage return is a different amount of money on a different starting balance.'
                  : capitalTouched
                    ? `Testing a size of your own. Your paper account has ${accountAvailable.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${quoteAsset} available; clear this field and reopen the page to go back to that.`
                    : `Filled in from your paper account: ${accountAvailable.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${quoteAsset} is available after what your running strategies are already holding. Change it to test a different size.`}
              </p>
              <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={startingCapital}
                  onChange={(e) => {
                    setCapitalTouched(true)
                    setStartingCapital(e.target.value)
                  }}
                  style={{ ...fieldStyle(), flex: 1 }}
                />
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', minWidth: 48 }}>
                  {quoteAsset || '—'}
                </span>
              </div>
              {capitalProblem !== null && (
                <p style={{ color: 'var(--down)', fontSize: '0.78rem', margin: '0.5rem 0 0' }}>{capitalProblem}</p>
              )}

              <SectionHeader label="Leverage" />
              <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: '0 0 0.6rem' }}>
                Leave this blank to test the strategy on spot, which is what it has always been. Above 1x the run can
                be liquidated — and when it is, it ends with nothing and takes no further trades, exactly as the account
                would.
              </p>
              <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                <input
                  type="number"
                  min={MIN_LEVERAGE}
                  max={MAX_LEVERAGE}
                  step="1"
                  placeholder="1"
                  value={leverageInput}
                  onChange={(e) => setLeverageInput(e.target.value)}
                  style={{ ...fieldStyle(), flex: 1 }}
                />
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', minWidth: 48 }}>×</span>
              </div>
              {leverageProblem !== null ? (
                <p style={{ color: 'var(--down)', fontSize: '0.78rem', margin: '0.5rem 0 0' }}>{leverageProblem}</p>
              ) : (
                leverageValue > 1 && (
                  <p style={{ color: 'var(--down)', fontSize: '0.78rem', margin: '0.5rem 0 0', fontWeight: 600 }}>
                    At {leverageValue}x a fall of{' '}
                    {liquidationDistancePct(leverageValue)?.toFixed(2) ?? '—'}% below an entry ends that trade and the
                    whole run with it. Funding is charged every 8 hours a position stays open, and every fee is{' '}
                    {leverageValue} times what it was.
                  </p>
                )
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              <button
                onClick={handleStart}
                disabled={symbolsLoading || !tradingRoute.symbol || capitalProblem !== null || leverageProblem !== null}
                title={symbolsLoading ? 'Symbols are still loading' : (capitalProblem ?? leverageProblem ?? undefined)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
                  background: 'linear-gradient(135deg, #7c86ff, #6366f1)',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.9rem',
                  color: '#fff',
                  fontSize: '0.95rem',
                  fontWeight: 700,
                  cursor: symbolsLoading || !tradingRoute.symbol || capitalProblem !== null || leverageProblem !== null ? 'not-allowed' : 'pointer',
                  opacity: symbolsLoading || !tradingRoute.symbol || capitalProblem !== null || leverageProblem !== null ? 0.6 : 1
                }}
              >
                <Zap size={16} /> Start
              </button>
              <button
                onClick={() => void handleCompare()}
                disabled={symbolsLoading || !tradingRoute.symbol || compareLoading}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
                  background: 'var(--bg-app)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.9rem',
                  color: 'var(--text-primary)',
                  fontSize: '0.9rem',
                  fontWeight: 600,
                  cursor: symbolsLoading || !tradingRoute.symbol || compareLoading ? 'not-allowed' : 'pointer',
                  opacity: symbolsLoading || !tradingRoute.symbol || compareLoading ? 0.6 : 1
                }}
              >
                <Plus size={16} /> Compare Strategies
              </button>
            </div>
          </div>
        </Card>
      )}
    </>
  )
}
