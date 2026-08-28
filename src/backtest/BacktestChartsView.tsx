import { useEffect, useRef, useState } from 'react'
import {
  createChart,
  CandlestickSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp
} from 'lightweight-charts'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTheme } from '../theme/ThemeContext'
import { CHART_PALETTE, type ChartPalette } from '../theme/palette'
import type { Candle } from '../../shared/ipc'
import type { Trade } from './engine'
import { formatUtcDate, formatUtcTime, formatUtcShort, formatHoldingDuration } from './formatTradeTime'

interface BacktestChartsViewProps {
  candles: Candle[]
  trades: Trade[]
}

function pctColor(pct: number): string {
  return pct >= 0 ? 'var(--up)' : 'var(--down)'
}

function exitReasonLabel(reason: Trade['exitReason']): string {
  if (reason === 'stop_loss') return 'STOP LOSS'
  if (reason === 'end_of_data') return 'FORCE CLOSE'
  return 'SIGNAL'
}

function markersForTrade(t: Trade, palette: ChartPalette): SeriesMarker<Time>[] {
  return [
    {
      time: t.entryTime as UTCTimestamp,
      position: t.side === 'long' ? 'belowBar' : 'aboveBar',
      shape: t.side === 'long' ? 'arrowUp' : 'arrowDown',
      color: t.side === 'long' ? palette.accent : palette.down,
      text: t.side === 'long' ? 'BUY · LONG' : 'SELL · SHORT'
    },
    {
      time: t.exitTime as UTCTimestamp,
      position: t.side === 'long' ? 'aboveBar' : 'belowBar',
      shape: t.side === 'long' ? 'arrowDown' : 'arrowUp',
      color: t.side === 'long' ? palette.down : palette.accent,
      text: t.side === 'long' ? 'SELL · LONG' : 'BUY · SHORT'
    }
  ]
}

function nearestCandleIndex(candles: Candle[], time: number): number {
  let lo = 0
  let hi = candles.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (candles[mid].time < time) lo = mid + 1
    else hi = mid
  }
  return lo
}

const CONTEXT_CANDLES = 40

// Shared so the header row and the body rows can never drift out of alignment, which is the
// classic way a grid table ends up with its labels one column off its data.
const ROW_COLUMNS = '1.05fr 0.9fr 0.75fr 0.85fr 26px'
const DETAIL_COLUMNS = '1.15fr 0.9fr 0.75fr 1fr 0.6fr'

