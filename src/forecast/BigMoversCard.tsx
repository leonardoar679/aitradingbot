import { useMemo } from 'react'
import { Card } from '../components/Card'
import { noteStyle } from '../agents/agentStyles'
import { BIG_MOVERS_LINES, BIG_MOVER_HORIZONS, bigMoversOf } from '../../shared/forecast/bigMovers'
import type { PricePrediction } from '../../shared/forecast/prediction'
import { LINE_HORIZON_WORDS, LINE_SPAN_WORDS, pairWords } from '../calls/callText'
import { useI18n } from '../i18n'

// THE BIG MOVERS, ON PREDICTIONS (V8 Stage 10, 27 October 2026; shared/forecast/bigMovers.ts). The coins most likely to
// move a size worth trading at each horizon -- 1% within an hour, 2% within four, 5% within a day, either way -- ranked
// by how often each moved that much over its last ninety days, as V8-R1-SIZE's registration says until one of its
// rankers passes. Size alone: no side is called. The same list is recorded each hour and scored on Performance.

export function BigMoversView({ predictions, onOpen }: { predictions: readonly PricePrediction[]; onOpen: (pair: string) => void }): React.JSX.Element | null {
  const i18n = useI18n()
  const { t, pctPlain } = i18n
  const lists = useMemo(() => bigMoversOf(predictions), [predictions])
  if (BIG_MOVER_HORIZONS.every((horizon) => lists[horizon].length === 0)) return null
  return (
    <Card title={t('Big movers')}>
      <p style={noteStyle}>
        {t("The coins most likely to move a size worth trading, either way, ranked by how often each moved that much over its last 90 days. Measured on March to September 2026, the forecast's ranges ranked such moves better, but their chances were not accurate enough to be adopted. Size, not direction: no side is called.")}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))', gap: '1rem', marginTop: '0.6rem' }}>
        {BIG_MOVER_HORIZONS.map((horizon) => (
          <div key={horizon} style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <span style={{ fontSize: '0.74rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
              {t('{size} or more within {span}', { size: pctPlain(BIG_MOVERS_LINES.horizons[horizon].sizePct, 0), span: t(LINE_HORIZON_WORDS[horizon]) })}
            </span>
            {lists[horizon].map((entry) => (
              <button
                key={entry.pair}
                type="button"
                onClick={() => onOpen(entry.pair)}
                style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-primary)', fontSize: '0.8rem', textAlign: 'start' }}
              >
                <span>{pairWords(entry.pair)}</span>
                <span style={{ color: 'var(--text-muted)' }}>{t(LINE_SPAN_WORDS[horizon], { share: pctPlain(entry.rate * 100, 0) })}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </Card>
  )
}
