import { AI_ADDITION_PROMPT_VERSIONS, REVIEW_LINES, newsReadingsOf, reviewRefusal, type NewsReading, type TradeReview } from '../../shared/aiAdditions'
import type { AiConfig } from '../../shared/aiCost'
import { aiExitOutcome, aiExitPlanEnd, aiExitPlanParams, aiExitPlanResult, aiExitWrite, type AiExitOrder } from '../../shared/aiExit'
import type { AiSignalDecision } from '../../shared/aiSignal'
import { MARKET_REFERENCE_SYMBOLS } from '../../shared/aiEventMarket'
import {
  btcMoveAgainst,
  describeWatchPaperEntry,
  planWatchPaperTrade,
  watchPaperBlock,
  watchPaperDropNotice,
  watchPaperExecutors,
  watchPaperNotice,
  type WatchPaperOutcome,
  type WatchPaperPlan
} from '../../shared/aiWatchPaper'
import type { AppSettings, Candle, Exchange, ExecutorConfig, PaperAccount, PaperRiskSettings, PositionExecutorParams } from '../../shared/ipc'
import { bookSpreadPct, livePaperBlock, priceAgeMs, streamedEntry, thinBookBlock, type LiveBook } from '../../shared/liveMarket'
import type { MarketEvent } from '../../shared/marketEvent'
import { CORRELATED_SHARE, correlatedCap, correlatedExposureBlock, correlatedOut, readBtcCorrelation, tracksBtc } from '../../shared/paperExposure'
import { RISK_LINES, volatilityRatio } from '../../shared/dynamicRisk'
import { aiCostPct, modelCostPerTrade } from '../../shared/aiCostPerTrade'
import { newsAgainstBlock, type NewsAgainstStory } from '../../shared/paperNewsBlock'
import { healPaperPause, paperPauseBlock } from '../../shared/paperPause'
import { NEAR_STOP_SHARE, nearStopNotice, paperCloseNotice, stopProgress, type NoticeExtra } from '../../shared/notices'
import type { AiCallFilter, AiCallPage, AiCallRecord } from '../../shared/aiLedger'
import { EV_LINES, calibratedWinRate, expectedValueBlock, tradeExpectedValue, watchOutcomes, type TradeEv } from '../../shared/expectedValue'
import { excursionOf } from '../../shared/research/excursions'
import { healPaperRisk, paperEquity, paperOutBlock, rMultiple } from '../../shared/paperRisk'
import { describeExecutorFunding } from '../account/executorFunding'
import { settleExecutorOnStop } from '../account/settleExecutor'
import { runExecutorSimulation } from '../executors/engine'
import { settingsWrites } from '../utils/settingsWrites'
import { ENGLISH, type I18n } from '../../shared/i18n/translate'
import { noticeI18n } from '../i18n/current'

// THE ONE FILE OF THE WATCH'S THAT WRITES ANYTHING (shared/aiWatchPaper.ts has the rules).
//
// Two things happen here, and both are paper bookkeeping. A call the watch would act on becomes a
// PAPER Position executor, appended to the executors on file, unless its limits, the paper money
// the app's own trades have out, what they have out on one side on coins that move with Bitcoin
// (shared/paperExposure.ts), a losing run of its own (shared/paperPause.ts), the reviewer's REJECT
// where something about the trade stood out (shared/aiAdditions.ts), the live price -- none
// fresh, or a spread over 0.1% (shared/liveMarket.ts) -- or, since 8 October 2026, a best level on
// the side a fill would take that cannot hold the stake (the same file), or major news on the coin
// pointing against the side (shared/paperNewsBlock.ts), refuse it. And
// a paper position of the watch's that has closed -- its stop, its target or its clock ended it,
// or its entry expired unfilled -- is stopped and its result settled into the paper account, the
// way pressing Stop on its card would, so that the money comes back and the count of open trades
// goes down. So is one still waiting for its entry when Bitcoin has moved against it by more than
// its safeguard allows.
//
// And since 6 October 2026, the exit check's EXIT (shared/aiExit.ts): an open paper trade of the
// watch's has its time limit brought forward, so that it closes at the next minute by the engine's
// own rule and is stopped and settled above like any other. Nothing else about it changes. Once the
// plan's own time has passed, what the plan would have made is written beside how it did end.
//
// PAPER IS WRITTEN HERE AS A LITERAL. watchPaperExecutor takes no mode and has no way to be given
// one. Nothing in this file mentions the bridge a real order travels over, and
// tests/aiNoLivePath.test.ts reads this file to make sure of both.
//
// EVERY WRITE GOES THROUGH THE ONE QUEUE (src/utils/settingsWrites.ts), on executors read inside
// it: Strategies › Execution, a controller and this file all replace the same array.

type OkPlan = Extract<WatchPaperPlan, { ok: true }>

