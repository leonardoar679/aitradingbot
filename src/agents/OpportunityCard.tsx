import { useState } from 'react'
import { formatUsd } from '../../shared/aiCost'
import {
  describeOpportunitySide,
  isActionableOpportunity,
  opportunityConsensus,
  opportunitySide,
  opportunityWindow
} from '../../shared/aiOpportunity'
import { describeOpportunityExit, type OpportunityOutcome } from '../../shared/aiOpportunityOutcome'
import { describeDecider } from '../../shared/aiPanel'
import { opportunityProposalProblem } from '../../shared/aiProposal'
import type { Candle } from '../../shared/ipc'
import { EVENT_MAX_RANKED, describeEventType, eventReasons } from '../../shared/marketEvent'
import { formatHoldingDuration } from '../backtest/formatTradeTime'
import { buttonStyle, noteStyle, reasonLabel, signedPct } from './agentStyles'
import { describeFeedItemStatus, feedItemStatus, scoreAnswer, type EventAnswer, type EventFeedItem, type FeedItemStatus } from './opportunities'

interface OpportunityCardProps {
  item: EventFeedItem
  /** Minute candles since the event, for what each recommendation has done. Absent until fetched. */
  bars: Candle[] | undefined
  /** Unix seconds, passed in so every card on the page expires at the same moment. */
  nowSec: number
  /** The ticked models that have not answered this event yet. */
  toAsk: string[]
  /** True while this event's question is being priced or asked. */
  busy: boolean
  /** What went wrong the last time something was tried on this card, if anything. */
  problem: string | null
  onAsk: () => void
  /** Opens the order form for one answer. Absent where no form is on offer at all. */
  onPaperTrade?: (answer: EventAnswer) => void
  /** CONFIRM is on: a BUY's button fills in a real order a person places. */
  confirm?: boolean
}

function utcMinute(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(5, 16).replace('T', ' ')
}

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 16)
}

function plainNumber(value: number): string {
  return Number(value.toPrecision(7)).toLocaleString('en-US', { maximumFractionDigits: 8 })
}

