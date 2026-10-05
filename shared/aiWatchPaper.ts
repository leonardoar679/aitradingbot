import { describeOpportunitySide, opportunitySide } from './aiOpportunity'
import { describeDecider } from './aiPanel'
import { buildOpportunityProposal, opportunityObstacle } from './aiProposal'
import { GPT_MIN_CONFIDENCE, type AiSignalDecision } from './aiSignal'
import type { ExecutorConfig, ExecutorSide, PositionExecutorParams } from './ipc'
import { describeEventType, type MarketEvent } from './marketEvent'

// PAPER TRADES FROM THE WATCH.
//
// The watch (shared/aiWatch.ts) asks and notifies. Since 2026-10-04, when the user chose it, it
// may also open a PAPER position on a call it would act on, so that what following its
// recommendations does is on Strategies › Execution, and in the paper account where there is one,
// without anyone having to be at the screen in the fifteen minutes an entry is good for.
//
// IT IS PAPER, AND CANNOT BE ANYTHING ELSE. The one file that turns a plan made here into an
// executor (src/agents/watchPaperTrade.ts) writes its mode as a literal and takes none; nothing
// here or there reaches the bridge an order travels over, and tests/aiNoLivePath.test.ts holds
// both to it. A bot that trades real money by itself was offered twice and not chosen, and is not
// built.
//
// WHAT IT OPENS IS THE RECOMMENDATION, AS THE "Paper trade" BUTTON WOULD HAVE FILLED IT IN for
// the same answer at the same moment (shared/aiProposal.ts): the model's own stop and target as
// distances from the entry, its hold as the time limit, and the entry abandoned when its validity
// ends. The one thing a person would have typed is the amount, and that is the stake in the
// setting.
//
// IT ENTERS WHERE THE RECOMMENDATION SAYS, AND NOWHERE ELSE: in the first minute the price trades
// inside the range the model named, at that minute's open when the open is inside it and otherwise
// at the edge the price came in by (PositionExecutorParams.entryRange). That is the rule the
// recommendation is scored by, so the paper trade and the journal agree on whether it entered.
// It is not "at market": the answer arrives part of the way through a minute, and a price that has
// left the range by the next one would be chased. And it is not a limit at the range's edge: with
// the price already under a buy's range, a limit there is marketable, and is filled at the next
// open, outside the range. A check in the app opened a trade "waiting for" the bottom of a range
// the price was already under, which is how this was found.
//
// ITS LIMITS ARE COUNTED FROM WHAT IS ON FILE: one paper trade an event, one open on a pair at a
// time, so many open at once -- each read from the executors themselves, never from a counter a
// restart would forget -- and, where a paper account is set up, its free funds, checked as the
// order form checks them. It follows one named model of the watch's: comparing models is the
// leaderboard's job, and three models trading one event would be three positions on one opinion
// of the market.
//
// IT ASKS NOTHING. A paper trade is made from an answer the watch already bought. Switching this
// on changes what the app does with that answer and never what it spends.

export const AI_WATCH_PAPER_STAKES = [25, 50, 100, 250, 500, 1000] as const
export const AI_WATCH_PAPER_OPEN_LIMITS = [1, 2, 3, 5, 10] as const
export const AI_WATCH_PAPER_DEFAULT_STAKE = 100
export const AI_WATCH_PAPER_DEFAULT_OPEN = 3

export interface AiWatchPaperConfig {
  enabled: boolean
  /** The one model of the watch's whose calls are paper traded. Null while none is chosen. */
  model: string | null
  /** What each paper trade stakes, in its pair's quote asset. */
  stakeQuote: number
  /** Paper trades of the watch's open at once, at most. */
  maxOpen: number
}

export const DEFAULT_AI_WATCH_PAPER: AiWatchPaperConfig = {
  enabled: false,
  model: null,
  stakeQuote: AI_WATCH_PAPER_DEFAULT_STAKE,
  maxOpen: AI_WATCH_PAPER_DEFAULT_OPEN
}

function isStake(value: unknown): value is number {
  return (AI_WATCH_PAPER_STAKES as readonly unknown[]).includes(value)
}

function isOpenLimit(value: unknown): value is number {
  return (AI_WATCH_PAPER_OPEN_LIMITS as readonly unknown[]).includes(value)
}

/** A stored setting, healed. Anything unreadable becomes the default.
 *
 * ON ONLY AS IT WAS SWITCHED ON. A model that is no longer one the watch asks, or a stake or a
 * limit that is not one of the choices, leaves it off: its confirmation named a model, a stake and
 * a limit, and nothing here runs in a repaired shape nobody read. */
