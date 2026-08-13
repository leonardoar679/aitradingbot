import { useEffect, useRef } from 'react'
import {
  createChart,
  CandlestickSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp
} from 'lightweight-charts'
import { ArrowLeft } from 'lucide-react'
import { EXCHANGES, type ExecutorConfig, type GridExecutorParams, type PositionExecutorParams } from '../../shared/ipc'
import { useExecutorSimulation } from './useExecutorSimulation'
import { useTheme } from '../theme/ThemeContext'
import { CHART_PALETTE } from '../theme/palette'

export function ExecutorDetailView({ executor, onBack }: { executor: ExecutorConfig; onBack: () => void }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const priceLinesRef = useRef<IPriceLine[]>([])
  const { theme } = useTheme()
  const palette = CHART_PALETTE[theme]
  const sim = useExecutorSimulation(executor)
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
      wickDownColor: palette.down
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
    if (!chart || !series || sim.candles.length === 0 || !sim.state) return

    series.setData(
      sim.candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }))
    )

    // This effect re-runs on every 60s poll, not just on mount — createPriceLine has no bulk-clear
    // API, so the previous set has to be removed explicitly or lines would pile up over time.
    for (const line of priceLinesRef.current) series.removePriceLine(line)
    priceLinesRef.current = []

    const newLines: IPriceLine[] = []

    if (sim.state.kind === 'grid') {
      const params = executor.params as GridExecutorParams
      for (const level of sim.state.levels) {
        newLines.push(
          series.createPriceLine({
            price: level.price,
            color: level.status === 'filled' ? palette.up : palette.grid,
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
            title: 'Stop'
          })
        )
      }
    } else if (sim.state.kind === 'dca') {
      for (const price of sim.state.levelPrices) {
        newLines.push(
          series.createPriceLine({
            price,
            color: palette.grid,
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

    priceLinesRef.current = newLines

    chart.timeScale().fitContent()
  }, [sim.candles, sim.state, executor.params, palette])

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
          <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)' }}>{executor.name}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            {exchangeName} • {executor.symbol} • {executor.type.toUpperCase()}
          </div>
        </div>
      </div>

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