/** The executor a plan becomes. Paper, unlevered, and its position is not kept when it stops:
 * a paper trade the watch opened is closed by its own levels, not handed to Inventory. The live
 * book it was opened against, where there was one, and its pair's correlation with Bitcoin, where
 * it was read for it, are written on its mark. Since 8 October 2026, where that book's fill price
 * is inside the entry range, the trade enters there and then (PositionExecutorParams.entryFill,
 * shared/liveMarket.ts streamedEntry) instead of waiting for a minute bar inside the range; the
 * recommendation's score stays on minute bars, and the two are shown side by side. */
export function watchPaperExecutor(input: {
  id: string
  event: Pick<MarketEvent, 'exchange' | 'symbol' | 'baseAsset' | 'quoteAsset'>
  plan: OkPlan
  nowSec: number
  book?: LiveBook | null
  btcCorrelation?: number | null
  /** The call's expected value (shared/expectedValue.ts), written on the mark. */
  ev?: TradeEv | null
}): ExecutorConfig {
  const { event, plan, book } = input
  const spread = book === undefined || book === null ? null : bookSpreadPct(book)
  const withBook =
    book === undefined || book === null || spread === null
      ? plan.mark
      : { ...plan.mark, book: { bid: book.bid, ask: book.ask, spreadPct: spread, ageMs: priceAgeMs(book, input.nowSec * 1000), source: book.source } }
  const mark = input.btcCorrelation === undefined ? withBook : { ...withBook, btcCorrelation: input.btcCorrelation }
  const marked = input.ev === undefined || input.ev === null ? mark : { ...mark, ev: input.ev }
  const fill = book === undefined || book === null ? null : streamedEntry(book, plan.params, input.nowSec * 1000)
  return {
    id: input.id,
    name: plan.name,
    type: 'position',
    exchange: event.exchange,
    symbol: event.symbol,
    baseAsset: event.baseAsset,
    quoteAsset: event.quoteAsset,
    createdAt: input.nowSec,
    status: 'active',
    stoppedAt: null,
    keepPosition: false,
    mode: 'paper',
    watch: marked,
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params: fill === null ? plan.params : { ...plan.params, entryFill: fill }
  }
}

export interface WatchPaperDeps {
  getConfig: () => Promise<Pick<AiConfig, 'watchPaper'>>
  getSettings: () => Promise<Pick<AppSettings, 'executors' | 'paperAccount' | 'paperRisk' | 'paperPause'>>
  setExecutors: (executors: ExecutorConfig[]) => Promise<void>
  /** The price now, or null when it cannot be had: the event's own price then stands in. */
  lastPrice: (exchange: Exchange, symbol: string) => Promise<number | null>
  /** The live book now (shared/liveMarket.ts): the stream's, or one read just now. Null when none
   * can be had, and then no paper trade is opened. */
  liveBook: (exchange: Exchange, symbol: string) => Promise<LiveBook | null>
  /** 1-minute candles of [startSec, endSec]. */
  fetchCandles: (exchange: Exchange, symbol: string, startSec: number, endSec: number) => Promise<Candle[]>
  /** Fifteen-minute candles of [startSec, endSec], for the pair's range now against its usual
   * (shared/dynamicRisk.ts; since 8 October 2026). */
  fifteenMinuteCandles: (exchange: Exchange, symbol: string, startSec: number, endSec: number) => Promise<Candle[]>
  /** The pair's hourly moves over the last week against Bitcoin's (shared/paperExposure.ts), or
   * null when they cannot be read: it then counts as a pair that tracks Bitcoin. */
  btcCorrelation: (exchange: Exchange, symbol: string) => Promise<number | null>
  /** The market's regime now (shared/marketResearch.ts), written on the trade's mark for where the
   * result came from (shared/performance/attribution.ts); null where the research has not read it.
   * A record: nothing here decides by it. */
  regime: () => Promise<'panic' | 'high-vol' | 'recovery' | 'bull' | 'bear' | 'sideways' | null>
  /** The reviewer's second look (shared/aiAdditions.ts), asked in the main process only when
   * something about the trade stands out. Its REJECT refuses the trade; anything else leaves it. */
  review: (event: MarketEvent, decision: AiSignalDecision) => Promise<TradeReview>
  /** The stories on file that name coins (shared/newsFeed.ts), for the news against a trade. */
  stories: () => Promise<NewsAgainstStory[]>
  /** The news analyst's readings by story id, from `sinceSec` on. */
  readings: (sinceSec: number) => Promise<Record<string, NewsReading>>
  /** The ledger's rows (shared/aiLedger.ts), for the calibrated win rate the expected value is read
   * at (shared/expectedValue.ts): the watch's calls over the last ninety days. */
  listCalls: (filter: AiCallFilter) => Promise<AiCallPage>
  /** Books a stopped paper executor's result into the paper account. */
  settle: (executor: ExecutorConfig, nowSec: number) => Promise<unknown>
  /** A desktop notice, with its kind and thread (shared/notices.ts). */
  notify: (title: string, body: string, extra?: NoticeExtra) => void
  nowSec: () => number
  newId: () => string
  /** Runs a read-modify-write of settings with no other one inside it. */
  queue: <T>(work: () => Promise<T>) => Promise<T>
  /** The language the person reads its notices and its card's line in (V6 Stage 14); English where
   * absent. What it records is English whatever this is. */
  i18n?: () => I18n
}

