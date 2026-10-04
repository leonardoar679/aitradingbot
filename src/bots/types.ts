import { getStrategy } from '../backtest/strategies'
import { canConfirmEntries } from '../backtest/aiConfirmation'
import {
  AI_PROVIDER_LABEL,
  GPT_INTRADAY_STRATEGY_ID,
  describeGptCadence,
  gptDecisionsPerDay,
  gptMaxSpanDays,
  isGptDecisionEvery,
  type AiSignalDecision,
  type AiSignalEstimate
} from '../../shared/aiSignal'
import type { AiEntryPeek } from '../../shared/aiConfirm'
import { formatUsd } from '../../shared/aiCost'
import { describeDecider } from '../../shared/aiPanel'
import { describeAiRoute, describeEscalation, describeRouteKind, parseAiRoute, type AiRoute } from '../../shared/aiRoute'
import type { Bot, Candle, Exchange, Interval, SymbolInfo } from '../../shared/ipc'
import { buildAiProposal, type AiOrderProposal } from '../../shared/aiProposal'

export type { Bot }

/** What a bot actually runs, versus the label stored on it.
 *
 * `strategy` is a free-text name written when the bot was created; `strategyId` is what the dry
 * run resolves. Bots created before strategy selection existed have no strategyId at all, and
 * getStrategy() falls back to the default for a missing or unknown id rather than throwing -- so
 * such a bot silently runs EMA Crossover + ATR Stop while its card still shows the old label.
 * One profile has a bot reading "EMS" doing exactly that.
 *
 * This is the same failure the Backtest Live tab had: a heading naming one strategy above a run
 * of another. The rule is that the UI shows what EXECUTES, and says so when the label disagrees.
 */
export function resolvedStrategy(bot: Bot): { name: string; label: string; mismatched: boolean } {
  const actual = getStrategy(bot.strategyId ?? '')
  const stored = (bot.strategy ?? '').trim()
  return {
    name: actual.name,
    label: stored,
    mismatched: stored !== '' && stored !== actual.name
  }
}

/** A bot is born STOPPED, and born with its label already agreeing with what it will run.
 *
 * Both halves matter. The mismatch resolvedStrategy() reports exists only because older records
 * were written before strategy selection did; nothing created through here can reproduce it. And
 * a new bot being stopped is why the Bots tab had to learn to open one -- a bot you cannot look
 * at until you switch it on is a bot you are asked to start before you can see what it does. */
export function createBot(input: {
  id: string
  name: string
  exchange: Exchange
  pair: SymbolInfo
  strategyId: string
  aiConfirm?: boolean
  aiEveryBars?: number
}): Bot {
  return {
    id: input.id,
    name: input.name,
    exchange: input.exchange,
    symbol: input.pair.symbol,
    baseAsset: input.pair.baseAsset,
    quoteAsset: input.pair.quoteAsset,
    strategy: getStrategy(input.strategyId).name,
    strategyId: input.strategyId,
    enabled: false,
    enabledAt: null,
    archived: false,
    // Written only when it means something, so a bot on a strategy that cannot be reviewed never
    // carries a flag claiming it is.
    ...(input.aiConfirm === true && canConfirmEntries(input.strategyId) ? { aiConfirm: true } : {}),
    // The same rule for the cadence: only GPT Intraday has one, and "every candle" is what a bot
    // without the field already does.
    ...(input.strategyId === GPT_INTRADAY_STRATEGY_ID && isGptDecisionEvery(input.aiEveryBars) && input.aiEveryBars > 1
      ? { aiEveryBars: input.aiEveryBars }
      : {})
  }
}

/** How often this bot asks its model, in 15-minute bars. One for every bot that is not GPT
 * Intraday and for every GPT Intraday bot saved before the cadence existed.
 *
 * A stored value is passed through as it is, valid or not. The main process refuses a cadence it
 * does not know, and a bot that stops with that reason is better than one quietly asked ninety-six
 * times a day because its setting could not be read. */
export function gptCadenceOf(bot: Pick<Bot, 'strategyId' | 'aiEveryBars'>): number {
  return bot.strategyId === GPT_INTRADAY_STRATEGY_ID ? (bot.aiEveryBars ?? 1) : 1
}

/** The route this bot was switched on with, or null: every bot that is not GPT Intraday, and
 * every GPT Intraday bot switched on while no route was set.
 *
 * Passed through as it was stored, for the reason the cadence is. The main process refuses a route
 * it cannot read, and a bot that stops with that reason is better than one quietly asking a second
 * model nobody can name. */
export function gptRouteOf(bot: Pick<Bot, 'strategyId' | 'aiRoute'>): AiRoute | null {
  return bot.strategyId === GPT_INTRADAY_STRATEGY_ID ? (bot.aiRoute ?? null) : null
}

