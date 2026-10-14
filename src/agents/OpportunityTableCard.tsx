import { Fragment, useState } from 'react'
import { Card } from '../components/Card'
import { describeOpportunitySide, isActionableOpportunity, opportunitySide, opportunityWindow } from '../../shared/aiOpportunity'
import { describeDecider } from '../../shared/aiPanel'
import type { ExecutorConfig, PaperAccount } from '../../shared/ipc'
import { MAX_SPREAD_PCT, STALE_PRICE_MS } from '../../shared/liveMarket'
import { calibratedWinRate, describeExpectedValue, tradeExpectedValue, type WatchOutcome } from '../../shared/expectedValue'
import { describeBand, describeEventCause, describeEventStatus, describeEventType, type EventLife } from '../../shared/marketEvent'
import { aiCostPct } from '../../shared/aiCostPerTrade'
import { describeOpportunityStatus } from '../../shared/opportunityStatus'
import { voteOf } from '../../shared/opportunityVote'
import { levelReadings } from '../../shared/planReadings'
import { THESIS_LINES } from '../../shared/thesisStatus'
import { describeEventType as describeStoryType, type NewsFeedState } from '../../shared/newsFeed'
import { SIGNAL_WEIGHTS, storiesAbout } from '../../shared/opportunityScore'
import { correlatedCap, correlatedOut } from '../../shared/paperExposure'
import { healPaperRisk, paperEquity, paperStake, riskedAtStop } from '../../shared/paperRisk'
import { formatHoldingDuration } from '../backtest/formatTradeTime'
import { WhyButton } from '../news/WhyItMovedHost'
import { buttonStyle, cellStyle, headCellStyle, noteStyle, reasonLabel, signedPct } from './agentStyles'
import { LiveVerdictView } from './LiveVerdictView'
import type { EventAnswer, EventFeedItem } from './opportunities'
import type { OpportunityTableRow } from './opportunityTable'
import { Interpolate, msg, useI18n, type I18n } from '../i18n'

const plainIn = ({ num }: I18n, value: number): string => num(Number(value.toPrecision(7)), 0, 8)
/** A story's reaction verdict in a word. */
const VERDICTS: Record<string, string> = { CONFIRMED: msg('CONFIRMED@@a reaction'), AGAINST: msg('AGAINST@@a reaction'), NONE: msg('NONE@@a reaction'), PENDING: msg('PENDING@@a reaction') }
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
  const { t, num } = useI18n()
  const { signal } = row
  return (
    <div>
      <p style={sectionTitle}>{t('Why this coin · signal {score}/100', { score: signal.score })}</p>
      {signal.parts.map((part) => (
        <p key={part.id} style={{ ...lineStyle, display: 'flex' }}>
          <span style={{ flex: '0 0 64px', color: 'var(--text-primary)', fontWeight: 600 }}>{part.label}</span>
          <span style={{ flex: '0 0 74px', color: 'var(--text-muted)' }}>
            {Math.round(part.value)} × {Math.round(SIGNAL_WEIGHTS[part.id] * 100)}%
          </span>
          <span style={{ flex: '0 0 44px', color: 'var(--text-primary)', fontWeight: 600 }}>+{num(part.points, 1, 1)}</span>
          <span style={{ flex: 1, minWidth: 0 }}>{part.fact}</span>
        </p>
      ))}
      {signal.penalties.map((penalty) => (
        <p key={penalty.id} style={{ ...lineStyle, display: 'flex', color: 'var(--down)' }}>
          <span style={{ flex: '0 0 138px', fontWeight: 600 }}>{penalty.label}</span>
          <span style={{ flex: '0 0 44px', fontWeight: 600 }}>−{num(penalty.points, 1, 1)}</span>
          <span style={{ flex: 1, minWidth: 0 }}>{penalty.fact}</span>
        </p>
      ))}
      <p style={{ ...noteStyle, marginTop: '0.35rem' }}>
        {t('Fixed weights, written down before any result was looked at. It ranks; it is not a probability of profit, and nothing is opened or refused by it. A model counts only as a side it would take at 65% or more.')}
      </p>
    </div>
  )
}

