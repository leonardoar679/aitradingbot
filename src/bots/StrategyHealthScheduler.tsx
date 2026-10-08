import { useEffect } from 'react'
import { GPT_INTRADAY_STRATEGY_ID } from '../../shared/aiSignal'
import { breakerNotice } from '../../shared/notices'
import { strategyHealth } from '../../shared/strategyHealth'
import { MEASURED_EXPECTATIONS } from '../backtest/marketConditions'
import { confirmsEntries } from './types'
import { fetchBotDryRunResult, summarizePaperTrades } from './useDryRun'

/** How often each bot's health is read. */
const LOOK_MS = 60 * 60 * 1000
/** The first look, once the page has settled. */
const FIRST_LOOK_MS = 90 * 1000

/** Headless -- mounted once in App.tsx, like ModelHealthScheduler (V5 Stage 8, 8 October 2026). Once
 * an hour it reads each running bot's health (shared/strategyHealth.ts): its last thirty closed
 * paper trades against what the strategy made a trade where it was measured, and tells a DEGRADED
 * one once a day on the bot's own thread. Until this, the notice was raised by the bot's card, so
 * only while Strategies was open.
 *
 * ONLY FOR BOTS THAT ASK NO MODEL. A GPT Intraday bot and a bot with AI confirmation replay their
 * model's calls, and a dry run of theirs can ask for new ones, which costs money: their health is
 * read by their card, as before, which is what a person opening it has agreed to see. A plain
 * strategy's dry run is arithmetic on candles. Nothing here stops a bot: a person does. */
export function StrategyHealthScheduler(): null {
  useEffect(() => {
    let cancelled = false
    const look = async (): Promise<void> => {
      let bots: Awaited<ReturnType<typeof window.api.settings.get>>['bots'] = []
      try {
        bots = (await window.api.settings.get()).bots
      } catch {
        return
      }
      for (const bot of bots) {
        if (cancelled) return
        if (!bot.enabled || bot.strategyId === GPT_INTRADAY_STRATEGY_ID || confirmsEntries(bot)) continue
        try {
          const run = await fetchBotDryRunResult(bot)
          if (run === null) continue
          const expectation = MEASURED_EXPECTATIONS.find((entry) => entry.strategyId === bot.strategyId)?.trades ?? null
          const health = strategyHealth(summarizePaperTrades(run.result.trades, bot.enabledAt).paperTrades, expectation)
          if (health.verdict !== 'degraded') continue
          const notice = breakerNotice('strategy', `${bot.name}: ${health.reasons.join('; ')}. It keeps running on paper; stop it under Strategies › Active Runs if that is what you want.`, `strategy:${bot.id}`)
          // Told through the one handler: once a day on the bot's thread, on file, and in the window.
          void window.api.notify(notice.title, notice.body, notice.extra.severity, notice.extra).catch(() => undefined)
        } catch {
          // A bot whose candles cannot be read this hour is looked at next hour.
        }
      }
    }
    const first = window.setTimeout(() => void look(), FIRST_LOOK_MS)
    const timer = window.setInterval(() => void look(), LOOK_MS)
    return (): void => {
      cancelled = true
      window.clearTimeout(first)
      window.clearInterval(timer)
    }
  }, [])
  return null
}