export function BacktestChartsView({ candles, trades }: BacktestChartsViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const [tradesVisible, setTradesVisible] = useState(true)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const { theme } = useTheme()
  const palette = CHART_PALETTE[theme]

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const chart: IChartApi = createChart(container, {
      autoSize: true,
      layout: { background: { color: palette.background }, textColor: palette.text },
      grid: {
        vertLines: { color: palette.grid },
        horzLines: { color: palette.grid }
      },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: palette.border }
    })
    chartRef.current = chart

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: palette.up,
      downColor: palette.down,
      borderVisible: false,
      wickUpColor: palette.up,
      wickDownColor: palette.down
    })
    candleSeries.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      }))
    )

    markersRef.current = createSeriesMarkers(candleSeries, [])
    chart.timeScale().fitContent()

    return () => {
      chart.remove()
      chartRef.current = null
      markersRef.current = null
    }
  }, [candles, palette])

  useEffect(() => {
    const chart = chartRef.current
    const markers = markersRef.current
    const trade = trades[selectedIndex]
    if (!chart || !markers || !trade || candles.length === 0) return

    markers.setMarkers(tradesVisible ? markersForTrade(trade, palette) : [])

    const entryIdx = nearestCandleIndex(candles, trade.entryTime)
    const exitIdx = nearestCandleIndex(candles, trade.exitTime)
    const fromIdx = Math.max(0, entryIdx - CONTEXT_CANDLES)
    const toIdx = Math.min(candles.length - 1, exitIdx + CONTEXT_CANDLES)
    chart.timeScale().setVisibleRange({
      from: candles[fromIdx].time as UTCTimestamp,
      to: candles[toIdx].time as UTCTimestamp
    })
  }, [selectedIndex, tradesVisible, trades, candles, palette])

  return (
    <div style={{ display: 'flex', gap: '1.25rem', height: 560 }}>
      <div style={{ width: 420, display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', flexShrink: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.6rem 0.9rem',
            borderBottom: '1px solid var(--border)'
          }}
        >
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{trades.length} trades</span>
          <button
            onClick={() => setTradesVisible((v) => !v)}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '0.35rem 0.7rem',
              color: 'var(--text-primary)',
              fontSize: '0.78rem',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            {tradesVisible ? 'Hide Trades' : 'Show Trades'}
          </button>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: ROW_COLUMNS,
            padding: '0.6rem 0.9rem',
            fontSize: '0.72rem',
            fontStyle: 'italic',
            color: 'var(--text-secondary)',
            borderBottom: '1px solid var(--border)'
          }}
        >
          <span>ENTRY (UTC)</span>
          <span>PRICE</span>
          <span>HELD</span>
          <span>PNL</span>
          <span />
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {trades.map((t, i) => {
            const selected = selectedIndex === i
            return (
              <div key={i}>
                <div
                  onClick={() => setSelectedIndex(i)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: ROW_COLUMNS,
                    alignItems: 'center',
                    padding: '0.55rem 0.9rem',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                    background: selected ? 'var(--bg-surface-hover)' : 'transparent',
                    borderBottom: '1px solid var(--border)',
                    borderLeft: selected ? '2px solid var(--accent)' : '2px solid transparent'
                  }}
                >
                  <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
                    <span style={{ color: 'var(--text-primary)' }}>{formatUtcDate(t.entryTime)}</span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>{formatUtcTime(t.entryTime)}</span>
                  </span>
                  <span style={{ color: 'var(--text-primary)' }}>{t.entryPrice.toFixed(2)}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{formatHoldingDuration(t.exitTime - t.entryTime)}</span>
                  <span style={{ color: pctColor(t.returnPct), fontWeight: 600 }}>{t.returnPct.toFixed(2)}%</span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {selected ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </span>
                </div>
                {selected && (
                  <div style={{ background: 'var(--bg-app)', padding: '0.55rem 0.9rem', borderBottom: '1px solid var(--border)' }}>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: DETAIL_COLUMNS,
                        fontSize: '0.68rem',
                        fontStyle: 'italic',
                        color: 'var(--text-secondary)',
                        marginBottom: '0.35rem'
                      }}
                    >
                      <span>TIME (UTC)</span>
                      <span>PRICE</span>
                      <span>QTY</span>
                      <span>TYPE</span>
                      <span>SIDE</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: DETAIL_COLUMNS, fontSize: '0.76rem', padding: '0.25rem 0' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>{formatUtcShort(t.entryTime)}</span>
                      <span>{t.entryPrice.toFixed(2)}</span>
                      <span>{t.qty.toFixed(2)}</span>
                      <span>MARKET</span>
                      <span style={{ color: t.side === 'long' ? 'var(--up)' : 'var(--down)' }}>
                        {t.side === 'long' ? 'BUY' : 'SELL'}
                      </span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: DETAIL_COLUMNS, fontSize: '0.76rem', padding: '0.25rem 0' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>{formatUtcShort(t.exitTime)}</span>
                      <span>{t.exitPrice.toFixed(2)}</span>
                      <span>{t.qty.toFixed(2)}</span>
                      <span>{exitReasonLabel(t.exitReason)}</span>
                      <span style={{ color: t.side === 'long' ? 'var(--down)' : 'var(--up)' }}>
                        {t.side === 'long' ? 'SELL' : 'BUY'}
                      </span>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        gap: '1.1rem',
                        flexWrap: 'wrap',
                        marginTop: '0.4rem',
                        paddingTop: '0.4rem',
                        borderTop: '1px solid var(--border)',
                        fontSize: '0.72rem',
                        color: 'var(--text-secondary)'
                      }}
                    >
                      <span>
                        Held{' '}
                        <strong style={{ color: 'var(--text-primary)' }}>
                          {formatHoldingDuration(t.exitTime - t.entryTime)}
                        </strong>
                      </span>
                      <span>
                        {formatUtcDate(t.entryTime)} {formatUtcTime(t.entryTime)} &rarr;{' '}
                        {formatUtcDate(t.exitTime)} {formatUtcTime(t.exitTime)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div ref={containerRef} style={{ flex: 1 }} />
    </div>
  )
}