/** Why now: the event, where it stands in its life and what it is read as (shared/marketEvent.ts). */
function WhyNowSection({ row, life }: { row: OpportunityTableRow; life?: EventLife }): React.JSX.Element {
  const i18n = useI18n()
  const { t, num, utcTime } = i18n
  const { event } = row.item
  const lifeWord = life === undefined ? null : describeEventStatus(life.status, i18n)
  const move = signedPct(event.returnsPct.m15, i18n)
  const kind = (
    <strong style={{ color: event.direction === 'up' ? 'var(--up)' : event.direction === 'down' ? 'var(--down)' : 'var(--text-primary)' }}>{describeEventType(event.type, i18n)}</strong>
  )
  const values = { kind, move: <span style={{ color: move.color }}>{move.text}</span> }
  const words = { time: utcTime(event.time * 1000), band: describeBand(event.band, i18n), score: Math.round(event.score), sigmas: num(event.moveSigmas, 1, 1) }
  return (
    <div>
      <p style={sectionTitle}>{t('Why now')}</p>
      <p style={lineStyle}>
        <Interpolate
          text={
            event.volumeRatio === null
              ? t('{kind} at {time} UTC, {band}, score {score}: {move} in fifteen minutes, {sigmas} of its usual moves.', { ...words, kind: '{kind}', move: '{move}' })
              : t('{kind} at {time} UTC, {band}, score {score}: {move} in fifteen minutes, {sigmas} of its usual moves, on {volume}× its usual volume.', { ...words, kind: '{kind}', move: '{move}', volume: num(event.volumeRatio, 1, 1) })
          }
          values={values}
        />
      </p>
      <p style={lineStyle}>
        {lifeWord === null ? t('The scanner no longer lists it, so where it stands in its life is not read.') : t('{word}: {detail}', { word: lifeWord.word, detail: lifeWord.detail })}
        {event.cause !== undefined ? ` ${t('Read as {cause}.', { cause: describeEventCause(event.cause, i18n) })}` : ''}
      </p>
    </div>
  )
}

/** The plan, and why this entry, this stop and this target: the model's levels read against the
 * event's record and the live price (shared/planReadings.ts), with the call's expected value
 * (shared/expectedValue.ts) at the watch's calibrated win rate for this model on this kind of event
 * where it has one, else at the model's own confidence. */
function LevelsSection({
  row,
  outcomes,
  nowSec,
  risk,
  aiCostByModel
}: {
  row: OpportunityTableRow
  outcomes: WatchOutcome[]
  nowSec: number
  risk: TableRisk | null
  /** What each model's answers cost a trade, in dollars (shared/aiCostPerTrade.ts). */
  aiCostByModel: Readonly<Record<string, number>>
}): React.JSX.Element | null {
  const i18n = useI18n()
  const { t, utcTime } = i18n
  const plain = (value: number): string => plainIn(i18n, value)
  const answer = offeredAnswer(row)
  const detail = answer?.decision.detail ?? null
  const validity = answer === null ? null : opportunityWindow(row.item.event.time, detail)
  if (row.offer === null || answer === null || detail?.entry == null || validity === null) return null
  const { offer } = row
  const way = offer.side === 'long' ? 'buy' : 'sell'
  const read = levelReadings({ event: row.item.event, side: way, entryMin: offer.entryMin, entryMax: offer.entryMax, stopLoss: detail.stopLoss, takeProfit: detail.takeProfit, livePrice: row.price }, i18n)
  // The model's answers' cost a trade, as a share of what the app would stake on it: part of the
  // costs the value is net of (the V5 document, §73).
  const stake = risk === null ? null : paperStake({ risk: healPaperRisk(risk.paperRisk), stakeQuote: risk.stakeQuote, stopPct: read.stopPct, equityQuote: paperEquity(risk.account, risk.executors, row.item.event.quoteAsset) })
  const ev = tradeExpectedValue({
    confidence: answer.decision.confidence,
    calibrated: calibratedWinRate(outcomes, { model: answer.model, eventType: row.item.event.type, side: way }, nowSec),
    stopPct: read.stopPct,
    targetPct: read.targetPct,
    spreadPct: row.live?.quality.spreadPct ?? null,
    aiCostPct: stake === null ? null : aiCostPct(aiCostByModel[answer.model] ?? null, stake)
  })
  return (
    <div>
      <p style={sectionTitle}>{t('The plan')}</p>
      <p style={lineStyle}>
        <strong style={{ color: sideColor(offer.side) }}>{describeOpportunitySide(offer.side, i18n)}</strong>{' '}
        {t('between {low} and {high} · stop {stop} · target {target} · valid until {time} UTC · held at most {hold}', {
          low: plain(offer.entryMin),
          high: plain(offer.entryMax),
          stop: detail.stopLoss === null ? '—' : plain(detail.stopLoss),
          target: detail.takeProfit === null ? '—' : plain(detail.takeProfit),
          time: utcTime(validity.expiresAt * 1000),
          hold: formatHoldingDuration(validity.holdSeconds, i18n)
        })}
      </p>
      {ev !== null && <p style={lineStyle}>{describeExpectedValue(ev, row.item.event.type, i18n)}</p>}
      <p style={{ ...sectionTitle, marginTop: '0.6rem' }}>{t('Why this entry')}</p>
      <p style={lineStyle}>{read.entry}</p>
      <p style={{ ...sectionTitle, marginTop: '0.6rem' }}>{t('Why this stop')}</p>
      <p style={lineStyle}>{read.stop}</p>
      <p style={{ ...sectionTitle, marginTop: '0.6rem' }}>{t('Why this target')}</p>
      <p style={lineStyle}>{read.target}</p>
      <p style={noteStyle}>{t("The levels are the model's, from its answer; the readings are the app's, against the event's record and the live price.")}</p>
    </div>
  )
}

