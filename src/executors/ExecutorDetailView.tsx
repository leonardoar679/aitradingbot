import { useEffect, useRef, useState } from 'react'
import {
  createChart,
  CandlestickSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type AutoscaleInfo,
  type UTCTimestamp
} from 'lightweight-charts'
import { ArrowLeft } from 'lucide-react'
import {
  EXCHANGES,
  type ExecutorConfig,
  type GridExecutorParams,
  type OrderExecutorParams,
  type PositionExecutorParams,
  type DcaExecutorParams
} from '../../shared/ipc'
import { useExecutorSimulation } from './useExecutorSimulation'
import { LiveOrderMetrics, useLiveTwapInfo } from './ExecutorCard'
import { dcaLevelPrice, buildGridLevels } from './engine'
import { useTheme } from '../theme/ThemeContext'
import { CHART_PALETTE } from '../theme/palette'

const WATCHER_POLL_MS = 5_000

/** Real current average entry price for a watched live DCA or Grid position -- null until the
 * first poll lands or there's no watcher to poll. Both share this exact "several resting orders,
 * one shared watcher" mechanism (see the Phase 6 plan for Grid). Mirrors ExecutorCard's own
 * useLiveWatcherInfo; kept separate rather than shared since this component only ever needs the
 * one number for the chart line, not the full watcher-info shape. */