export interface WatchPaperResult {
  opened: boolean
  /** One sentence, in English: what is recorded and refused by. */
  text: string
  /** The same sentence in the person's language, for the Watch card and a notice, where it is not the English. */
  shown?: string
}

/** A result, with its sentence in the person's language where that differs from the English. */
function resultOf(opened: boolean, text: string, shown: string): WatchPaperResult {
  return shown === text ? { opened, text } : { opened, text, shown }
}

/** Rows of the ledger read for the calibrated rate, at most. */
const EV_ROWS = 5000

/** The call's expected value for the plan (shared/expectedValue.ts): at the watch's own calibrated
 * win rate where its record is long enough, else at the model's confidence. Null without a stop or
 * a target. A ledger that cannot be read leaves the model's confidence. */
async function expectedValueOf(event: MarketEvent, decision: AiSignalDecision, plan: OkPlan, book: LiveBook | null, executors: ExecutorConfig[], deps: WatchPaperDeps): Promise<TradeEv | null> {
  let rows: AiCallRecord[] = []
  try {
    rows = (await deps.listCalls({ source: 'watch', sinceSec: deps.nowSec() - EV_LINES.days * 86_400, limit: EV_ROWS })).rows
  } catch {
    rows = []
  }
  const calibrated = calibratedWinRate(watchOutcomes(executors, rows), { model: decision.model, eventType: event.type, side: plan.side }, deps.nowSec())
  // What the model's answers cost a trade (shared/aiCostPerTrade.ts), over the last thirty days of
  // the ledger, every source: the watch's calls and the additions' looks. Part of the costs the
  // value is net of (the V5 document, §73). A ledger that cannot be read charges nothing.
  let costRows: AiCallRecord[] = []
  try {
    costRows = (await deps.listCalls({ sinceSec: deps.nowSec() - AI_COST_DAYS * 86_400, limit: EV_ROWS })).rows
  } catch {
    costRows = []
  }
  return tradeExpectedValue({
    confidence: decision.confidence,
    calibrated,
    stopPct: plan.params.stopLossPct,
    targetPct: plan.params.takeProfitPct,
    spreadPct: book === null ? null : bookSpreadPct(book),
    slippageRate: plan.params.slippageRate,
    aiCostPct: aiCostPct(modelCostPerTrade(decision.model, executors, costRows), plan.params.amountQuote)
  })
}

/** Days of the ledger the model's cost a trade is read over, as the Performance card reads it. */
const AI_COST_DAYS = 30

/** The conditions a trade would be entered in (shared/dynamicRisk.ts), from what was read: the live
 * book's spread and best level, the pair's range against its usual, the vote's tally, and what the
 * app's own paper trades have out on this side on coins that move with Bitcoin, as a share of the
 * paper money the cap is a share of. What could not be read is null, and reduces nothing. */
function conditionsOf(input: {
  book: LiveBook | null
  side: 'buy' | 'sell'
  volatilityRatio: number | null
  vote?: { taking: number; usable: number }
  executors: ExecutorConfig[]
  account: PaperAccount | null
  risk: PaperRiskSettings
  quoteAsset: string
  btcCorrelation: number | null
}): NonNullable<Parameters<typeof planWatchPaperTrade>[0]['conditions']> {
  const cap = correlatedCap({ account: input.account, risk: input.risk, quoteAsset: input.quoteAsset })
  const correlatedShare = cap === null || !(cap > 0) || !tracksBtc(input.btcCorrelation) ? null : correlatedOut(input.executors, input.side, input.quoteAsset) / (cap / CORRELATED_SHARE)
  return {
    volatilityRatio: input.volatilityRatio,
    spreadPct: input.book === null ? null : bookSpreadPct(input.book),
    bestLevelQuote: input.book === null ? null : input.side === 'buy' ? input.book.ask * input.book.askQty : input.book.bid * input.book.bidQty,
    dissent: input.vote === undefined ? null : input.vote.usable > input.vote.taking,
    correlatedShare
  }
}

/** Opens a paper trade on an answer the watch got, if that is switched on and its limits allow.
 * Null when there is nothing to say: paper trades are off, or the answer is another model's.
 * Never throws for a trade it decides not to make; that is a result. */
