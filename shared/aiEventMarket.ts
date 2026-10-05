import type { Candle } from './ipc'

// THE MARKET AROUND AN EVENT.
//
// The first benchmark on events (4 October 2026) showed three models that each took the side of
// the move, every time. They had been shown one pair: its event, and seven days of its own
// candles. Whether that pair rose because everything rose, or rose alone, was not in the question,
// and it is the first thing a person looking at a pump asks.
//
// So a question can carry a `market` block: what the two reference markets did over the same
// fifteen minutes, hour, four hours and day, and this pair's return less each of theirs.
//
// IT IS REBUILT FROM CANDLES, NEVER HANDED IN, for the reason the event is (shared/aiContext.ts):
// a caller names two markets and a minute by the candles it sends, and cannot say what they did.
//
// NOTHING AT OR AFTER THE EVENT'S MINUTE IS READ. A reference bar that opens at the event's time
// is the first candle of the future, exactly as the pair's own is.
//
// NO FIGURE HERE IS A VIEW. The block is returns and differences of returns. The two labels below
// it are fixed lines for cutting results by, worked out by arithmetic and never shown to or asked
// of a model.

/** The two reference markets, on the event's own exchange. Bitcoin is the market; ether is the
 * one other coin large enough to say something Bitcoin does not. */
export const MARKET_REFERENCE_SYMBOLS = { btc: 'BTCUSDT', eth: 'ETHUSDT' } as const

const MINUTE = 60
const QUARTER_HOUR = 900
/** Minute bars a reference needs: four hours, and the bar they are measured from. */
export const MARKET_BARS_1M = 241
/** Fifteen-minute bars: a day, and the bar it is measured from. */
export const MARKET_BARS_15M = 97

export interface AiMarketReturns {
  m15: number
  h1: number
  h4: number
  /** Up to the last fifteen-minute bar that had closed, as the pair's own day is. Null when the
   * candles for it are not all there. */
  h24: number | null
}

/** What a model is shown of the market around an event. Percent, six significant digits. */
export interface AiMarketBlock {
  btc: AiMarketReturns
  eth: AiMarketReturns
  /** This pair's return less Bitcoin's over each stretch: positive when it rose more, or fell less. */
  vsBtc: AiMarketReturns
  vsEth: AiMarketReturns
}

export interface ReferenceCandles {
  /** COMPLETED 1-minute candles, oldest first, ending at the minute before the event. */
  candles1m: Candle[]
  /** COMPLETED 15-minute candles, oldest first, ending at the last one closed by the event. */
  candles15m: Candle[]
}

export interface EventReference {
  btc: ReferenceCandles
  eth: ReferenceCandles
}

function sig(value: number): number {
  return Number.isFinite(value) ? Number(value.toPrecision(6)) : 0
}

/** The last `count` bars of `bars` if they are `count` unbroken bars of `step` seconds, else null. */
function unbroken(bars: Candle[], count: number, step: number): Candle[] | null {
  if (bars.length < count) return null
  const tail = bars.slice(-count)
  return tail[count - 1].time - tail[0].time === (count - 1) * step ? tail : null
}

function change(from: Candle, to: Candle): number | null {
  return from.close > 0 && to.close > 0 ? (to.close / from.close - 1) * 100 : null
}

/** One reference market's returns up to an event's minute, or null when its minute candles do not
 * run unbroken to the minute before it. A day that cannot be measured is null on its own: the
 * shorter stretches are what the event is set against, and they do not need it. */
export function referenceReturns(reference: ReferenceCandles, eventTime: number): AiMarketReturns | null {
  const minutes = unbroken(
    reference.candles1m.filter((bar) => bar.time < eventTime),
    MARKET_BARS_1M,
    MINUTE
  )
  // The newest has to be the minute the event was read at, or these are returns up to some
  // earlier moment than the event's.
  if (minutes === null || minutes[minutes.length - 1].time !== eventTime - MINUTE) return null
  const last = minutes[minutes.length - 1]
  const over = (bars: number): number | null => change(minutes[minutes.length - 1 - bars], last)
  const m15 = over(15)
  const h1 = over(60)
  const h4 = over(240)
  if (m15 === null || h1 === null || h4 === null) return null

  const quarters = unbroken(
    reference.candles15m.filter((bar) => bar.time + QUARTER_HOUR <= eventTime),
    MARKET_BARS_15M,
    QUARTER_HOUR
  )
  const fresh = quarters !== null && eventTime - (quarters[quarters.length - 1].time + QUARTER_HOUR) < QUARTER_HOUR
  const h24 = quarters !== null && fresh ? change(quarters[0], quarters[quarters.length - 1]) : null
  return { m15: sig(m15), h1: sig(h1), h4: sig(h4), h24: h24 === null ? null : sig(h24) }
}

function less(pair: AiMarketReturns, reference: AiMarketReturns): AiMarketReturns {
  return {
    m15: sig(pair.m15 - reference.m15),
    h1: sig(pair.h1 - reference.h1),
    h4: sig(pair.h4 - reference.h4),
    h24: pair.h24 === null || reference.h24 === null ? null : sig(pair.h24 - reference.h24)
  }
}

/** The market block for an event, or null when either reference's candles do not reach its
 * minute. `pair` is the event's own returns over the same stretches.
 *
 * NULL, NOT HALF A BLOCK. A question with one reference missing would be a third kind of question
 * with no version of its own. */
export function buildMarketBlock(pair: AiMarketReturns, reference: EventReference, eventTime: number): AiMarketBlock | null {
  const btc = referenceReturns(reference.btc, eventTime)
  const eth = referenceReturns(reference.eth, eventTime)
  if (btc === null || eth === null) return null
  return { btc, eth, vsBtc: less(pair, btc), vsEth: less(pair, eth) }
}

// ---------------------------------------------------------------------------------------------
// Two labels for cutting results by. Fixed lines, written here before any result was looked at.

/** Bitcoin's four-hour change, in percent, at or beyond which it is called rising or falling. */
export const BTC_REGIME_PCT = 1
/** The share of an event's fifteen-minute move that Bitcoin has to have made, the same way, for
 * the event to count as made with the market. */
export const WITH_MARKET_SHARE = 0.5

export type BtcRegime = 'rising' | 'falling' | 'flat'
export type EventCompany = 'with the market' | 'on its own'

/** What Bitcoin was doing when an event was raised, by its last four hours. */
export function btcRegimeOf(block: Pick<AiMarketBlock, 'btc'>): BtcRegime {
  if (block.btc.h4 >= BTC_REGIME_PCT) return 'rising'
  return block.btc.h4 <= -BTC_REGIME_PCT ? 'falling' : 'flat'
}

/** Whether a pair moved with Bitcoin or by itself: with the market when Bitcoin moved the same
 * way over the same fifteen minutes by at least half as much. Bitcoin's own events are always
 * with the market: it is the market. */
export function eventCompanyOf(pairM15: number, block: Pick<AiMarketBlock, 'btc'>): EventCompany {
  if (!(Math.abs(pairM15) > 0)) return 'on its own'
  return block.btc.m15 / pairM15 >= WITH_MARKET_SHARE ? 'with the market' : 'on its own'
}
