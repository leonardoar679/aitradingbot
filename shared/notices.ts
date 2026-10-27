import type { AlertKind, AlertSeverity } from './alerts'
import { describeBand, eventTypeWord, type MarketEvent } from './marketEvent'
import { ENGLISH, msg, type I18n } from './i18n/translate'

// THE NOTICES THE DOCUMENT NAMES, EACH IN WORDS (the V4 document, §47-49), beside the ones the app
// already raised (a story, a crash, a call, a paper trade opened, a drop, the digest, the pause, the
// exit check). Every notice goes through one handler in the main process (noticeService.ts), which
// obeys the Notifications control, keeps one THREAD per kind and pair for thirty minutes so that a
// repeat updates the thread and raises no new notice, records what it told (shared/records.ts) and
// tells the window. The texts are here, pure, so that each is pinned by a test. Since V6 Stage 14 each is
// said in a language: English unless the window or the main process hands the person's (I18n).

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
  /** The sound it makes, where its meaning is not its kind's (shared/sounds.ts; V6 Stage 13). */
  sound?: import('./sounds').NoticeSound
}

export interface Notice {
  title: string
  body: string
  extra: NoticeExtra
}

const pctIn = (value: number, i18n: I18n): string => (i18n.language === 'en' ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : i18n.pct(value, 2))
const moneyIn = (value: number, asset: string, i18n: I18n): string =>
  i18n.language === 'en' ? `${value >= 0 ? '+' : ''}${Number(value.toFixed(2))} ${asset}` : `${i18n.signed(Number(value.toFixed(2)), 2)} ${asset}`

/** An urgent event the watch did not ask about, and why: told once per pair per thread. `why` is said
 * in the notice's language by its caller. */
export function marketEventNotice(event: Pick<MarketEvent, 'symbol' | 'type' | 'band' | 'score' | 'returnsPct' | 'time'>, why: string, i18n: I18n = ENGLISH): Notice {
  const { t } = i18n
  return {
    title: t('{pair}: {kind} ({band})', { pair: event.symbol, kind: eventTypeWord(event.type, i18n), band: describeBand(event.band, i18n) }),
    body: t('Score {score}, {move} in fifteen minutes at {time} UTC. The watch did not ask about it: {why} Nothing was placed.', {
      score: Math.round(event.score),
      move: pctIn(event.returnsPct.m15, i18n),
      time: utcClock(event.time, i18n),
      why
    }),
    extra: { kind: 'MARKET_EVENT', thread: event.symbol, severity: 'watch' }
  }
}

/** Models on opposite sides of one event. */
export function disagreementNotice(event: Pick<MarketEvent, 'id' | 'symbol' | 'type'>, sides: { model: string; side: 'long' | 'short' }[], i18n: I18n = ENGLISH): Notice {
  const { t } = i18n
  const longs = sides.filter((entry) => entry.side === 'long').map((entry) => entry.model)
  const shorts = sides.filter((entry) => entry.side === 'short').map((entry) => entry.model)
  return {
    title: t('{pair}: the models disagree', { pair: event.symbol }),
    body: t('On the {kind}: BUY from {longs}; SELL from {shorts}. The paper trade, if any, follows the model it is set to.', { kind: eventTypeWord(event.type, i18n), longs: longs.join(', '), shorts: shorts.join(', ') }),
    extra: { kind: 'MODEL_DISAGREEMENT', thread: event.id, severity: 'watch' }
  }
}

export type PaperCloseExit = 'take_profit' | 'stop_loss' | 'trailing_stop' | 'time_limit' | 'liquidation' | 'ai_exit'