export async function openWatchPaperTrade(
  event: MarketEvent,
  decision: AiSignalDecision,
  deps: WatchPaperDeps,
  options: {
    /** The answer is the one the models' vote chose (shared/opportunityVote.ts, since 8 October
     * 2026): followed whichever model gave it. Without it, only the named model's answers are. */
    byVote?: boolean
    /** How many of the vote's usable answers took the side: one not on it reduces the risk. */
    vote?: { taking: number; usable: number }
  } = {}
): Promise<WatchPaperResult | null> {
  const { watchPaper } = await deps.getConfig()
  if (!watchPaper.enabled || (options.byVote !== true && decision.model !== watchPaper.model)) return null
  // English for the record and the rules that read it; the person's language for what they read.
  const say = deps.i18n?.() ?? ENGLISH
  const refusedWith = (text: string, shown: string): WatchPaperResult => resultOf(false, `No paper trade: ${text}`, say.t('No paper trade: {reason}', { reason: shown }))

  const before = await deps.getSettings()
  // Its own limits, then the losing run that pauses the app's own paper trades (shared/paperPause.ts).
  const blockedIn = (i18n: I18n): string | null =>
    watchPaperBlock({ config: watchPaper, event, decision, executors: before.executors, nowSec: deps.nowSec(), byVote: options.byVote === true }, i18n) ??
    paperPauseBlock({ setting: healPaperPause(before.paperPause), executors: before.executors, source: 'watch' }, i18n)
  const blocked = blockedIn(ENGLISH)
  if (blocked !== null) return refusedWith(blocked, blockedIn(say) ?? blocked)

  let lastPrice: number | null = null
  try {
    lastPrice = await deps.lastPrice(event.exchange, event.symbol)
  } catch {
    lastPrice = null
  }
  const readBook = async (): Promise<LiveBook | null> => {
    try {
      return await deps.liveBook(event.exchange, event.symbol)
    } catch {
      return null
    }
  }
  // The conditions it would be entered in (shared/dynamicRisk.ts; since 8 October 2026), read
  // together before it is sized: the live book, the pair's fifteen-minute range against its
  // thirty-day usual, and whether the pair moves with Bitcoin (for what is out on this side). What
  // cannot be read is null and reduces nothing: the risk only ever falls on what was read.
  const readVolatility = async (): Promise<number | null> => {
    try {
      const now = deps.nowSec()
      return volatilityRatio(await deps.fifteenMinuteCandles(event.exchange, event.symbol, now - RISK_LINES.usualDays * 86_400, now), now)
    } catch {
      return null
    }
  }
  const readCorrelation = async (): Promise<number | null> => {
    try {
      return await deps.btcCorrelation(event.exchange, event.symbol)
    } catch {
      return null
    }
  }
  const readRegime = async (): Promise<Awaited<ReturnType<WatchPaperDeps['regime']>>> => {
    try {
      return await deps.regime()
    } catch {
      return null
    }
  }
  // The book after the rest: thirty days of candles can take as long as a request's timeout, and a
  // book read beside them was judged on a market that had moved on -- the rehearsal of 15 October 2026
  // refused a trade on a price 17 seconds old, held that long by a candle read that timed out.
  const [volatility, btcCorrelation, regime] = await Promise.all([readVolatility(), readCorrelation(), readRegime()])
  const first = await readBook()
  const risk = healPaperRisk(before.paperRisk)
  const planIn = (i18n: I18n): WatchPaperPlan =>
    planWatchPaperTrade({
      config: watchPaper,
      risk,
      event,
      decision,
      nowSec: deps.nowSec(),
      lastPrice,
      equityQuote: paperEquity(before.paperAccount ?? null, event.quoteAsset),
      regime,
      conditions: conditionsOf({
        book: first,
        side: decision.recommendation === 'sell' ? 'sell' : 'buy',
        volatilityRatio: volatility,
        vote: options.vote,
        executors: before.executors,
        account: before.paperAccount ?? null,
        risk,
        quoteAsset: event.quoteAsset,
        btcCorrelation
      }),
      i18n
    })
  const plan = planIn(ENGLISH)
  // The same plan in the person's language: its words only, for the notice and the card.
  const shownPlan = say === ENGLISH ? plan : planIn(say)
  if (!plan.ok) return refusedWith(plan.reason, shownPlan.ok ? plan.reason : shownPlan.reason)

  // The market it would enter, live (shared/liveMarket.ts): with no fresh price, a spread wider than
  // a trade is entered at, or a best level that cannot hold the stake, none is opened; nor against
  // major news on the coin (shared/paperNewsBlock.ts). Looked at before a second look is asked for,
  // so that the reviewer is not asked about a trade that could not be opened.
  const marketIn = (i18n: I18n): string | null => livePaperBlock(first, deps.nowSec() * 1000, i18n) ?? thinBookBlock(first, plan.side, plan.params.amountQuote, i18n)
  const market = marketIn(ENGLISH)
  if (market !== null) return refusedWith(market, marketIn(say) ?? market)
  const news = await newsAgainst(event, plan.side, deps, say)
  if (news !== null) return refusedWith(news.text, news.shown)

  // The expected value (shared/expectedValue.ts): refused only at a CALIBRATED win rate under the
  // margin a round trip costs; at the model's own confidence it is written on the trade and never
  // refuses. Read before the reviewer, so no second look is paid for on a trade this refuses.
  const ev = await expectedValueOf(event, decision, plan, first, before.executors, deps)
  const evBlock = expectedValueBlock(ev)
  if (evBlock !== null) return refusedWith(evBlock, expectedValueBlock(ev, say) ?? evBlock)

  // A second look, where something about this trade stands out: its REJECT means no trade. A review
  // that was not asked, refused or could not be had leaves the trade as it was: it only opens less.
  let review: TradeReview | null = null
  try {
    review = await deps.review(event, decision)
  } catch {
    review = null
  }
  const rejected = reviewRefusal(review)
  if (rejected !== null) return refusedWith(rejected, reviewRefusal(review, say) ?? rejected)

  // Read again, as a review can take seconds: the trade is judged on the market as it is now.
  const book = await readBook()

  // Checked again on the executors read inside the queue, with the funds and with what the app's
  // own paper trades have out together, and on one side on coins that move with Bitcoin: two
  // answers arriving together both passed the look above, and only one of them may be the pair's
  // open trade. A trade that closed in between may have ended a losing run, and that is read again
  // too; and the live price is judged as of now.
  const made: { executor: ExecutorConfig | null } = { executor: null }
  const refused = await deps.queue(async (): Promise<{ text: string; shown: string } | null> => {
    const fresh = await deps.getSettings()
    const problemIn = (i18n: I18n): string | null =>
      watchPaperBlock({ config: watchPaper, event, decision, executors: fresh.executors, nowSec: deps.nowSec(), byVote: options.byVote === true }, i18n) ??
      paperPauseBlock({ setting: healPaperPause(fresh.paperPause), executors: fresh.executors, source: 'watch' }, i18n) ??
      livePaperBlock(book, deps.nowSec() * 1000, i18n) ??
      thinBookBlock(book, plan.side, plan.params.amountQuote, i18n) ??
      describeExecutorFunding(
        {
          account: fresh.paperAccount ?? null,
          executors: fresh.executors,
          mode: 'paper',
          quoteAsset: event.quoteAsset,
          amountQuote: plan.params.amountQuote
        },
        i18n
      ) ??
      paperOutBlock({ risk: healPaperRisk(fresh.paperRisk), executors: fresh.executors, quoteAsset: event.quoteAsset, amountQuote: plan.params.amountQuote }, i18n) ??
      correlatedExposureBlock(
        {
          account: fresh.paperAccount ?? null,
          risk: healPaperRisk(fresh.paperRisk),
          executors: fresh.executors,
          quoteAsset: event.quoteAsset,
          side: plan.side,
          amountQuote: plan.params.amountQuote,
          correlation: btcCorrelation
        },
        i18n
      )
    const problem = problemIn(ENGLISH)
    if (problem !== null) return { text: problem, shown: problemIn(say) ?? problem }
    const executor = watchPaperExecutor({ id: deps.newId(), event, plan, nowSec: deps.nowSec(), book, btcCorrelation, ev })
    await deps.setExecutors([...fresh.executors, executor])
    made.executor = executor
    return null
  })
  if (refused !== null) return refusedWith(refused.text, refused.shown)

  const notice = watchPaperNotice(event, plan, say, shownPlan.ok ? shownPlan.riskNote : plan.riskNote)
  try {
    deps.notify(notice.title, notice.body, { kind: 'TRADE_EXECUTED', thread: made.executor?.id ?? event.id })
  } catch {
    // A desktop that cannot show it is not a reason to report a trade that was opened as not.
  }
  const entered = (made.executor?.params as PositionExecutorParams | undefined) ?? plan.params
  const riskNote = shownPlan.ok ? shownPlan.riskNote : plan.riskNote
  const values = { amount: String(plan.params.amountQuote), asset: event.quoteAsset, entry: describeWatchPaperEntry(entered, say), risk: riskNote ?? '' }
  return resultOf(
    true,
    `A paper ${plan.side === 'buy' ? 'BUY' : 'SELL'} of ${plan.params.amountQuote} ${event.quoteAsset} was opened, ${describeWatchPaperEntry(entered)}${plan.riskNote === null ? '' : `, at ${plan.riskNote}`}.`,
    plan.side === 'buy'
      ? riskNote === null
        ? say.t('A paper BUY of {amount} {asset} was opened, {entry}.', values)
        : say.t('A paper BUY of {amount} {asset} was opened, {entry}, at {risk}.', values)
      : riskNote === null
        ? say.t('A paper SELL of {amount} {asset} was opened, {entry}.', values)
        : say.t('A paper SELL of {amount} {asset} was opened, {entry}, at {risk}.', values)
  )
}

