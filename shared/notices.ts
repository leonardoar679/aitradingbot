import type { AlertKind, AlertSeverity } from './alerts'
import { describeEventType, type MarketEvent } from './marketEvent'

// THE NOTICES THE DOCUMENT NAMES, EACH IN WORDS (the V4 document, §47-49), beside the ones the app
// already raised (a story, a crash, a call, a paper trade opened, a drop, the digest, the pause, the
// exit check). Every notice goes through one handler in the main process (noticeService.ts), which
// obeys the Notifications control, keeps one THREAD per kind and pair for thirty minutes so that a
// repeat updates the thread and raises no new notice, records what it told (shared/records.ts) and
// tells the window. The texts are here, pure, so that each is pinned by a test.

/** What a notice carries beside its text: how loud, what kind, which thread it belongs to (a pair,
 * an event, a trade, or a fixed name), its id on file where the caller has one, a link. */
export interface NoticeExtra {
  severity?: 'watch' | 'high' | 'critical'
  kind: AlertKind
  thread?: string
  /** How long a thread holds repeats back, where not the default half hour: a model rested for the
   * day is told once a day, not once every half hour. */
  threadSeconds?: number
  id?: string
  url?: string
}

export interface Notice {
  title: string
  body: string
  extra: NoticeExtra
}

const pct = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
const money = (value: number, asset: string): string => `${value >= 0 ? '+' : ''}${Number(value.toFixed(2))} ${asset}`

/** An urgent event the watch did not ask about, and why: told once per pair per thread. */
export function marketEventNotice(event: Pick<MarketEvent, 'symbol' | 'type' | 'band' | 'score' | 'returnsPct' | 'time'>, why: string): Notice {
  return {
    title: `${event.symbol}: ${describeEventType(event.type).toLowerCase()} (${event.band})`,
    body: `Score ${Math.round(event.score)}, ${pct(event.returnsPct.m15)} in fifteen minutes at ${utcClock(event.time)} UTC. The watch did not ask about it: ${why} Nothing was placed.`,
    extra: { kind: 'MARKET_EVENT', thread: event.symbol, severity: 'watch' }
  }
}

/** Models on opposite sides of one event. */
export function disagreementNotice(event: Pick<MarketEvent, 'id' | 'symbol' | 'type'>, sides: { model: string; side: 'long' | 'short' }[]): Notice {
  const longs = sides.filter((entry) => entry.side === 'long').map((entry) => entry.model)
  const shorts = sides.filter((entry) => entry.side === 'short').map((entry) => entry.model)
  return {
    title: `${event.symbol}: the models disagree`,
    body: `On the ${describeEventType(event.type).toLowerCase()}: BUY from ${longs.join(', ')}; SELL from ${shorts.join(', ')}. The paper trade, if any, follows the model it is set to.`,
    extra: { kind: 'MODEL_DISAGREEMENT', thread: event.id, severity: 'watch' }
  }
}

export type PaperCloseExit = 'take_profit' | 'stop_loss' | 'trailing_stop' | 'time_limit' | 'liquidation' | 'ai_exit'

/** A paper trade of the app's own closed: how, and what it made or lost, in money and in R. */
export function paperCloseNotice(
  trade: { id: string; symbol: string; side: 'buy' | 'sell'; quoteAsset: string },
  result: { exit: PaperCloseExit; pnlQuote: number; r: number | null }
): Notice {
  const how =
    result.exit === 'take_profit'
      ? 'reached its target'
      : result.exit === 'stop_loss'
        ? 'hit its stop'
        : result.exit === 'trailing_stop'
          ? 'hit its trailing stop'
          : result.exit === 'liquidation'
            ? 'was liquidated'
            : result.exit === 'ai_exit'
              ? 'was closed by the exit check'
              : 'ran out its time limit'
  const kind: AlertKind = result.exit === 'take_profit' ? 'TARGET_REACHED' : result.exit === 'stop_loss' || result.exit === 'trailing_stop' || result.exit === 'liquidation' ? 'STOP_TRIGGERED' : 'TRADE_EXECUTED'
  const r = result.r === null ? '' : ` (${result.r >= 0 ? '+' : ''}${result.r.toFixed(2)} R)`
  return {
    title: `${trade.symbol}: paper ${trade.side === 'buy' ? 'BUY' : 'SELL'} ${how}`,
    body: `${money(result.pnlQuote, trade.quoteAsset)}${r} after fees, on paper. Nothing real was placed or sold.`,
    extra: { kind, thread: trade.id, severity: kind === 'TRADE_EXECUTED' ? 'watch' : 'high' }
  }
}

/** How close to its stop a position may come, as a share of the distance from its entry, before it
 * is told: three quarters of the way. */
export const NEAR_STOP_SHARE = 0.75

/** Where a position stands between its entry and its stop: 0 at the entry, 1 at the stop; null
 * without a stop. For a short the stop is above. */
export function stopProgress(input: { side: 'buy' | 'sell'; entryPrice: number; stopPct: number | null; price: number }): number | null {
  if (input.stopPct === null || input.stopPct <= 0 || !(input.entryPrice > 0)) return null
  const stop = input.side === 'buy' ? input.entryPrice * (1 - input.stopPct / 100) : input.entryPrice * (1 + input.stopPct / 100)
  const distance = Math.abs(input.entryPrice - stop)
  if (distance === 0) return null
  const gone = input.side === 'buy' ? input.entryPrice - input.price : input.price - input.entryPrice
  return gone / distance
}

