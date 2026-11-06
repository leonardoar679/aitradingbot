import { useMemo } from 'react'
import { Card } from '../components/Card'
import { noteStyle } from '../agents/agentStyles'
import { BIG_MOVERS_LINES, BIG_MOVER_HORIZONS, bigMoversOf, type BigMoverHorizon } from '../../shared/forecast/bigMovers'
import { ratesAt } from '../../shared/forecast/moveRates'
import type { PricePrediction } from '../../shared/forecast/prediction'
import type { CardSource, PrimaryCallState } from '../../shared/forecast/primaryCall'
import { LINE_HORIZON_WORDS, LINE_SPAN_WORDS, pairWords } from '../calls/callText'
import { durationOf } from '../traders/traderText'
import { msg, useI18n } from '../i18n'

// THE BIG MOVERS, ON PREDICTIONS (V8 Stage 10, 27 October 2026; shared/forecast/bigMovers.ts) AND ON HOME (V9 Stage 1, 6
// November 2026). The coins most likely to move a size worth trading at each horizon -- 1% within an hour, 2% within
// four, 5% within a day, either way -- within an hour by the width of the forecast's 80% range, which V9-SIZE-RANK found
// ranks such moves better, and within four hours and a day by how often each moved that much over its last ninety days,
// where it did not. Size alone: no side is called by the list. On Home,
// at four hours and a day, each coin also says how soon such a move came when it came (the median time to its first
// touch over the ninety days), and a way only where a measured source calls one. The same list is recorded each hour
// and scored on Performance.

const SOURCE_NAMES: Record<CardSource, string> = { 'delisting-rule': msg('The delisting rule'), 'direction-model': msg('A direction model') }

export function BigMoversView({
  predictions,
  onOpen,
  horizons = BIG_MOVER_HORIZONS,
  times = false,
  calls = null,
  behind = null
}: {
  predictions: readonly PricePrediction[]
  onOpen: (pair: string) => void
  /** The horizons shown: all three on Predictions, four hours and a day on Home. */
  horizons?: readonly BigMoverHorizon[]
  /** Each coin's time to its first touch of the size, said as conditional (Home). */
  times?: boolean
  /** The primary call, where a listed coin's way is to be said: only a measured source's card gives one (Home). */
  calls?: PrimaryCallState | null
  /** forecastBehindText's sentence, when the forecast has fallen behind the closes. */
  behind?: string | null
}): React.JSX.Element | null {
  const i18n = useI18n()
  const { t, pctPlain } = i18n
  const lists = useMemo(() => bigMoversOf(predictions), [predictions])
  const byPair = useMemo(() => new Map(predictions.map((prediction) => [prediction.pair, prediction])), [predictions])
  if (horizons.every((horizon) => lists[horizon].length === 0)) return null
  const cardOf = (pair: string): PrimaryCallState['cards'][number] | undefined => calls?.cards.find((card) => card.pair === pair)
  const anyWay = calls !== null && horizons.some((horizon) => lists[horizon].some((entry) => cardOf(entry.pair) !== undefined))
  return (
    <Card title={t('Big movers')}>
      {behind !== null && (
        <p role="status" style={{ ...noteStyle, margin: '0 0 0.6rem', color: 'var(--gold)' }}>
          {behind}
        </p>
      )}
      <p style={noteStyle}>
        {horizons.includes('hour1')
          ? t("The coins most likely to move a size worth trading, either way. Within an hour they are ranked by the width of the forecast's 80% range, which ranked such moves better than the coins' own rates on a year apart; within four hours and a day by how often each moved that much over its last 90 days. The chance shown is that 90-day rate. Size, not direction: no side is called.")
          : t("The coins most likely to move a size worth trading, either way, ranked by how often each moved that much over its last 90 days: on a year apart, the forecast's ranges ranked moves of four hours and a day no better. Size, not direction: no side is called.")}
      </p>
      {calls !== null && !anyWay && <p style={noteStyle}>{t('Which way is unknown: no measured source calls one for these coins now.')}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))', gap: '1rem', marginTop: '0.6rem' }}>
        {horizons.map((horizon) => {
          const sizePct = BIG_MOVERS_LINES.horizons[horizon].sizePct
          const span = t(LINE_HORIZON_WORDS[horizon])
          return (
            <div key={horizon} style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <span style={{ fontSize: '0.74rem', fontWeight: 700, color: 'var(--text-secondary)' }}>{t('{size} or more within {span}', { size: pctPlain(sizePct, 0), span })}</span>
              {lists[horizon].map((entry) => {
                const touch = times ? ratesAt(byPair.get(entry.pair)?.moveRates, horizon)?.touch.find((rate) => rate.pct === sizePct) : undefined
                const card = cardOf(entry.pair)
                return (
                  <button
                    key={entry.pair}
                    type="button"
                    onClick={() => onOpen(entry.pair)}
                    style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-primary)', fontSize: '0.8rem', textAlign: 'start' }}
                  >
                    <span style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', width: '100%' }}>
                      <span>{pairWords(entry.pair)}</span>
                      <span style={{ color: 'var(--text-muted)' }}>{t(LINE_SPAN_WORDS[horizon], { share: pctPlain(entry.rate * 100, 0) })}</span>
                    </span>
                    {touch !== undefined && touch.medianMinutes !== null && (
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.74rem' }}>
                        {t('When it moved {size} within {span}, the first touch came after {time} (median).', { size: pctPlain(sizePct, 0), span, time: durationOf(i18n, touch.medianMinutes) })}
                      </span>
                    )}
                    {card !== undefined && (
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.74rem' }}>
                        {card.side === 'down' ? t('Down, by {source}', { source: t(SOURCE_NAMES[card.source]) }) : t('Up, by {source}', { source: t(SOURCE_NAMES[card.source]) })}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
    </Card>
  )
}
