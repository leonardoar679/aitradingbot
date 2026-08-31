import { useEffect, useRef } from 'react'
import { createChart, AreaSeries, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import { useTheme } from '../theme/ThemeContext'
import { CHART_PALETTE } from '../theme/palette'
import type { EquityPoint } from '../backtest/engine'

export function EquityCurveChart({ equityCurve }: { equityCurve: EquityPoint[] }): React.JSX.Element {
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
      timeScale: { borderVisible: false, timeVisible: false, secondsVisible: false },
      crosshair: { mode: 0 }
    })

    const series = chart.addSeries(AreaSeries, {
      lineColor: palette.gold,
      topColor: `${palette.gold}40`,
      bottomColor: `${palette.gold}05`,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false
    })
    series.setData(equityCurve.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })))
    chart.timeScale().fitContent()

    return (): void => {
      chart.remove()
    }
  }, [equityCurve, palette])

  return <div ref={containerRef} style={{ width: '100%', height: 140 }} />
}
