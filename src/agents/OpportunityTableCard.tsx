import { Fragment, useState } from 'react'
import { Card } from '../components/Card'
import { describeOpportunitySide, isActionableOpportunity, opportunitySide, opportunityWindow } from '../../shared/aiOpportunity'
import { describeDecider } from '../../shared/aiPanel'
import type { ExecutorConfig, PaperAccount } from '../../shared/ipc'
import { MAX_SPREAD_PCT, STALE_PRICE_MS } from '../../shared/liveMarket'
import { calibratedWinRate, describeExpectedValue, tradeExpectedValue, type WatchOutcome } from '../../shared/expectedValue'
import { describeEventType } from '../../shared/marketEvent'
import { describeEventType as describeStoryType, type NewsFeedState } from '../../shared/newsFeed'
import { SIGNAL_WEIGHTS, storiesAbout } from '../../shared/opportunityScore'
import { correlatedCap, correlatedOut } from '../../shared/paperExposure'
import { healPaperRisk, paperEquity, paperStake, riskedAtStop } from '../../shared/paperRisk'
import { formatHoldingDuration } from '../backtest/formatTradeTime'
import { WhyButton } from '../news/WhyItMovedHost'
import { buttonStyle, cellStyle, headCellStyle, noteStyle, reasonLabel, signedPct } from './agentStyles'
import { LiveVerdictView } from './LiveVerdictView'
import { describeFeedItemStatus, type EventAnswer, type EventFeedItem } from './opportunities'
import type { OpportunityTableRow } from './opportunityTable'

const plain = (value: number): string => Number(value.toPrecision(7)).toLocaleString('en-US', { maximumFractionDigits: 8 })
const utcClock = (sec: number): string => new Date(sec * 1000).toISOString().slice(11, 16)
const sideColor = (side: 'long' | 'short' | null): string => (side === 'long' ? 'var(--up)' : side === 'short' ? 'var(--down)' : 'var(--text-secondary)')
const scoreColor = (score: number): string => (score >= 70 ? 'var(--up)' : score >= 50 ? 'var(--text-primary)' : 'var(--text-muted)')