/** News against the trade (shared/paperNewsBlock.ts): a story of major impact naming the coin, from
 * the reviewer's three hours before the event to now, pointing the other way. Stories or readings
 * that cannot be read refuse nothing: as with the reviewer, what could not be had leaves the trade
 * as it was. */
async function newsAgainst(event: MarketEvent, side: 'buy' | 'sell', deps: WatchPaperDeps, say: I18n): Promise<{ text: string; shown: string } | null> {
  try {
    const [stories, readings] = await Promise.all([deps.stories(), deps.readings(event.time - REVIEW_LINES.majorNewsSeconds)])
    const input = { event, side, stories, readings, nowSec: deps.nowSec() }
    const text = newsAgainstBlock(input)
    return text === null ? null : { text, shown: newsAgainstBlock(input, say) ?? text }
  } catch {
    return null
  }
}

/** Stops and settles each paper trade of the watch's whose position has closed. Returns the names
 * of the ones it settled.
 *
 * A POSITION IS JUDGED ON MINUTES THAT HAVE CLOSED. A forming candle has a low and a high that are
 * not yet facts, and a stop "hit" by one may not be hit when the minute ends.
 *
 * A TRADE IS SETTLED ONCE. It is stopped inside the queue, on the executors read there, and only
 * the pass that found it still active goes on to settle it: so two passes that overlap, and an
 * executor someone stopped or deleted by hand while its candles were being read, each end with
 * its result booked exactly once, by whoever stopped it.
 *
 * HOW IT ENDED IS WRITTEN ON IT in the same write that stops it: the exit and what it made or
 * lost. The paper account, where there is one, is told the same figure by the settlement. */
