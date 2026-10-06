import { useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { TextLink } from '../components/TextLink'
import { describeOpportunitySide, opportunitySide } from '../../shared/aiOpportunity'
import { describeDecider } from '../../shared/aiPanel'
import type { AiOrderProposal } from '../../shared/aiProposal'
import { describeEventType } from '../../shared/marketEvent'
import { useNowSec } from '../utils/useNowSec'
import { buttonStyle, noteStyle } from '../agents/agentStyles'
import { overviewOpportunity, proposalForAnswer, type EventAnswer, type EventFeedItem } from '../agents/opportunities'
import { liveReadingOf } from '../agents/liveVerdict'
import { LiveVerdictView } from '../agents/LiveVerdictView'
import { opportunityTableRows } from '../agents/opportunityTable'
import { useEventFeed } from '../agents/useEventFeed'
import { useLiveMarket } from '../hooks/useLiveMarket'
import { useMarketResearch } from '../hooks/useMarketResearch'
import { useNewsFeed } from '../news/useNewsFeed'
import type { Page } from '../navigation/pages'

/** Events read for this card: the newest, as many as Opportunities shows at first. */
const EVENTS_READ = 20

function plainNumber(value: number): string {
  return Number(value.toPrecision(7)).toLocaleString('en-US', { maximumFractionDigits: 8 })
}

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 16)
}

function describeEvent(item: EventFeedItem): string {
  const { event } = item
  return `${event.symbol}: ${describeEventType(event.type).toLowerCase()} at ${utcClock(event.time)} UTC, score ${event.score.toFixed(0)} (${event.band})`
}

/** What the models asked about an event said, model by model. */
function Answers({ answers }: { answers: EventAnswer[] }): React.JSX.Element {
  if (answers.length === 0) return <p style={{ ...noteStyle, marginTop: '0.5rem' }}>No model has answered about it.</p>
  return (
    <p style={{ ...noteStyle, marginTop: '0.5rem', color: 'var(--text-secondary)' }}>
      What the models said:{' '}
      {answers.map((answer, index) => {
        const side = opportunitySide(answer.decision)
        const refused = Boolean(answer.decision.rejected)
        return (
          <span key={answer.model}>
            {index > 0 && ' · '}
            {describeDecider(answer.model)}{' '}
            <strong style={{ color: refused ? 'var(--down)' : side === 'long' ? 'var(--up)' : side === 'short' ? 'var(--down)' : 'var(--text-secondary)' }}>
              {refused ? 'REFUSED' : side === null ? 'NO TRADE' : describeOpportunitySide(side)}
            </strong>
            {!refused && ` ${Math.round(answer.decision.confidence * 100)}%`}
          </span>
        )
      })}
      .
    </p>
  )
}

/** What can be acted on right now, and what the models make of it: the recommendation still on
 * offer with the strongest signal (shared/opportunityScore.ts), the one the Opportunities table
 * leads with -- or, as is usual, that there is none, the strongest event of the last hour and what
 * it lacks.
 *
 * NOTHING HERE TRADES. "Paper trade" hands a filled-in order form up to the app, which opens it on
 * Strategies › Execution; a person sets the amount and submits it there. */