/** What could invalidate it: what ends the entry before it fills, and, once in, what its thesis
 * reads as weakening or broken (shared/thesisStatus.ts). */
function InvalidSection({ row, risk }: { row: OpportunityTableRow; risk: TableRisk | null }): React.JSX.Element | null {
  const { t, utcTime, share, num } = useI18n()
  const answer = offeredAnswer(row)
  const validity = answer === null ? null : opportunityWindow(row.item.event.time, answer.decision.detail)
  if (row.offer === null || validity === null) return null
  return (
    <div>
      <p style={sectionTitle}>{t('What could invalidate it')}</p>
      <ul style={{ ...lineStyle, paddingInlineStart: '1.1rem' }}>
        <li>{t('its entry has not filled by {time} UTC;', { time: utcTime(validity.expiresAt * 1000) })}</li>
        {risk !== null && risk.btcLimitPct > 0 && <li>{t("Bitcoin moves {move} against it from the event's minute;", { move: share(risk.btcLimitPct) })}</li>}
        <li>{t('the spread is wider than {line};', { line: share(MAX_SPREAD_PCT) })}</li>
        <li>{t('no price fresher than {seconds} seconds can be had.', { seconds: STALE_PRICE_MS / 1000 })}</li>
      </ul>
      <p style={noteStyle}>{t('Outside its range it waits, and is entered only if the price comes back into it before it expires.')}</p>
      <p style={{ ...lineStyle, marginTop: '0.35rem' }}>
        {t(
          'Once in, its thesis reads WEAKENING when the price has covered {near} of the way to the stop, when a story against it at impact {impact} or more names the coin, or when the pair moves {move} against it over fifteen minutes; BROKEN at the stop, or with {count} of those at once.',
          { near: share(Math.round(THESIS_LINES.nearStopShare * 100)), impact: THESIS_LINES.newsImpact, move: share(THESIS_LINES.oppositeMovePct), count: num(THESIS_LINES.brokenReasons, 0, 0) }
        )}
      </p>
    </div>
  )
}

/** What it would risk, sized as the app sizes its own paper trades (shared/paperRisk.ts), and what
 * the app has out on that side (shared/paperExposure.ts). */