export async function settleWatchPaperTrades(deps: WatchPaperDeps): Promise<string[]> {
  const settled: string[] = []
  const { executors } = await deps.getSettings()
  await measureWatchExitPlans(executors, deps)
  const active = watchPaperExecutors(executors).filter((entry) => entry.status === 'active')
  if (active.length === 0) return settled
  // The safeguard as it is set now, and Bitcoin's minutes read once a pass for every trade that
  // needs them, from the earliest of their events.
  const { watchPaper } = await deps.getConfig()
  const btcMinutes = new Map<Exchange, Promise<Candle[]>>()
  const bitcoin = (exchange: Exchange, nowSec: number): Promise<Candle[]> => {
    let read = btcMinutes.get(exchange)
    if (read === undefined) {
      const fromSec = Math.min(...active.map((entry) => entry.watch?.eventTime ?? nowSec)) - 60
      read = deps.fetchCandles(exchange, MARKET_REFERENCE_SYMBOLS.btc, fromSec, nowSec).then((bars) => bars.filter((bar) => bar.time + 60 <= nowSec))
      btcMinutes.set(exchange, read)
    }
    return read
  }
  for (const executor of active) {
    try {
      const nowSec = deps.nowSec()
      const candles = (await deps.fetchCandles(executor.exchange, executor.symbol, executor.createdAt, nowSec)).filter((bar) => bar.time + 60 <= nowSec)
      if (candles.length === 0) continue
      const state = runExecutorSimulation(candles, executor, candles[0].close)
      if (state.kind !== 'position') continue
      let found: WatchPaperOutcome | null = null
      if (state.status === 'closed' && state.exitReason !== null) {
        // How it ended goes on its mark: a stopped executor is not simulated again, so this is what
        // its card and the Watch card have to show, with or without a paper account. One the exit
        // check's time limit ended is the check's exit.
        // With how far the price went for it and against it while it was held (shared/research/excursions.ts).
        const held = state.enteredAt === null ? [] : candles.filter((bar) => bar.time >= (state.enteredAt ?? 0) && (state.closedAt === null || bar.time <= state.closedAt))
        const excursions = state.enteredAt === null || state.entryPrice === null ? {} : excursionOf(held, state.entryPrice, (executor.params as PositionExecutorParams).side)
        found = { exit: aiExitOutcome(state.exitReason, executor.watch?.aiExit), pnlQuote: state.realizedPnl ?? 0, closedAt: state.closedAt ?? nowSec, ...excursions }
      } else if (state.status === 'pending' && executor.watch !== undefined && watchPaper.dropOnBtcMovePct > 0) {
        // Still waiting for its entry: dropped when Bitcoin has moved against it since the event.
        const movePct = btcMoveAgainst({
          side: (executor.params as PositionExecutorParams).side,
          eventTime: executor.watch.eventTime,
          btc: await bitcoin(executor.exchange, nowSec),
          limitPct: watchPaper.dropOnBtcMovePct
        })
        if (movePct !== null) found = { exit: 'btc_moved', pnlQuote: 0, closedAt: nowSec, btcMovePct: movePct }
      }
      if (found === null) {
        // Still open: within three quarters of the way to its stop, it is told, once per trade per
        // thread. Judged where it is judged, on the last closed minute.
        if (state.status === 'open' && state.levelPrice !== null) {
          const params = executor.params as PositionExecutorParams
          const price = candles[candles.length - 1].close
          const progress = stopProgress({ side: params.side, entryPrice: state.levelPrice, stopPct: params.stopLossPct, price })
          if (progress !== null && progress >= NEAR_STOP_SHARE) {
            const near = nearStopNotice({ id: executor.id, symbol: executor.symbol, side: params.side, real: false }, progress, price, deps.i18n?.() ?? ENGLISH)
            try {
              deps.notify(near.title, near.body, near.extra)
            } catch {
              // A desktop that cannot show it is not a reason to fail the pass.
            }
          }
        }
        continue
      }
      const result: WatchPaperOutcome = found
      const stopped = await deps.queue(async (): Promise<boolean> => {
        const fresh = await deps.getSettings()
        const current = fresh.executors.find((entry) => entry.id === executor.id)
        if (current?.status !== 'active' || current.watch === undefined) return false
        const ended: ExecutorConfig = { ...current, status: 'stopped', stoppedAt: nowSec, watch: { ...current.watch, result } }
        await deps.setExecutors(fresh.executors.map((entry) => (entry.id === executor.id ? ended : entry)))
        return true
      })
      if (!stopped) continue
      await deps.settle(executor, nowSec)
      settled.push(executor.name)
      if (result.exit === 'btc_moved' && executor.watch !== undefined) {
        const notice = watchPaperDropNotice(executor, executor.watch.eventTime, result.btcMovePct ?? 0, deps.i18n?.() ?? ENGLISH)
        try {
          deps.notify(notice.title, notice.body, { kind: 'TRADE_BLOCKED', thread: executor.id })
        } catch {
          // A desktop that cannot show it is not a reason to report a trade that was dropped as not.
        }
      } else if (result.exit !== 'entry_expired' && result.exit !== 'btc_moved') {
        // How it ended, in its own kind: the target reached, the stop triggered, or a trade run out.
        const params = executor.params as PositionExecutorParams
        const closed = paperCloseNotice(
          { id: executor.id, symbol: executor.symbol, side: params.side, quoteAsset: executor.quoteAsset },
          { exit: result.exit, pnlQuote: result.pnlQuote, r: rMultiple(result.pnlQuote, params) },
          deps.i18n?.() ?? ENGLISH
        )
        try {
          deps.notify(closed.title, closed.body, closed.extra)
        } catch {
          // A desktop that cannot show it is not a reason to report a trade that closed as not.
        }
      }
    } catch (failure) {
      // One trade whose candles could not be read is tried again next minute; the others go on.
      console.error(`The watch could not settle its paper trade "${executor.name}":`, failure)
    }
  }
  return settled
}

