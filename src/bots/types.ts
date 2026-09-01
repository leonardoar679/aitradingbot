import { getStrategy } from '../backtest/strategies'
import type { Bot } from '../../shared/ipc'

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