export function TopOpportunityCard({
  onPrepareOrder,
  onNavigate
}: {
  onPrepareOrder: (proposal: AiOrderProposal) => void
  onNavigate: (page: Page) => void
}): React.JSX.Element {
  const { events, scannerOn, feed, bars, problem: feedProblem } = useEventFeed(EVENTS_READ)
  const nowSec = useNowSec(true, 15_000)
  const [problem, setProblem] = useState<string | null>(null)
  const { state: research } = useMarketResearch()
  const news = useNewsFeed()
  const pick = useMemo(() => overviewOpportunity(feed, bars, nowSec), [feed, bars, nowSec])
  // The entries on offer by their signal, as the table ranks them; the signal reads no live price.
  const top = useMemo(
    () =>
      opportunityTableRows({ feed, bars, live: null, pairs: research?.pairs ?? [], regime: research?.market?.regime ?? null, news, nowSec, nowMs: nowSec * 1000 }).onOffer[0] ?? null,
    [feed, bars, research, news, nowSec]
  )
  const answerOf = top?.item.answers.find((entry) => entry.model === top.offer?.model) ?? null
  // The live price of the pair on offer, to say whether it can be entered now.
  const live = useLiveMarket(top !== null ? [top.item.event.symbol] : [])

  async function paperTrade(item: EventFeedItem, answer: EventAnswer): Promise<void> {
    setProblem(null)
    const result = await proposalForAnswer(item, answer, async () => (await window.api.market.fetchTicker24h(item.event.exchange, item.event.symbol)).lastPrice)
    if ('problem' in result) {
      setProblem(result.problem)
      return
    }
    onPrepareOrder(result.proposal)
  }

  const open = (
    <TextLink onClick={() => onNavigate('opportunities')}>Open Opportunities</TextLink>
  )

  if (feedProblem !== null || events === null) {
    return (
      <Card title="What can be acted on">
        <p style={noteStyle}>{feedProblem ?? 'Loading…'}</p>
      </Card>
    )
  }

  if (top !== null && top.offer !== null && answerOf !== null) {
    const row = top.offer
    const answer = answerOf
    const detail = answer.decision.detail
    const left = Math.max(0, row.expiresAt - nowSec)
    return (
      <Card title="What can be acted on">
        <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>{describeEvent(row.item)}</div>
        <div style={{ marginTop: '0.45rem', fontSize: '0.88rem', color: 'var(--text-primary)' }}>
          <strong style={{ color: row.side === 'long' ? 'var(--up)' : 'var(--down)' }}>{describeOpportunitySide(row.side)}</strong> between{' '}
          {plainNumber(row.entryMin)} and {plainNumber(row.entryMax)}, until {utcClock(row.expiresAt)} UTC ({left < 60 ? `${left}s` : `${Math.ceil(left / 60)} min`} left)
          {detail !== undefined && detail !== null && detail.stopLoss !== null && detail.takeProfit !== null && (
            <span style={{ color: 'var(--text-secondary)' }}>
              {' '}
              · stop {plainNumber(detail.stopLoss)} · target {plainNumber(detail.takeProfit)}
            </span>
          )}
        </div>
        <div style={{ marginTop: '0.35rem' }}>
          <span style={{ fontSize: '0.84rem', color: 'var(--text-secondary)' }}>Signal </span>
          <strong style={{ fontSize: '0.84rem', color: 'var(--text-primary)' }}>{top.signal.score}/100</strong>
          <span style={{ fontSize: '0.84rem', color: 'var(--text-secondary)' }}> · Now: </span>
          <LiveVerdictView reading={liveReadingOf(row, live, { nowMs: Date.now() })} />
        </div>
        <p style={{ ...noteStyle, marginTop: '0.4rem' }}>
          The surest call to act on: {describeDecider(row.model)} at {Math.round(answer.decision.confidence * 100)}%. A model&apos;s confidence is not a
          probability of profit, and taking every event has lost money (research/EVENTS.md).
        </p>
        <Answers answers={row.item.answers} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem', marginTop: '0.8rem', flexWrap: 'wrap' }}>
          <button onClick={() => void paperTrade(row.item, answer)} style={buttonStyle('primary')}>
            Paper trade
          </button>
          {open}
        </div>
        {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.5rem' }}>{problem}</p>}
      </Card>
    )
  }

  // Nothing on offer, so the pick is the strongest event of the last hour, where there is one.
  const candidate = pick.kind === 'none' ? pick.candidate : null
  return (
    <Card title="What can be acted on">
      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>No high-quality opportunity right now. Wait.</div>
      {candidate !== null ? (
        <>
          <p style={{ ...noteStyle, marginTop: '0.45rem', color: 'var(--text-secondary)' }}>
            The strongest event of the last hour: {describeEvent(candidate.item)}. {candidate.lacks}
          </p>
          <Answers answers={candidate.item.answers} />
        </>
      ) : (
        <p style={{ ...noteStyle, marginTop: '0.45rem' }}>
          {scannerOn === false ? 'The scanner is off, so no event is being raised.' : 'The scanner has raised no event in the last hour.'}
        </p>
      )}
      <div style={{ marginTop: '0.7rem', fontSize: '0.82rem' }}>{open}</div>
    </Card>
  )
}