function sideColor(side: 'long' | 'short' | null): string {
  if (side === 'long') return 'var(--up)'
  if (side === 'short') return 'var(--down)'
  return 'var(--text-secondary)'
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div style={{ minWidth: 84 }}>
      <div style={{ fontSize: '0.62rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ marginTop: '0.15rem', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>{value}</div>
    </div>
  )
}

/** What a recommendation has done so far, in a sentence. */
function describeOutcome(outcome: OpportunityOutcome, expired: boolean): { text: string; color: string } {
  if (outcome.status === 'waiting') {
    // Past its expiry and still "waiting" means the candles that would settle it have not been read.
    return expired
      ? { text: 'What it did is not known yet: the candles up to its expiry have not been read.', color: 'var(--text-muted)' }
      : { text: 'Waiting for the price to trade in its entry range.', color: 'var(--text-secondary)' }
  }
  if (outcome.status === 'expired') return { text: 'Expired: the price never traded in its entry range while it was valid.', color: 'var(--text-muted)' }
  const entered = outcome.entryPrice !== null && outcome.entryTime !== null ? `In at ${plainNumber(outcome.entryPrice)}, ${utcClock(outcome.entryTime)} UTC` : 'In'
  const range = `best ${signedPct(outcome.bestPct).text}, worst ${signedPct(outcome.worstPct).text}`
  if (outcome.status === 'open') return { text: `${entered}. Still held: ${range} so far.`, color: 'var(--text-primary)' }
  const net = signedPct(outcome.netPct)
  const how = outcome.exit !== null ? describeOpportunityExit(outcome.exit) : 'closed'
  return {
    text: `${entered}. Closed after ${outcome.heldMinutes} min, ${how}: ${net.text} after fees and slippage (${range} on the way).`,
    color: net.color
  }
}

function AnswerRow({
  item,
  answer,
  bars,
  nowSec,
  onPaperTrade,
  confirm = false
}: {
  item: EventFeedItem
  answer: EventAnswer
  bars: Candle[] | undefined
  nowSec: number
  onPaperTrade?: (answer: EventAnswer) => void
  /** CONFIRM is on: a BUY's button fills in a real order a person places. */
  confirm?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { decision } = answer
  const side = opportunitySide(decision)
  const detail = decision.detail ?? null
  const validity = opportunityWindow(item.event.time, detail)
  const outcome = bars !== undefined ? scoreAnswer(item, answer, bars, nowSec) : null
  const usage = decision.usage ?? null
  const expired = validity !== null && nowSec >= validity.expiresAt
  // The same rule the form itself applies, asked here so the card can say why nothing is offered.
  const tradeProblem = side === null ? null : opportunityProposalProblem(item.event.time, decision, nowSec)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem', padding: '0.75rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-app)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.7rem', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>{describeDecider(answer.model)}</span>
        <span style={{ fontSize: '0.85rem', fontWeight: 700, color: decision.rejected ? 'var(--down)' : sideColor(side) }}>
          {decision.rejected ? 'REFUSED' : describeOpportunitySide(side)}
        </span>
        {!decision.rejected && <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{Math.round(decision.confidence * 100)}% confidence</span>}
        {side !== null && !isActionableOpportunity(decision) && (
          <span style={{ fontSize: '0.72rem', color: 'var(--gold)' }}>below the 65% this app acts on</span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          {usage ? `${(usage.latencyMs / 1000).toFixed(1)}s` : ''}
          {usage && usage.costUsd !== null ? ` · ${formatUsd(usage.costUsd)}` : ''}
        </span>
      </div>

      {decision.rejected && (
        <p style={{ ...noteStyle, color: 'var(--down)' }}>
          The model answered, and was billed, but the answer was refused and counts as no trade: {decision.rejected}
        </p>
      )}

      {side !== null && detail?.entry && validity !== null && (
        <div style={{ display: 'flex', gap: '1.2rem', flexWrap: 'wrap' }}>
          <Field label="Entry" value={`${plainNumber(detail.entry.min)} – ${plainNumber(detail.entry.max)}`} />
          <Field label="Stop" value={detail.stopLoss === null ? '—' : plainNumber(detail.stopLoss)} />
          <Field label="Target" value={detail.takeProfit === null ? '—' : plainNumber(detail.takeProfit)} />
          <Field
            label={expired ? 'Entry expired' : 'Entry valid until'}
            value={expired ? `${utcClock(validity.expiresAt)} UTC` : `${utcClock(validity.expiresAt)} UTC (${Math.max(1, Math.ceil((validity.expiresAt - nowSec) / 60))} min)`}
          />
          <Field label="Hold" value={formatHoldingDuration(validity.holdSeconds)} />
        </div>
      )}

      {outcome !== null && <p style={{ ...noteStyle, color: describeOutcome(outcome, expired).color }}>{describeOutcome(outcome, expired).text}</p>}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
        {!decision.rejected && (
          <button onClick={() => setOpen((shown) => !shown)} style={buttonStyle('secondary')} aria-expanded={open}>
            {open ? 'Hide analysis' : 'View analysis'}
          </button>
        )}
        {side !== null && onPaperTrade && tradeProblem === null && (
          <button onClick={() => onPaperTrade(answer)} style={buttonStyle('primary')}>
            {confirm === true && side === 'long' ? 'Confirm' : 'Paper trade'}
          </button>
        )}
        {side !== null && tradeProblem !== null && <span style={{ ...noteStyle, flex: '1 1 240px' }}>{tradeProblem}</span>}
      </div>

      {open && !decision.rejected && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}>
          {decision.rationale && <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>{decision.rationale}</p>}
          {detail && (
            <div style={{ display: 'flex', gap: '1.2rem', flexWrap: 'wrap' }}>
              <Field label="Regime" value={reasonLabel(detail.marketRegime)} />
              <Field label="Risk" value={detail.riskLevel} />
              {detail.reasonCodes.length > 0 && <Field label="Reasons" value={detail.reasonCodes.map(reasonLabel).join(', ')} />}
            </div>
          )}
          {detail?.levelsNote && <p style={{ ...noteStyle, color: 'var(--gold)' }}>{detail.levelsNote}</p>}
        </div>
      )}
    </div>
  )
}

const STATUS_COLOR: Record<FeedItemStatus, string> = {
  waiting: 'var(--text-muted)',
  asked: 'var(--text-secondary)',
  valid: 'var(--up)',
  open: 'var(--accent)',
  expired: 'var(--text-muted)',
  closed: 'var(--text-secondary)'
}

