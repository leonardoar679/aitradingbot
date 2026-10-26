import { Card } from '../components/Card'
import { noteStyle } from '../agents/agentStyles'
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
  priceText,
  reasonText,
  signed,
  sizeSpanText,
  sourceWords,
  sourcesText,
  utcTime
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
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.9rem', flexWrap: 'wrap' }}>
        <span dir="ltr" style={{ fontSize: '1.25rem', fontWeight: 700 }}>
          {pairWords(card.pair)}
        </span>
        <span style={{ fontSize: '1rem', fontWeight: 700, color: card.side === 'down' ? 'var(--down)' : 'var(--up)' }}>{cardLabel(card)}</span>
        <span style={{ ...noteStyle, marginInlineStart: 'auto' }}>
          {sourceWords(card)} · paper only{card.detail.kind === 'delisting' && card.detail.weaker ? ' · weaker than its study' : ''}
        </span>
      </div>
      <div style={{ marginTop: '0.6rem' }}>
        <Row name="Price">
          reference {priceText(card.refPrice)} at {utcTime(card.madeAt)}
          {livePrice !== null ? ` · now ${priceText(livePrice)}` : ''}
        </Row>
        <Row name="Target and window">
          {priceText(card.targetPrice)} ({signed(card.side === 'down' ? -card.movePct : card.movePct)} before costs), by {utcTime(card.exitAt)}
          {card.detail.kind === 'delisting' ? ", the rule's exit four hours after the announcement" : ''}
        </Row>
        <Row name="Arrival">{arrivalText(card)}</Row>
        <Row name="Risk scenarios">
          in its favour {signed(card.scenarios.forPct)} (one call in ten did better); against it {signed(card.scenarios.againstPct)} (one in ten did worse); the worst
          on file {signed(card.scenarios.worstPct)} after costs
        </Row>
        <Row name="Costs">{costText(card)}</Row>
        <Row name="Net at the target">{signed(card.netAtTargetPct)} after the round trip</Row>
        <Row name="Expected net">{expectedNetText(card)}</Row>
        <Row name="Why">{reasonText(card)}</Row>
        <Row name="What you can do">{actionText(card)}</Row>
      </div>
      <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
        Risk scenarios are what its source's calls did, not limits: a squeeze can go past them. Recorded as {card.predictionId}; its outcome is settled from the
        venue's bars when its window ends.
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
  if (state === null) {
    return (
      <Card title="Primary call">
        <p style={noteStyle}>Weighing the sources that may call a way…</p>
      </Card>
    )
  }
  const [best, ...others] = state.cards
  if (best !== undefined) {
    return (
      <Card title="Primary call">
        <CallCardBody card={best} livePrice={livePrice ?? null} />
        {others.length > 0 && (
          <p style={{ ...noteStyle, marginTop: '0.4rem' }}>
            {others.length === 1 ? 'One more card' : `${others.length} more cards`}: {others.map((card) => `${pairWords(card.pair)} ${cardLabel(card)}`).join(', ')} — on Predictions.
          </p>
        )}
      </Card>
    )
  }
  const size = sizeSpanText(predictions)
  const live = liveCheckText(state.delistLive)
  return (
    <Card title="Primary call">
      <p style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700 }}>No profitable opportunity identified</p>
      <p style={{ ...noteStyle, marginTop: '0.45rem' }}>{noCardText(state)}</p>
      {state.late.map((late) => (
        <p key={`${late.pair}:${late.eventAt}`} style={{ ...noteStyle, marginTop: '0.3rem' }}>
          {lateText(late)}
        </p>
      ))}
      {size !== null && <p style={{ ...noteStyle, marginTop: '0.45rem' }}>{size}</p>}
      <p style={{ ...noteStyle, marginTop: '0.45rem' }}>{sourcesText(state)}</p>
      {live !== null && <p style={{ ...noteStyle, marginTop: '0.3rem' }}>{live}</p>}
    </Card>
  )
}