/** A paper trade of the app's own closed: how, and what it made or lost, in money and in R. */
/** How a paper trade ended, whole: a buy's and a sell's, by its end. */
const PAPER_CLOSED: Record<'buy' | 'sell', Record<PaperCloseExit, string>> = {
  buy: {
    take_profit: msg('{pair}: paper BUY reached its target'),
    stop_loss: msg('{pair}: paper BUY hit its stop'),
    trailing_stop: msg('{pair}: paper BUY hit its trailing stop'),
    liquidation: msg('{pair}: paper BUY was liquidated'),
    ai_exit: msg('{pair}: paper BUY was closed by the exit check'),
    time_limit: msg('{pair}: paper BUY ran out its time limit')
  },
  sell: {
    take_profit: msg('{pair}: paper SELL reached its target'),
    stop_loss: msg('{pair}: paper SELL hit its stop'),
    trailing_stop: msg('{pair}: paper SELL hit its trailing stop'),
    liquidation: msg('{pair}: paper SELL was liquidated'),
    ai_exit: msg('{pair}: paper SELL was closed by the exit check'),
    time_limit: msg('{pair}: paper SELL ran out its time limit')
  }
}

export function paperCloseNotice(
  trade: { id: string; symbol: string; side: 'buy' | 'sell'; quoteAsset: string },
  result: { exit: PaperCloseExit; pnlQuote: number; r: number | null },
  i18n: I18n = ENGLISH
): Notice {
  const { t } = i18n
  const kind: AlertKind = result.exit === 'take_profit' ? 'TARGET_REACHED' : result.exit === 'stop_loss' || result.exit === 'trailing_stop' || result.exit === 'liquidation' ? 'STOP_TRIGGERED' : 'TRADE_EXECUTED'
  const pnl = moneyIn(result.pnlQuote, trade.quoteAsset, i18n)
  const r = result.r === null ? null : i18n.language === 'en' ? `${result.r >= 0 ? '+' : ''}${result.r.toFixed(2)}` : i18n.signed(result.r, 2)
  return {
    title: t(PAPER_CLOSED[trade.side][result.exit] ?? PAPER_CLOSED[trade.side].time_limit, { pair: trade.symbol }),
    body: r === null ? t('{pnl} after fees, on paper. Nothing real was placed or sold.', { pnl }) : t('{pnl} ({r} R) after fees, on paper. Nothing real was placed or sold.', { pnl, r }),
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
export function nearStopNotice(position: { id: string; symbol: string; side: 'buy' | 'sell'; real: boolean }, progress: number, price: number, i18n: I18n = ENGLISH): Notice {
  const { t } = i18n
  const values = { share: i18n.pctPlain(Math.round(progress * 100), 0), price: String(price) }
  const key = position.real
    ? position.side === 'buy'
      ? msg('The real BUY is {share} of the way from its entry to its stop, at {price}. Its stop is still in place on its watcher; nothing was done.')
      : msg('The real SELL is {share} of the way from its entry to its stop, at {price}. Its stop is still in place on its watcher; nothing was done.')
    : position.side === 'buy'
      ? msg('The paper BUY is {share} of the way from its entry to its stop, at {price}. Its stop is still in place; nothing was done.')
      : msg('The paper SELL is {share} of the way from its entry to its stop, at {price}. Its stop is still in place; nothing was done.')
  return {
    title: t('{pair}: near its stop', { pair: position.symbol }),
    body: t(key, values),
    extra: { kind: 'POSITION_RISK', thread: position.id, severity: 'high' }
  }
}

/** How a real position closed, whole, by its end. */
const LIVE_CLOSED: Record<'take_profit' | 'stop_loss' | 'trailing_stop' | 'time_limit' | 'manual', string> = {
  take_profit: msg('{pair}: real position reached its target'),
  time_limit: msg('{pair}: real position ran out its time limit'),
  trailing_stop: msg('{pair}: real position hit its trailing stop'),
  manual: msg('{pair}: real position was closed by hand'),
  stop_loss: msg('{pair}: real position hit its stop')
}

const DEMO_CLOSED = {
  take_profit: msg('{pair}: demo position reached its target'),
  time_limit: msg('{pair}: demo position ran out of time'),
  trailing_stop: msg('{pair}: demo position hit its trailing stop'),
  manual: msg('{pair}: demo position was closed by hand'),
  stop_loss: msg('{pair}: demo position hit its stop')
}

/** A DEMO position closed by its watcher (V7.1 Stage 8): the same kinds, said to be play money. */
export function demoExitNotice(
  exit: { executorId: string; symbol: string; exitReason: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'time_limit' | 'manual'; exitPrice: number; realizedPnl: number; quoteAsset: string },
  i18n: I18n = ENGLISH
): Notice {
  const { t } = i18n
  const kind: AlertKind = exit.exitReason === 'take_profit' ? 'TARGET_REACHED' : exit.exitReason === 'time_limit' || exit.exitReason === 'manual' ? 'TRADE_EXECUTED' : 'STOP_TRIGGERED'
  return {
    title: t(DEMO_CLOSED[exit.exitReason] ?? DEMO_CLOSED.stop_loss, { pair: exit.symbol }),
    body: t('Closed by its watcher at {price}: {pnl} realized on the demo account, play money. A demo sell was placed, not a real one.', { price: String(exit.exitPrice), pnl: moneyIn(exit.realizedPnl, exit.quoteAsset, i18n) }),
    extra: { kind, thread: exit.executorId, severity: 'watch' }
  }
}

/** A real position closed by its watcher: by its target, its stop, or its time limit. */
export function liveExitNotice(
  exit: { executorId: string; symbol: string; exitReason: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'time_limit' | 'manual'; exitPrice: number; realizedPnl: number; quoteAsset: string },
  i18n: I18n = ENGLISH
): Notice {
  const { t } = i18n
  const kind: AlertKind = exit.exitReason === 'take_profit' ? 'TARGET_REACHED' : exit.exitReason === 'time_limit' || exit.exitReason === 'manual' ? 'TRADE_EXECUTED' : 'STOP_TRIGGERED'
  return {
    title: t(LIVE_CLOSED[exit.exitReason] ?? LIVE_CLOSED.stop_loss, { pair: exit.symbol }),
    body: t('Closed by its watcher at {price}: {pnl} realized. A real sell was placed.', { price: String(exit.exitPrice), pnl: moneyIn(exit.realizedPnl, exit.quoteAsset, i18n) }),
    extra: { kind, thread: exit.executorId, severity: 'high' }
  }
}

const FAILURE_TITLES = {
  scanner: msg('The scanner is failing'),
  stream: msg('The live stream is dead'),
  feed: msg('The news feeds cannot be read'),
  'ai-key': msg('The OpenRouter key was rejected'),
  announcements: msg('The announcement reader stopped')
}

/** Something the app runs on has failed: the scanner, the stream, the feeds, the AI key; and since V8 Stage 9 the
 * reader of Binance's announcements, stopped after reads in a row that read nothing. `detail` is said in the notice's
 * language by its caller. */
export function systemFailureNotice(what: 'scanner' | 'stream' | 'feed' | 'ai-key' | 'announcements', detail: string, { t }: I18n = ENGLISH): Notice {
  return {
    title: t(FAILURE_TITLES[what]),
    body: t('{detail} Nothing was placed; what is open keeps its stops.', { detail }),
    extra: { kind: 'SYSTEM_FAILURE', thread: what, severity: 'high', threadSeconds: 3600 }
  }
}

const BREAKER_TITLES = {
  'ai-budget': msg("Today's AI budget is spent"),
  model: msg('A model is rested for the day'),
  'live-loss': msg('Live trading disarmed: the daily loss limit'),
  health: msg('LIVE TRADING PAUSED'),
  'health-ok': msg('Live trading resumed'),
  degraded: msg('A model has degraded'),
  strategy: msg('A strategy is not doing what was measured')
}

/** A breaker tripped: the AI budget, a model rested, the day's live loss, the exchange's health;
 * and, since 8 October 2026, a model or a strategy whose record has degraded (shared/modelHealth.ts,
 * shared/strategyHealth.ts), told once a day on its own thread and switching nothing off. `detail` is
 * said in the notice's language by its caller. */
export function breakerNotice(what: 'ai-budget' | 'model' | 'live-loss' | 'health' | 'health-ok' | 'degraded' | 'strategy', detail: string, thread: string = what, { t }: I18n = ENGLISH): Notice {
  const severity: AlertSeverity = what === 'health-ok' ? 'watch' : 'high'
  const daily = what === 'model' || what === 'ai-budget' || what === 'degraded' || what === 'strategy'
  return {
    title: t(BREAKER_TITLES[what]),
    body: detail,
    extra: { kind: 'CIRCUIT_BREAKER', thread, severity: severity === 'watch' ? 'watch' : 'high', threadSeconds: daily ? 86_400 : 1800 }
  }
}

/** A paper trade refused for a reason a person can act on: funds, the money-out cap. Not the market
 * reasons that repeat every minute (a spread, a stale price), which the Watch card says. The thread is
 * read from the English `reason`; the body says `shown`, the same reason in the notice's language. */
export function tradeBlockedNotice(symbol: string, reason: string, { t }: I18n = ENGLISH, shown: string = reason): Notice {
  // A losing run's pause (shared/paperPause.ts) refuses every call until it is resumed: told once a
  // day on a thread of its own, not once per call (V5 Stage 8, 8 October 2026).
  const paused = PAUSE_REFUSAL.test(reason)
  return {
    title: t('{pair}: paper trade not opened', { pair: symbol }),
    body: t('{reason} Nothing was placed.', { reason: shown }),
    extra: { kind: 'TRADE_BLOCKED', thread: paused ? 'paper-paused' : 'paper-blocked', severity: 'watch', ...(paused ? { threadSeconds: 86_400 } : {}) }
  }
}

/** What the reconciliation found (the V5 document, §102; V5 Stage 11, 8 October 2026): a resting
 * order on the exchange the ledger does not know, or an asset the ledger claims more of than the
 * account holds. HIGH, once per order or asset per RECONCILIATION_THREAD_SECONDS while it stands.
 * The ledger is never rewritten by it: the notice says what was found, and a person puts it right. */
export const RECONCILIATION_THREAD_SECONDS = 4 * 3600

export function reconciliationNotice(what: 'order' | 'asset', detail: string, thread: string, { t }: I18n = ENGLISH): Notice {
  return {
    title: what === 'order' ? t('A resting order this app does not know') : t('A holding the account does not back'),
    body: t('{detail} Nothing was changed: the record is yours to put right.', { detail }),
    extra: { kind: 'RECONCILIATION', thread: `reconcile:${thread}`, severity: 'high', threadSeconds: RECONCILIATION_THREAD_SECONDS }
  }
}

/** The words of a pause's refusal (shared/paperPause.ts paperPauseBlock). */
const PAUSE_REFUSAL = /paused|resumed on Risk & Safety/i

/** The refusal reasons a person can act on, by the words the writer gives (shared/aiWatchPaper.ts,
 * shared/paperRisk.ts, shared/paperPause.ts): a word in each that the market reasons do not have. */
export function actionableRefusal(text: string): boolean {
  return /paper account|money-out|cap on what|funds|balance/i.test(text) || PAUSE_REFUSAL.test(text)
}

function utcClock(sec: number, i18n: I18n = ENGLISH): string {
  return i18n.language === 'en' ? new Date(sec * 1000).toISOString().slice(11, 16) : i18n.utcTime(sec * 1000)
}

/** CONFIRM: a paper BUY the watch opened, told as ready to confirm as a real order (the V4 document,
 * §45). The person fills the order in from Opportunities and places it; nothing is placed by this. */
export function confirmNotice(event: Pick<MarketEvent, 'id' | 'symbol' | 'type' | 'time'>, call: { who: string; confidence: number }, i18n: I18n = ENGLISH): Notice {
  const { t } = i18n
  return {
    title: t('{pair}: ready to confirm', { pair: event.symbol }),
    body: t(
      '{model} at {confidence} confidence called a BUY on the {kind} at {time} UTC, and a paper trade is open on it. Open Opportunities and press Confirm to fill in a real order from the call, sized by your risk setting: you place it, and nothing is placed by this.',
      { model: call.who, confidence: i18n.pctPlain(Math.round(call.confidence * 100), 0), kind: eventTypeWord(event.type, i18n), time: utcClock(event.time, i18n) }
    ),
    extra: { kind: 'TRADE_OPPORTUNITY', thread: `confirm:${event.id}`, severity: 'high' }
  }
}