/** A position of the app's own, paper or real, within the share of the way to its stop. */
export function nearStopNotice(position: { id: string; symbol: string; side: 'buy' | 'sell'; real: boolean }, progress: number, price: number): Notice {
  return {
    title: `${position.symbol}: near its stop`,
    body: `The ${position.real ? 'real' : 'paper'} ${position.side === 'buy' ? 'BUY' : 'SELL'} is ${Math.round(progress * 100)}% of the way from its entry to its stop, at ${price}. Its stop is still in place${position.real ? ' on its watcher' : ''}; nothing was done.`,
    extra: { kind: 'POSITION_RISK', thread: position.id, severity: 'high' }
  }
}

/** A real position closed by its watcher: by its target, its stop, or its time limit. */
export function liveExitNotice(exit: { executorId: string; symbol: string; exitReason: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'time_limit' | 'manual'; exitPrice: number; realizedPnl: number; quoteAsset: string }): Notice {
  const how =
    exit.exitReason === 'take_profit'
      ? 'reached its target'
      : exit.exitReason === 'time_limit'
        ? 'ran out its time limit'
        : exit.exitReason === 'trailing_stop'
          ? 'hit its trailing stop'
          : exit.exitReason === 'manual'
            ? 'was closed by hand'
            : 'hit its stop'
  const kind: AlertKind = exit.exitReason === 'take_profit' ? 'TARGET_REACHED' : exit.exitReason === 'time_limit' || exit.exitReason === 'manual' ? 'TRADE_EXECUTED' : 'STOP_TRIGGERED'
  return {
    title: `${exit.symbol}: real position ${how}`,
    body: `Closed by its watcher at ${exit.exitPrice}: ${money(exit.realizedPnl, exit.quoteAsset)} realized. A real sell was placed.`,
    extra: { kind, thread: exit.executorId, severity: 'high' }
  }
}

/** Something the app runs on has failed: the scanner, the stream, the feeds, the AI key. */
export function systemFailureNotice(what: 'scanner' | 'stream' | 'feed' | 'ai-key', detail: string): Notice {
  const titles = { scanner: 'The scanner is failing', stream: 'The live stream is dead', feed: 'The news feeds cannot be read', 'ai-key': 'The OpenRouter key was rejected' }
  return { title: titles[what], body: `${detail} Nothing was placed; what is open keeps its stops.`, extra: { kind: 'SYSTEM_FAILURE', thread: what, severity: 'high', threadSeconds: 3600 } }
}

/** A breaker tripped: the AI budget, a model rested, the day's live loss, the exchange's health. */
export function breakerNotice(what: 'ai-budget' | 'model' | 'live-loss' | 'health' | 'health-ok', detail: string, thread: string = what): Notice {
  const titles = {
    'ai-budget': "Today's AI budget is spent",
    model: 'A model is rested for the day',
    'live-loss': 'Live trading disarmed: the daily loss limit',
    health: 'LIVE TRADING PAUSED',
    'health-ok': 'Live trading resumed'
  }
  const severity: AlertSeverity = what === 'health-ok' ? 'watch' : 'high'
  return {
    title: titles[what],
    body: detail,
    extra: { kind: 'CIRCUIT_BREAKER', thread, severity: severity === 'watch' ? 'watch' : 'high', threadSeconds: what === 'model' || what === 'ai-budget' ? 86_400 : 1800 }
  }
}

/** A paper trade refused for a reason a person can act on: funds, the money-out cap. Not the market
 * reasons that repeat every minute (a spread, a stale price), which the Watch card says. */
export function tradeBlockedNotice(symbol: string, reason: string): Notice {
  return { title: `${symbol}: paper trade not opened`, body: `${reason} Nothing was placed.`, extra: { kind: 'TRADE_BLOCKED', thread: 'paper-blocked', severity: 'watch' } }
}

/** The refusal reasons a person can act on, by the words the writer gives (shared/aiWatchPaper.ts,
 * shared/paperRisk.ts, shared/paperPause.ts): a word in each that the market reasons do not have. */
export function actionableRefusal(text: string): boolean {
  return /paper account|money-out|cap on what|paused|funds|balance/i.test(text)
}

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 16)
}

/** CONFIRM: a paper BUY the watch opened, told as ready to confirm as a real order (the V4 document,
 * §45). The person fills the order in from Opportunities and places it; nothing is placed by this. */
export function confirmNotice(event: Pick<MarketEvent, 'id' | 'symbol' | 'type' | 'time'>, call: { who: string; confidence: number }): Notice {
  const at = `${new Date(event.time * 1000).toISOString().slice(11, 16)} UTC`
  return {
    title: `${event.symbol}: ready to confirm`,
    body: `${call.who} at ${Math.round(call.confidence * 100)}% confidence called a BUY on the ${describeEventType(event.type).toLowerCase()} at ${at}, and a paper trade is open on it. Open Opportunities and press Confirm to fill in a real order from the call, sized by your risk setting: you place it, and nothing is placed by this.`,
    extra: { kind: 'TRADE_OPPORTUNITY', thread: `confirm:${event.id}`, severity: 'high' }
  }
}
