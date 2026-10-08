import { aiCallNotice } from '../../shared/aiProposal'
import { botAiProposal, type Bot, type BotAiCall } from './types'

// A running bot makes its call when nobody is looking, and the order form that call can be turned
// into is on offer only until its candle closes. This is what says so on the desktop.
//
// It raises a notice and nothing else. The form is still opened by a person, under Strategies › Active Runs, and
// still submitted by a person; a notification that a model said BUY is not an order and the text
// says as much.

/** Calls already announced in this session. One call is seen by every poller of the bot, and by
 * the same poller again each time it runs while the candle is open. */
const announced = new Set<string>()

/** Announces a bot's latest call if an order form is on offer for it and it has not been announced.
 * Returns whether it raised one, which is what the tests read. */
export function announceBotAiCall(bot: Bot, call: BotAiCall | null, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
  const proposal = botAiProposal(bot, call, nowSec)
  if (proposal === null) return false
  const notice = aiCallNotice(bot.name, proposal)
  if (announced.has(notice.key)) return false
  announced.add(notice.key)
  // A desktop that cannot show it is not a reason to fail the poll that noticed the call.
  void window.api.notify(notice.title, notice.body, undefined, { kind: 'TRADE_OPPORTUNITY', thread: notice.key }).catch(() => undefined)
  return true
}

/** Test seam: forgets what has been announced. */
export function resetAnnouncedAiCalls(): void {
  announced.clear()
}
