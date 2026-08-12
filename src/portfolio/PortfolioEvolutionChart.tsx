import { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, AreaSeries, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import { BarChart3, Layers } from 'lucide-react'
import { useTheme } from '../theme/ThemeContext'
import { CHART_PALETTE } from '../theme/palette'
import { MOCK_HOLDINGS, TIMEFRAMES, generatePortfolioSeries, type Timeframe } from './data'

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

  const series = useMemo(() => generatePortfolioSeries(timeframe), [timeframe])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

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
      areaSeries.setData(series.map((p) => ({ time: toTime(p.time), value: p.value })))
    } else {
      // Stacked composition: split the same total-value curve by each holding's current
      // portfolio share. Series are added smallest-cumulative-last so painter's order stacks
      // them bottom-to-top in holdings order.
      const totalShare = MOCK_HOLDINGS.reduce((sum, h) => sum + h.value, 0)
      let cumulative = 0
      const cumulativeFractions = MOCK_HOLDINGS.map((h) => {
        cumulative += h.value / totalShare
        return cumulative
      })

      for (let i = MOCK_HOLDINGS.length - 1; i >= 0; i--) {
        const holding = MOCK_HOLDINGS[i]
        const fraction = cumulativeFractions[i]
        const areaSeries = chart.addSeries(AreaSeries, {
          lineColor: holding.color,
          topColor: `${holding.color}e6`,
          bottomColor: `${holding.color}e6`,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false
        })
        areaSeries.setData(series.map((p) => ({ time: toTime(p.time), value: p.value * fraction })))
      }
    }

    chart.timeScale().fitContent()

    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [series, mode, timeframe, palette])

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
      <div ref={containerRef} style={{ width: '100%', height: 360, marginTop: '1rem' }} />
    </section>
  )
}