function RiskSection({ row, risk }: { row: OpportunityTableRow; risk: TableRisk | null }): React.JSX.Element | null {
  const i18n = useI18n()
  const { t, num } = i18n
  const plain = (value: number): string => plainIn(i18n, value)
  const detail = offeredAnswer(row)?.decision.detail ?? null
  if (row.offer === null || risk === null || detail?.entry == null) return null
  const { offer } = row
  const mid = (offer.entryMin + offer.entryMax) / 2
  const stopPct = detail.stopLoss === null || !(mid > 0) ? null : (Math.abs(mid - detail.stopLoss) / mid) * 100
  const way = offer.side === 'long' ? 'buy' : 'sell'
  const quote = row.item.event.quoteAsset
  const sized = paperStake({ risk: healPaperRisk(risk.paperRisk), stakeQuote: risk.stakeQuote, stopPct, equityQuote: paperEquity(risk.account, risk.executors, quote) })
  const lost = stopPct === null ? null : riskedAtStop({ amountQuote: sized, stopLossPct: stopPct })
  const cap = correlatedCap({ account: risk.account, risk: healPaperRisk(risk.paperRisk), quoteAsset: quote })
  const out = correlatedOut(risk.executors, way, quote)
  return (
    <div>
      <p style={sectionTitle}>{t('The risk')}</p>
      <p style={lineStyle}>
        {stopPct === null
          ? t('Sized as the app sizes its own paper trades, it stakes {stake} {quote}.', { stake: plain(sized), quote })
          : lost === null
            ? t('Sized as the app sizes its own paper trades, it stakes {stake} {quote}, with its stop {stop} away', { stake: plain(sized), quote, stop: i18n.pctPlain(stopPct, 2) })
            : t('Sized as the app sizes its own paper trades, it stakes {stake} {quote}, with its stop {stop} away: stopped out, it loses about {lost} {quote} after fees.', {
                stake: plain(sized),
                quote,
                stop: i18n.pctPlain(stopPct, 2),
                lost: num(lost, 2, 2)
              })}
      </p>
      <p style={lineStyle}>
        {cap === null
          ? t("There is no cap on what the app's own paper trades stake on one side.")
          : t("On this side, on coins that move with Bitcoin, the app's own open paper trades stake {out} of the {cap} {quote} they may have out together.", { out: plain(out), cap: plain(cap), quote })}
      </p>
    </div>
  )
}