/** What the plan of each trade the exit check closed would have made, once the plan's own time limit
 * has passed: the same minutes from when the trade was opened, simulated with the time limit it had,
 * and written on its mark beside how it did end. Judged on minutes that have closed, and written
 * once, inside the queue, on the executors read there. */
async function measureWatchExitPlans(executors: ExecutorConfig[], deps: WatchPaperDeps): Promise<void> {
  for (const executor of watchPaperExecutors(executors)) {
    const mark = executor.watch?.aiExit
    if (executor.status !== 'stopped' || mark === undefined || mark.plan !== undefined || executor.watch?.result === undefined) continue
    try {
      const nowSec = deps.nowSec()
      const end = aiExitPlanEnd(mark)
      if (nowSec < end + 60) continue
      const candles = (await deps.fetchCandles(executor.exchange, executor.symbol, executor.createdAt, end + 60)).filter((bar) => bar.time + 60 <= nowSec)
      const plan = { ...executor, params: aiExitPlanParams(executor.params as PositionExecutorParams, mark) }
      const state = candles.length === 0 ? null : runExecutorSimulation(candles, plan, candles[0].close)
      const result = aiExitPlanResult(state?.kind === 'position' ? state : null, mark, nowSec)
      if (result === undefined) continue
      await deps.queue(async (): Promise<void> => {
        const fresh = await deps.getSettings()
        const current = watchPaperExecutors(fresh.executors).find((entry) => entry.id === executor.id)
        if (current?.watch?.aiExit === undefined || current.watch.aiExit.plan !== undefined) return
        const measured: ExecutorConfig = { ...current, watch: { ...current.watch, aiExit: { ...current.watch.aiExit, plan: result } } }
        await deps.setExecutors(fresh.executors.map((entry) => (entry.id === executor.id ? measured : entry)))
      })
    } catch (failure) {
      // Its minutes are read again next minute.
      console.error(`The watch could not measure the plan of "${executor.name}":`, failure)
    }
  }
}

