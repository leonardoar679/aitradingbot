import type { LiquidityVerdict } from '../liquidityGate'
import { NEWS_RECORD_SINCE } from '../newsRecord'
import { fundingAgainstPct, type CostedVenue, type RoundTrip } from '../venueCosts'
import { ROUND_TRIP_PCT } from './edge'
import { DIRECTION_MODELS, type DirectionModelId } from './models'
import type { PUpSource } from './runCalibration'
import { UNCERTAINTY_LINES, bootstrapOverHours, type Figure } from './uncertainty'

// THE PRIMARY CALL (V8 Stage 3, 26 October 2026). The user's V8 document asks for one card -- BULLISH +X% or BEARISH
// -X%, its reference price, target and window, its risk scenarios, the route's real cost, the net at the target and
// the reason -- shown only where its reliability and its expected value after costs are measured, and otherwise
// "No profitable opportunity identified". The year's research says where a measured way comes from: not the
// forecast's own distribution, which calls no way over seven months out of sample (V72R-S6-DIRYEAR), and not the news
// adjusters, the base rate, the models' answers or a person's view; only a direction model that clears the direction
// bar on two walk forwards in a row (none has), the Binance delisting rule (research/NEWS.md: a delisted coin held
// short four hours, measured on a held-out half), and any direction hypothesis a second year confirms (V8 Stage 11).
// So a card's side comes from that registry alone, and a card is shown only where its expected net -- the source's
// outcomes on its side less the route's round trip at the stake, and for a short the funding the hold crosses --
// clears its lines (V8-S3-EV). Arithmetic on what it is handed: it reads no clock, no file and no book, and places
// nothing; the main process's primary-call service weighs the cards and the renderer words them.

export const PRIMARY_CALL_VERSION = 'primary-call-v1'

/** The lines a card clears (V8-S3-EV): the expected net's interval, its level, and what its lower end and its mean must
 * clear, in percent after the route's cost. */
export const PRIMARY_CALL_LINES = {
  version: PRIMARY_CALL_VERSION,
  level: 0.9,
  minLowerPct: 0,
  minNetPct: 1
} as const

/** The delisting card and the study it rests on (V8-S3-DELIST-CARD): the rule as research/NEWS.md measured it -- short
 * at the open of the second minute after the announcement's, out at the open 240 minutes after it, a 0.1% fee and
 * 0.1% slippage a side -- shown within the rule's five minutes, and what the study printed for the hold after its
 * costs, to the digits research/news.ts printed them, which the coins' rows the card shows must reproduce
 * (shared/delistingStudy.ts). NEWS.md rounds them to +13.17 and -80.3, the second twice: the worst coin's hold is
 * -80.247%, -80.2 at one decimal. */
export const DELISTING_CARD_LINES = {
  version: 'delisting-card-v1',
  entryBars: 2,
  exitBars: 240,
  feePct: 0.1,
  slippagePct: 0.1,
  windowSec: 300,
  published: { hourlyMeanPct: 13.169, ahead: 75, coins: 87, hours: 18, worstPct: -80.25 }
} as const

/** The live check on the delisting rule (V8-S3-DELIST-LIVE): the delistings announced since 1 October 2026 as the app's
 * record scores them; the card is withdrawn, or marked weaker than its study, by these lines. */
export const DELIST_LIVE_LINES = {
  sinceSec: NEWS_RECORD_SINCE,
  level: 0.9,
  withdraw: { minHours: 6, upperUnderPct: 2 },
  weaker: { minHours: 12, meanUnderPct: 7.4 }
} as const

// ---------------------------------------------------------------------------------------------------------------
// Who may set a card's side.

export type CardSource = 'delisting-rule' | 'direction-model'

/** The registry: each source that may set a card's side, the registration its measurement stands on, and the unit its
 * evidence is resampled by. Nothing outside it sets one. */
