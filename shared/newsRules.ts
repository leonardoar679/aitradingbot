import { FEE_RATE } from './fees'
import type { Candle } from './ipc'
import { readEventAt } from './marketEvent'

// The trades research/NEWS.md measured after Binance's announcements, as arithmetic on 1-minute
// candles: the bracket every study here has used, and the four-hour hold.
//
// ONE MODULE FOR THE STUDIES AND THE APP. research/announcementStudy.ts scored both halves of the
// news study and of the Upbit study with these functions, and the app's record of what the two
// rules that passed, and the two trades that came nearest, would have made since
// (electron/services/newsRecordService.ts) scores each announcement after it with the same ones, so
// that the record and the studies can be set side by side. A change here is a change to all of them.

/** An app that reads the list once a minute sees an announcement within the minute after it, and
 * can act at the next bar's open at the earliest: the second bar after the announcement's own. */
export const ENTRY_DELAY_BARS = 2
/** The bracket: a stop and a target in units of the coin's usual fifteen-minute move, and out
 * after an hour otherwise. */
export const BRACKET_STOP_SIGMAS = 1.5
export const BRACKET_TARGET_SIGMAS = 3
export const BRACKET_HOLD_BARS = 60
/** The hold: out at the open four hours after the announcement's minute, with no stop and no
 * target. */
export const HOLD_EXIT_BARS = 240
export const ROUND_TRIP_FEE_PCT = FEE_RATE * 2 * 100
/** Slippage a side: a coin being delisted, or marked as one that may be, has a thin book. */
export const THIN_BOOK_SLIPPAGE = 0.001
export const ORDINARY_SLIPPAGE = 0.0005
/** A minute with no row had no trade in it, and is carried at the last close. A hole longer than
 * this is not filled: the series is cut there (fillMinutes). */
export const LONGEST_FILLED_SECONDS = 30 * 60

export type RuleSide = 1 | -1

/** The bracket's net, in percent after fees and slippage, entered at `entryIndex`'s open; null
 * when there is under an hour of candles from there. The stop is checked before the target in a
 * minute that reaches both, and a stop gapped through is filled at the open. */
export function bracketNet(bars: Candle[], entryIndex: number, side: RuleSide, sigma15Pct: number, slippage: number): number | null {
  if (entryIndex + BRACKET_HOLD_BARS > bars.length) return null
  const open = bars[entryIndex].open
  const entry = open * (1 + side * slippage)
  const stop = open * (1 - (side * BRACKET_STOP_SIGMAS * sigma15Pct) / 100)
  const target = open * (1 + (side * BRACKET_TARGET_SIGMAS * sigma15Pct) / 100)
  const net = (exit: number): number => side * (exit / entry - 1) * 100 - ROUND_TRIP_FEE_PCT
  for (let i = entryIndex; i < entryIndex + BRACKET_HOLD_BARS; i++) {
    const bar = bars[i]
    const stopped = side > 0 ? bar.low <= stop : bar.high >= stop
    if (stopped) {
      const level = side > 0 ? Math.min(stop, bar.open) : Math.max(stop, bar.open)
      return net(level * (1 - side * slippage))
    }
    const reached = side > 0 ? bar.high >= target : bar.low <= target
    if (reached) return net(target)
  }
  return net(bars[entryIndex + BRACKET_HOLD_BARS - 1].close * (1 - side * slippage))
}

/** The hold's net, in percent after fees and slippage: in at `entryIndex`'s open and out at
 * `exitIndex`'s; null when there is no such bar. */
export function holdNet(bars: Candle[], entryIndex: number, exitIndex: number, side: RuleSide, slippage: number): number | null {
  if (exitIndex >= bars.length || !(bars[entryIndex].open > 0)) return null
  const entry = bars[entryIndex].open * (1 + side * slippage)
  const exit = bars[exitIndex].open * (1 - side * slippage)
  return side * (exit / entry - 1) * 100 - ROUND_TRIP_FEE_PCT
}