export function healAiWatchPaper(value: unknown, watchModels: string[]): AiWatchPaperConfig {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof AiWatchPaperConfig, unknown>>
  const model = typeof raw.model === 'string' && watchModels.includes(raw.model) ? raw.model : null
  const stakeOk = isStake(raw.stakeQuote)
  const openOk = isOpenLimit(raw.maxOpen)
  return {
    enabled: raw.enabled === true && model !== null && stakeOk && openOk,
    model,
    stakeQuote: isStake(raw.stakeQuote) ? raw.stakeQuote : AI_WATCH_PAPER_DEFAULT_STAKE,
    maxOpen: isOpenLimit(raw.maxOpen) ? raw.maxOpen : AI_WATCH_PAPER_DEFAULT_OPEN
  }
}

/** Why a setting cannot be saved, or null when it can. It arrives over IPC, so its shape is
 * checked and not assumed. `watchModels` is what the watch asks. */
export function aiWatchPaperProblem(config: AiWatchPaperConfig, watchModels: string[]): string | null {
  if (typeof config.enabled !== 'boolean') return 'Paper trades from the watch are either on or off'
  if (config.model !== null && typeof config.model !== 'string') return 'Paper trades follow one model'
  if (!isStake(config.stakeQuote)) return `A paper trade stakes ${AI_WATCH_PAPER_STAKES.join(', ')}`
  if (!isOpenLimit(config.maxOpen)) return `The watch keeps at most ${AI_WATCH_PAPER_OPEN_LIMITS.join(', ')} paper trades open`
  if (config.model !== null && !watchModels.includes(config.model)) {
    return `${config.model} is not one of the models the watch asks, so there is no call of its to paper trade.`
  }
  if (config.enabled && config.model === null) return 'Choose the model whose calls are paper traded'
  return null
}

/** What switching it on does, said before it is switched on. */
export function describeAiWatchPaper(input: { config: AiWatchPaperConfig; watchOn: boolean; hasPaperAccount: boolean }): string {
  const { config } = input
  const who = config.model === null ? 'the chosen model' : describeDecider(config.model)
  const confidence = Math.round(GPT_MIN_CONFIDENCE * 100)
  return [
    'Let the watch open paper trades by itself?',
    '',
    `While this is on, each time ${who} answers an event the watch put to it with BUY or SELL at ${confidence}% confidence or more, a PAPER position of ${config.stakeQuote} in the pair's quote currency is opened at once, with nobody pressing anything.`,
    '',
    'It is the position the Paper trade button would have filled in: it enters in the first minute the price trades inside the range the model named, and is abandoned if that has not happened when its entry expires; with the model\'s own stop and target, and its holding time as the time limit.',
    `At most ${config.maxOpen} open at once, one an event, and one on a pair at a time. When a position has closed, it is stopped, and its card on Strategies › Execution says how it ended.`,
    input.hasPaperAccount
      ? 'Its result goes to the paper account, and a trade the paper account cannot fund is not opened.'
      : 'No paper account is set up, so their results are added to no balance, and nothing limits what these positions add up to. Set one up under Account to hold them to a balance.',
    '',
    'It is paper. Nothing is placed on an exchange, and this cannot be pointed at real money. A SELL is a short, which this app only ever paper trades.',
    'It asks no model and costs nothing: what the watch may ask, and spend, is unchanged.',
    ...(input.watchOn ? [] : ['The watch itself is off, so nothing will be opened until it is switched on.']),
    '',
    'Switch it on?'
  ].join('\n')
}

export type WatchPaperMark = NonNullable<ExecutorConfig['watch']>
/** How one ended: written on its mark when the watch stops it (src/agents/watchPaperTrade.ts). */
export type WatchPaperOutcome = NonNullable<WatchPaperMark['result']>

/** The watch's own paper trades among `executors`: a paper Position carrying its mark. An executor
 * that is not paper is never one of them, whatever it carries. */
export function watchPaperExecutors(executors: ExecutorConfig[]): ExecutorConfig[] {
  return executors.filter((executor) => executor.watch !== undefined && executor.mode === 'paper' && executor.type === 'position')
}

/** What an executor's card says about where a paper trade of the watch's came from. */
export function describeWatchPaperOrigin(mark: WatchPaperMark): string {
  return `Opened by the watch, with nobody pressing anything, on a call by ${describeDecider(mark.model)} (${Math.round(mark.confidence * 100)}% confidence, ${utcClock(mark.eventTime)} UTC event). Paper.`
}