export const CARD_SOURCES: Readonly<Record<CardSource, { registration: string; unit: 'announcement-hour' | 'hour' }>> = {
  'delisting-rule': { registration: 'V8-S3-DELIST-CARD', unit: 'announcement-hour' },
  'direction-model': { registration: 'V72-S2-DIRECTIONBAR', unit: 'hour' }
}

/** Whether a forecast range's P(up) may set a card's side: only where it is read from a direction model, which the
 * forecast does only where the model cleared the direction bar on two walk forwards in a row. The distribution's own
 * P(up), the news's and the base rate never may, whatever way they lean. */
export function isCardSideSource(source: PUpSource | undefined): source is DirectionModelId {
  return source !== undefined && (DIRECTION_MODELS as readonly string[]).includes(source)
}

// ---------------------------------------------------------------------------------------------------------------
// What a call like it nets.

/** One call on a source's record: its unit of evidence, and its move in the call's favour before any cost. */
export interface SourceCall {
  unit: number
  favourablePct: number
}

/** The expected net of a call: the mean over the source's calls of their move less `costPct`, with its interval at the
 * lines' level, resampled by unit; null with fewer units than an interval needs. */
export function expectedNetOf(calls: readonly SourceCall[], costPct: number, lines: typeof PRIMARY_CALL_LINES = PRIMARY_CALL_LINES): Figure | null {
  if (calls.length === 0 || !Number.isFinite(costPct)) return null
  const rows = calls.filter((call) => Number.isFinite(call.favourablePct)).map((call) => ({ hour: call.unit, sample: [call.favourablePct - costPct] }))
  const resampled = bootstrapOverHours(rows, [(sums, n): number => sums[0] / n], 1, { ...UNCERTAINTY_LINES, level: lines.level })
  return resampled === null ? null : resampled.figures[0]
}

/** Whether an expected net clears the card's lines: its interval's lower end above the line, its mean at least the net
 * asked. */
export function clearsLines(net: Pick<Figure, 'value' | 'low'> | null, lines: typeof PRIMARY_CALL_LINES = PRIMARY_CALL_LINES): boolean {
  return net !== null && Number.isFinite(net.low) && net.low > lines.minLowerPct && net.value >= lines.minNetPct
}

// ---------------------------------------------------------------------------------------------------------------
// The card.

/** What the route costs a card's trade, in percent of the stake: the round trip on the venue's book at the stake, and
 * for a short the funding the hold crosses, charged against it. */
export interface CardCost {
  venue: CostedVenue
  basis: RoundTrip['basis']
  side: 'BUY' | 'SELL'
  stakeQuote: number
  feePct: number
  spreadPct: number | null
  impactPct: number
  fundingPct: number
  totalPct: number
}

export interface PrimaryCard {
  v: typeof PRIMARY_CALL_VERSION
  source: CardSource
  sourceVersion: string
  registration: string
  /** The id its prediction line is recorded under (shared/evaluation/predictionRecord.ts). */
  predictionId: string
  pair: string
  venue: CostedVenue
  side: 'up' | 'down'
  /** When it was weighed, and the event it answers (an announcement's moment), in seconds. */
  madeAt: number
  eventAt: number | null
  refPrice: number
  /** The move it calls, in its favour, before costs, and the price that move reaches. */
  movePct: number
  targetPrice: number
  /** When its trade ends, and when the move is expected: the middle half of the times its source's calls first reached
   * it, in seconds from the event (or from `madeAt` where there is none), with the share that reached it. */
  exitAt: number
  arrival: { fromSec: number; toSec: number; touchedShare: number } | null
  /** Its risk scenarios before costs: the move in its favour its source's calls beat one time in ten, the move against
   * it they fell to one time in ten; and the worst after costs on file. */
  scenarios: { forPct: number; againstPct: number; worstPct: number }
  cost: CardCost
  /** The move at the target less the cost, and the expected net with its interval and what it rests on. */
  netAtTargetPct: number
  expectedNet: { pct: number; low: number; high: number; calls: number; units: number }
  /** The share of its source's calls that came out ahead after costs, and of how many. */
  ahead: { count: number; of: number }
  /** What the evidence is: the source's own record ids (an announcement's). */
  evidence: string[]
  /** The facts the card's words are made from, by source. */
  detail: { kind: 'delisting'; ticker: string; title: string; hours: number; coins: number; weaker: boolean } | { kind: 'model'; model: DirectionModelId; horizonSec: number }
}