/** Closes one of the watch's open paper trades at the next minute, on the exit check's EXIT: its time
 * limit is brought forward (shared/aiExit.ts), so that the engine ends it by its own rule and the
 * settle loop above stops and books it, and the plan as it was and what was said are written on its
 * mark. Its stop and its target are not touched, and its time is never made longer. Only one of the
 * watch's own paper trades still open, read inside the queue. Returns whether it was brought
 * forward. */
export async function exitWatchPaperTrade(order: AiExitOrder, deps: Pick<WatchPaperDeps, 'getSettings' | 'setExecutors' | 'nowSec' | 'queue'>): Promise<boolean> {
  return deps.queue(async (): Promise<boolean> => {
    const fresh = await deps.getSettings()
    const current = watchPaperExecutors(fresh.executors).find((entry) => entry.id === order.executorId)
    if (current?.status !== 'active' || current.watch === undefined || current.watch.aiExit !== undefined) return false
    const written = aiExitWrite({
      params: current.params as PositionExecutorParams,
      enteredAt: order.enteredAt,
      nowSec: deps.nowSec(),
      model: order.model,
      triggers: order.triggers,
      confidence: order.confidence,
      reason: order.reason
    })
    if (written === null) return false
    const closing: ExecutorConfig = { ...current, params: written.params, watch: { ...current.watch, aiExit: written.mark } }
    await deps.setExecutors(fresh.executors.map((entry) => (entry.id === current.id ? closing : entry)))
    return true
  })
}

/** The same, against the running app. */
export const watchPaperBrowserDeps: WatchPaperDeps = {
  getConfig: () => window.api.ai.getConfig(),
  getSettings: () => window.api.settings.get(),
  setExecutors: async (executors) => {
    await window.api.settings.set({ executors })
  },
  lastPrice: async (exchange, symbol) => (await window.api.market.fetchTicker24h(exchange, symbol)).lastPrice,
  // The live stream is Binance's: an event on another exchange has no live book here.
  liveBook: (exchange, symbol) => (exchange === 'binance' ? window.api.market.liveBook(symbol) : Promise.resolve(null)),
  fetchCandles: async (exchange, symbol, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, '1m', startSec, endSec)).candles,
  fifteenMinuteCandles: async (exchange, symbol, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, '15m', startSec, endSec)).candles,
  btcCorrelation: (exchange, symbol) =>
    readBtcCorrelation(
      async (from, pair, startSec, endSec) => (await window.api.market.fetchHistoricalRange(from, pair, '1h', startSec, endSec)).candles,
      exchange,
      symbol,
      Math.floor(Date.now() / 1000)
    ),
  // The market's regime, read from the research done at launch and every ten minutes: a record on the mark.
  regime: async () => (await window.api.research.getState()).market?.regime ?? null,
  review: (event, decision) => window.api.ai.reviewTrade({ event, decision }),
  // The stories on file, and the analyst's readings of them from the ledger: both free to read.
  stories: async () => (await window.api.feed.getState()).stories,
  readings: async (sinceSec) =>
    newsReadingsOf((await window.api.ai.listCalls({ source: 'addition', promptVersion: AI_ADDITION_PROMPT_VERSIONS.news, sinceSec, limit: 1000 })).rows),
  // The ledger, read for the calibrated win rate: free, and the rows are already on file.
  listCalls: (filter) => window.api.ai.listCalls(filter),
  // Not kept in Inventory (keepPosition is false), so nothing was handed over and the whole
  // result is cash.
  settle: (executor, nowSec) => settleExecutorOnStop({ executor, handedOver: { held: null, realizedPnl: 0 }, now: nowSec }),
  notify: (title, body, extra) => void window.api.notify(title, body, extra?.severity, extra).catch(() => undefined),
  nowSec: () => Math.floor(Date.now() / 1000),
  newId: () => crypto.randomUUID(),
  queue: (work) => settingsWrites(work),
  i18n: noticeI18n
}

/** The events the watch's own paper trades were opened on, from the books: what the restart sweep
 * (./opportunityWatch.ts sweepRestartMisses; the V5 document, §94) reads to tell an answer traded
 * from one never acted on. A read of settings, which this file alone of the watch's may make. */
export async function watchTradedEventIds(): Promise<ReadonlySet<string>> {
  const settings = await window.api.settings.get()
  return new Set(watchPaperExecutors(settings.executors).map((executor) => executor.watch?.eventId).filter((id): id is string => typeof id === 'string'))
}