function useLiveLadderAvgEntry(executor: ExecutorConfig): number | null {
  const [entryPrice, setEntryPrice] = useState<number | null>(null)
  const watching =
    (executor.type === 'dca' || executor.type === 'grid') && executor.mode === 'live' && executor.liveWatcherId !== null

  useEffect(() => {
    if (!watching) {
      setEntryPrice(null)
      return
    }
    let cancelled = false
    async function poll(): Promise<void> {
      try {
        const watchers = await window.api.liveTrading.listActiveWatchers()
        if (cancelled) return
        const match = watchers.find((w) => w.executorId === executor.id)
        setEntryPrice(match ? match.entryPrice : null)
      } catch {
        // Best-effort display only.
      }
    }
    void poll()
    const timer = setInterval(poll, WATCHER_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [watching, executor.id])

  return entryPrice
}

export function ExecutorDetailView({ executor, onBack }: { executor: ExecutorConfig; onBack: () => void }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const priceLinesRef = useRef<IPriceLine[]>([])
  /** Prices the vertical scale must cover even when no candle reaches them — see the
   * autoscaleInfoProvider below. */
  const extraScalePricesRef = useRef<number[]>([])
  const { theme } = useTheme()
  const palette = CHART_PALETTE[theme]
  const sim = useExecutorSimulation(executor)
  const liveLadderAvgEntry = useLiveLadderAvgEntry(executor)
  const liveTwapInfo = useLiveTwapInfo(executor)
  const exchangeName = EXCHANGES.find((e) => e.id === executor.exchange)?.name ?? executor.exchange

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const chart = createChart(container, {
      autoSize: true,
      layout: { background: { color: palette.background }, textColor: palette.text },
      grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: palette.border }
    })
    chartRef.current = chart

    const series = chart.addSeries(CandlestickSeries, {
      upColor: palette.up,
      downColor: palette.down,
      borderVisible: false,
      wickUpColor: palette.up,
      wickDownColor: palette.down,
      // A price line does NOT stretch the price scale on its own, so a level outside the candles'
      // own range is created and then simply never drawn. That is tolerable for a take-profit the
      // user chose and can look up; it is not tolerable for a liquidation level, which is the one
      // line on a leveraged chart that would otherwise stay invisible for exactly as long as the
      // position is healthy -- and then appear, unannounced, at the moment it stops being.
      //
      // Including it can squash the candles at low leverage, where the level is genuinely far
      // away. That squashing is the honest picture: it is what "far from liquidation" looks like.
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const base = original()
        const extras = extraScalePricesRef.current
        if (extras.length === 0) return base
        if (!base || !base.priceRange) {
          return { priceRange: { minValue: Math.min(...extras), maxValue: Math.max(...extras) } }
        }
        return {
          ...base,
          priceRange: {
            minValue: Math.min(base.priceRange.minValue, ...extras),
            maxValue: Math.max(base.priceRange.maxValue, ...extras)
          }
        }
      }
    })
    seriesRef.current = series

    return () => {
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      priceLinesRef.current = []
    }
  }, [palette])

  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series || sim.candles.length === 0) return

    // Set before setData, so the very first autoscale already accounts for it rather than
    // rescaling a frame later.
    extraScalePricesRef.current =
      sim.state && sim.state.kind === 'position' && sim.state.liquidationPrice !== null
        ? [sim.state.liquidationPrice]
        : []

    series.setData(
      sim.candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }))
    )

    // This effect re-runs on every 60s poll, not just on mount — createPriceLine has no bulk-clear
    // API, so the previous set has to be removed explicitly or lines would pile up over time.
    for (const line of priceLinesRef.current) series.removePriceLine(line)
    priceLinesRef.current = []

    const newLines: IPriceLine[] = []

    if (sim.state) {
    // Level lines are drawn in accent, not palette.grid. palette.grid is the colour of the
    // chart's own background gridlines (see the grid config above), so a strategy level painted
    // with it was indistinguishable from chart decoration -- on a Grid executor, where "where are
    // my levels" is the entire reason to open this chart, none of them were visible. Filled stays
    // green and a stop stays red, so the three states now read apart at a glance.
    if (sim.state.kind === 'grid') {
      const params = executor.params as GridExecutorParams
      for (const level of sim.state.levels) {
        newLines.push(
          series.createPriceLine({
            price: level.price,
            color: level.status === 'filled' ? palette.up : palette.accent,
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: false,
            title: ''
          })
        )
      }
      if (params.limitPrice !== null) {
        newLines.push(
          series.createPriceLine({
            price: params.limitPrice,
            color: palette.down,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: sim.state.stoppedAt !== null ? 'Stop (hit)' : 'Stop'
          })
        )
      }
    } else if (sim.state.kind === 'dca') {
      for (const price of sim.state.levelPrices) {
        newLines.push(
          series.createPriceLine({
            price,
            color: palette.accent,
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: false,
            title: ''
          })
        )
      }
      if (sim.state.avgEntryPrice !== null) {
        newLines.push(
          series.createPriceLine({
            price: sim.state.avgEntryPrice,
            color: palette.gold,
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: 'Avg Entry'
          })
        )
      }
    } else if (sim.state.kind === 'twap' && sim.state.vwap !== null) {
      newLines.push(
        series.createPriceLine({
          price: sim.state.vwap,
          color: palette.gold,
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: 'VWAP'
        })
      )
    } else if (sim.state.kind === 'position') {
      const params = executor.params as PositionExecutorParams
      const isBuy = sim.state.side === 'buy'
      if (sim.state.entryPrice !== null) {
        newLines.push(
          series.createPriceLine({
            price: sim.state.entryPrice,
            color: palette.gold,
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: 'Entry'
          })
        )
        if (params.takeProfitPct !== null) {
          const tp = isBuy ? sim.state.entryPrice * (1 + params.takeProfitPct / 100) : sim.state.entryPrice * (1 - params.takeProfitPct / 100)
          newLines.push(
            series.createPriceLine({ price: tp, color: palette.up, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'TP' })
          )
        }
        if (params.stopLossPct !== null) {
          const sl = isBuy ? sim.state.entryPrice * (1 - params.stopLossPct / 100) : sim.state.entryPrice * (1 + params.stopLossPct / 100)
          newLines.push(
            series.createPriceLine({ price: sl, color: palette.down, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'SL' })
          )
        }
        // Solid and thick, unlike the dashed SL beside it, because it is not a level the holder
        // chose and can move -- it is where the position ends whether they like it or not. Null
        // at 1x, where there is nothing to draw.
        if (sim.state.liquidationPrice !== null) {
          newLines.push(
            series.createPriceLine({
              price: sim.state.liquidationPrice,
              color: palette.down,
              lineWidth: 2,
              lineStyle: LineStyle.Solid,
              axisLabelVisible: true,
              title: 'LIQUIDATION'
            })
          )
        }
      }
    } else if (sim.state.kind === 'order' && sim.state.fillPrice !== null) {
      newLines.push(
        series.createPriceLine({
          price: sim.state.fillPrice,
          color: palette.gold,
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: 'Fill'
        })
      )
    } else if (sim.state.kind === 'marketmaking') {
      if (sim.state.bidPrice !== null) {
        newLines.push(
          series.createPriceLine({ price: sim.state.bidPrice, color: palette.up, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'Bid' })
        )
      }
      if (sim.state.askPrice !== null) {
        newLines.push(
          series.createPriceLine({ price: sim.state.askPrice, color: palette.down, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'Ask' })
        )
      }
    }
    } else if (executor.mode === 'live') {
      // Live executors draw from real state (liveOrder/liveWatcherId/liveExitResult), never a
      // simulated replay -- sim.state is always null here (see useExecutorSimulation).
      if (executor.type === 'position') {
        const params = executor.params as PositionExecutorParams
        // params.entryPrice is patched to the real fill price when a live Position is created
        // (ExecutorsPage.handleCreate) -- unlike paper mode it's never a "wait for this price"
        // resting target here, since live Position entries are market-only.
        if (params.entryPrice !== null) {
          const entryPrice = params.entryPrice
          newLines.push(
            series.createPriceLine({ price: entryPrice, color: palette.gold, lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'Entry' })
          )
          if (params.takeProfitPct !== null) {
            newLines.push(
              series.createPriceLine({
                price: entryPrice * (1 + params.takeProfitPct / 100),
                color: palette.up,
                lineWidth: 1,
                lineStyle: LineStyle.Dashed,
                axisLabelVisible: true,
                title: 'TP'
              })
            )
          }
          if (params.stopLossPct !== null) {
            newLines.push(
              series.createPriceLine({
                price: entryPrice * (1 - params.stopLossPct / 100),
                color: palette.down,
                lineWidth: 1,
                lineStyle: LineStyle.Dashed,
                axisLabelVisible: true,
                title: 'SL'
              })
            )
          }
        }
        if (executor.liveExitResult) {
          newLines.push(
            series.createPriceLine({
              price: executor.liveExitResult.exitPrice,
              color: palette.gold,
              lineWidth: 2,
              lineStyle: LineStyle.Solid,
              axisLabelVisible: true,
              title: 'Exit'
            })
          )
        }
      } else if (executor.type === 'dca') {
        const params = executor.params as DcaExecutorParams
        // Dotted line per configured level, same as paper DCA draws every levelPrice regardless
        // of fill status -- computed from the real reference price captured at creation
        // (liveDcaBasePrice), since there's no candle replay live the way paper mode has one.
        if (executor.liveDcaBasePrice !== null) {
          for (const level of params.levels) {
            newLines.push(
              series.createPriceLine({
                price: dcaLevelPrice(executor.liveDcaBasePrice, level, params.side),
                color: palette.accent,
                lineWidth: 1,
                lineStyle: LineStyle.Dotted,
                axisLabelVisible: false,
                title: ''
              })
            )
          }
        }
        const avgEntry = executor.liveExitResult?.entryPrice ?? liveLadderAvgEntry
        if (avgEntry !== null) {
          newLines.push(
            series.createPriceLine({ price: avgEntry, color: palette.gold, lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'Avg Entry' })
          )
        }
        if (executor.liveExitResult) {
          newLines.push(
            series.createPriceLine({
              price: executor.liveExitResult.exitPrice,
              color: palette.gold,
              lineWidth: 2,
              lineStyle: LineStyle.Solid,
              axisLabelVisible: true,
              title: 'Exit'
            })
          )
        }
      } else if (executor.type === 'grid') {
        // Dotted line per configured level, same as paper Grid draws every levelPrice regardless
        // of fill status -- buildGridLevels(params) is recomputable directly (no captured
        // reference price needed, unlike DCA, since Grid's prices are already absolute).
        const params = executor.params as GridExecutorParams
        for (const price of buildGridLevels(params)) {
          newLines.push(
            series.createPriceLine({ price, color: palette.accent, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '' })
          )
        }
        const avgEntry = executor.liveExitResult?.entryPrice ?? liveLadderAvgEntry
        if (avgEntry !== null) {
          newLines.push(
            series.createPriceLine({ price: avgEntry, color: palette.gold, lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'Avg Entry' })
          )
        }
        if (executor.liveExitResult) {
          newLines.push(
            series.createPriceLine({
              price: executor.liveExitResult.exitPrice,
              color: palette.gold,
              lineWidth: 2,
              lineStyle: LineStyle.Solid,
              axisLabelVisible: true,
              title: 'Exit'
            })
          )
        }
      } else if (executor.type === 'twap') {
        // Combine slice 0 (executor.liveOrder, resolved synchronously at creation) with whatever
        // the run itself has placed since, for a correct VWAP -- same combination ExecutorCard
        // uses, see the LiveTwapRunSummary doc comment in shared/ipc.ts.
        const slice0Qty = executor.liveOrder?.filledQty ?? 0
        const slice0Quote = executor.liveOrder?.cummulativeQuoteQty ?? 0
        const totalBaseFilled = executor.liveTwapResult?.totalBaseFilled ?? liveTwapInfo?.totalBaseFilled ?? 0
        const totalQuoteFilled = executor.liveTwapResult?.totalQuoteFilled ?? liveTwapInfo?.totalQuoteFilled ?? 0
        const totalQty = slice0Qty + totalBaseFilled
        const totalQuote = slice0Quote + totalQuoteFilled
        const vwap = totalQty > 0 ? totalQuote / totalQty : null
        if (vwap !== null) {
          newLines.push(
            series.createPriceLine({ price: vwap, color: palette.gold, lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'VWAP' })
          )
        }
      } else if (executor.type === 'order') {
        if (executor.liveOrder) {
          newLines.push(
            series.createPriceLine({
              price: executor.liveOrder.avgFillPrice,
              color: palette.gold,
              lineWidth: 2,
              lineStyle: LineStyle.Solid,
              axisLabelVisible: true,
              title: 'Fill'
            })
          )
        } else if (executor.pendingLiveOrderIds.length > 0) {
          const params = executor.params as OrderExecutorParams
          if (params.limitPrice !== null) {
            newLines.push(
              series.createPriceLine({
                price: params.limitPrice,
                color: palette.accent,
                lineWidth: 1,
                lineStyle: LineStyle.Dashed,
                axisLabelVisible: true,
                title: 'Limit'
              })
            )
          }
        }
      }
    }

    priceLinesRef.current = newLines

    chart.timeScale().fitContent()
  }, [sim.candles, sim.state, executor, palette, liveLadderAvgEntry, liveTwapInfo])

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
        <button
          onClick={onBack}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
            background: 'var(--bg-app)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.5rem 0.8rem',
            color: 'var(--text-primary)',
            fontSize: '0.8rem',
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          <ArrowLeft size={14} /> Back to Executors
        </button>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)' }}>{executor.name}</span>
            {executor.mode === 'live' && (
              <span
                style={{
                  padding: '0.15rem 0.45rem',
                  borderRadius: 999,
                  background: 'var(--down)',
                  color: '#fff',
                  fontSize: '0.6rem',
                  fontWeight: 800,
                  letterSpacing: '0.04em'
                }}
              >
                LIVE
              </span>
            )}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            {exchangeName} • {executor.symbol} • {executor.type.toUpperCase()}
          </div>
        </div>
      </div>

      {executor.mode === 'live' && (
        <div
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: '0.9rem',
            marginBottom: '1rem'
          }}
        >
          <LiveOrderMetrics executor={executor} />
        </div>
      )}

      {sim.status === 'error' && <p style={{ color: 'var(--down)', fontSize: '0.85rem' }}>Error: {sim.error}</p>}
      {executor.status === 'stopped' && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          This executor was stopped {executor.stoppedAt ? new Date(executor.stoppedAt * 1000).toLocaleString() : ''}.
        </p>
      )}

      <div ref={containerRef} style={{ width: '100%', height: 480 }} />
    </div>
  )
}