function NewsSection({ row, news, nowSec }: { row: OpportunityTableRow; news: NewsFeedState | null; nowSec: number }): React.JSX.Element {
  const i18n = useI18n()
  const { t, utcTime } = i18n
  const { event } = row.item
  const stories = news === null ? [] : storiesAbout(event.baseAsset, event.time, news.stories, nowSec)
  return (
    <div>
      <p style={sectionTitle}>{t('Which news · {coin}', { coin: event.baseAsset })}</p>
      {stories.length === 0 && <p style={lineStyle}>{news === null ? t('The news has not been read yet.') : t('No story names it in the three hours before the event or since.')}</p>}
      {stories.slice(0, 5).map((story) => {
        const reaction = news?.reactions[story.id]
        return (
          <p key={story.id} style={{ ...lineStyle, display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
            <span style={{ color: 'var(--text-muted)' }}>{utcTime(story.publishedAt * 1000)}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span lang="en" dir="auto" style={{ color: 'var(--text-primary)' }}>
                {story.title}
              </span>{' '}
              ({story.sourceName}) · {t('{kind} · impact {impact}', { kind: describeStoryType(story.eventType, i18n), impact: story.impact })}
              {story.stale ? ` · ${t('old news')}` : ''}
              {reaction !== undefined && reaction.verdict !== 'PENDING' ? ` · ${t(VERDICTS[reaction.verdict] ?? reaction.verdict)}${reaction.pricedIn ? t(', priced in') : ''}` : ''}
            </span>
            <button onClick={() => void window.api.feed.openLink(story.url).catch(() => undefined)} style={{ ...buttonStyle('secondary'), padding: '0.15rem 0.5rem', fontSize: '0.7rem' }}>
              {t('Open@@a link')}
            </button>
          </p>
        )
      })}
    </div>
  )
}

function ModelsSection({ row }: { row: OpportunityTableRow }): React.JSX.Element {
  const i18n = useI18n()
  const { t, pctPlain } = i18n
  const { answers } = row.item
  // With two or more answers, the vote the watch's paper trade follows (shared/opportunityVote.ts).
  const vote = answers.length >= 2 ? voteOf(answers.map((answer) => answer.decision), i18n) : null
  return (
    <div>
      <p style={sectionTitle}>{t('Which models')}</p>
      {answers.length === 0 && <p style={lineStyle}>{t('No model has been asked about it. Ask is on its card below.')}</p>}
      {vote !== null && (
        <p style={{ ...lineStyle, marginBottom: '0.45rem' }} data-testid="models-vote">
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{t('Vote')}</span> {vote.text}
          {vote.refusal !== null ? ` · ${vote.refusal}` : ''}
        </p>
      )}
      {answers.map((answer) => {
        const side = opportunitySide(answer.decision)
        const { detail } = answer.decision
        return (
          <div key={answer.model} style={{ marginBottom: '0.45rem' }}>
            <p style={lineStyle}>
              <span dir="ltr" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                {describeDecider(answer.model, i18n)}
              </span>{' '}
              <strong style={{ color: answer.decision.rejected ? 'var(--down)' : sideColor(side) }}>{answer.decision.rejected ? t('REFUSED') : describeOpportunitySide(side, i18n)}</strong>
              {!answer.decision.rejected && ` ${pctPlain(Math.round(answer.decision.confidence * 100), 0)}${side !== null && !isActionableOpportunity(answer.decision) ? t(', under the 65% acted on') : ''}`}
              {detail != null && !answer.decision.rejected && (
                <span style={{ color: 'var(--text-muted)' }}> · {t('its reading: {regime}, {risk} risk', { regime: reasonLabel(detail.marketRegime, i18n), risk: reasonLabel(detail.riskLevel, i18n) })}</span>
              )}
            </p>
            {!answer.decision.rejected && answer.decision.rationale !== '' && (
              <p style={{ ...lineStyle, color: 'var(--text-muted)' }}>
                <em>{t('AI summary, in its own words:')}</em>{' '}
                <span lang="en" dir="auto">
                  {answer.decision.rationale}
                </span>
              </p>
            )}
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
  onPaperTrade,
  life,
  aiCostByModel
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
  /** Where the event stands in its life, when the scanner still lists it. */
  life?: EventLife
  /** What each model's answers cost a trade, in dollars (shared/aiCostPerTrade.ts), for the expected value. */
  aiCostByModel?: Readonly<Record<string, number>>
}): React.JSX.Element {
  const i18n = useI18n()
  const { t } = i18n
  const answer = offeredAnswer(row)
  const confirming = confirm === true && answer !== null && answer.decision.recommendation === 'buy'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1rem 1.6rem', padding: '0.8rem 0.4rem 0.9rem' }}>
      {/* The eight questions (the V5 document, §55): why this coin, why now, why this entry, stop and
          target, which news, which models, and what could invalidate it. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
        <SignalSection row={row} />
        <WhyNowSection row={row} life={life} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
        {row.offer !== null && (
          <div>
            <p style={sectionTitle}>{t('The live price')}</p>
            <LiveVerdictView reading={row.live} />
          </div>
        )}
        <LevelsSection row={row} outcomes={outcomes ?? []} nowSec={nowSec} risk={risk} aiCostByModel={aiCostByModel ?? {}} />
        <InvalidSection row={row} risk={risk} />
        <RiskSection row={row} risk={risk} />
        {row.offer === null && (
          <p style={lineStyle}>
            {row.status === null && row.standing === 'qualified' ? t('Where it stands is not known yet: its candles have not been read.') : describeOpportunityStatus(row.standing, i18n).detail} {t('Nothing is on offer from it.')}
          </p>
        )}
        {answer !== null && onPaperTrade !== undefined && (
          <div>
            <button onClick={() => onPaperTrade(row.item, answer)} style={buttonStyle('primary')}>
              {confirming ? t('Confirm') : t('Paper trade')}
            </button>
            <span style={{ ...noteStyle, marginInlineStart: '0.6rem' }}>
              {confirming
                ? t('Fills in a real order from this call on Strategies › Execution, sized by your risk setting; you type the phrase and place it.')
                : t('Fills in an order form on Strategies › Execution; a person sets the amount and submits it.')}
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
  muted,
  life
}: {
  row: OpportunityTableRow
  index: number
  open: boolean
  onToggle: () => void
  muted: boolean
  /** Where the event stands in its life (shared/marketEvent.ts), when the scanner still lists it. */
  life?: EventLife
}): React.JSX.Element {
  const i18n = useI18n()
  const { t, utcTime } = i18n
  const { event } = row.item
  const lifeWord = life === undefined ? null : describeEventStatus(life.status, i18n)
  const lifeColor = life === undefined ? 'var(--text-muted)' : life.status === 'confirmed' || life.status === 'active' ? 'var(--up)' : life.status === 'weakening' ? 'var(--gold)' : 'var(--text-muted)'
  const day = row.research === null ? null : signedPct(row.research.change24hPct, i18n)
  const week = row.research?.change7dPct == null ? null : signedPct(row.research.change7dPct, i18n)
  const story = row.signal.story
  // One status (shared/opportunityStatus.ts), and for an entry on offer the live check beside it.
  const standing = describeOpportunityStatus(row.standing, i18n)
  const action = (
    <>
      <strong style={{ color: standing.tone === 'primary' ? 'var(--text-primary)' : `var(--${standing.tone})` }} title={standing.detail} data-testid="opportunity-status">
        {standing.word}
      </strong>
      {row.offer !== null && (
        <span style={{ display: 'block' }}>
          <LiveVerdictView reading={row.live} compact />
        </span>
      )}
    </>
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
          aria-label={open ? t("Hide {pair}'s details", { pair: event.symbol }) : t("Show {pair}'s details", { pair: event.symbol })}
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, fontSize: '0.75rem' }}
        >
          {open ? '▾' : '▸'} {index + 1}
        </button>
      </td>
      <td style={{ ...cellStyle, fontWeight: 700 }} onClick={(click) => click.stopPropagation()}>
        <span dir="ltr">{event.symbol}</span> <WhyButton symbol={event.symbol} compact />
      </td>
      <td style={cellStyle}>{row.price === null ? '—' : plainIn(i18n, row.price)}</td>
      <td style={{ ...cellStyle, color: day?.color }}>{day?.text ?? '—'}</td>
      <td style={{ ...cellStyle, color: week?.color }}>{week?.text ?? '—'}</td>
      <td style={{ ...cellStyle, color: event.direction === 'up' ? 'var(--up)' : event.direction === 'down' ? 'var(--down)' : 'var(--text-secondary)' }}>
        {describeEventType(event.type, i18n)} <span style={{ color: 'var(--text-muted)' }}>{utcTime(event.time * 1000)}</span>
        {lifeWord !== null && (
          <span style={{ color: lifeColor, fontSize: '0.68rem', fontWeight: 700, marginInlineStart: '0.35rem' }} title={lifeWord.detail} data-testid="event-life">
            {lifeWord.word}
          </span>
        )}
        {event.cause !== undefined && <span style={{ color: 'var(--text-muted)', fontSize: '0.68rem', marginInlineStart: '0.35rem' }}>· {describeEventCause(event.cause, i18n)}</span>}
      </td>
      <td style={{ ...cellStyle, color: story === null ? 'var(--text-muted)' : 'var(--text-primary)' }} title={story?.title}>
        {story === null ? '—' : `${describeStoryType(story.eventType, i18n)} ${story.impact}`}
      </td>
      <td style={cellStyle}>
        {row.agreement.answered === 0 ? (
          <span style={{ color: 'var(--text-muted)' }}>{t('not asked')}</span>
        ) : (
          <span style={{ color: row.agreement.taking > 0 ? sideColor(row.side) : 'var(--text-secondary)' }}>
            {row.side !== null && row.agreement.taking > 0
              ? t('{taking} of {count} {side}', { taking: row.agreement.taking, count: row.agreement.answered, side: describeOpportunitySide(row.side, i18n) })
              : t('{taking} of {count}', { taking: row.agreement.taking, count: row.agreement.answered })}
          </span>
        )}
      </td>
      <td style={{ ...cellStyle, whiteSpace: 'normal', minWidth: 170 }}>
        {row.offer !== null && <strong style={{ color: sideColor(row.offer.side), marginInlineEnd: '0.4rem' }}>{describeOpportunitySide(row.offer.side, i18n)}</strong>}
        {action}
      </td>
      <td style={{ ...cellStyle, fontWeight: 700, color: scoreColor(row.signal.score) }}>{row.signal.score}</td>
      <td style={{ ...cellStyle, fontWeight: 700, color: row.live === null ? 'var(--text-muted)' : scoreColor(row.live.quality.score) }}>{row.live === null ? '—' : row.live.quality.score}</td>
      <td style={cellStyle}>{row.offer === null ? '—' : utcTime(row.offer.expiresAt * 1000)}</td>
    </tr>
  )
}

const COLUMNS = [msg('#'), msg('Pair'), msg('Price'), msg('24h'), msg('7d'), msg('Event'), msg('News'), msg('AI'), msg('Status'), msg('Signal'), msg('Execution'), msg('Until (UTC)')]

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
  onPaperTrade,
  lives = {},
  aiCostByModel = {}
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
  /** Where each recent event stands in its life, by id (the scanner's state). */
  lives?: Record<string, EventLife>
  /** What each model's answers cost a trade, in dollars (shared/aiCostPerTrade.ts), for the expected value. */
  aiCostByModel?: Readonly<Record<string, number>>
}): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState<string | null>(null)
  const toggle = (id: string): void => setOpen((current) => (current === id ? null : id))
  const body = (rows: OpportunityTableRow[], offset: number, muted: boolean): React.JSX.Element[] =>
    rows.map((row, index) => (
      <Fragment key={row.item.event.id}>
        <Row row={row} index={offset + index} open={open === row.item.event.id} onToggle={() => toggle(row.item.event.id)} muted={muted} life={lives[row.item.event.id]} />
        {open === row.item.event.id && (
          <tr>
            <td colSpan={COLUMNS.length} style={{ ...cellStyle, whiteSpace: 'normal', background: 'var(--bg-app)' }}>
              <RowDetail row={row} news={news} nowSec={nowSec} risk={risk} confirm={confirm} outcomes={outcomes} onPaperTrade={onPaperTrade} life={lives[row.item.event.id]} aiCostByModel={aiCostByModel} />
            </td>
          </tr>
        )}
      </Fragment>
    ))

  return (
    <Card title={t('Right now')}>
      {onOffer.length === 0 && (
        <>
          {/* Saying so is the point, not a gap in the page: a system that always has a trade to
              offer is not a better one. */}
          <p style={{ margin: '0 0 0.4rem', fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>{t('No high-quality opportunity right now. Wait.')}</p>
          <p style={{ ...noteStyle, marginBottom: recent.length > 0 ? '0.8rem' : 0 }}>
            {t('No recommendation can be acted on at the moment. A call to trade is listed here from the minute it arrives until its entry is filled or runs out, which is at most an hour and usually fifteen minutes.')}
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
                    {t(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body(onOffer, 0, false)}
              {recent.length > 0 && (
                <tr>
                  <td colSpan={COLUMNS.length} style={{ ...cellStyle, color: 'var(--text-muted)', fontSize: '0.7rem', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                    {t("The last hour's other events: nothing on offer")}
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
          {t(
            "Strongest signal first; a row opens what is behind it. The signal weighs the event, its volume and break, how much the pair trades, the news on the coin, the market's regime and how many models would take it, less wild bars, old news and models on opposite sides. Execution is the live price's: the spread, what the book holds against the stake, and how fresh it is. \"Action\" is the entry against the live price: enterable when what a fill would pay is inside the range, the spread within 0.1% and the price under ten seconds old; waiting while it is outside the range; invalidated once the entry has expired, Bitcoin has moved against it by the watch's safeguard, the spread is wider or no fresh price is had."
          )}
        </p>
      )}
    </Card>
  )
}
