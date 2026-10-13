import { useEffect, useRef } from 'react'
import { createChart, LineSeries, LineStyle, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import type { Horizon } from '../../shared/forecast/features'
import type { PredictionLine } from '../../shared/forecast/forecastRecord'
import { HORIZON_BARS } from '../../shared/forecast/features'
import { useTheme } from '../theme/ThemeContext'
import { CHART_PALETTE } from '../theme/palette'

/** Each recorded forecast's levels, drawn at the moment they were for. */
function bandsOf(lines: readonly PredictionLine[], horizon: Horizon): { time: number; levels: number[] }[] {
  const seconds = HORIZON_BARS[horizon] * 300
  const byTime = new Map<number, number[]>()
  for (const line of lines) {
    const q = line.h[horizon]?.q
    if (q === undefined || line.why !== 'grid') continue
    byTime.set(line.t + seconds, q.map((pct) => line.price * (1 + pct / 100)))
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, levels]) => ({ time, levels }))
}

/** The price the record holds at each of its closes. */
function pricesOf(lines: readonly PredictionLine[]): { time: number; value: number }[] {
  const byTime = new Map<number, number>()
  for (const line of lines) byTime.set(line.t, line.price)
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }))
}

/** A pair's forecasts against what came (the V6 document, §94): each recorded forecast's range at a
 * horizon -- its likely range and its 80% one -- drawn at the moment it was a forecast for, and the
 * price the record holds at each close over it, so that whether the model is believable can be seen. */
export function ForecastHistoryChart({ lines, horizon }: { lines: readonly PredictionLine[]; horizon: Horizon }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const { theme } = useTheme()
  const palette = CHART_PALETTE[theme]

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const chart: IChartApi = createChart(container, {
      autoSize: true,
      layout: { background: { color: palette.background }, textColor: palette.text, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: palette.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 }
    })
    const bands = bandsOf(lines, horizon)
    const level = (index: number, color: string, style: LineStyle): void => {
      const series = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: style, priceLineVisible: false, lastValueVisible: false })
      series.setData(bands.map((band) => ({ time: band.time as UTCTimestamp, value: band.levels[index] })))
    }
    level(0, `${palette.down}99`, LineStyle.Dotted)
    level(1, palette.accent, LineStyle.Solid)
    level(3, palette.accent, LineStyle.Solid)
    level(4, `${palette.up}99`, LineStyle.Dotted)
    const price = chart.addSeries(LineSeries, { color: palette.gold, lineWidth: 2, priceLineVisible: false, lastValueVisible: true })
    price.setData(pricesOf(lines).map((point) => ({ time: point.time as UTCTimestamp, value: point.value })))
    chart.timeScale().fitContent()
    return (): void => {
      chart.remove()
    }
  }, [lines, horizon, palette])

  return <div ref={containerRef} style={{ width: '100%', height: 220 }} />
}
