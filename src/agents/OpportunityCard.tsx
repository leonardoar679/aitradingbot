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
import { calibratedWinRate, describeExpectedValue, tradeExpectedValue, type WatchOutcome } from '../../shared/expectedValue'
import { describeDecider } from '../../shared/aiPanel'
import { opportunityProposalProblem } from '../../shared/aiProposal'
import type { Candle } from '../../shared/ipc'
import { EVENT_MAX_RANKED, describeBand, describeEventType, eventReasons } from '../../shared/marketEvent'
import { formatHoldingDuration } from '../backtest/formatTradeTime'
import { buttonStyle, noteStyle, reasonLabel, signedPct } from './agentStyles'
import { describeFeedItemStatus, feedItemStatus, scoreAnswer, type EventAnswer, type EventFeedItem, type FeedItemStatus } from './opportunities'
import { aiCostPct } from '../../shared/aiCostPerTrade'
import { useI18n, type I18n } from '../i18n'

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
  /** The watch's closed paper trades with their calls (shared/expectedValue.ts), for each answer's
   * expected value at a calibrated rate. */
  outcomes?: WatchOutcome[]
  /** What each model's answers cost a trade, in dollars (shared/aiCostPerTrade.ts), and the watch's
   * stake it is read against: part of the costs the expected value is net of. */
  aiCostByModel?: Readonly<Record<string, number>>
  stakeQuote?: number | null
}

/** "10-13 07:45" in English, as the records write it; the day and the time in a language's own form. */
function utcMinute(sec: number, i18n: I18n): string {
  if (i18n.language === 'en') return new Date(sec * 1000).toISOString().slice(5, 16).replace('T', ' ')
  return `${i18n.utcDay(sec * 1000)} ${i18n.utcTime(sec * 1000)}`
}

