import { Card } from '../components/Card'
import { noteStyle } from '../agents/agentStyles'
import { useI18n } from '../i18n'
import { Interpolate } from '../i18n/Interpolate'
import type { PrimaryCallState, PrimaryCard } from '../../shared/forecast/primaryCall'
import type { PricePrediction } from '../../shared/forecast/prediction'
import {
  actionText,
  arrivalText,
  cardLabel,
  costText,
  expectedNetText,
  lateText,
  liveCheckText,
  noCardText,
  pairWords,
  reasonText,
  sizeSpanText,
  sourceWords,
  sourcesText,
  utcText
} from './callText'

const label: React.CSSProperties = { fontSize: '0.66rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)', flex: '0 0 9.5rem' }
const value: React.CSSProperties = { fontSize: '0.86rem', color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', minWidth: 0 }

function Row({ name, children }: { name: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: '1rem', padding: '0.25rem 0', alignItems: 'baseline', flexWrap: 'wrap' }}>
      <span style={label}>{name}</span>
      <span style={{ ...value, flex: '1 1 16rem' }}>{children}</span>
    </div>
  )
}

/** One card: the pair and the call, the reference price, target and window, the arrival, the risk scenarios, the
 * route's cost, the net at the target and the expected net, and the reason. */
export function CallCardBody({ card, livePrice }: { card: PrimaryCard; livePrice: number | null }): React.JSX.Element {
  const i18n = useI18n()
  const { t, pct, dollars } = i18n
  const tags = [sourceWords(card, i18n), t('paper only')]
  if (card.detail.kind === 'delisting' && card.detail.weaker) tags.push(t('weaker than its study'))
  const price = t('reference {price} at {time}', { price: dollars(card.refPrice), time: utcText(card.madeAt, i18n) })
  const target = t('{price} ({move} before costs), by {time}', { price: dollars(card.targetPrice), move: pct(card.side === 'down' ? -card.movePct : card.movePct, 2), time: utcText(card.exitAt, i18n) })
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.9rem', flexWrap: 'wrap' }}>
        <span dir="ltr" style={{ fontSize: '1.25rem', fontWeight: 700 }}>
          {pairWords(card.pair)}
        </span>
        <span style={{ fontSize: '1rem', fontWeight: 700, color: card.side === 'down' ? 'var(--down)' : 'var(--up)' }}>{cardLabel(card, i18n)}</span>
        <span style={{ ...noteStyle, marginInlineStart: 'auto' }}>{tags.join(' · ')}</span>
      </div>
      <div style={{ marginTop: '0.6rem' }}>
        <Row name={t('Price')}>{livePrice !== null ? `${price} · ${t('now {price}', { price: dollars(livePrice) })}` : price}</Row>
        <Row name={t('Target and window')}>{card.detail.kind === 'delisting' ? `${target}, ${t("the rule's exit four hours after the announcement")}` : target}</Row>
        <Row name={t('Arrival')}>{arrivalText(card, i18n)}</Row>
        <Row name={t('Risk scenarios')}>
          {t('in its favour {for} (one call in ten did better); against it {against} (one in ten did worse); the worst on file {worst} after costs', {
            for: pct(card.scenarios.forPct, 2),
            against: pct(card.scenarios.againstPct, 2),
            worst: pct(card.scenarios.worstPct, 2)
          })}
        </Row>
        <Row name={t('Costs')}>{costText(card, i18n)}</Row>
        <Row name={t('Net at the target')}>{t('{net} after the round trip', { net: pct(card.netAtTargetPct, 2) })}</Row>
        <Row name={t('Expected net')}>{expectedNetText(card, i18n)}</Row>
        <Row name={t('Why')}>{reasonText(card, i18n)}</Row>
        <Row name={t('What you can do')}>{actionText(card, i18n)}</Row>
      </div>
      <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
        <Interpolate
          text={t("Risk scenarios are what its source's calls did, not limits: a squeeze can go past them. Recorded as {id}; its outcome is settled from the venue's bars when its window ends.")}
          values={{ id: <code>{card.predictionId}</code> }}
        />
      </p>
    </div>
  )
}

/** THE PRIMARY CALL (V8 Stage 3): the best card weighed, or "No profitable opportunity identified" with why, the size
 * that is measured, and where calls come from. Reading it records, opens and places nothing. */
export function PrimaryCallCard({
  state,
  predictions,
  livePrice
}: {
  state: PrimaryCallState | null
  predictions: readonly PricePrediction[]
  /** The best card's pair's live mid, where the stream holds it. */
  livePrice?: number | null
}): React.JSX.Element {
  const i18n = useI18n()
  const { t } = i18n
  if (state === null) {
    return (
      <Card title={t('Primary call')}>
        <p style={noteStyle}>{t('Weighing the sources that may call a way…')}</p>
      </Card>
    )
  }
  const [best, ...others] = state.cards
  if (best !== undefined) {
    return (
      <Card title={t('Primary call')}>
        <CallCardBody card={best} livePrice={livePrice ?? null} />
        {others.length > 0 && (
          <p style={{ ...noteStyle, marginTop: '0.4rem' }}>
            {t('{count} more cards: {cards} — on Predictions.', { count: others.length, cards: others.map((card) => `${pairWords(card.pair)} ${cardLabel(card, i18n)}`).join(', ') })}
          </p>
        )}
      </Card>
    )
  }
  const size = sizeSpanText(predictions, i18n)
  const live = liveCheckText(state.delistLive, i18n)
  return (
    <Card title={t('Primary call')}>
      <p style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700 }}>{t('No profitable opportunity identified')}</p>
      <p style={{ ...noteStyle, marginTop: '0.45rem' }}>{noCardText(state, i18n)}</p>
      {state.late.map((late) => (
        <p key={`${late.pair}:${late.eventAt}`} style={{ ...noteStyle, marginTop: '0.3rem' }}>
          {lateText(late, i18n)}
        </p>
      ))}
      {size !== null && <p style={{ ...noteStyle, marginTop: '0.45rem' }}>{size}</p>}
      <p style={{ ...noteStyle, marginTop: '0.45rem' }}>{sourcesText(state, i18n)}</p>
      {live !== null && <p style={{ ...noteStyle, marginTop: '0.3rem' }}>{live}</p>}
    </Card>
  )
}