const sectionTitle: React.CSSProperties = { margin: '0 0 0.35rem', fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' }
const lineStyle: React.CSSProperties = { margin: 0, fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.55 }

/** What the paper side of the app needs to say what an entry would risk. */
export interface TableRisk {
  /** settings.json's paperRisk, as stored. */
  paperRisk: unknown
  account: PaperAccount | null
  executors: ExecutorConfig[]
  /** The watch's stake, and its Bitcoin safeguard. */
  stakeQuote: number
  btcLimitPct: number
}

/** The answer an entry on offer is from. */
function offeredAnswer(row: OpportunityTableRow): EventAnswer | null {
  if (row.offer === null) return null
  return row.item.answers.find((answer) => answer.model === row.offer?.model) ?? null
}

function SignalSection({ row }: { row: OpportunityTableRow }): React.JSX.Element {
  const { signal } = row
  return (
    <div>
      <p style={sectionTitle}>Signal {signal.score}/100</p>
      {signal.parts.map((part) => (
        <p key={part.id} style={{ ...lineStyle, display: 'flex' }}>
          <span style={{ flex: '0 0 64px', color: 'var(--text-primary)', fontWeight: 600 }}>{part.label}</span>
          <span style={{ flex: '0 0 74px', color: 'var(--text-muted)' }}>
            {Math.round(part.value)} × {Math.round(SIGNAL_WEIGHTS[part.id] * 100)}%
          </span>
          <span style={{ flex: '0 0 44px', color: 'var(--text-primary)', fontWeight: 600 }}>+{part.points.toFixed(1)}</span>
          <span style={{ flex: 1, minWidth: 0 }}>{part.fact}</span>
        </p>
      ))}
      {signal.penalties.map((penalty) => (
        <p key={penalty.id} style={{ ...lineStyle, display: 'flex', color: 'var(--down)' }}>
          <span style={{ flex: '0 0 138px', fontWeight: 600 }}>{penalty.label}</span>
          <span style={{ flex: '0 0 44px', fontWeight: 600 }}>−{penalty.points.toFixed(1)}</span>
          <span style={{ flex: 1, minWidth: 0 }}>{penalty.fact}</span>
        </p>
      ))}
      <p style={{ ...noteStyle, marginTop: '0.35rem' }}>
        Fixed weights, written down before any result was looked at. It ranks; it is not a probability of profit, and nothing is opened or refused by it. A model counts only
        as a side it would take at 65% or more.
      </p>
    </div>
  )
}

function PlanSection({ row, risk, outcomes, nowSec }: { row: OpportunityTableRow; risk: TableRisk | null; outcomes: WatchOutcome[]; nowSec: number }): React.JSX.Element | null {
  const answer = offeredAnswer(row)
  const detail = answer?.decision.detail ?? null
  const validity = answer === null ? null : opportunityWindow(row.item.event.time, detail)
  if (row.offer === null || detail?.entry == null || validity === null) return null
  const { offer } = row
  const mid = (offer.entryMin + offer.entryMax) / 2
  const stopPct = detail.stopLoss === null || !(mid > 0) ? null : (Math.abs(mid - detail.stopLoss) / mid) * 100
  const way = offer.side === 'long' ? 'buy' : 'sell'
  const targetPct = detail.takeProfit === null || !(mid > 0) ? null : (Math.abs(detail.takeProfit - mid) / mid) * 100
  // The call's expected value (shared/expectedValue.ts), at the watch's calibrated win rate for this
  // model on this kind of event where it has one, else at the model's own confidence.
  const ev =
    answer === null
      ? null
      : tradeExpectedValue({
          confidence: answer.decision.confidence,
          calibrated: calibratedWinRate(outcomes, { model: answer.model, eventType: row.item.event.type, side: way }, nowSec),
          stopPct,
          targetPct,
          spreadPct: row.live?.quality.spreadPct ?? null
        })
  const sized =
    risk === null
      ? null
      : paperStake({ risk: healPaperRisk(risk.paperRisk), stakeQuote: risk.stakeQuote, stopPct, equityQuote: paperEquity(risk.account, risk.executors, row.item.event.quoteAsset) })
  const lost = sized === null || stopPct === null ? null : riskedAtStop({ amountQuote: sized, stopLossPct: stopPct })
  const quote = row.item.event.quoteAsset
  const cap = risk === null ? null : correlatedCap({ account: risk.account, risk: healPaperRisk(risk.paperRisk), quoteAsset: quote })
  const out = risk === null ? 0 : correlatedOut(risk.executors, way, quote)
  return (
    <div>
      <p style={sectionTitle}>The plan</p>
      <p style={lineStyle}>
        <strong style={{ color: sideColor(offer.side) }}>{describeOpportunitySide(offer.side)}</strong> between {plain(offer.entryMin)} and {plain(offer.entryMax)} · stop{' '}
        {detail.stopLoss === null ? '—' : plain(detail.stopLoss)} · target {detail.takeProfit === null ? '—' : plain(detail.takeProfit)} · valid until {utcClock(validity.expiresAt)} UTC
        · held at most {formatHoldingDuration(validity.holdSeconds)}
      </p>
      {ev !== null && <p style={lineStyle}>{describeExpectedValue(ev, row.item.event.type)}</p>}
      <p style={{ ...sectionTitle, marginTop: '0.6rem' }}>Invalid if</p>
      <ul style={{ ...lineStyle, paddingLeft: '1.1rem' }}>
        <li>its entry has not filled by {utcClock(validity.expiresAt)} UTC;</li>
        {risk !== null && risk.btcLimitPct > 0 && <li>Bitcoin moves {risk.btcLimitPct}% against it from the event&apos;s minute;</li>}
        <li>the spread is wider than {MAX_SPREAD_PCT}%;</li>
        <li>no price fresher than {STALE_PRICE_MS / 1000} seconds can be had.</li>
      </ul>
      <p style={noteStyle}>Outside its range it waits, and is entered only if the price comes back into it before it expires.</p>
      {risk !== null && (
        <>
          <p style={{ ...sectionTitle, marginTop: '0.6rem' }}>The risk</p>
          <p style={lineStyle}>
            {sized === null ? '' : `Sized as the app sizes its own paper trades, it stakes ${plain(sized)} ${quote}`}
            {stopPct === null ? '.' : `, with its stop ${stopPct.toFixed(2)}% away`}
            {lost === null ? '' : `: stopped out, it loses about ${lost.toFixed(2)} ${quote} after fees.`}
          </p>
          <p style={lineStyle}>
            {cap === null
              ? `There is no cap on what the app's own paper trades stake on one side.`
              : `On this side, on coins that move with Bitcoin, the app's own open paper trades stake ${plain(out)} of the ${plain(cap)} ${quote} they may have out together.`}
          </p>
        </>
      )}
    </div>
  )
}

function NewsSection({ row, news, nowSec }: { row: OpportunityTableRow; news: NewsFeedState | null; nowSec: number }): React.JSX.Element {
  const { event } = row.item
  const stories = news === null ? [] : storiesAbout(event.baseAsset, event.time, news.stories, nowSec)
  return (
    <div>
      <p style={sectionTitle}>News on {event.baseAsset}</p>
      {stories.length === 0 && <p style={lineStyle}>{news === null ? 'The news has not been read yet.' : 'No story names it in the three hours before the event or since.'}</p>}
      {stories.slice(0, 5).map((story) => {
        const reaction = news?.reactions[story.id]
        return (
          <p key={story.id} style={{ ...lineStyle, display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
            <span style={{ color: 'var(--text-muted)' }}>{utcClock(story.publishedAt)}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ color: 'var(--text-primary)' }}>{story.title}</span> ({story.sourceName}) · {describeStoryType(story.eventType)} · impact {story.impact}
              {story.stale ? ' · old news' : ''}
              {reaction !== undefined && reaction.verdict !== 'PENDING' ? ` · ${reaction.verdict}${reaction.pricedIn ? ', priced in' : ''}` : ''}
            </span>
            <button onClick={() => void window.api.feed.openLink(story.url).catch(() => undefined)} style={{ ...buttonStyle('secondary'), padding: '0.15rem 0.5rem', fontSize: '0.7rem' }}>
              Open
            </button>
          </p>
        )
      })}
    </div>
  )
}

function ModelsSection({ row }: { row: OpportunityTableRow }): React.JSX.Element {
  const { answers } = row.item
  return (
    <div>
      <p style={sectionTitle}>The models</p>
      {answers.length === 0 && <p style={lineStyle}>No model has been asked about it. Ask is on its card below.</p>}
      {answers.map((answer) => {
        const side = opportunitySide(answer.decision)
        const { detail } = answer.decision
        return (
          <div key={answer.model} style={{ marginBottom: '0.45rem' }}>
            <p style={lineStyle}>
              <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{describeDecider(answer.model)}</span>{' '}
              <strong style={{ color: answer.decision.rejected ? 'var(--down)' : sideColor(side) }}>{answer.decision.rejected ? 'REFUSED' : describeOpportunitySide(side)}</strong>
              {!answer.decision.rejected && ` ${Math.round(answer.decision.confidence * 100)}%${side !== null && !isActionableOpportunity(answer.decision) ? ', under the 65% acted on' : ''}`}
              {detail != null && !answer.decision.rejected && (
                <span style={{ color: 'var(--text-muted)' }}>
                  {' '}
                  · its reading: {reasonLabel(detail.marketRegime)}, {detail.riskLevel} risk
                </span>
              )}
            </p>
            {!answer.decision.rejected && answer.decision.rationale !== '' && <p style={{ ...lineStyle, color: 'var(--text-muted)' }}>{answer.decision.rationale}</p>}
          </div>
        )
      })}
    </div>
  )
}

function RowDetail({
  row,
  news,
  nowSec,
  risk,
  confirm = false,
  outcomes,
  onPaperTrade
}: {
  row: OpportunityTableRow
  news: NewsFeedState | null
  nowSec: number
  risk: TableRisk | null
  /** CONFIRM is on: a BUY's button fills in a real order a person places. */
  confirm?: boolean
  /** The watch's closed paper trades with their calls (shared/expectedValue.ts), for the calibrated rate. */
  outcomes?: WatchOutcome[]
  onPaperTrade?: (item: EventFeedItem, answer: EventAnswer) => void
}): React.JSX.Element {
  const answer = offeredAnswer(row)
  const confirming = confirm === true && answer !== null && answer.decision.recommendation === 'buy'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1rem 1.6rem', padding: '0.8rem 0.4rem 0.9rem' }}>
      <SignalSection row={row} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
        {row.offer !== null && (
          <div>
            <p style={sectionTitle}>The live price</p>
            <LiveVerdictView reading={row.live} />
          </div>
        )}
        <PlanSection row={row} risk={risk} outcomes={outcomes ?? []} nowSec={nowSec} />
        {row.offer === null && (
          <p style={lineStyle}>
            {row.status === null ? 'Where it stands is not known yet: its candles have not been read.' : `${describeFeedItemStatus(row.status)}: nothing is on offer from it.`}
          </p>
        )}
        {answer !== null && onPaperTrade !== undefined && (
          <div>
            <button onClick={() => onPaperTrade(row.item, answer)} style={buttonStyle('primary')}>
              {confirming ? 'Confirm' : 'Paper trade'}
            </button>
            <span style={{ ...noteStyle, marginLeft: '0.6rem' }}>
              {confirming
                ? 'Fills in a real order from this call on Strategies › Execution, sized by your risk setting; you type the phrase and place it.'
                : 'Fills in an order form on Strategies › Execution; a person sets the amount and submits it.'}
            </span>
          </div>
        )}
      </div>
      <NewsSection row={row} news={news} nowSec={nowSec} />
      <ModelsSection row={row} />
    </div>
  )
}

