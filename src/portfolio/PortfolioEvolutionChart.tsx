import { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, AreaSeries, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import { BarChart3, Layers } from 'lucide-react'
import { useTheme } from '../theme/ThemeContext'
import { CHART_PALETTE } from '../theme/palette'
import { TIMEFRAMES, TIMEFRAME_LOOKBACK_SEC, type Timeframe } from './data'
import { usePortfolioSnapshots } from './portfolioStore'
import { colorForAsset } from './assetColor'
import { isUsdLikeQuote } from '../utils/formatCurrency'

type ChartMode = 'value' | 'composition'

function toTime(seconds: number): UTCTimestamp {
  return seconds as UTCTimestamp
}

function toggleButtonStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    background: active ? 'var(--gold)' : 'transparent',
    color: active ? '#161310' : 'var(--text-secondary)',
    cursor: 'pointer'
  }
}

function timeframeButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '0.35rem 0.65rem',
    fontSize: '0.75rem',
    fontWeight: 700,
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    background: active ? 'var(--gold)' : 'transparent',
    color: active ? '#161310' : 'var(--text-secondary)',
    cursor: 'pointer'
  }
}

export function PortfolioEvolutionChart(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const [timeframe, setTimeframe] = useState<Timeframe>('1M')
  const [mode, setMode] = useState<ChartMode>('value')
  const { theme } = useTheme()
  const palette = CHART_PALETTE[theme]

  const allSnapshots = usePortfolioSnapshots()
  const snapshots = useMemo(() => {
    const cutoff = Math.floor(Date.now() / 1000) - TIMEFRAME_LOOKBACK_SEC[timeframe]
    return allSnapshots.filter((s) => s.takenAt >= cutoff)
  }, [allSnapshots, timeframe])

  const hasEnoughHistory = snapshots.length >= 2

  useEffect(() => {
    const container = containerRef.current
    if (!container || !hasEnoughHistory) return

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: palette.background },
        textColor: palette.text,
        attributionLogo: false
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: palette.grid }
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: timeframe === '1D', secondsVisible: false },
      crosshair: { mode: 0 }
    })
    chartRef.current = chart

    if (mode === 'value') {
      const areaSeries = chart.addSeries(AreaSeries, {
        lineColor: '#d4a94a',
        topColor: 'rgba(212, 169, 74, 0.45)',
        bottomColor: 'rgba(212, 169, 74, 0.02)',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false
      })
      areaSeries.setData(snapshots.map((s) => ({ time: toTime(s.takenAt), value: s.totalValue })))
    } else {
      // Real stacked composition, from each snapshot's own real holdings breakdown at that
      // moment -- not a static current-share projected backward, like the old mock did. Only
      // USD-family-quoted rows are included, matching totalValue's own definition, so the stack
      // visually sums to the same line the value mode plots.
      const seriesKeys = new Set<string>()
      for (const snapshot of snapshots) {
        for (const holding of snapshot.holdings) {
          if (isUsdLikeQuote(holding.quoteAsset)) seriesKeys.add(`${holding.baseAsset}:${holding.quoteAsset}:${holding.isLive}`)
        }
      }

      const perSnapshotValues = snapshots.map((snapshot) => {
        const byKey = new Map<string, number>()
        for (const holding of snapshot.holdings) {
          if (isUsdLikeQuote(holding.quoteAsset)) byKey.set(`${holding.baseAsset}:${holding.quoteAsset}:${holding.isLive}`, holding.value)
        }
        return byKey
      })

      // Painter's order: draw the cumulative-largest series first so later (smaller) series
      // layer on top and stay visible, same approach the old mock used.
      const keys = [...seriesKeys]
      const cumulativeByIndex = snapshots.map((_, i) => {
        let running = 0
        return keys.map((key) => (running += perSnapshotValues[i].get(key) ?? 0))
      })

      for (let k = keys.length - 1; k >= 0; k--) {
        const [baseAsset] = keys[k].split(':')
        const color = colorForAsset(baseAsset)
        const areaSeries = chart.addSeries(AreaSeries, {
          lineColor: color,
          topColor: `${color}e6`,
          bottomColor: `${color}e6`,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false
        })
        areaSeries.setData(snapshots.map((s, i) => ({ time: toTime(s.takenAt), value: cumulativeByIndex[i][k] })))
      }
    }

    chart.timeScale().fitContent()

    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [snapshots, mode, timeframe, palette, hasEnoughHistory])

  return (
    <section
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: '1.25rem'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
        <h2
          style={{
            margin: 0,
            fontSize: '0.95rem',
            fontWeight: 700,
            color: 'var(--text-primary)'
          }}
        >
          Portfolio Evolution
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem' }}>
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            <button
              title="Value"
              style={toggleButtonStyle(mode === 'value')}
              onClick={() => setMode('value')}
            >
              <BarChart3 size={15} />
            </button>
            <button
              title="Composition"
              style={toggleButtonStyle(mode === 'composition')}
              onClick={() => setMode('composition')}
            >
              <Layers size={15} />
            </button>
          </div>
          <div style={{ display: 'flex', gap: '0.2rem', background: 'var(--bg-app)', borderRadius: 'var(--radius-sm)', padding: '0.2rem' }}>
            {TIMEFRAMES.map((tf) => (
              <button key={tf} style={timeframeButtonStyle(timeframe === tf)} onClick={() => setTimeframe(tf)}>
                {tf}
              </button>
            ))}
          </div>
        </div>
      </div>
      {hasEnoughHistory ? (
        <div ref={containerRef} style={{ width: '100%', height: 360, marginTop: '1rem' }} />
      ) : (
        <p style={{ margin: '1rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          Not enough history yet — this chart tracks real values from now forward, not a fabricated past. Leave the
          app open for a bit and it'll start filling in.
        </p>
      )}
    </section>
  )
}
