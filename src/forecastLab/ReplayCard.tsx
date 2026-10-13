import { useEffect, useRef, useState } from 'react'
import { createChart, LineSeries, LineStyle, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import { Card } from '../components/Card'
import { buttonStyle, inputStyle, noteStyle } from '../agents/agentStyles'
import { HORIZON_BARS, HORIZONS, type Horizon } from '../../shared/forecast/features'
import type { ForecastReplay } from '../../shared/forecast/labView'
import { useTheme } from '../theme/ThemeContext'
import { CHART_PALETTE } from '../theme/palette'
import { HORIZON_NAME, pct, share } from './labTables'

/** The tested hour's levels at a horizon, from its close, drawn over the horizon's span; and the path. */
function ReplayChart({ replay, horizon }: { replay: ForecastReplay; horizon: Horizon }): React.JSX.Element {
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
    const price = chart.addSeries(LineSeries, { color: palette.gold, lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
    // A bar is drawn at its close.
    price.setData(replay.path.map((bar) => ({ time: (bar.time + 300) as UTCTimestamp, value: bar.close })))
    const entry = replay.path.find((bar) => bar.time + 300 === replay.t)?.close
    const row = replay.horizons[horizon]
    if (entry !== undefined && row !== undefined) {
      const end = replay.t + HORIZON_BARS[horizon] * 300
      const colors = [`${palette.down}aa`, palette.accent, palette.text, palette.accent, `${palette.up}aa`]
      row.q.forEach((level, index) => {
        const series = chart.addSeries(LineSeries, { color: colors[index], lineWidth: 1, lineStyle: index === 0 || index === 4 ? LineStyle.Dotted : LineStyle.Solid, priceLineVisible: false, lastValueVisible: false })
        const value = entry * (1 + level / 100)
        series.setData([
          { time: replay.t as UTCTimestamp, value },
          { time: end as UTCTimestamp, value }
        ])
      })
    }
    chart.timeScale().fitContent()
    return (): void => {
      chart.remove()
    }
  }, [replay, horizon, palette])

  return <div ref={containerRef} style={{ width: '100%', height: 260 }} />
}

const toInput = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 16)
const fromInput = (text: string): number => Math.floor(Date.parse(`${text}:00Z`) / 1000)

/** A tested hour replayed (§95): the levels the walk forward's forecast of it gave, with models and a
 * calibration made only from the weeks before, the path that came, the coin's stories on file then, and
 * the analyst's readings of them. */
export function ReplayCard({ pairs, span }: { pairs: readonly string[]; span: { from: number; to: number } }): React.JSX.Element {
  const [pair, setPair] = useState(pairs.includes('BTCUSDT') ? 'BTCUSDT' : (pairs[0] ?? ''))
  const [time, setTime] = useState(toInput(Math.floor((span.from + (span.to - span.from) * 0.7) / 3600) * 3600))
  const [horizon, setHorizon] = useState<Horizon>('hour1')
  const [replay, setReplay] = useState<ForecastReplay | null | undefined>(undefined)

  const load = (): void => {
    const t = fromInput(time)
    if (!Number.isFinite(t) || pair === '') return
    void window.api.forecast.replay(pair, t).then(setReplay, () => setReplay(null))
  }

  return (
    <Card title="Replay a tested hour">
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.6rem' }}>
        <select value={pair} onChange={(change) => setPair(change.target.value)} style={inputStyle()} aria-label="Replay pair">
          {pairs.map((symbol) => (
            <option key={symbol} value={symbol}>
              {symbol}
            </option>
          ))}
        </select>
        <input type="datetime-local" step={3600} value={time} min={toInput(span.from)} max={toInput(span.to)} onChange={(change) => setTime(change.target.value)} style={inputStyle()} aria-label="Replay hour (UTC)" />
        <span style={noteStyle}>UTC</span>
        <button type="button" style={buttonStyle('primary')} onClick={load}>
          Replay
        </button>
      </div>
      {replay === undefined && <p style={noteStyle}>Pick a pair and an hour between {toInput(span.from).replace('T', ' ')} and {toInput(span.to).replace('T', ' ')} UTC: the hours the walk forward tested.</p>}
      {replay === null && <p style={noteStyle}>That hour of that pair was not tested: the walk forward keeps each pair's whole hours of its tested weeks.</p>}
      {replay !== null && replay !== undefined && (
        <>
          <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.4rem', flexWrap: 'wrap' }}>
            {HORIZONS.filter((one) => replay.horizons[one] !== undefined).map((one) => (
              <button key={one} type="button" style={buttonStyle(one === horizon ? 'primary' : 'secondary')} onClick={() => setHorizon(one)}>
                {HORIZON_NAME[one]}
              </button>
            ))}
          </div>
          <ReplayChart replay={replay} horizon={horizon} />
          <div style={{ display: 'grid', gap: '0.2rem', marginTop: '0.5rem' }}>
            {HORIZONS.map((one) => {
              const row = replay.horizons[one]
              if (row === undefined) return null
              return (
                <p key={one} style={{ ...noteStyle, color: 'var(--text-primary)' }}>
                  <strong>{HORIZON_NAME[one]}</strong> · {row.dir} · P10 {pct(row.q[0])} · likely {pct(row.q[1])} ~ {pct(row.q[3])} · median {pct(row.q[2])} · P90 {pct(row.q[4])} · P(up) {share(row.pUp, 0)} · came {pct(row.move)} (best {pct(row.best)}, worst {pct(row.worst)})
                </p>
              )
            })}
          </div>
          <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
            {replay.stories.length === 0
              ? 'No story about the coin on file from four hours before to a day after: the free feeds keep no archive, so the record holds only what this profile saw.'
              : replay.stories.map((story) => `${new Date(story.publishedAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} ${story.kind.toLowerCase()}${story.reading === null ? '' : ` (the analyst: ${story.reading})`}`).join(' · ')}
          </p>
          <p style={noteStyle}>The gold line is the price; the lines from the hour on are its forecast's levels at {HORIZON_NAME[horizon]} (dotted: P10 and P90). A replay of the walk forward: price and technical figures only, no news.</p>
        </>
      )}
    </Card>
  )
}