function compactUsd(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`
  return `$${Math.round(value).toLocaleString('en-US')}`
}

/** Why the scanner singled this pair out: the five components of its score, each beside the
 * reading it was made from, and what the scanner knew of the pair's market when it raised it. */
function WhyThisPair({ item }: { item: EventFeedItem }): React.JSX.Element {
  const { event } = item
  const live = event.live
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}>
      {eventReasons(event).map((reason) => (
        <div key={reason.component} style={{ display: 'flex', alignItems: 'baseline', gap: '0.7rem', fontSize: '0.78rem' }}>
          <span style={{ width: 62, color: 'var(--text-secondary)', fontWeight: 600 }}>{reason.label}</span>
          <span style={{ width: 30, textAlign: 'right', color: 'var(--text-primary)', fontWeight: 700 }}>{reason.score.toFixed(0)}</span>
          <span style={{ flex: 1, color: 'var(--text-secondary)' }}>{reason.fact}</span>
        </div>
      ))}
      <p style={noteStyle}>
        The score, {event.score.toFixed(0)}, is the plain mean of the five. Each is a fixed formula on twelve hours of 1-minute candles, measured against the hours before the move began.
        {live !== null &&
          ` Among the events of its minute it ranked ${live.rank}, on a candidate score of ${live.candidateScore.toFixed(0)}: six parts the event, two and a half how much the pair trades${
            live.quoteVolume24h === null ? '' : ` (${compactUsd(live.quoteVolume24h)} a day)`
          }, one and a half how tight its spread is${live.spreadPct === null ? '' : ` (${live.spreadPct.toFixed(3)}%)`}.`}
        {live === null && ' It was found by scanning history, so it has no rank: a rank is a fact about the minute it was raised in.'}
      </p>
    </div>
  )
}

/** One event the scanner raised, and what each model asked about it recommended.
 *
 * A recommendation is shown with its clock: where to enter, until when, and what it has done
 * since. Nothing on the card trades. "Paper trade" opens the order form on another page, filled
 * in; a person sets the amount and submits it there. */
export function OpportunityCard({ item, bars, nowSec, toAsk, busy, problem, onAsk, onPaperTrade, confirm = false }: OpportunityCardProps): React.JSX.Element {
  const { event, answers } = item
  const [why, setWhy] = useState(false)
  const status = feedItemStatus(item, bars, nowSec)
  const consensus = opportunityConsensus(answers.map((answer) => answer.decision))
  const move = signedPct(event.returnsPct.m15)
  const directionColor = event.direction === 'up' ? 'var(--up)' : event.direction === 'down' ? 'var(--down)' : 'var(--text-secondary)'
  const counts = [
    consensus.long > 0 ? `${consensus.long} BUY` : null,
    consensus.short > 0 ? `${consensus.short} SELL` : null,
    consensus.noTrade > 0 ? `${consensus.noTrade} NO TRADE` : null,
    consensus.refused > 0 ? `${consensus.refused} refused` : null
  ].filter((part): part is string => part !== null)

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem', padding: '1rem', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.8rem', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>{event.symbol}</span>
        <span style={{ fontSize: '0.85rem', fontWeight: 700, color: directionColor }}>{describeEventType(event.type)}</span>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          {event.band} · score {event.score.toFixed(0)}
        </span>
        {status !== null && (
          <span
            title="Where this event stands: not asked, no trade, an entry still on offer, in a trade, expired, or closed."
            style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: STATUS_COLOR[status], border: `1px solid ${STATUS_COLOR[status]}`, borderRadius: 999, padding: '0.1rem 0.5rem' }}
          >
            {describeFeedItemStatus(status)}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: '0.76rem', color: 'var(--text-muted)' }}>{utcMinute(event.time)} UTC</span>
      </div>

      <div style={{ display: 'flex', gap: '1.2rem', flexWrap: 'wrap' }}>
        <Field label="Price at the event" value={plainNumber(event.price)} />
        <div style={{ minWidth: 84 }}>
          <div style={{ fontSize: '0.62rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>15m move</div>
          <div style={{ marginTop: '0.15rem', fontSize: '0.8rem', fontWeight: 600, color: move.color }}>{move.text}</div>
        </div>
        <Field label="Volume" value={event.volumeRatio === null ? '—' : `${event.volumeRatio.toFixed(1)}× usual`} />
        {event.live !== null && <Field label="Spread" value={event.live.spreadPct === null ? '—' : `${event.live.spreadPct.toFixed(3)}%`} />}
        {event.live !== null && event.live.rank > EVENT_MAX_RANKED && <Field label="Rank in its minute" value={`#${event.live.rank}`} />}
      </div>

      {answers.length > 0 && (
        <p style={{ ...noteStyle, color: 'var(--text-primary)' }}>
          {counts.join(' · ')}
          {consensus.disagreement && <span style={{ color: 'var(--gold)', fontWeight: 600 }}> · the models take opposite sides</span>}
          {consensus.agreementPct !== null && !consensus.disagreement && (
            <span style={{ color: 'var(--text-muted)' }}> · {consensus.agreementPct.toFixed(0)}% make the same call</span>
          )}
        </p>
      )}

      {answers.map((answer) => (
        <AnswerRow key={answer.model} item={item} answer={answer} bars={bars} nowSec={nowSec} onPaperTrade={onPaperTrade} confirm={confirm} />
      ))}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', flexWrap: 'wrap' }}>
        <button onClick={onAsk} disabled={busy || toAsk.length === 0} style={buttonStyle(answers.length === 0 ? 'primary' : 'secondary', busy || toAsk.length === 0)}>
          {busy ? 'Asking…' : toAsk.length === 0 ? (answers.length === 0 ? 'Tick a model above to ask' : 'Every ticked model has answered') : `Ask ${toAsk.length === 1 ? describeDecider(toAsk[0]) : `${toAsk.length} models`}`}
        </button>
        <button onClick={() => setWhy((shown) => !shown)} style={buttonStyle('secondary')} aria-expanded={why}>
          {why ? 'Hide why this pair' : 'Why this pair'}
        </button>
        {toAsk.length > 0 && !busy && <span style={noteStyle}>The price is stated before anything is asked.</span>}
      </div>
      {why && <WhyThisPair item={item} />}
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p>}
    </section>
  )
}