/** An amount of a quote asset with its sign, to four significant digits: "+3.786 USDT". */
function signedQuote(amount: number, asset: string): string {
  const shown = Number(amount.toPrecision(4))
  return `${shown > 0 ? '+' : ''}${shown} ${asset}`
}

const EXIT_WORDS: Record<Exclude<WatchPaperOutcome['exit'], 'entry_expired'>, string> = {
  take_profit: 'Target reached',
  stop_loss: 'Stopped out',
  time_limit: 'Time ran out',
  trailing_stop: 'Trailing stop',
  liquidation: 'Liquidated'
}

/** How a paper trade of the watch's ended, for its card: the exit, and what it made or lost. */
export function describeWatchPaperResult(result: WatchPaperOutcome, quoteAsset: string): string {
  if (result.exit === 'entry_expired') return 'Never entered: the price did not trade in its entry range before it expired.'
  return `${EXIT_WORDS[result.exit]}: ${signedQuote(result.pnlQuote, quoteAsset)} after fees.`
}

export interface WatchPaperTally {
  /** The ones the watch stopped because their position had closed. */
  ended: number
  /** Of those, the ones whose entry was reached. */
  entered: number
  /** Of those, the ones that made money. */
  ahead: number
  /** What the entered ones made or lost, by quote asset, in the order first seen. */
  pnl: { asset: string; amount: number }[]
}

/** What the watch's ended paper trades add up to, from the results on file. One stopped by hand
 * carries no result and is not counted: nobody simulated it to its end. */
export function watchPaperTally(executors: ExecutorConfig[]): WatchPaperTally {
  const tally: WatchPaperTally = { ended: 0, entered: 0, ahead: 0, pnl: [] }
  for (const executor of watchPaperExecutors(executors)) {
    const result = executor.watch?.result
    if (executor.status !== 'stopped' || result === undefined) continue
    tally.ended++
    if (result.exit === 'entry_expired') continue
    tally.entered++
    if (result.pnlQuote > 0) tally.ahead++
    const held = tally.pnl.find((entry) => entry.asset === executor.quoteAsset)
    if (held === undefined) tally.pnl.push({ asset: executor.quoteAsset, amount: result.pnlQuote })
    else held.amount += result.pnlQuote
  }
  return tally
}

/** The tally in a sentence, or nothing when none has ended. A sum and two counts: not a rate. */
export function describeWatchPaperTally(tally: WatchPaperTally): string {
  if (tally.ended === 0) return ''
  const ended = `${tally.ended} ${tally.ended === 1 ? 'has' : 'have'} ended`
  if (tally.entered === 0) return `${ended}, and ${tally.ended === 1 ? 'it never' : 'none'} entered.`
  const sums = tally.pnl.map((entry) => signedQuote(entry.amount, entry.asset))
  const total = sums.length === 1 ? sums[0] : `${sums.slice(0, -1).join(', ')} and ${sums[sums.length - 1]}`
  return `${ended}: ${tally.entered} entered, ${tally.ahead} of them ahead, ${total} in all after fees.`
}

/** Why the watch opens no paper trade on this answer whatever the price is doing, or null when its
 * limits allow one. Asked twice: before the price is fetched, and again on the executors read
 * immediately before the write, so that two answers arriving together cannot both pass. */
export function watchPaperBlock(input: {
  config: AiWatchPaperConfig
  event: Pick<MarketEvent, 'id' | 'exchange' | 'symbol'>
  decision: Pick<AiSignalDecision, 'model'>
  executors: ExecutorConfig[]
}): string | null {
  const { config, event } = input
  if (!config.enabled || config.model === null) return 'Paper trades from the watch are off.'
  if (input.decision.model !== config.model) return `Paper trades follow ${describeDecider(config.model)}, and this answer is not its.`
  const own = watchPaperExecutors(input.executors)
  if (own.some((executor) => executor.watch?.eventId === event.id)) return 'A paper trade was already opened for this event.'
  const open = own.filter((executor) => executor.status === 'active')
  if (open.some((executor) => executor.exchange === event.exchange && executor.symbol === event.symbol)) {
    return `A paper trade of the watch's is still open on ${event.symbol}.`
  }
  if (open.length >= config.maxOpen) {
    return `The watch has ${open.length} paper ${open.length === 1 ? 'trade' : 'trades'} open, and ${config.maxOpen} is the most it keeps.`
  }
  return null
}

export type WatchPaperPlan =
  | { ok: true; name: string; side: ExecutorSide; params: PositionExecutorParams; mark: WatchPaperMark }
  | { ok: false; reason: string }

