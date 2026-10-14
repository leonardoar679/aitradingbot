import { useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { TextLink } from '../components/TextLink'
import { describeOpportunitySide, opportunitySide } from '../../shared/aiOpportunity'
import { describeDecider } from '../../shared/aiPanel'
import type { AiOrderProposal } from '../../shared/aiProposal'
import { describeBand, eventTypeWord } from '../../shared/marketEvent'
import { useI18n, type I18n } from '../i18n'
import { useNowSec } from '../utils/useNowSec'
import { buttonStyle, noteStyle } from '../agents/agentStyles'
import { describeWhatItLacks, overviewOpportunity, proposalForAnswer, type EventAnswer, type EventFeedItem } from '../agents/opportunities'
import { liveReadingOf } from '../agents/liveVerdict'
import { LiveVerdictView } from '../agents/LiveVerdictView'
import { opportunityTableRows } from '../agents/opportunityTable'
import { useEventFeed } from '../agents/useEventFeed'
import { useLiveMarket } from '../hooks/useLiveMarket'
import { useMarketResearch } from '../hooks/useMarketResearch'
import { useNewsFeed } from '../news/useNewsFeed'
import { useNewsReadings } from '../news/useNewsReadings'
import type { Page } from '../navigation/pages'

/** Events read for this card: the newest, as many as Opportunities shows at first. */
const EVENTS_READ = 20

/** A price as the card writes one: seven significant figures. */
function plainNumber(value: number, { num }: I18n): string {
  return num(Number(value.toPrecision(7)), 0, 8)
}

function describeEvent(item: EventFeedItem, i18n: I18n): string {
  const { event } = item
  return i18n.t('{pair}: {kind} at {time} UTC, score {score} ({band})', {
    pair: event.symbol,
    kind: eventTypeWord(event.type, i18n),
    time: i18n.utcTime(event.time * 1000),
    score: Math.round(event.score),
    band: describeBand(event.band, i18n)
  })
}

/** What the models asked about an event said, model by model. */
function Answers({ answers }: { answers: EventAnswer[] }): React.JSX.Element {
  const i18n = useI18n()
  const { t, pctPlain } = i18n
  if (answers.length === 0) return <p style={{ ...noteStyle, marginTop: '0.5rem' }}>{t('No model has answered about it.')}</p>
  return (
    <p style={{ ...noteStyle, marginTop: '0.5rem', color: 'var(--text-secondary)' }}>
      {t('What the models said:')}{' '}
      {answers.map((answer, index) => {
        const side = opportunitySide(answer.decision)
        const refused = Boolean(answer.decision.rejected)
        return (
          <span key={answer.model}>
            {index > 0 && ' · '}
            <span dir="ltr">{describeDecider(answer.model, i18n)}</span>{' '}
            <strong style={{ color: refused ? 'var(--down)' : side === 'long' ? 'var(--up)' : side === 'short' ? 'var(--down)' : 'var(--text-secondary)' }}>
              {refused ? t('REFUSED') : describeOpportunitySide(side, i18n)}
            </strong>
            {!refused && ` ${pctPlain(Math.round(answer.decision.confidence * 100), 0)}`}
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
  const i18n = useI18n()
  const { t, pctPlain, utcTime } = i18n
  const { events, scannerOn, feed, bars, problem: feedProblem } = useEventFeed(EVENTS_READ)
  const nowSec = useNowSec(true, 15_000)
  const [problem, setProblem] = useState<string | null>(null)
  const { state: research } = useMarketResearch()
  const news = useNewsFeed()
  const readings = useNewsReadings(news)
  const pick = useMemo(() => overviewOpportunity(feed, bars, nowSec), [feed, bars, nowSec])
  // The entries on offer by their signal, as the table ranks them; the signal reads no live price.
  const offers = useMemo(
    () => opportunityTableRows({ feed, bars, live: null, pairs: research?.pairs ?? [], regime: research?.market?.regime ?? null, news, readings, nowSec, nowMs: nowSec * 1000 }).onOffer,
    [feed, bars, research, news, readings, nowSec]
  )
  const top = offers[0] ?? null
  const answerOf = top?.item.answers.find((entry) => entry.model === top.offer?.model) ?? null
  // The live price of the pair on offer, to say whether it can be entered now.
  const live = useLiveMarket(top !== null ? [top.item.event.symbol] : [])

  async function paperTrade(item: EventFeedItem, answer: EventAnswer): Promise<void> {
    setProblem(null)
    const result = await proposalForAnswer(item, answer, async () => (await window.api.market.fetchTicker24h(item.event.exchange, item.event.symbol)).lastPrice, undefined, i18n)
    if ('problem' in result) {
      setProblem(result.problem)
      return
    }
    onPrepareOrder(result.proposal)
  }

  const open = (
    <TextLink onClick={() => onNavigate('opportunities')}>{t('Open Opportunities')}</TextLink>
  )

  if (feedProblem !== null || events === null) {
    return (
      <Card title={t('What can be acted on')}>
        <p style={noteStyle}>{feedProblem ?? t('Loading…')}</p>
      </Card>
    )
  }

  if (top !== null && top.offer !== null && answerOf !== null) {
    const row = top.offer
    const answer = answerOf
    const detail = answer.decision.detail
    const left = Math.max(0, row.expiresAt - nowSec)
    const leftText = left < 60 ? t('{seconds}s left', { seconds: left }) : t('{minutes} min left', { minutes: Math.ceil(left / 60) })
    return (
      <Card title={t('What can be acted on')}>
        <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>{describeEvent(row.item, i18n)}</div>
        <div style={{ marginTop: '0.45rem', fontSize: '0.88rem', color: 'var(--text-primary)' }}>
          <strong style={{ color: row.side === 'long' ? 'var(--up)' : 'var(--down)' }}>{describeOpportunitySide(row.side, i18n)}</strong>{' '}
          {t('between {low} and {high}, until {time} UTC ({left})', { low: plainNumber(row.entryMin, i18n), high: plainNumber(row.entryMax, i18n), time: utcTime(row.expiresAt * 1000), left: leftText })}
          {detail !== undefined && detail !== null && detail.stopLoss !== null && detail.takeProfit !== null && (
            <span style={{ color: 'var(--text-secondary)' }}> {t('· stop {stop} · target {target}', { stop: plainNumber(detail.stopLoss, i18n), target: plainNumber(detail.takeProfit, i18n) })}</span>
          )}
        </div>
        <div style={{ marginTop: '0.35rem' }}>
          <span style={{ fontSize: '0.84rem', color: 'var(--text-secondary)' }}>{t('Signal')} </span>
          <strong style={{ fontSize: '0.84rem', color: 'var(--text-primary)' }}>{t('{score}/100', { score: top.signal.score })}</strong>
          <span style={{ fontSize: '0.84rem', color: 'var(--text-secondary)' }}> · {t('Now:')} </span>
          <LiveVerdictView reading={liveReadingOf(row, live, { nowMs: Date.now(), i18n })} />
        </div>
        <p style={{ ...noteStyle, marginTop: '0.4rem' }}>
          {t("The surest call to act on: {model} at {confidence}. A model's confidence is not a probability of profit, and taking every event has lost money (research/EVENTS.md).", {
            model: describeDecider(row.model, i18n),
            confidence: pctPlain(Math.round(answer.decision.confidence * 100), 0)
          })}
        </p>
        <Answers answers={row.item.answers} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem', marginTop: '0.8rem', flexWrap: 'wrap' }}>
          <button onClick={() => void paperTrade(row.item, answer)} style={buttonStyle('primary')}>
            {t('Paper trade')}
          </button>
          {open}
        </div>
        {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.5rem' }}>{problem}</p>}
        {offers.length > 1 && (
          <p style={{ ...noteStyle, marginTop: '0.6rem', color: 'var(--text-secondary)' }}>
            {t('Also on offer:')}{' '}
            {offers.slice(1, 3).map((entry, index) => (
              <span key={entry.item.event.id}>
                {index > 0 && ' · '}
                <span dir="ltr">{entry.item.event.symbol}</span>
                {entry.offer !== null && (
                  <>
                    {' '}
                    <strong style={{ color: entry.offer.side === 'long' ? 'var(--up)' : 'var(--down)' }}>{describeOpportunitySide(entry.offer.side, i18n)}</strong>{' '}
                    {t('until {time} UTC', { time: utcTime(entry.offer.expiresAt * 1000) })}
                  </>
                )}
                {t(', signal {score}', { score: entry.signal.score })}
              </span>
            ))}
            .
          </p>
        )}
      </Card>
    )
  }

  // Nothing on offer, so the pick is the strongest event of the last hour, where there is one.
  const candidate = pick.kind === 'none' ? pick.candidate : null
  return (
    <Card title={t('What can be acted on')}>
      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>{t('No high-quality opportunity right now. Wait.')}</div>
      {candidate !== null ? (
        <>
          <p style={{ ...noteStyle, marginTop: '0.45rem', color: 'var(--text-secondary)' }}>
            {t('The strongest event of the last hour: {event}.', { event: describeEvent(candidate.item, i18n) })} {describeWhatItLacks(candidate.item, candidate.status, i18n)}
          </p>
          <Answers answers={candidate.item.answers} />
        </>
      ) : (
        <p style={{ ...noteStyle, marginTop: '0.45rem' }}>{scannerOn === false ? t('The scanner is off, so no event is being raised.') : t('The scanner has raised no event in the last hour.')}</p>
      )}
      <div style={{ marginTop: '0.7rem', fontSize: '0.82rem' }}>{open}</div>
    </Card>
  )
}
