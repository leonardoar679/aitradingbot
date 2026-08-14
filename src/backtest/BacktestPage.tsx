import { useEffect, useRef, useState } from 'react'
import { Plus, Zap } from 'lucide-react'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { BacktestRunningView, type RunningState } from './BacktestRunningView'
import { BacktestResultsView, type ResultsGeneralInfo } from './BacktestResultsView'
import { BacktestChartsView } from './BacktestChartsView'
import { StrategyComparisonView } from './StrategyComparisonView'
import { runBacktest, type BacktestResult } from './engine'
import { STRATEGIES, DEFAULT_STRATEGY_ID, getStrategy } from './strategies'
import { EXCHANGES, INTERVALS, type Candle, type Exchange, type Interval, type SymbolInfo } from '../../shared/ipc'

type Tab = 'configuration' | 'progress' | 'charts' | 'compare'

type RunState =
  | RunningState
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
  const [compareCandles, setCompareCandles] = useState<Candle[] | null>(null)
  const [compareLoading, setCompareLoading] = useState(false)
  const [compareError, setCompareError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSymbolsLoading(true)
    window.api.market
      .listSymbols(exchange)
      .then((list) => {
        if (!cancelled) setSymbols(list)
      })
      .catch((error) => console.error('Failed to load symbols:', error))
      .finally(() => {
        if (!cancelled) setSymbolsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [exchange])

  function handleExchangeChange(next: Exchange): void {
    setExchange(next)
    const info = EXCHANGES.find((e) => e.id === next)
    setTradingRoute(defaultTradingRoute(info?.defaultSymbol.symbol ?? ''))
  }

  function updateTradingRoute(patch: Partial<TradingRouteRow>): void {
    setTradingRoute((prev) => ({ ...prev, ...patch }))
  }

  function handleStart(): void {
    const route = tradingRoute
    if (!route.symbol) return

    const strategy = getStrategy(route.strategyId)
    const strategyLabel = strategy.name
    const symbolInfo = symbols.find((s) => s.symbol === route.symbol)
    const symbolLabel = symbolInfo ? `${symbolInfo.baseAsset}-${symbolInfo.quoteAsset}` : route.symbol
    const intervalLabel = INTERVALS.find((iv) => iv.id === route.interval)?.label ?? route.interval
    setRunLabel(`${strategyLabel} • ${symbolLabel} • ${intervalLabel}`)
    setTab('progress')
    setRunState({ status: 'running', done: 0, total: 1 })

    const startSec = Math.floor(new Date(`${startDate}T00:00:00Z`).getTime() / 1000)
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
        log(`Running strategy: ${strategy.name} — ${strategy.description}`)
        const result = runBacktest(fetchResult.candles, route.strategyId)
        log(
          `Simulation complete: ${result.trades.length} trades, net P&L ${result.stats.totalNetProfit.toFixed(2)} (${result.stats.totalNetProfitPct.toFixed(2)}%)`
        )
        const elapsedSec = (performance.now() - startedAt) / 1000
        log(`Total elapsed: ${elapsedSec.toFixed(2)}s`)
        const generalInfo: ResultsGeneralInfo = {
          periodDays: Math.round((endSec - startSec) / 86400),
          startDate,
          endDate,
          exchangeName: EXCHANGES.find((e) => e.id === exchange)?.name ?? exchange,
          symbolLabel,
          intervalLabel,
          strategyLabel,
          splitDate: splitDate && splitDate > startDate && splitDate < endDate ? splitDate : null
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

      {tab === 'progress' && runState && runState.status === 'done' && (
        <Card title="Backtest results">
          <BacktestResultsView
            result={runState.result}
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
          {!compareLoading && !compareError && compareCandles && <StrategyComparisonView candles={compareCandles} />}
          {!compareLoading && !compareError && !compareCandles && (
            <p style={{ color: 'var(--text-secondary)', margin: 0 }}>No candle data loaded yet.</p>
          )}
        </Card>
      )}

      {tab === 'progress' && runState && runState.status !== 'done' && (
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

              <SectionHeader label="Route" />
              <div style={{ display: 'flex', gap: '0.6rem', marginBottom: '0.6rem' }}>
                <select
                  value={tradingRoute.symbol}
                  onChange={(e) => updateTradingRoute({ symbol: e.target.value })}
                  style={{ ...fieldStyle(), flex: 1 }}
                >
                  {symbolsLoading && <option>Loading symbols...</option>}
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
                </select>
              </div>

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

              <SectionHeader label="Options" />
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: 0 }}>No additional options yet.</p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              <button
                onClick={handleStart}
                disabled={symbolsLoading || !tradingRoute.symbol}
                title={symbolsLoading ? 'Symbols are still loading' : undefined}
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
                  cursor: symbolsLoading || !tradingRoute.symbol ? 'not-allowed' : 'pointer',
                  opacity: symbolsLoading || !tradingRoute.symbol ? 0.6 : 1
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