/** Why a candidate is not a card. `no-pair`: the coin has no USDT pair on a venue the app reads (a coin traded only on
 * a decentralised exchange among them), so nothing about it can be costed or traded here. */
export type RefusalCode = 'late' | 'withdrawn' | 'no-price' | 'no-pair' | 'no-book' | 'stale-book' | 'cannot-hold' | 'thin' | 'cost-share' | 'under-lines' | 'no-evidence'

export interface CardRefusal {
  refused: RefusalCode
  source: CardSource
  pair: string
  eventAt: number | null
  /** The expected net where it was read and fell short. */
  expectedNet: { pct: number; low: number; high: number } | null
}

const gateRefusal = (verdict: Exclude<LiquidityVerdict, { ok: true }>): RefusalCode => verdict.code

// ---------------------------------------------------------------------------------------------------------------
// The delisting rule.

/** One coin of the study the delisting card rests on: its announcement's hour, its hold before costs, and after the
 * study's. */
export interface DelistingStudyCoin {
  ticker: string
  hour: number
  grossPct: number
  netPct: number
}

/** The study's coins and when they first reached the card's target (shared/news/delistingStudy.ts). */
export interface DelistingStudy {
  coins: readonly DelistingStudyCoin[]
  touch: { targetPct: number; touched: number; of: number; p25Min: number; p75Min: number }
}

/** The p-quantile of sorted numbers, by straight lines between the order statistics (R's type 7). */
export function quantileOf(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const at = (sorted.length - 1) * Math.min(1, Math.max(0, p))
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}

/** The study's figures, from its coins: what it printed (the mean of announcement-hour means after costs, the coins
 * ahead, the worst), and what the card shows (the median before costs, its target; the 10th and 90th percentiles). */
export function delistingFiguresOf(coins: readonly DelistingStudyCoin[]): {
  coins: number
  hours: number
  hourlyMeanNetPct: number
  ahead: number
  worstNetPct: number
  medianGrossPct: number
  p10GrossPct: number
  p90GrossPct: number
} {
  const byHour = new Map<number, number[]>()
  for (const coin of coins) byHour.set(coin.hour, [...(byHour.get(coin.hour) ?? []), coin.netPct])
  const hourMeans = [...byHour.values()].map((list) => list.reduce((a, b) => a + b, 0) / list.length)
  const gross = coins.map((coin) => coin.grossPct).sort((a, b) => a - b)
  return {
    coins: coins.length,
    hours: byHour.size,
    hourlyMeanNetPct: hourMeans.reduce((a, b) => a + b, 0) / hourMeans.length,
    ahead: coins.filter((coin) => coin.netPct > 0).length,
    worstNetPct: Math.min(...coins.map((coin) => coin.netPct)),
    medianGrossPct: quantileOf(gross, 0.5),
    p10GrossPct: quantileOf(gross, 0.1),
    p90GrossPct: quantileOf(gross, 0.9)
  }
}

/** The live check's reading (V8-S3-DELIST-LIVE): the delistings since its start as the app's record scored them. */
export interface DelistLiveReading {
  hours: number
  coins: number
  /** The mean of announcement-hour means after costs, with its interval; null under two hours. */
  meanPct: number | null
  low: number | null
  high: number | null
  state: 'ok' | 'weaker' | 'withdrawn'
}