/** What a paid bot is pinned to when it is switched on: the model, and the route or the lack of
 * one. */
export interface AiPins {
  /** Absent leaves the bot's model pin as it was. */
  model?: string
  /** Null REMOVES the route the bot was last switched on with; absent leaves it as it was. */
  route?: AiRoute | null
}

/** The pins a GPT Intraday bot takes from the estimate its confirmation was written from.
 *
 * THE ROUTE IS ALWAYS DECIDED HERE, never left as it was. A confirmation that named no second
 * model -- because none is set, or because nothing could be estimated -- must not switch on a bot
 * that still asks the one it was pinned to last month. Only the two fields that make a route are
 * kept: the rest of an estimate is about one run, and has no business being stored on a bot. */
export function gptPinsFrom(estimate: AiSignalEstimate | null): AiPins {
  return {
    model: estimate?.model,
    route: estimate?.route ? { model: estimate.route.model, when: estimate.route.when } : null
  }
}

/** A bot with its pins moved. */
export function withAiPins(bot: Bot, pin: AiPins = {}): Bot {
  const { aiRoute, ...rest } = bot
  const route = pin.route === undefined ? aiRoute : (pin.route ?? undefined)
  return {
    ...rest,
    ...(pin.model !== undefined ? { aiModel: pin.model } : {}),
    ...(route !== undefined ? { aiRoute: route } : {})
  }
}

/** A bot's route as it was stored, when it can be read. Null for an unrouted bot, and for a stored
 * route that cannot be read: that one is reported by the run, not printed on a card. */
function readableRouteOf(bot: Pick<Bot, 'strategyId' | 'aiRoute'>): AiRoute | null {
  try {
    return parseAiRoute(gptRouteOf(bot))
  } catch {
    return null
  }
}

/** A routed bot's two steps in words, for its header. */
export function describeBotRoute(bot: Pick<Bot, 'strategyId' | 'aiRoute' | 'aiModel'>): string | null {
  const route = readableRouteOf(bot)
  return route ? describeAiRoute(bot.aiModel ?? 'the default model', route) : null
}

/** The same in two or three words, for its card: `two models`, or `model and panel`. */
export function describeBotRouteKind(bot: Pick<Bot, 'strategyId' | 'aiRoute'>): string | null {
  const route = readableRouteOf(bot)
  return route ? describeRouteKind(route) : null
}

/** Archiving is a STOP as well as a move, and the stop is the half that was missing.
 *
 * Clearing enabledAt is not tidiness: enabledAt is what every paper-trade figure in this app is
 * measured from, so an archived record carrying `enabled: false` next to a live enabledAt claims
 * a running window that nothing is running. The caller is separately responsible for writing the
 * BotRun, exactly as disabling does -- see BotsPage.recordRun. */
export function archiveBot(bot: Bot): Bot {
  return { ...bot, archived: true, enabled: false, enabledAt: null }
}

/** What the last dry-run refresh asked of a model. Null for every strategy that never calls one.
 *
 * The tape has always counted this and useDryRun always threw it away, so a running GPT bot billed
 * an external account every 60 seconds with nothing anywhere on screen saying so. The confirmation
 * before enabling makes the first click honest; this makes the ongoing state honest. */
export interface AiCallCount {
  total: number
  cached: number
  generated: number
  errors: number
  /** Present only on a bot whose entries a model reviews: how many of `total` it vetoed. Its
   * presence is also what says the count is of entries reviewed rather than candles decided. */
  vetoed?: number
  /** Present only on a routed bot: how many of `total` were passed on to its second model. */
  escalated?: number
}

/** One line describing a refresh's AI usage, and whether it is bad news.
 *
 * Failures lead, because a tape that is entirely failures is the case that already bit someone:
 * an account out of credits produced 672 safety-holds, which replay as a perfectly valid strategy
 * that simply never trades. "0 trades" and "672 calls failed" look identical on a chart. */
