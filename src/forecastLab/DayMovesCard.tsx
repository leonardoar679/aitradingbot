import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { cellStyle, headCellStyle, noteStyle } from '../agents/agentStyles'
import { BIG_MOVERS_LINES } from '../../shared/forecast/bigMovers'
import { pairWords } from '../calls/callText'

// MOVES OF 5% AND 10% IN A DAY, STUDIED APART (V8 Stage 10, 27 October 2026; the user's V8 aims: 1-5% moves, with 5-10%
// studied apart). For each pair the forecast reads, how often over its last ninety days a day's close landed at least
// 5% and 10% from where it started, either way, read at every hour's close (shared/forecast/bigMovers.ts). A frequency
// of the past, not a forecast: no model is asked and no side is called. English, as the Lab is.

type DayMoves = Awaited<ReturnType<typeof window.api.forecast.dayMoves>>

const SHOWN = 15

export function DayMovesView({ moves }: { moves: DayMoves | null }): React.JSX.Element {
  const [small, large] = BIG_MOVERS_LINES.dayMovesPct
  return (
    <Card title={`Moves of ${small}% and ${large}% in a day`}>
      <p style={noteStyle}>
        How often each pair's close a day later landed at least {small}% and {large}% from where it started, either way, over its last {BIG_MOVERS_LINES.dayMoveDays} days, read at every hour's close; the {SHOWN} most often moving {large}% shown. A frequency of the past, not a forecast: it names no side, and the price forecast's own chances of moves this large are not shown, since they have not passed their registered lines.
      </p>
      {moves === null ? (
        <p style={noteStyle}>Reading the bars…</p>
      ) : moves.rows.length === 0 ? (
        <p style={noteStyle}>No pair has thirty days of bars on file yet.</p>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: '0.6rem' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={headCellStyle}>Pair</th>
                <th style={headCellStyle}>{`Days ${small}% or more`}</th>
                <th style={headCellStyle}>{`Days ${large}% or more`}</th>
                <th style={headCellStyle}>Hours read</th>
              </tr>
            </thead>
            <tbody>
              {moves.rows.slice(0, SHOWN).map((row) => (
                <tr key={row.pair}>
                  <td style={cellStyle}>{pairWords(row.pair)}</td>
                  <td style={cellStyle}>{`${((row.rates[small] ?? 0) * 100).toFixed(1)}%`}</td>
                  <td style={cellStyle}>{`${((row.rates[large] ?? 0) * 100).toFixed(1)}%`}</td>
                  <td style={cellStyle}>{row.moments.toLocaleString('en-US')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

export function DayMovesCard(): React.JSX.Element {
  const [moves, setMoves] = useState<DayMoves | null>(null)
  useEffect(() => {
    let live = true
    void window.api.forecast
      .dayMoves()
      .then((read) => {
        if (live) setMoves(read)
      })
      .catch(() => undefined)
    return (): void => {
      live = false
    }
  }, [])
  return <DayMovesView moves={moves} />
}