function Row({
  row,
  index,
  open,
  onToggle,
  muted
}: {
  row: OpportunityTableRow
  index: number
  open: boolean
  onToggle: () => void
  muted: boolean
}): React.JSX.Element {
  const { event } = row.item
  const day = row.research === null ? null : signedPct(row.research.change24hPct)
  const week = row.research?.change7dPct == null ? null : signedPct(row.research.change7dPct)
  const story = row.signal.story
  const action =
    row.offer !== null ? (
      <LiveVerdictView reading={row.live} compact />
    ) : (
      <span style={{ color: 'var(--text-muted)' }}>{row.status === null ? '—' : describeFeedItemStatus(row.status).toUpperCase()}</span>
    )
  return (
    <tr onClick={onToggle} style={{ cursor: 'pointer', opacity: muted ? 0.8 : 1, background: open ? 'var(--bg-app)' : undefined }}>
      <td style={{ ...cellStyle, color: 'var(--text-muted)' }}>
        <button
          onClick={(click) => {
            click.stopPropagation()
            onToggle()
          }}
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} ${event.symbol}'s details`}
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, fontSize: '0.75rem' }}
        >
          {open ? '▾' : '▸'} {index + 1}
        </button>
      </td>
      <td style={{ ...cellStyle, fontWeight: 700 }} onClick={(click) => click.stopPropagation()}>
        {event.symbol} <WhyButton symbol={event.symbol} compact />
      </td>
      <td style={cellStyle}>{row.price === null ? '—' : plain(row.price)}</td>
      <td style={{ ...cellStyle, color: day?.color }}>{day?.text ?? '—'}</td>
      <td style={{ ...cellStyle, color: week?.color }}>{week?.text ?? '—'}</td>
      <td style={{ ...cellStyle, color: event.direction === 'up' ? 'var(--up)' : event.direction === 'down' ? 'var(--down)' : 'var(--text-secondary)' }}>
        {describeEventType(event.type)} <span style={{ color: 'var(--text-muted)' }}>{utcClock(event.time)}</span>
      </td>
      <td style={{ ...cellStyle, color: story === null ? 'var(--text-muted)' : 'var(--text-primary)' }} title={story?.title}>
        {story === null ? '—' : `${describeStoryType(story.eventType)} ${story.impact}`}
      </td>
      <td style={cellStyle}>
        {row.agreement.answered === 0 ? (
          <span style={{ color: 'var(--text-muted)' }}>not asked</span>
        ) : (
          <span style={{ color: row.agreement.taking > 0 ? sideColor(row.side) : 'var(--text-secondary)' }}>
            {row.agreement.taking} of {row.agreement.answered}
            {row.side !== null && row.agreement.taking > 0 ? ` ${describeOpportunitySide(row.side)}` : ''}
          </span>
        )}
      </td>
      <td style={{ ...cellStyle, whiteSpace: 'normal', minWidth: 170 }}>
        {row.offer !== null && <strong style={{ color: sideColor(row.offer.side), marginRight: '0.4rem' }}>{describeOpportunitySide(row.offer.side)}</strong>}
        {action}
      </td>
      <td style={{ ...cellStyle, fontWeight: 700, color: scoreColor(row.signal.score) }}>{row.signal.score}</td>
      <td style={{ ...cellStyle, fontWeight: 700, color: row.live === null ? 'var(--text-muted)' : scoreColor(row.live.quality.score) }}>{row.live === null ? '—' : row.live.quality.score}</td>
      <td style={cellStyle}>{row.offer === null ? '—' : utcClock(row.offer.expiresAt)}</td>
    </tr>
  )
}

