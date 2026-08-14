import { useEffect, useRef } from 'react'
import { createChart, AreaSeries, LineStyle, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import { ArrowLeft } from 'lucide-react'
import { EXCHANGES, type ExecutorConfig, type XemmExecutorParams, type ArbitrageExecutorParams } from '../../shared/ipc'
import { useSpreadExecutorSimulation } from './useSpreadExecutorSimulation'
import { spreadPct } from './spreadEngine'
import { useTheme } from '../theme/ThemeContext'
import { CHART_PALETTE } from '../theme/palette'
import { formatQuotePrice } from '../utils/formatCurrency'

export function SpreadExecutorDetailView({ executor, onBack }: { executor: ExecutorConfig; onBack: () => void }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const { theme } = useTheme()
  const palette = CHART_PALETTE[theme]
  const sim = useSpreadExecutorSimulation(executor)
  const params = executor.params as XemmExecutorParams | ArbitrageExecutorParams
  const buyingExchangeName = EXCHANGES.find((e) => e.id === params.buyingMarket.exchange)?.name ?? params.buyingMarket.exchange
  const sellingExchangeName = EXCHANGES.find((e) => e.id === params.sellingMarket.exchange)?.name ?? params.sellingMarket.exchange

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

    const series = chart.addSeries(AreaSeries, {
      lineColor: palette.accent,
      topColor: `${palette.accent}40`,
      bottomColor: `${palette.accent}05`,
      lineWidth: 2,
      priceLineVisible: false
    })

    if (sim.aligned.length > 0) {
      series.setData(sim.aligned.map((p) => ({ time: p.time as UTCTimestamp, value: spreadPct(p.priceA, p.priceB) })))
      series.createPriceLine({
        price: params.minProfitabilityPct,
        color: palette.up,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Threshold'
      })
      // Arbitrage captures on the spread crossing the threshold in EITHER direction
      // (simulateArbitrage checks abs(pct) >= minProfitabilityPct) -- XEMM is directional and
      // only ever has the one positive threshold.
      if (executor.type === 'arbitrage') {
        series.createPriceLine({
          price: -params.minProfitabilityPct,
          color: palette.down,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'Threshold'
        })
      }
      chart.timeScale().fitContent()
    }

    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [sim.aligned, palette, params.minProfitabilityPct, executor.type])

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
            {buyingExchangeName} {params.buyingMarket.symbol} → {sellingExchangeName} {params.sellingMarket.symbol} • {executor.type.toUpperCase()}
          </div>
        </div>
      </div>

      {sim.status === 'error' && <p style={{ color: 'var(--down)', fontSize: '0.85rem' }}>Error: {sim.error}</p>}
      {executor.status === 'stopped' && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          This executor was stopped {executor.stoppedAt ? new Date(executor.stoppedAt * 1000).toLocaleString() : ''}.
        </p>
      )}

      <div ref={containerRef} style={{ width: '100%', height: 320 }} />

      {sim.state && sim.state.captures.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <h3 style={{ margin: '0 0 0.6rem', fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            Captures ({sim.state.captures.length})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {sim.state.captures
              .slice()
              .reverse()
              .slice(0, 50)
              .map((c, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '0.5rem 0.7rem',
                    background: 'var(--bg-app)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '0.78rem'
                  }}
                >
                  <span style={{ color: 'var(--text-secondary)' }}>{new Date(c.time * 1000).toLocaleString()}</span>
                  <span style={{ color: 'var(--text-primary)' }}>{c.spreadPct.toFixed(3)}%</span>
                  <span style={{ color: 'var(--up)', fontWeight: 600 }}>+{formatQuotePrice(c.profitQuote, executor.quoteAsset)}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
