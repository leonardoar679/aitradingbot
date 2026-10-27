import { useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { buttonStyle, cellStyle, headCellStyle, noteStyle } from '../agents/agentStyles'
import { useI18n } from '../i18n'
import { msg } from '../../shared/i18n/translate'
import type { PrimaryCallState, PrimaryCard, RefusalCode } from '../../shared/forecast/primaryCall'
import type { PricePrediction } from '../../shared/forecast/prediction'
import { LINE_HORIZON_WORDS, LINE_SIZE_PCT, LINE_SPAN_WORDS, cardLabel, likelyText, pairWords, rateOf, refusalText, sourceWords, utcText, type LineHorizon } from './callText'

const HORIZON_CHOICES: readonly { horizon: LineHorizon; label: string }[] = [
  { horizon: 'hour1', label: msg('1 hour') },
  { horizon: 'hours4', label: msg('4 hours') },
  { horizon: 'hours24', label: msg('1 day') }
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
  const i18n = useI18n()
  const { t, pct, pctPlain } = i18n
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
  const size = pctPlain(LINE_SIZE_PCT[horizon], 0)

  return (
    <Card title={t("Every coin's call")}>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.7rem' }}>
        {HORIZON_CHOICES.map((choice) => (
          <button key={choice.horizon} type="button" style={buttonStyle(choice.horizon === horizon ? 'primary' : 'secondary')} onClick={() => setHorizon(choice.horizon)}>
            {t(choice.label)}
          </button>
        ))}
      </div>
      {lines.length === 0 ? (
        <p style={noteStyle}>{t("No forecast yet: the lines come with the forecast's first pass.")}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={headCellStyle}>{t('Coin')}</th>
                <th style={headCellStyle}>{t('Call')}</th>
                <th style={headCellStyle}>{t('Likely move (80%)')}</th>
                <th style={headCellStyle}>{t('Moved {size}+ in its last 90 days', { size })}</th>
                <th style={headCellStyle}>{t('Why')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.pair} onClick={line.prediction === null ? undefined : (): void => onOpen(line.pair)} style={{ cursor: line.prediction === null ? 'default' : 'pointer' }}>
                  <td dir="ltr" style={{ ...cellStyle, fontWeight: 600 }}>
                    {pairWords(line.pair)}
                  </td>
                  <td style={{ ...cellStyle, fontWeight: 600, color: line.card === null ? 'var(--text-secondary)' : line.card.side === 'down' ? 'var(--down)' : 'var(--up)' }}>
                    {line.card === null ? t('none') : cardLabel(line.card, i18n)}
                  </td>
                  <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>
                    {line.card !== null
                      ? t('to {time}; expected net {net}', { time: utcText(line.card.exitAt, i18n), net: pct(line.card.expectedNet.pct, 2) })
                      : line.prediction === null
                        ? '—'
                        : (likelyText(line.prediction, horizon, i18n) ?? '—')}
                  </td>
                  <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{line.rate === null ? '—' : t(LINE_SPAN_WORDS[horizon], { share: pctPlain(Math.round(line.rate * 100), 0) })}</td>
                  <td style={{ ...cellStyle, whiteSpace: 'normal', minWidth: '14rem', color: 'var(--text-secondary)' }}>
                    {line.card !== null ? sourceWords(line.card, i18n) : line.why !== null ? refusalText(line.why, i18n) : t('No measured source calls its way.')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ ...noteStyle, marginTop: '0.7rem' }}>
        {t(
          "The cards first; then each coin by how often its own close moved at least {size} either way over {span} in its last 90 days — a frequency of the past, not a forecast. The likely move is the forecast's 80% range at the last close. A line opens the coin's whole forecast, with its own lean, P(up) and edge. Nothing here places anything.",
          { size, span: t(LINE_HORIZON_WORDS[horizon]) }
        )}
      </p>
    </Card>
  )
}