/** 1-minute candles as a series with no holes, so that "n bars ago" keeps meaning n minutes: a
 * minute with no row is carried at the last close with no volume. A hole longer than half an
 * hour -- maintenance, a halt -- is not filled: the series is cut there, and only the part holding
 * `aroundSec` is kept. `filled` counts the minutes carried, as research/news.ts reports them. */
export function fillMinutes(rows: Candle[], aroundSec: number): { bars: Candle[]; filled: number } {
  const sorted = [...rows].sort((a, b) => a.time - b.time)
  let bars: Candle[] = []
  let filled = 0
  for (const row of sorted) {
    const previous = bars[bars.length - 1]
    if (previous !== undefined) {
      if (row.time <= previous.time) continue
      if (row.time - previous.time > LONGEST_FILLED_SECONDS) {
        if (previous.time >= aroundSec) break
        bars = []
      } else {
        for (let t = previous.time + 60; t < row.time; t += 60) {
          bars.push({ time: t, open: previous.close, high: previous.close, low: previous.close, close: previous.close, volume: 0 })
          filled++
        }
      }
    }
    bars.push({ time: row.time, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume })
  }
  return { bars, filled }
}

/** The symbols a coin's spot price may be under, in the order to try them: a ticker Binance
 * prefixes with a multiple (1000SATS) may trade without it on spot. */
export function spotSymbolCandidates(ticker: string): string[] {
  const own = `${ticker}USDT`
  const bare = ticker.replace(/^(1000000|1000|1M)(?=[A-Z])/, '')
  return bare !== ticker ? [own, `${bare}USDT`] : [own]
}

export type RuleScore = { netPct: number } | { skipped: string }

function announcementIndex(bars: Candle[], releaseSec: number): number {
  const minute = Math.floor(releaseSec / 60) * 60
  return bars.findIndex((bar) => bar.time === minute)
}

/** The four-hour hold, short, on one coin, as research/NEWS.md and research/UPBIT.md measured it:
 * short at the second bar after the announcement's minute, out at the open four hours after it,
 * thin-book slippage. It is a delisting's rule, and the trade Binance's Monitoring Tag and Upbit's
 * caution designation missed their bar with. */
export function scoreHeldShort(bars: Candle[], releaseSec: number): RuleScore {
  const i = announcementIndex(bars, releaseSec)
  if (i < 0) return { skipped: 'no candle at the announcement minute' }
  const net = holdNet(bars, i + ENTRY_DELAY_BARS, i + HOLD_EXIT_BARS, -1, THIN_BOOK_SLIPPAGE)
  return net === null ? { skipped: 'under four hours of candles after it' } : { netPct: net }
}

/** The bracket, short, on one coin, as research/NEWS.md measured it: at the second bar, its stop
 * and target from the coin's usual move read at the minute before the announcement's, thin-book
 * slippage. It is a Monitoring Tag's rule. */
export function scoreBracketShort(bars: Candle[], releaseSec: number): RuleScore {
  const i = announcementIndex(bars, releaseSec)
  if (i < 0) return { skipped: 'no candle at the announcement minute' }
  const reading = readEventAt(bars, i - 1)
  if (reading === null) return { skipped: 'under twelve hours of candles before it' }
  const net = bracketNet(bars, i + ENTRY_DELAY_BARS, -1, reading.sigma15Pct, THIN_BOOK_SLIPPAGE)
  return net === null ? { skipped: 'under an hour of candles after it' } : { netPct: net }
}

export type RuleTrade = 'hold' | 'bracket'

/** When a trade on an announcement is over, so that it can be scored: once the last minute it reads
 * has closed. */
export function tradeReadyAt(trade: RuleTrade, releaseSec: number): number {
  const minute = Math.floor(releaseSec / 60) * 60
  const lastBar = trade === 'hold' ? HOLD_EXIT_BARS : ENTRY_DELAY_BARS + BRACKET_HOLD_BARS - 1
  return minute + (lastBar + 1) * 60
}