/** The paper position an answer becomes at this moment and this price, or why it becomes none.
 *
 * The rule is the order form's (opportunityObstacle), said here in the watch's words. One thing
 * is stricter than the form: a level of the model's that is not a usable distance from the entry
 * is a reason not to trade. A person looking at the form sees the form's own stop in its place
 * and can decide; nobody is looking at this. */
export function planWatchPaperTrade(input: {
  config: AiWatchPaperConfig
  event: Pick<MarketEvent, 'id' | 'exchange' | 'symbol' | 'baseAsset' | 'quoteAsset' | 'time' | 'type' | 'price'>
  decision: AiSignalDecision
  nowSec: number
  /** The price now. Null means the event's own price, the last the model saw. */
  lastPrice: number | null
}): WatchPaperPlan {
  const { config, event, decision } = input
  const current = input.lastPrice ?? event.price
  const obstacle = opportunityObstacle(event.time, decision, input.nowSec, current)
  if (obstacle !== null) {
    switch (obstacle.code) {
      case 'unreached':
        return { ok: false, reason: 'The model was not reached.' }
      case 'refused':
        return { ok: false, reason: 'Its answer was refused.' }
      case 'no_trade':
        return { ok: false, reason: 'It called no trade.' }
      case 'low_confidence':
        return { ok: false, reason: `Its call is below the ${Math.round(GPT_MIN_CONFIDENCE * 100)}% confidence this app acts on.` }
      case 'expired':
        return { ok: false, reason: 'Its entry had already expired.' }
      case 'through_stop':
        return { ok: false, reason: 'The price had already gone through its stop.' }
      case 'at_target':
        return { ok: false, reason: 'The price had already reached its target.' }
    }
  }
  const proposal = buildOpportunityProposal({ event, decision, nowSec: input.nowSec, lastPrice: input.lastPrice })
  if (proposal === null || proposal.entryRange === undefined) return { ok: false, reason: 'Its recommendation could not be turned into a position.' }
  if (proposal.stopLossPct === null || proposal.takeProfitPct === null) {
    return { ok: false, reason: 'Its stop or its target is not a usable distance from the entry.' }
  }
  const side: ExecutorSide = proposal.side ?? 'buy'
  return {
    ok: true,
    name: `Watch: ${describeOpportunitySide(opportunitySide(decision))} ${event.symbol}`,
    side,
    // No leverage field: absent is 1x, the only thing the watch ever opens.
    params: {
      side,
      // The range decides the entry (see the top of this file). The form's single entry price is
      // left empty: nothing reads it while a range is there, and a figure in it would look like
      // the price this position waits for.
      entryPrice: null,
      entryRange: proposal.entryRange,
      amountQuote: config.stakeQuote,
      takeProfitPct: proposal.takeProfitPct,
      stopLossPct: proposal.stopLossPct,
      timeLimitSec: proposal.timeLimitSec,
      trailingStop: null,
      entryExpiresAt: proposal.expiresAt ?? null
    },
    mark: { eventId: event.id, eventTime: event.time, model: decision.model, confidence: decision.confidence }
  }
}

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 16)
}

/** Where a paper trade of the watch's enters, in a few words: "to enter between 99.8 and 100.2". */
export function describeWatchPaperEntry(params: Pick<PositionExecutorParams, 'entryPrice' | 'entryRange'>): string {
  const shown = (price: number): number => Number(price.toPrecision(8))
  if (params.entryRange != null) return `to enter between ${shown(params.entryRange.min)} and ${shown(params.entryRange.max)}`
  return params.entryPrice === null ? 'at market' : `waiting for ${shown(params.entryPrice)}`
}

/** What the desktop is told when the watch has opened a paper trade. It says it is paper, and that
 * nothing real was placed, because a notification that reads "BUY" reads otherwise. */
export function watchPaperNotice(
  event: Pick<MarketEvent, 'id' | 'symbol' | 'quoteAsset' | 'time' | 'type'>,
  plan: Extract<WatchPaperPlan, { ok: true }>
): { key: string; title: string; body: string } {
  return {
    key: `${event.id}:paper`,
    title: `${event.symbol}: paper ${plan.side === 'buy' ? 'BUY' : 'SELL'} opened`,
    body:
      `${describeDecider(plan.mark.model)} at ${Math.round(plan.mark.confidence * 100)}% confidence, on the ${describeEventType(event.type).toLowerCase()} at ${utcClock(event.time)} UTC. ` +
      `A paper position of ${plan.params.amountQuote} ${event.quoteAsset} was opened ${describeWatchPaperEntry(plan.params)}, with its stop ${plan.params.stopLossPct}% away and its target ${plan.params.takeProfitPct}%. ` +
      'Nothing real has been placed. It is on Strategies › Execution.'
  }
}
