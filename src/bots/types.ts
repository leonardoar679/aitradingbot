import { getStrategy } from '../backtest/strategies'
import { GPT_INTRADAY_STRATEGY_ID } from '../../shared/aiSignal'
import type { Bot, Exchange, SymbolInfo } from '../../shared/ipc'

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
    archived: false
  }
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

/** Whether running this strategy spends the user's money.
 *
 * GPT Intraday calls OpenAI with the user's own key, once per candle, for as long as the bot is
 * on. Everything else replays local arithmetic over candles that are already fetched. Two places
 * need this same answer -- the confirmation before enabling, and the refusal to auto-fetch a
 * stopped bot's chart -- and they must not be able to disagree about which strategies are free. */
export function costsMoneyToRun(strategyId: string): boolean {
  return strategyId === GPT_INTRADAY_STRATEGY_ID
}