export function describeAiCalls(calls: AiCallCount): { text: string; bad: boolean } {
  const fresh = calls.generated === 1 ? '1 new call' : `${calls.generated} new calls`
  if (calls.vetoed !== undefined) {
    // An entry nobody ruled on is not taken, so this is the one state where the bot is doing
    // something other than what its strategy signalled -- and it has to say so.
    if (calls.errors > 0) {
      return { text: 'The model could not be reached to review the latest entry, so it is not taken. It is asked again on the next refresh.', bad: true }
    }
    if (calls.total === 0) return { text: 'AI confirmation on · no entry signalled yet', bad: false }
    const reviewed = calls.total === 1 ? '1 entry reviewed' : `${calls.total} entries reviewed`
    return { text: `${reviewed} · ${calls.vetoed} vetoed · ${fresh} last refresh`, bad: false }
  }
  if (calls.errors > 0) {
    return { text: `${calls.errors} of ${calls.total} AI calls failed`, bad: true }
  }
  const passedOn = calls.escalated !== undefined ? ` · ${calls.escalated} passed on to the second model` : ''
  // A bot in its first hour has made exactly one, and "1 decisions" is what it showed for it.
  const decisions = calls.total === 1 ? '1 decision' : `${calls.total} decisions`
  return { text: `${decisions} · ${calls.cached} cached · ${fresh} last refresh${passedOn}`, bad: false }
}

/** Whether running this strategy spends the user's money by itself, for as long as it is on.
 *
 * GPT Intraday asks a model through the user's own key on every candle its cadence names, for as
 * long as the bot is on. Everything else replays local arithmetic over candles that are already
 * fetched. Two places
 * need this same answer -- the confirmation before enabling, and the refusal to auto-fetch a
 * stopped bot's chart -- and they must not be able to disagree about which strategies are free.
 *
 * A bot with AI-confirmed entries is NOT in this set, and the difference matters to the second of
 * those places: stopped, it asks nothing, because a model is only asked about entries signalled
 * after the bot was switched on. Its chart is free to look at. Switching it on is not free, and
 * confirmsEntries() below is what the enable confirmation reads for that. */
export function costsMoneyToRun(strategyId: string): boolean {
  return strategyId === GPT_INTRADAY_STRATEGY_ID
}

/** Whether a model reviews this bot's entries. False on GPT Intraday whatever the flag says: its
 * decisions already come from a model, and there is no strategy signal to review. */
export function confirmsEntries(bot: Pick<Bot, 'strategyId' | 'aiConfirm'>): boolean {
  return bot.aiConfirm === true && canConfirmEntries(bot.strategyId)
}

/** What someone is agreeing to when they switch a paid bot on.
 *
 * `estimate` is null when it could not be had -- no key yet, or the exchange unreachable -- and
 * `problem` then says why. The confirmation is still shown, with the reason in it: a bot that
 * cannot be priced because there is no key cannot run either, and this is the moment to say so.
 *
 * `everyBars` is the bot's own cadence, passed beside the estimate rather than read from it,
 * because the sentence it changes has to be right even when there is no estimate. */
export function describePaidBotCost(
  botName: string,
  estimate: AiSignalEstimate | null,
  problem: string | null = null,
  everyBars = 1
): string {
  const lines = [`Enable "${botName}"?`, '']
  const perDay = gptDecisionsPerDay(everyBars)
  const daily =
    estimate?.perCallCostUsd != null
      ? `, roughly ${formatUsd(estimate.perCallCostUsd * perDay)} a day at what this model has been costing`
      : ''
  const each = everyBars > 1 ? `one call every ${describeGptCadence(everyBars)}` : 'one call per new 15-minute candle'
  const missed =
    everyBars > 1
      ? `the decisions it missed, up to ${gptMaxSpanDays(everyBars)} days of them at once`
      : 'the candles it missed, up to a week of them at once'
  lines.push(
    `GPT Intraday asks ${estimate?.model ?? 'the default model'} through ${AI_PROVIDER_LABEL} with your key, and ` +
      `${AI_PROVIDER_LABEL} bills your credits: ${each} for as long as this app stays ` +
      `open (${perDay} a day${daily}). After the app has been closed it catches up on ${missed}. ` +
      'Anything already cached is free.'
  )
  // A route is stated here or it does not run: the pin a bot keeps is the one this names.
  if (estimate?.route) {
    const second = estimate.route
    // A panel takes four calls for each decision it is handed, and the ceiling is all of them.
    const perDecision = second.callsPerDecision ?? 1
    const moreCalls = perDay * perDecision
    const ceiling =
      second.perCallCostUsd != null
        ? `, up to ${formatUsd(second.perCallCostUsd * moreCalls)} a day at what that model ${
            second.costBasis === 'history' ? 'has been costing' : 'is priced at'
          }`
        : ''
    lines.push('')
    lines.push(
      `When ${estimate.model} ${describeEscalation(second.when)}, ${describeDecider(second.model)} is asked the same question and its ` +
        `answer is the one that counts: up to ${moreCalls} more calls a day${perDecision > 1 ? ` (${perDecision} for each decision passed on)` : ''}${ceiling}.`
    )
  }
  lines.push('')
  lines.push(
    estimate
      ? `${formatUsd(estimate.budgetRemainingUsd)} of today's AI budget is left; the bot stops asking when it runs out.`
      : `What it will cost could not be estimated${problem ? `: ${problem}` : ' just now.'}`
  )
  lines.push('', 'No other strategy costs anything to run, unless a model is asked to confirm its entries.')
  return lines.join('\n')
}