/** The live check, from the record's scored holds since its start. */
export function delistLiveOf(rows: readonly { releaseSec: number; netPct: number }[], lines: typeof DELIST_LIVE_LINES = DELIST_LIVE_LINES): DelistLiveReading {
  const since = rows.filter((row) => row.releaseSec >= lines.sinceSec && Number.isFinite(row.netPct))
  const byHour = new Map<number, number[]>()
  for (const row of since) {
    const hour = Math.floor(row.releaseSec / 3600)
    byHour.set(hour, [...(byHour.get(hour) ?? []), row.netPct])
  }
  const hourly = [...byHour.entries()].map(([hour, list]) => ({ hour, sample: [list.reduce((a, b) => a + b, 0) / list.length] }))
  const resampled = hourly.length === 0 ? null : bootstrapOverHours(hourly, [(sums, n): number => sums[0] / n], 1, { ...UNCERTAINTY_LINES, level: lines.level })
  const figure = resampled?.figures[0] ?? null
  const hours = byHour.size
  let state: DelistLiveReading['state'] = 'ok'
  if (figure !== null && hours >= lines.withdraw.minHours && figure.high < lines.withdraw.upperUnderPct) state = 'withdrawn'
  else if (figure !== null && hours >= lines.weaker.minHours && figure.value < lines.weaker.meanUnderPct) state = 'weaker'
  return { hours, coins: since.length, meanPct: figure?.value ?? null, low: figure?.low ?? null, high: figure?.high ?? null, state }
}

/** A coin a delisting announcement names, with its Binance USDT pair. */
export interface DelistingCandidate {
  articleId: number
  title: string
  releaseSec: number
  ticker: string
  pair: string
}

/** The minute the rule's hold ends: the open 240 minutes after the announcement's minute. */
export const delistingExitAt = (releaseSec: number, lines: typeof DELISTING_CARD_LINES = DELISTING_CARD_LINES): number => Math.floor(releaseSec / 60) * 60 + lines.exitBars * 60

/** The delisting card for one coin, or why there is none: within the rule's window, on a price and a fresh book that
 * holds the stake, its expected net from the study's coins less this route's cost clearing the lines, and the rule not
 * withdrawn by its live check. */
