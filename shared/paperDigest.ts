import type { ExecutorConfig, PaperDigestSettings, PositionExecutorParams } from './ipc'
import { describeR, rMultiple } from './paperRisk'

// ONE DESKTOP NOTICE A DAY: WHAT THE APP'S OWN PAPER TRADES DID THE DAY BEFORE.
//
// The watch and the news rules open paper trades by themselves (shared/aiWatchPaper.ts,
// shared/newsActions.ts; shared/paperRisk.ts sizes them). Each opening raises a notice already,
// but what they come to is only on the app's pages. Since 5 October 2026, when the user chose it,
// one notice a day says what was opened and closed on paper the UTC day before, and what each
// closed trade made against what it risked at its stop: its R. A day with nothing opened or closed
// raises none, and a day the app was not open for is not caught up on later: only the day before
// the first look after midnight is told.
//
// IT READS AND SAYS. It opens, closes and asks nothing, and costs nothing. The day it last told is
// kept in settings.json beside the switch, so that a restart does not tell it twice.

export const DEFAULT_PAPER_DIGEST: PaperDigestSettings = { enabled: true, lastDay: null }

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** A stored setting, read as one. On until switched off. */
export function healPaperDigest(value: unknown): PaperDigestSettings {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Partial<Record<keyof PaperDigestSettings, unknown>>
  return {
    enabled: raw.enabled === false ? false : DEFAULT_PAPER_DIGEST.enabled,
    lastDay: typeof raw.lastDay === 'string' && DAY.test(raw.lastDay) ? raw.lastDay : null
  }
}

/** `2026-10-05`, the UTC day a moment falls in. */
export function utcDay(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10)
}

export interface PaperDigestGroup {
  opened: number
  closed: number
  /** Of the closed, the ones whose entry was never reached, or that were dropped before it was. */
  neverEntered: number
  /** Of the entered, the ones that made money after fees. */
  ahead: number
  /** What the entered ones made or lost after fees, by quote asset, in the order first seen. */
  pnl: { asset: string; amount: number }[]
  /** What the entered ones with a stop made, in what each risked there, added up; and how many. */
  r: number
  rTrades: number
  /** Entered ones with no stop: a delisting's short. */
  unmeasured: number
}

export interface PaperDigest {
  day: string
  watch: PaperDigestGroup
  news: PaperDigestGroup
  /** The app's own paper trades still open when it is read. */
  openNow: number
}

function emptyGroup(): PaperDigestGroup {
  return { opened: 0, closed: 0, neverEntered: 0, ahead: 0, pnl: [], r: 0, rTrades: 0, unmeasured: 0 }
}

/** What the app's own paper trades -- a paper Position with the watch's mark or a news rule's --
 * did on `day`: opened by when each was made, closed by when its position ended. One stopped by
 * hand carries no result and is not counted as closed. */
export function paperDigest(executors: ExecutorConfig[], day: string): PaperDigest {
  const digest: PaperDigest = { day, watch: emptyGroup(), news: emptyGroup(), openNow: 0 }
  for (const executor of executors) {
    if (executor.mode !== 'paper' || executor.type !== 'position') continue
    const group = executor.watch !== undefined ? digest.watch : executor.newsRule !== undefined ? digest.news : null
    if (group === null) continue
    if (executor.status === 'active') digest.openNow++
    if (utcDay(executor.createdAt) === day) group.opened++
    const result = executor.watch?.result ?? executor.newsRule?.result
    if (executor.status !== 'stopped' || result === undefined || utcDay(result.closedAt) !== day) continue
    group.closed++
    if (result.exit === 'entry_expired' || result.exit === 'btc_moved') {
      group.neverEntered++
      continue
    }
    if (result.pnlQuote > 0) group.ahead++
    const held = group.pnl.find((entry) => entry.asset === executor.quoteAsset)
    if (held === undefined) group.pnl.push({ asset: executor.quoteAsset, amount: result.pnlQuote })
    else held.amount += result.pnlQuote
    // R, from shared/paperRisk.ts: what it made over what its stop would have lost.
    const r = rMultiple(result.pnlQuote, executor.params as PositionExecutorParams)
    if (r === null) group.unmeasured++
    else {
      group.r += r
      group.rTrades++
    }
  }
  return digest
}

/** "+0.30", "-1.25": signed as the app writes amounts elsewhere. */
const signed = (value: number): string => `${value > 0 ? '+' : ''}${value.toFixed(2)}`

/** One origin's day in a sentence: "The watch opened 3 paper trades and closed 2, 1 of them ahead:
 * +0.30 USDT after fees, or +0.20 R against what each risked at its stop; 1 more never entered."
 * Null when it opened and closed nothing. */
function groupSentence(name: string, noun: [string, string], group: PaperDigestGroup): string | null {
  if (group.opened === 0 && group.closed === 0) return null
  const counted = (n: number): string => (n === 0 ? `no ${noun[1]}` : `${n} ${n === 1 ? noun[0] : noun[1]}`)
  const entered = group.closed - group.neverEntered
  let sentence = `${name} opened ${counted(group.opened)}`
  if (entered > 0) {
    const sums = group.pnl.map((entry) => `${signed(entry.amount)} ${entry.asset}`).join(' and ')
    const r =
      group.rTrades === 0
        ? ', with no stop to measure R against'
        : group.rTrades === entered
          ? `, or ${describeR(group.r)} against what each risked at its stop`
          : `, or ${describeR(group.r)} for the ${group.rTrades} with a stop`
    sentence += ` and closed ${entered}, ${group.ahead} of them ahead: ${sums} after fees${r}`
  }
  if (group.neverEntered > 0) sentence += entered > 0 ? `; ${group.neverEntered} more never entered` : `, and ${group.neverEntered} never entered`
  return `${sentence}.`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The notice for a day, or null when nothing was opened or closed on it. */
export function paperDigestNotice(digest: PaperDigest): { title: string; body: string } | null {
  const sentences = [groupSentence('The watch', ['paper trade', 'paper trades'], digest.watch), groupSentence('The news rules', ['paper short', 'paper shorts'], digest.news)].filter(
    (sentence): sentence is string => sentence !== null
  )
  if (sentences.length === 0) return null
  const [, month, date] = digest.day.split('-').map(Number)
  const open = digest.openNow === 0 ? 'None is open now.' : `${digest.openNow} ${digest.openNow === 1 ? 'is' : 'are'} open now.`
  return {
    title: `Paper trades on ${date} ${MONTHS[month - 1]} (UTC)`,
    body: `${sentences.join(' ')} ${open} Nothing real was placed. The daily report on Performance has the day.`
  }
}

/** Whether to tell a day now, and which: the UTC day before `nowSec`, once, while the digest is on.
 * Null when it is off or that day has been told; otherwise the day to mark as told, and the notice,
 * or null for a day with nothing to tell. */
export function planPaperDigest(input: { setting: PaperDigestSettings; executors: ExecutorConfig[]; nowSec: number }): { day: string; notice: { title: string; body: string } | null } | null {
  if (!input.setting.enabled) return null
  const day = utcDay(input.nowSec - 86_400)
  if (input.setting.lastDay !== null && input.setting.lastDay >= day) return null
  return { day, notice: paperDigestNotice(paperDigest(input.executors, day)) }
}