/** What a bot with AI-confirmed entries was priced from before it is switched on. */
export interface ConfirmBotEstimate {
  /** The model that would be asked, what one review costs, and what is left of today's budget. */
  quote: AiEntryPeek
  /** Positions the strategy opened over the stretch of history the bot's chart replays, and how
   * many days that stretch is: the only honest hint at how often it will ask. */
  recentEntries: number
  recentDays: number
}

/** What someone is agreeing to when they switch on a bot whose entries a model reviews.
 *
 * The unit is the TRADE, not the candle, and that is the whole difference from GPT Intraday: a
 * slow strategy takes a handful a month, and a model is asked once about each. So this prices one
 * review and says how often the strategy has been opening positions, instead of multiplying by a
 * day's candles. It also says what a veto does and what an unreachable model does, because both
 * mean the bot sits out a trade its strategy took -- which is the thing the user is switching on. */
export function describeConfirmBotCost(
  botName: string,
  strategyName: string,
  estimate: ConfirmBotEstimate | null,
  problem: string | null = null
): string {
  const lines = [`Enable "${botName}"?`, '']
  const each =
    estimate?.quote.perCallCostUsd != null
      ? `, about ${formatUsd(estimate.quote.perCallCostUsd)} each at what this model ${
          estimate.quote.costBasis === 'history' ? 'has been costing' : 'is priced at'
        }`
      : ''
  lines.push(
    `${strategyName} decides as it always does. Each time it signals an entry, ${estimate?.quote.model ?? 'the default model'} ` +
      `is asked through ${AI_PROVIDER_LABEL} with your key to confirm or veto it, and ${AI_PROVIDER_LABEL} bills your credits: ` +
      `one call per signalled entry${each}, while this app is open.`
  )
  if (estimate && estimate.recentDays >= 1) {
    const positions = estimate.recentEntries === 1 ? '1 position' : `${estimate.recentEntries} positions`
    lines.push(`Over the last ${estimate.recentDays} days it would have opened ${positions}.`)
  }
  lines.push(
    '',
    'A vetoed entry is skipped: the bot sits that whole trade out and is not asked again until the strategy would have ' +
      'closed it. If the model cannot be reached, the entry is not taken.'
  )
  lines.push(
    '',
    estimate
      ? `${formatUsd(estimate.quote.budgetRemainingUsd)} of today's AI budget is left; the bot stops asking when it runs out.`
      : `What it will cost could not be estimated${problem ? `: ${problem}` : ' just now.'}`
  )
  lines.push('', 'Paper only: nothing here places a real order.')
  return lines.join('\n')
}

/** The newest decision of a GPT Intraday bot's tape, with what turning it into an order form needs. */
export interface BotAiCall {
  decision: AiSignalDecision
  interval: Interval
  /** The close the model was shown: the bar before the one the decision is for. */
  referencePrice: number
  /** Whether the paper bot opened a position on it. False for a call made while it was already
   * long, which is a call about holding and opens nothing. */
  entered: boolean
}

/** The call a running GPT bot made last, read off its tape and the signals built from it.
 *
 * `entries` is generateGptIntradaySignals' own answer to "did this decision open a position", so
 * the order form is offered for exactly the calls the paper bot acted on -- one rule, not a copy. */
export function latestBotAiCall(candles: Candle[], decisions: AiSignalDecision[], entries: boolean[], interval: Interval): BotAiCall | null {
  const decision = decisions[decisions.length - 1]
  if (decision === undefined) return null
  let index = candles.length - 1
  while (index >= 0 && candles[index].time !== decision.candleTime) index--
  // Without the bar before it there is no price the model's levels can be measured from.
  if (index < 1) return null
  return { decision, interval, referencePrice: candles[index - 1].close, entered: entries[index] === true }
}

/** The order form a bot's latest call is on offer as, or null: see shared/aiProposal.ts. */
export function botAiProposal(
  bot: Pick<Bot, 'exchange' | 'symbol' | 'baseAsset' | 'quoteAsset'>,
  call: BotAiCall | null,
  nowSec: number
): AiOrderProposal | null {
  if (call === null) return null
  return buildAiProposal({
    decision: call.decision,
    exchange: bot.exchange,
    pair: { symbol: bot.symbol, baseAsset: bot.baseAsset, quoteAsset: bot.quoteAsset },
    interval: call.interval,
    referencePrice: call.referencePrice,
    nowSec,
    opensPosition: call.entered
  })
}