const COLUMNS = ['#', 'Pair', 'Price', '24h', '7d', 'Event', 'News', 'AI', 'Action', 'Signal', 'Execution', 'Until (UTC)']

/** What can be acted on now, as a table (./opportunityTable.ts): each entry on offer, and the last
 * hour's other events, with the signal score and, for an entry, the execution the live price allows.
 * A row opens what is behind it: the score part by part, the live price, the plan and when it stops
 * standing, what it would risk, the news on the coin, and each model's answer. It shows; it asks
 * nothing and opens nothing -- Paper trade fills in a form a person submits. */
export function OpportunityTableCard({
  onOffer,
  recent,
  nowSec,
  news,
  risk,
  confirm = false,
  outcomes,
  onPaperTrade
}: {
  onOffer: OpportunityTableRow[]
  recent: OpportunityTableRow[]
  nowSec: number
  news: NewsFeedState | null
  risk: TableRisk | null
  /** CONFIRM is on, for every row: a BUY's button fills in a real order a person places. */
  confirm?: boolean
  /** The watch's closed paper trades with their calls, for each row's expected value. */
  outcomes?: WatchOutcome[]
  onPaperTrade?: (item: EventFeedItem, answer: EventAnswer) => void
}): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const toggle = (id: string): void => setOpen((current) => (current === id ? null : id))
  const body = (rows: OpportunityTableRow[], offset: number, muted: boolean): React.JSX.Element[] =>
    rows.map((row, index) => (
      <Fragment key={row.item.event.id}>
        <Row row={row} index={offset + index} open={open === row.item.event.id} onToggle={() => toggle(row.item.event.id)} muted={muted} />
        {open === row.item.event.id && (
          <tr>
            <td colSpan={COLUMNS.length} style={{ ...cellStyle, whiteSpace: 'normal', background: 'var(--bg-app)' }}>
              <RowDetail row={row} news={news} nowSec={nowSec} risk={risk} confirm={confirm} outcomes={outcomes} onPaperTrade={onPaperTrade} />
            </td>
          </tr>
        )}
      </Fragment>
    ))

  return (
    <Card title="Right now">
      {onOffer.length === 0 && (
        <>
          {/* Saying so is the point, not a gap in the page: a system that always has a trade to
              offer is not a better one. */}
          <p style={{ margin: '0 0 0.4rem', fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>No high-quality opportunity right now. Wait.</p>
          <p style={{ ...noteStyle, marginBottom: recent.length > 0 ? '0.8rem' : 0 }}>
            No recommendation can be acted on at the moment. A call to trade is listed here from the minute it arrives until its entry is filled or runs out, which is at most an
            hour and usually fifteen minutes.
          </p>
        </>
      )}
      {onOffer.length + recent.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <th key={column} style={headCellStyle}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body(onOffer, 0, false)}
              {recent.length > 0 && (
                <tr>
                  <td colSpan={COLUMNS.length} style={{ ...cellStyle, color: 'var(--text-muted)', fontSize: '0.7rem', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                    The last hour&apos;s other events: nothing on offer
                  </td>
                </tr>
              )}
              {body(recent, onOffer.length, true)}
            </tbody>
          </table>
        </div>
      )}
      {onOffer.length + recent.length > 0 && (
        <p style={{ ...noteStyle, marginTop: '0.7rem' }}>
          Strongest signal first; a row opens what is behind it. The signal weighs the event, its volume and break, how much the pair trades, the news on the coin, the
          market&apos;s regime and how many models would take it, less wild bars, old news and models on opposite sides. Execution is the live price&apos;s: the spread, what
          the book holds against the stake, and how fresh it is. &quot;Action&quot; is the entry against the live price: enterable when what a fill would pay is inside the range,
          the spread within 0.1% and the price under ten seconds old; waiting while it is outside the range; invalidated once the entry has expired, Bitcoin has moved against it
          by the watch&apos;s safeguard, the spread is wider or no fresh price is had.
        </p>
      )}
    </Card>
  )
}
