import { useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { buttonStyle, cellStyle, headCellStyle, noteStyle } from '../agents/agentStyles'
import type { PrimaryCallState, PrimaryCard, RefusalCode } from '../../shared/forecast/primaryCall'
import type { PricePrediction } from '../../shared/forecast/prediction'
import { LINE_HORIZON_WORDS, LINE_SIZE_PCT, LINE_SPAN_WORDS, cardLabel, likelyText, pairWords, rateOf, refusalText, signed, sourceWords, utcTime } from './callText'

type LineHorizon = 'hour1' | 'hours4' | 'hours24'
const HORIZON_CHOICES: readonly { horizon: LineHorizon; label: string }[] = [
  { horizon: 'hour1', label: '1 hour' },
  { horizon: 'hours4', label: '4 hours' },
  { horizon: 'hours24', label: '1 day' }
]

interface Line {
  pair: string
  card: PrimaryCard | null
  prediction: PricePrediction | null
  rate: number | null
  why: RefusalCode | null
}

/** EVERY COIN'S CALL (V8 Stage 3): one line per coin at an hour, four hours or a day -- its card, or "none" with the
 * size of move it is likely to make and why there is no call. The cards first; then the coins by how often their own
 * close moved at least 1%, 2% or 5% over that span in their last 90 days. The forecast's own lean, P(up) and edge are
 * in a coin's whole forecast, which a line opens. Reading it places nothing. */
export function CallLines({
  state,
  predictions,
  pairs,
  onOpen
}: {
  state: PrimaryCallState | null
  predictions: ReadonlyMap<string, PricePrediction>
  /** The forecast's pairs, in the ranking's order. */
  pairs: readonly string[]
  onOpen: (pair: string) => void
}): React.JSX.Element {
  const [horizon, setHorizon] = useState<LineHorizon>('hours4')
  const lines = useMemo((): Line[] => {
    const cards = new Map((state?.cards ?? []).map((card) => [card.pair, card]))
    const refused = new Map((state?.refused ?? []).map((refusal) => [refusal.pair, refusal.refused]))
    const out: Line[] = []
    for (const card of state?.cards ?? []) out.push({ pair: card.pair, card, prediction: predictions.get(card.pair) ?? null, rate: null, why: null })
    for (const late of state?.late ?? []) if (!cards.has(late.pair)) out.push({ pair: late.pair, card: null, prediction: predictions.get(late.pair) ?? null, rate: null, why: 'late' })
    const seen = new Set(out.map((line) => line.pair))
    const rest = pairs
      .filter((pair) => !seen.has(pair))
      .map((pair) => {
        const prediction = predictions.get(pair) ?? null
        return { pair, card: null, prediction, rate: prediction === null ? null : rateOf(prediction, horizon), why: refused.get(pair) ?? null }
      })
      .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1))
    return [...out, ...rest]
  }, [state, predictions, pairs, horizon])

  return (
    <Card title="Every coin's call">
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.7rem' }}>
        {HORIZON_CHOICES.map((choice) => (
          <button key={choice.horizon} type="button" style={buttonStyle(choice.horizon === horizon ? 'primary' : 'secondary')} onClick={() => setHorizon(choice.horizon)}>
            {choice.label}
          </button>
        ))}
      </div>
      {lines.length === 0 ? (
        <p style={noteStyle}>No forecast yet: the lines come with the forecast's first pass.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={headCellStyle}>Coin</th>
                <th style={headCellStyle}>Call</th>
                <th style={headCellStyle}>Likely move (80%)</th>
                <th style={headCellStyle}>Moved {LINE_SIZE_PCT[horizon]}%+ in its last 90 days</th>
                <th style={headCellStyle}>Why</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.pair} onClick={line.prediction === null ? undefined : (): void => onOpen(line.pair)} style={{ cursor: line.prediction === null ? 'default' : 'pointer' }}>
                  <td dir="ltr" style={{ ...cellStyle, fontWeight: 600 }}>
                    {pairWords(line.pair)}
                  </td>
                  <td style={{ ...cellStyle, fontWeight: 600, color: line.card === null ? 'var(--text-secondary)' : line.card.side === 'down' ? 'var(--down)' : 'var(--up)' }}>
                    {line.card === null ? 'none' : cardLabel(line.card)}
                  </td>
                  <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>
                    {line.card !== null
                      ? `to ${utcTime(line.card.exitAt)}; expected net ${signed(line.card.expectedNet.pct)}`
                      : line.prediction === null
                        ? '—'
                        : (likelyText(line.prediction, horizon) ?? '—')}
                  </td>
                  <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{line.rate === null ? '—' : `${Math.round(line.rate * 100)}% of ${LINE_SPAN_WORDS[horizon]} spans`}</td>
                  <td style={{ ...cellStyle, whiteSpace: 'normal', minWidth: '14rem', color: 'var(--text-secondary)' }}>
                    {line.card !== null ? sourceWords(line.card) : line.why !== null ? refusalText(line.why) : 'No measured source calls its way.'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ ...noteStyle, marginTop: '0.7rem' }}>
        The cards first; then each coin by how often its own close moved at least {LINE_SIZE_PCT[horizon]}% either way over {LINE_HORIZON_WORDS[horizon]} in its last
        90 days — a frequency of the past, not a forecast. The likely move is the forecast's 80% range at the last close. A line opens the coin's whole
        forecast, with its own lean, P(up) and edge. Nothing here places anything.
      </p>
    </Card>
  )
}
