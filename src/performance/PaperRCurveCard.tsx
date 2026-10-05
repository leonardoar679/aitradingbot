import { useEffect, useMemo, useRef } from 'react'
import { createChart, LineSeries, LineStyle, LineType, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import { Card } from '../components/Card'
import type { ExecutorConfig } from '../../shared/ipc'
import { paperRCurves, type RCurve } from '../../shared/paperRCurve'
import { describeR } from '../../shared/paperRisk'
import { noteStyle } from '../agents/agentStyles'
import { useTheme } from '../theme/ThemeContext'
import { CHART_PALETTE } from '../theme/palette'

/** The two running totals, stepping at each close, over a dashed zero. */
function RCurveChart({ watch, news }: { watch: RCurve; news: RCurve }): React.JSX.Element {
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
    const drawn: ISeriesApi<'Line'>[] = []
    for (const [curve, color] of [
      [watch, palette.accent],
      [news, palette.gold]
    ] as const) {
      if (curve.points.length === 0) continue
      const series = chart.addSeries(LineSeries, { color, lineWidth: 2, lineType: LineType.WithSteps, priceLineVisible: false, lastValueVisible: true })
      series.setData(curve.points.map((point) => ({ time: point.time as UTCTimestamp, value: point.r })))
      drawn.push(series)
    }
    drawn[0]?.createPriceLine({ price: 0, color: palette.text, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' })
    chart.timeScale().fitContent()
    return (): void => {
      chart.remove()
    }
  }, [watch, news, palette])

  return <div ref={containerRef} style={{ width: '100%', height: 180 }} />
}

function Swatch({ color }: { color: string }): React.JSX.Element {
  return <span style={{ display: 'inline-block', width: 10, height: 3, borderRadius: 2, background: color, marginRight: 6, verticalAlign: 'middle' }} />
}

function line(name: string, noun: [string, string], curve: RCurve): string {
  const counted = (n: number): string => `${n} ${n === 1 ? noun[0] : noun[1]}`
  const unmeasured =
    curve.unmeasured === 0 ? '' : `${curve.trades === 0 ? '' : '; '}${counted(curve.unmeasured)} with no stop ${curve.unmeasured === 1 ? 'is' : 'are'} not on the line`
  if (curve.trades === 0) return curve.unmeasured === 0 ? `${name}: none has closed yet.` : `${name}: ${unmeasured}.`
  const last = curve.points[curve.points.length - 1]
  return `${name}: ${counted(curve.trades)}, ${curve.ahead} ahead, ${describeR(last.r)} in all${unmeasured}.`
}

/** What the paper trades the app opens by itself -- the watch's and the news rules' -- have come to,
 * as a running total in R (shared/paperRCurve.ts), from how each ended. Read only: it is handed the
 * executors on file by the page, and reaches nothing itself. */
export function PaperRCurveCard({ executors }: { executors: ExecutorConfig[] | null }): React.JSX.Element {
  const { theme } = useTheme()
  const palette = CHART_PALETTE[theme]
  const curves = useMemo(() => (executors === null ? null : paperRCurves(executors)), [executors])

  return (
    <Card title="The app's own paper trades, in R">
      <p style={{ ...noteStyle, marginTop: 0 }}>
        A running total of what each closed trade made over what its stop would have lost: +1 R is a win as large as the loss its stop
        allowed. The watch&apos;s paper trades and the news rules&apos; paper shorts, one line each, from how each ended. One that never
        entered is not on a line, and a delisting&apos;s short has no stop to measure against. Paper: nothing real was placed.
      </p>
      {curves === null ? (
        <p style={noteStyle}>Reading the trades…</p>
      ) : (
        <>
          <p style={{ ...noteStyle, margin: '0.5rem 0 0', color: 'var(--text-primary)' }}>
            <Swatch color={palette.accent} />
            {line('The watch', ['trade', 'trades'], curves.watch)}
          </p>
          <p style={{ ...noteStyle, margin: '0.2rem 0 0', color: 'var(--text-primary)' }}>
            <Swatch color={palette.gold} />
            {line('The news rules', ['short', 'shorts'], curves.news)}
          </p>
          {(curves.watch.points.length > 0 || curves.news.points.length > 0) && (
            <div style={{ marginTop: '0.6rem' }}>
              <RCurveChart watch={curves.watch} news={curves.news} />
            </div>
          )}
        </>
      )}
    </Card>
  )
}