function plainNumber(value: number, { num }: I18n): string {
  return num(Number(value.toPrecision(7)), 0, 8)
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
function describeOutcome(outcome: OpportunityOutcome, expired: boolean, i18n: I18n): { text: string; color: string } {
  const { t } = i18n
  if (outcome.status === 'waiting') {
    // Past its expiry and still "waiting" means the candles that would settle it have not been read.
    return expired
      ? { text: t('What it did is not known yet: the candles up to its expiry have not been read.'), color: 'var(--text-muted)' }
      : { text: t('Waiting for the price to trade in its entry range.'), color: 'var(--text-secondary)' }
  }
  if (outcome.status === 'expired') return { text: t('Expired: the price never traded in its entry range while it was valid.'), color: 'var(--text-muted)' }
  const entered =
    outcome.entryPrice !== null && outcome.entryTime !== null ? t('In at {price}, {time} UTC', { price: plainNumber(outcome.entryPrice, i18n), time: i18n.utcTime(outcome.entryTime * 1000) }) : t('In')
  const range = t('best {best}, worst {worst}', { best: signedPct(outcome.bestPct, i18n).text, worst: signedPct(outcome.worstPct, i18n).text })
  if (outcome.status === 'open') return { text: t('{entered}. Still held: {range} so far.', { entered, range }), color: 'var(--text-primary)' }
  const net = signedPct(outcome.netPct, i18n)
  const how = outcome.exit !== null ? describeOpportunityExit(outcome.exit, i18n) : t('closed')
  return {
    text: t('{entered}. Closed after {minutes} min, {how}: {net} after fees and slippage ({range} on the way).', { entered, minutes: outcome.heldMinutes ?? 0, how, net: net.text, range }),
    color: net.color
  }
}

function AnswerRow({
  item,
  answer,
  bars,
  nowSec,
  onPaperTrade,
  confirm = false,
  outcomes = [],
  aiCostByModel = {},
  stakeQuote = null
}: {
  item: EventFeedItem
  answer: EventAnswer
  bars: Candle[] | undefined
  nowSec: number
  onPaperTrade?: (answer: EventAnswer) => void
  /** CONFIRM is on: a BUY's button fills in a real order a person places. */
  confirm?: boolean
  outcomes?: WatchOutcome[]
  aiCostByModel?: Readonly<Record<string, number>>
  stakeQuote?: number | null
}): React.JSX.Element {
  const i18n = useI18n()
  const { t, pctPlain, utcTime } = i18n
  const [open, setOpen] = useState(false)
  const { decision } = answer
  const side = opportunitySide(decision)
  const detail = decision.detail ?? null
  const validity = opportunityWindow(item.event.time, detail)
  const outcome = bars !== undefined ? scoreAnswer(item, answer, bars, nowSec) : null
  const usage = decision.usage ?? null
  const expired = validity !== null && nowSec >= validity.expiresAt
  // The same rule the form itself applies, asked here so the card can say why nothing is offered.
  const tradeProblem = side === null ? null : opportunityProposalProblem(item.event.time, decision, nowSec, null, i18n)
  // The call's expected value (shared/expectedValue.ts): its levels as distances from the middle of
  // its range, at the watch's calibrated win rate where it has one, else at the model's confidence.
  const mid = detail?.entry ? (detail.entry.min + detail.entry.max) / 2 : null
  const levelPct = (level: number | null): number | null => (mid === null || !(mid > 0) || level === null ? null : (Math.abs(level - mid) / mid) * 100)
  const ev =
    side === null || detail === null
      ? null
      : tradeExpectedValue({
          confidence: decision.confidence,
          calibrated: calibratedWinRate(outcomes, { model: answer.model, eventType: item.event.type, side: side === 'long' ? 'buy' : 'sell' }, nowSec),
          stopPct: levelPct(detail.stopLoss),
          targetPct: levelPct(detail.takeProfit),
          // The model's answers' cost a trade, as a share of the watch's stake (the V5 document, §73).
          aiCostPct: stakeQuote === null ? null : aiCostPct(aiCostByModel[answer.model] ?? null, stakeQuote)
        })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem', padding: '0.75rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-app)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.7rem', flexWrap: 'wrap' }}>
        <span dir="ltr" style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>
          {describeDecider(answer.model, i18n)}
        </span>
        <span style={{ fontSize: '0.85rem', fontWeight: 700, color: decision.rejected ? 'var(--down)' : sideColor(side) }}>{decision.rejected ? t('REFUSED') : describeOpportunitySide(side, i18n)}</span>
        {!decision.rejected && <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{t('{confidence} confidence', { confidence: pctPlain(Math.round(decision.confidence * 100), 0) })}</span>}
        {side !== null && !isActionableOpportunity(decision) && <span style={{ fontSize: '0.72rem', color: 'var(--gold)' }}>{t('below the 65% this app acts on')}</span>}
        <span style={{ marginInlineStart: 'auto', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          {usage ? t('{seconds}s', { seconds: i18n.num(usage.latencyMs / 1000, 1, 1) }) : ''}
          {usage && usage.costUsd !== null ? ` · ${formatUsd(usage.costUsd, i18n)}` : ''}
        </span>
      </div>

      {decision.rejected && (
        <p style={{ ...noteStyle, color: 'var(--down)' }}>
          {t('The model answered, and was billed, but the answer was refused and counts as no trade: {reason}', { reason: decision.rejected })}
        </p>
      )}

      {side !== null && detail?.entry && validity !== null && (
        <div style={{ display: 'flex', gap: '1.2rem', flexWrap: 'wrap' }}>
          <Field label={t('Entry')} value={t('{low} – {high}', { low: plainNumber(detail.entry.min, i18n), high: plainNumber(detail.entry.max, i18n) })} />
          <Field label={t('Stop')} value={detail.stopLoss === null ? '—' : plainNumber(detail.stopLoss, i18n)} />
          <Field label={t('Target')} value={detail.takeProfit === null ? '—' : plainNumber(detail.takeProfit, i18n)} />
          <Field
            label={expired ? t('Entry expired') : t('Entry valid until')}
            value={
              expired
                ? t('{time} UTC', { time: utcTime(validity.expiresAt * 1000) })
                : t('{time} UTC ({minutes} min)', { time: utcTime(validity.expiresAt * 1000), minutes: Math.max(1, Math.ceil((validity.expiresAt - nowSec) / 60)) })
            }
          />
          <Field label={t('Hold')} value={formatHoldingDuration(validity.holdSeconds, i18n)} />
        </div>
      )}
      {ev !== null && <p style={noteStyle}>{describeExpectedValue(ev, item.event.type, i18n)}</p>}

      {outcome !== null && <p style={{ ...noteStyle, color: describeOutcome(outcome, expired, i18n).color }}>{describeOutcome(outcome, expired, i18n).text}</p>}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
        {!decision.rejected && (
          <button onClick={() => setOpen((shown) => !shown)} style={buttonStyle('secondary')} aria-expanded={open}>
            {open ? t('Hide analysis') : t('View analysis')}
          </button>
        )}
        {side !== null && onPaperTrade && tradeProblem === null && (
          <button onClick={() => onPaperTrade(answer)} style={buttonStyle('primary')}>
            {confirm === true && side === 'long' ? t('Confirm') : t('Paper trade')}
          </button>
        )}
        {side !== null && tradeProblem !== null && <span style={{ ...noteStyle, flex: '1 1 240px' }}>{tradeProblem}</span>}
      </div>

      {open && !decision.rejected && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}>
          {decision.rationale && (
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              <em>{t('AI summary, in its own words:')}</em>{' '}
              <span lang="en" dir="auto">
                {decision.rationale}
              </span>
            </p>
          )}
          {detail && (
            <div style={{ display: 'flex', gap: '1.2rem', flexWrap: 'wrap' }}>
              <Field label={t('Regime')} value={reasonLabel(detail.marketRegime, i18n)} />
              <Field label={t('Risk')} value={reasonLabel(detail.riskLevel, i18n)} />
              {detail.reasonCodes.length > 0 && <Field label={t('Reasons')} value={detail.reasonCodes.map((code) => reasonLabel(code, i18n)).join(t(', '))} />}
            </div>
          )}
          {detail?.levelsNote && (
            <p lang="en" style={{ ...noteStyle, color: 'var(--gold)' }}>
              {detail.levelsNote}
            </p>
          )}
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

function compactUsd(value: number, i18n: I18n): string {
  if (i18n.language !== 'en') return new Intl.NumberFormat(`${i18n.language}-u-nu-latn`, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', notation: 'compact', maximumFractionDigits: 1 }).format(value)
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`
  return `$${Math.round(value).toLocaleString('en-US')}`
}

/** Why the scanner singled this pair out: the five components of its score, each beside the
 * reading it was made from, and what the scanner knew of the pair's market when it raised it. */
function WhyThisPair({ item }: { item: EventFeedItem }): React.JSX.Element {
  const i18n = useI18n()
  const { t } = i18n
  const { event } = item
  const live = event.live
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}>
      {eventReasons(event, i18n).map((reason) => (
        <div key={reason.component} style={{ display: 'flex', alignItems: 'baseline', gap: '0.7rem', fontSize: '0.78rem' }}>
          <span style={{ width: 62, color: 'var(--text-secondary)', fontWeight: 600 }}>{reason.label}</span>
          <span style={{ width: 30, textAlign: 'end', color: 'var(--text-primary)', fontWeight: 700 }}>{reason.score.toFixed(0)}</span>
          <span style={{ flex: 1, color: 'var(--text-secondary)' }}>{reason.fact}</span>
        </div>
      ))}
      <p style={noteStyle}>
        {t('The score, {score}, is the plain mean of the five. Each is a fixed formula on twelve hours of 1-minute candles, measured against the hours before the move began.', { score: Math.round(event.score) })}{' '}
        {live !== null &&
          (live.quoteVolume24h === null
            ? live.spreadPct === null
              ? t('Among the events of its minute it ranked {rank}, on a candidate score of {score}: six parts the event, two and a half how much the pair trades, one and a half how tight its spread is.', { rank: live.rank, score: Math.round(live.candidateScore) })
              : t('Among the events of its minute it ranked {rank}, on a candidate score of {score}: six parts the event, two and a half how much the pair trades, one and a half how tight its spread is ({spread}).', {
                  rank: live.rank,
                  score: Math.round(live.candidateScore),
                  spread: i18n.pctPlain(live.spreadPct, 3)
                })
            : live.spreadPct === null
              ? t('Among the events of its minute it ranked {rank}, on a candidate score of {score}: six parts the event, two and a half how much the pair trades ({volume} a day), one and a half how tight its spread is.', {
                  rank: live.rank,
                  score: Math.round(live.candidateScore),
                  volume: compactUsd(live.quoteVolume24h, i18n)
                })
              : t('Among the events of its minute it ranked {rank}, on a candidate score of {score}: six parts the event, two and a half how much the pair trades ({volume} a day), one and a half how tight its spread is ({spread}).', {
                  rank: live.rank,
                  score: Math.round(live.candidateScore),
                  volume: compactUsd(live.quoteVolume24h, i18n),
                  spread: i18n.pctPlain(live.spreadPct, 3)
                }))}
        {live === null && t('It was found by scanning history, so it has no rank: a rank is a fact about the minute it was raised in.')}
      </p>
    </div>
  )
}

/** One event the scanner raised, and what each model asked about it recommended.
 *
 * A recommendation is shown with its clock: where to enter, until when, and what it has done
 * since. Nothing on the card trades. "Paper trade" opens the order form on another page, filled
 * in; a person sets the amount and submits it there. */
export function OpportunityCard({ item, bars, nowSec, toAsk, busy, problem, onAsk, onPaperTrade, confirm = false, outcomes = [], aiCostByModel = {}, stakeQuote = null }: OpportunityCardProps): React.JSX.Element {
  const i18n = useI18n()
  const { t } = i18n
  const { event, answers } = item
  const [why, setWhy] = useState(false)
  const status = feedItemStatus(item, bars, nowSec)
  const consensus = opportunityConsensus(answers.map((answer) => answer.decision))
  const move = signedPct(event.returnsPct.m15, i18n)
  const directionColor = event.direction === 'up' ? 'var(--up)' : event.direction === 'down' ? 'var(--down)' : 'var(--text-secondary)'
  const counts = [
    consensus.long > 0 ? t('{count} BUY', { count: consensus.long }) : null,
    consensus.short > 0 ? t('{count} SELL', { count: consensus.short }) : null,
    consensus.noTrade > 0 ? t('{count} NO TRADE', { count: consensus.noTrade }) : null,
    consensus.refused > 0 ? t('{count} refused', { count: consensus.refused }) : null
  ].filter((part): part is string => part !== null)

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem', padding: '1rem', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.8rem', flexWrap: 'wrap' }}>
        <span dir="ltr" style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
          {event.symbol}
        </span>
        <span style={{ fontSize: '0.85rem', fontWeight: 700, color: directionColor }}>{describeEventType(event.type, i18n)}</span>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{t('{band} · score {score}', { band: describeBand(event.band, i18n), score: Math.round(event.score) })}</span>
        {status !== null && (
          <span
            title={t('Where this event stands: not asked, no trade, an entry still on offer, in a trade, expired, or closed.')}
            style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: STATUS_COLOR[status], border: `1px solid ${STATUS_COLOR[status]}`, borderRadius: 999, padding: '0.1rem 0.5rem' }}
          >
            {describeFeedItemStatus(status, i18n)}
          </span>
        )}
        <span style={{ marginInlineStart: 'auto', fontSize: '0.76rem', color: 'var(--text-muted)' }}>{t('{time} UTC', { time: utcMinute(event.time, i18n) })}</span>
      </div>

      <div style={{ display: 'flex', gap: '1.2rem', flexWrap: 'wrap' }}>
        <Field label={t('Price at the event')} value={plainNumber(event.price, i18n)} />
        <div style={{ minWidth: 84 }}>
          <div style={{ fontSize: '0.62rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{t('15m move')}</div>
          <div style={{ marginTop: '0.15rem', fontSize: '0.8rem', fontWeight: 600, color: move.color }}>{move.text}</div>
        </div>
        <Field label={t('Volume')} value={event.volumeRatio === null ? '—' : t('{ratio}× usual', { ratio: i18n.num(event.volumeRatio, 1, 1) })} />
        {event.live !== null && <Field label={t('Spread')} value={event.live.spreadPct === null ? '—' : i18n.pctPlain(event.live.spreadPct, 3)} />}
        {event.live !== null && event.live.rank > EVENT_MAX_RANKED && <Field label={t('Rank in its minute')} value={`#${event.live.rank}`} />}
      </div>

      {answers.length > 0 && (
        <p style={{ ...noteStyle, color: 'var(--text-primary)' }}>
          {counts.join(' · ')}
          {consensus.disagreement && <span style={{ color: 'var(--gold)', fontWeight: 600 }}> · {t('the models take opposite sides')}</span>}
          {consensus.agreementPct !== null && !consensus.disagreement && (
            <span style={{ color: 'var(--text-muted)' }}> · {t('{share} make the same call', { share: i18n.pctPlain(Math.round(consensus.agreementPct), 0) })}</span>
          )}
        </p>
      )}

      {answers.map((answer) => (
        <AnswerRow key={answer.model} item={item} answer={answer} bars={bars} nowSec={nowSec} onPaperTrade={onPaperTrade} confirm={confirm} outcomes={outcomes} aiCostByModel={aiCostByModel} stakeQuote={stakeQuote} />
      ))}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', flexWrap: 'wrap' }}>
        <button onClick={onAsk} disabled={busy || toAsk.length === 0} style={buttonStyle(answers.length === 0 ? 'primary' : 'secondary', busy || toAsk.length === 0)}>
          {busy
            ? t('Asking…')
            : toAsk.length === 0
              ? answers.length === 0
                ? t('Tick a model above to ask')
                : t('Every ticked model has answered')
              : toAsk.length === 1
                ? t('Ask {model}', { model: describeDecider(toAsk[0], i18n) })
                : t('Ask {count} models', { count: toAsk.length })}
        </button>
        <button onClick={() => setWhy((shown) => !shown)} style={buttonStyle('secondary')} aria-expanded={why}>
          {why ? t('Hide why this pair') : t('Why this pair')}
        </button>
        {toAsk.length > 0 && !busy && <span style={noteStyle}>{t('The price is stated before anything is asked.')}</span>}
      </div>
      {why && <WhyThisPair item={item} />}
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p>}
    </section>
  )
}