export function delistingCardOf(input: {
  candidate: DelistingCandidate
  nowSec: number
  livePrice: number | null
  /** The liquidity gate on Binance's book, a sell at the stake against the card's target. */
  gate: LiquidityVerdict
  stakeQuote: number
  study: DelistingStudy
  live: DelistLiveReading
  predictionId: string
}): PrimaryCard | CardRefusal {
  const { candidate, nowSec, study, live } = input
  const refuse = (refused: RefusalCode, expectedNet: CardRefusal['expectedNet'] = null): CardRefusal => ({ refused, source: 'delisting-rule', pair: candidate.pair, eventAt: candidate.releaseSec, expectedNet })
  if (live.state === 'withdrawn') return refuse('withdrawn')
  if (nowSec - candidate.releaseSec > DELISTING_CARD_LINES.windowSec) return refuse('late')
  if (study.coins.length === 0) return refuse('no-evidence')
  if (input.livePrice === null || !(input.livePrice > 0)) return refuse('no-price')
  if (!input.gate.ok) return refuse(gateRefusal(input.gate))
  const figures = delistingFiguresOf(study.coins)
  const exitAt = delistingExitAt(candidate.releaseSec)
  const entryAt = Math.ceil(nowSec / 60) * 60
  const trip = input.gate.trip
  const fundingPct = fundingAgainstPct(entryAt, exitAt)
  const cost: CardCost = { venue: trip.venue, basis: trip.basis, side: 'SELL', stakeQuote: input.stakeQuote, feePct: trip.feePct, spreadPct: trip.spreadPct, impactPct: trip.impactPct, fundingPct, totalPct: trip.totalPct + fundingPct }
  const net = expectedNetOf(
    study.coins.map((coin) => ({ unit: coin.hour, favourablePct: coin.grossPct })),
    cost.totalPct
  )
  if (net === null) return refuse('no-evidence')
  if (!clearsLines(net)) return refuse('under-lines', { pct: net.value, low: net.low, high: net.high })
  const movePct = figures.medianGrossPct
  const minute = Math.floor(candidate.releaseSec / 60) * 60
  return {
    v: PRIMARY_CALL_VERSION,
    source: 'delisting-rule',
    sourceVersion: DELISTING_CARD_LINES.version,
    registration: CARD_SOURCES['delisting-rule'].registration,
    predictionId: input.predictionId,
    pair: candidate.pair,
    venue: trip.venue,
    side: 'down',
    madeAt: nowSec,
    eventAt: candidate.releaseSec,
    refPrice: input.livePrice,
    movePct,
    targetPrice: input.livePrice * (1 - movePct / 100),
    exitAt,
    arrival:
      study.touch.of > 0 && study.touch.touched > 0
        ? { fromSec: minute + study.touch.p25Min * 60 - candidate.releaseSec, toSec: minute + study.touch.p75Min * 60 - candidate.releaseSec, touchedShare: study.touch.touched / study.touch.of }
        : null,
    scenarios: { forPct: figures.p90GrossPct, againstPct: figures.p10GrossPct, worstPct: figures.worstNetPct },
    cost,
    netAtTargetPct: movePct - cost.totalPct,
    expectedNet: { pct: net.value, low: net.low, high: net.high, calls: study.coins.length, units: figures.hours },
    ahead: { count: figures.ahead, of: figures.coins },
    evidence: [`binance:${candidate.articleId}`],
    detail: { kind: 'delisting', ticker: candidate.ticker, title: candidate.title, hours: figures.hours, coins: figures.coins, weaker: live.state === 'weaker' }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A direction model's call (none today: no model has cleared the direction bar twice).

/** A promoted direction model's card at a horizon: its walk forward's calls' mean move in their way (the record keeps
 * it after the flat round trip, which is added back) less this route's cost, with the record's interval moved the same
 * way; refused unless the range's P(up) is read from a direction model and calls a way. */
export function modelCardOf(input: {
  pair: string
  nowSec: number
  horizonSec: number
  pUpSource: PUpSource | undefined
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  livePrice: number | null
  /** The model's calls on its walk forward: their count, their mean move after the flat round trip, its interval and
   * the hours they rest on. */
  record: { calls: number; meanPct: number; ci: { low: number; high: number } | null; hours: number } | null
  /** The range's quantiles in percent from the price, [P10, P25, P50, P75, P90]. */
  quantilesPct: readonly [number, number, number, number, number]
  gate: LiquidityVerdict
  stakeQuote: number
  predictionId: string
}): PrimaryCard | CardRefusal | null {
  if (!isCardSideSource(input.pUpSource) || input.direction === 'NEUTRAL') return null
  const side = input.direction === 'BULLISH' ? 'up' : 'down'
  const refuse = (refused: RefusalCode, expectedNet: CardRefusal['expectedNet'] = null): CardRefusal => ({ refused, source: 'direction-model', pair: input.pair, eventAt: null, expectedNet })
  if (input.record === null || input.record.ci === null || input.record.calls === 0) return refuse('no-evidence')
  if (input.livePrice === null || !(input.livePrice > 0)) return refuse('no-price')
  if (!input.gate.ok) return refuse(gateRefusal(input.gate))
  const trip = input.gate.trip
  const fundingPct = side === 'down' ? fundingAgainstPct(input.nowSec, input.nowSec + input.horizonSec) : 0
  const totalPct = trip.totalPct + fundingPct
  const shift = ROUND_TRIP_PCT - totalPct
  const net = { value: input.record.meanPct + shift, low: input.record.ci.low + shift, high: input.record.ci.high + shift }
  if (!clearsLines(net)) return refuse('under-lines', { pct: net.value, low: net.low, high: net.high })
  const sign = side === 'up' ? 1 : -1
  const q = input.quantilesPct
  const movePct = Math.max(0, sign * q[2])
  return {
    v: PRIMARY_CALL_VERSION,
    source: 'direction-model',
    sourceVersion: input.pUpSource,
    registration: CARD_SOURCES['direction-model'].registration,
    predictionId: input.predictionId,
    pair: input.pair,
    venue: trip.venue,
    side,
    madeAt: input.nowSec,
    eventAt: null,
    refPrice: input.livePrice,
    movePct,
    targetPrice: input.livePrice * (1 + (sign * movePct) / 100),
    exitAt: input.nowSec + input.horizonSec,
    arrival: null,
    scenarios: { forPct: side === 'up' ? q[4] : -q[0], againstPct: side === 'up' ? q[0] : -q[4], worstPct: side === 'up' ? q[0] - totalPct : -q[4] - totalPct },
    cost: { venue: trip.venue, basis: trip.basis, side: side === 'up' ? 'BUY' : 'SELL', stakeQuote: input.stakeQuote, feePct: trip.feePct, spreadPct: trip.spreadPct, impactPct: trip.impactPct, fundingPct, totalPct },
    netAtTargetPct: movePct - totalPct,
    expectedNet: { pct: net.value, low: net.low, high: net.high, calls: input.record.calls, units: input.record.hours },
    ahead: { count: 0, of: 0 },
    evidence: [],
    detail: { kind: 'model', model: input.pUpSource, horizonSec: input.horizonSec }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The call: the best card, or none.

/** A coin a delisting named whose rule's window has passed: how far it has moved since the announcement. */
export interface LateCall {
  pair: string
  ticker: string
  eventAt: number
  exitAt: number
  /** From the open of the announcement's minute to the price now, signed; null where either is not read. */
  movedSincePct: number | null
}

export interface PrimaryCallState {
  v: typeof PRIMARY_CALL_VERSION
  /** When it was weighed, in seconds. */
  at: number
  /** Every card that cleared its lines, the largest expected net first; the first is the primary call. */
  cards: PrimaryCard[]
  /** The delisted coins past the rule's window, until their hold would have ended. */
  late: LateCall[]
  refused: CardRefusal[]
  /** The rule's live check, and whether the announcements are read at all. */
  delistLive: DelistLiveReading | null
  readerOn: boolean
  /** Promoted direction models in use at any horizon: none until one clears the bar twice. */
  modelSources: number
}

/** Each coin's card state at a whole hour (predictions/cards-YYYY-MM.jsonl): its card, or none and why -- `no-source`
 * where no source that may set a side called it at all. */
export const CARD_STATE_VERSION = 'card-state-v1'
export interface CardStateLine {
  v: typeof CARD_STATE_VERSION
  at: number
  pair: string
  state: 'card' | 'none'
  source: CardSource | null
  predictionId: string | null
  why: RefusalCode | 'no-source' | null
}

/** The hour's card state of each coin: the cards', the refused candidates', and `no-source` for every other coin read. */
export function cardStatesOf(atSec: number, state: Pick<PrimaryCallState, 'cards' | 'refused'>, pairs: readonly string[]): CardStateLine[] {
  const out = new Map<string, CardStateLine>()
  for (const card of state.cards) out.set(card.pair, { v: CARD_STATE_VERSION, at: atSec, pair: card.pair, state: 'card', source: card.source, predictionId: card.predictionId, why: null })
  for (const refusal of state.refused) {
    if (!out.has(refusal.pair)) out.set(refusal.pair, { v: CARD_STATE_VERSION, at: atSec, pair: refusal.pair, state: 'none', source: refusal.source, predictionId: null, why: refusal.refused })
  }
  for (const pair of pairs) if (!out.has(pair)) out.set(pair, { v: CARD_STATE_VERSION, at: atSec, pair, state: 'none', source: null, predictionId: null, why: 'no-source' })
  return [...out.values()].sort((a, b) => a.pair.localeCompare(b.pair))
}

/** Orders the cards: the largest expected net first, a tie to the earlier made. */
export function rankCards(cards: readonly PrimaryCard[]): PrimaryCard[] {
  return [...cards].sort((a, b) => b.expectedNet.pct - a.expectedNet.pct || a.madeAt - b.madeAt)
}

export const isCard = (value: PrimaryCard | CardRefusal | null): value is PrimaryCard => value !== null && 'v' in value
