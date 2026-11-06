import { SOURCE_RECORD_VERSION, sourcePredictionId, type SourcePrediction } from '../evaluation/predictionRecord'
import type { OpenPosition } from './hyperliquid'
import { okxCoinOf } from './okx'

// WHAT THE FOUND TRADERS HOLD (V9 Stage 4, 6 November 2026; registered as V9-TOP-TRADERS-2 before anything was read).
// Once a day, at the first turn after 00:00 UTC -- within the day's first two hours, or not that day, so that every
// call is made at the same hour and is read against the same day's moves -- the open positions of every found trader the app has analysed are
// read (Hyperliquid's clearinghouseState, OKX's current positions) and counted coin by coin, each trader once, on its
// net side. Where at least three hold a coin of the forecast's universe and at least two thirds of them hold it the
// same way, that way is recorded as a call of the source 'top-traders': a direction over the next day, scored like
// every other source from the coin's own minutes, net of a 0.24% round trip, and judged once sixty days of calls are
// scored, against the share of the same days' coins that moved that way (most found traders are long; a market that
// rose would make any long-leaning source look right).
//
// Until it is judged, and if it fails, what they hold is CONTEXT on Copy Traders: never shown on Home, never a card's
// side, never a trade. It reads; it places nothing.

export const TOP_TRADERS_LINES = {
  version: 'top-traders-v1',
  /** At least this many found traders hold the coin. */
  minHolders: 3,
  /** At least this share of them hold it the same way. */
  minShare: 2 / 3,
  /** The call speaks for a day. */
  horizonSec: 86_400,
  /** The positions are read within this long after 00:00 UTC; a day the app is not running then has no call. */
  readWindowSec: 2 * 3600,
  /** The round trip a call is scored net of, in percent. */
  roundTripPct: 0.24
} as const

/** A found trader's side on a coin: their net position's sign. */
export interface TraderHolding {
  traderKey: string
  coin: string
  side: 'long' | 'short'
}

/** The coin a venue names, as the forecast's universe names its base: Hyperliquid writes a thousand of a small coin as
 * "kPEPE". */
export function baseOfCoin(coin: string): string {
  return /^k[A-Z0-9]{2,}$/.test(coin) ? coin.slice(1) : coin.toUpperCase()
}

/** A trader's holdings: one a coin, by the sign of their net size; none where it nets to nothing. */
export function holdingsOf(traderKey: string, positions: readonly Pick<OpenPosition, 'coin' | 'size'>[]): TraderHolding[] {
  const net = new Map<string, number>()
  for (const position of positions) {
    if (!Number.isFinite(position.size) || position.size === 0) continue
    const coin = baseOfCoin(position.coin)
    net.set(coin, (net.get(coin) ?? 0) + position.size)
  }
  return [...net.entries()].filter(([, size]) => size !== 0).map(([coin, size]) => ({ traderKey, coin, side: size > 0 ? 'long' : 'short' }))
}

/** An OKX lead trader's open positions as sides: each USDT-margined perpetual's coin, its size's sign by its position
 * side (or by its own sign, in net mode). Its size in contracts says nothing here: a side is a side. */
export function okxSidesOf(raw: unknown): Pick<OpenPosition, 'coin' | 'size'>[] {
  const out: Pick<OpenPosition, 'coin' | 'size'>[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const entry = item as { instId?: unknown; subPos?: unknown; posSide?: unknown } | null
    if (entry === null || typeof entry !== 'object') continue
    const coin = okxCoinOf(entry.instId)
    const contracts = typeof entry.subPos === 'string' ? Number(entry.subPos) : typeof entry.subPos === 'number' ? entry.subPos : Number.NaN
    if (coin === null || !Number.isFinite(contracts) || contracts === 0) continue
    const short = entry.posSide === 'short' || (entry.posSide === 'net' && contracts < 0)
    out.push({ coin, size: short ? -1 : 1 })
  }
  return out
}

/** A coin as the found traders hold it, and the way it is called where they agree. */
export interface CoinConsensus {
  coin: string
  longs: number
  shorts: number
  holders: number
  side: 'up' | 'down' | null
}

/** Each coin's holders, each trader once (a trader's later holding of a coin replaces an earlier one), and the way the
 * rule calls: at least `minHolders`, at least `minShare` one way. The coins of `universe` only, where one is given;
 * the most held first. */
export function consensusOf(holdings: readonly TraderHolding[], universe: ReadonlySet<string> | null = null, lines = TOP_TRADERS_LINES): CoinConsensus[] {
  const byCoin = new Map<string, Map<string, 'long' | 'short'>>()
  for (const holding of holdings) {
    if (universe !== null && !universe.has(holding.coin)) continue
    const traders = byCoin.get(holding.coin) ?? new Map<string, 'long' | 'short'>()
    traders.set(holding.traderKey, holding.side)
    byCoin.set(holding.coin, traders)
  }
  return [...byCoin.entries()]
    .map(([coin, traders]): CoinConsensus => {
      const sides = [...traders.values()]
      const longs = sides.filter((side) => side === 'long').length
      const shorts = sides.length - longs
      const holders = sides.length
      const side = holders >= lines.minHolders && longs / holders >= lines.minShare ? 'up' : holders >= lines.minHolders && shorts / holders >= lines.minShare ? 'down' : null
      return { coin, longs, shorts, holders, side }
    })
    .sort((a, b) => b.holders - a.holders || a.coin.localeCompare(b.coin))
}

/** The day's calls as source predictions: each coin the rule calls, at its price when read, its way over the next day. */
export function topTraderPredictionsOf(
  consensus: readonly CoinConsensus[],
  madeAt: number,
  prices: ReadonlyMap<string, number>,
  traders: number,
  versions: { engine: string; config: string },
  lines = TOP_TRADERS_LINES
): SourcePrediction[] {
  const out: SourcePrediction[] = []
  let seq = 0
  for (const entry of consensus) {
    if (entry.side === null) continue
    const pair = `${entry.coin}USDT`
    const price = prices.get(pair)
    if (price === undefined || !(price > 0)) continue
    seq++
    const agree = entry.side === 'up' ? entry.longs : entry.shorts
    out.push({
      v: SOURCE_RECORD_VERSION,
      id: sourcePredictionId('top-traders', pair, madeAt, seq),
      source: 'top-traders',
      sourceVersion: lines.version,
      kind: 'direction',
      pair,
      venue: 'binance',
      madeAt,
      bar: null,
      horizonSec: lines.horizonSec,
      refPrice: price,
      side: entry.side,
      movePct: null,
      targetPrice: null,
      window: { fromSec: 0, toSec: lines.horizonSec },
      dist: { pRight: null, q: null, pMove: null },
      scenarios: null,
      cost: { roundTripPct: lines.roundTripPct, basis: 'flat', stakeQuote: 0 },
      expectedNet: null,
      reason: `${agree} of the ${entry.holders} found traders holding ${entry.coin} hold it ${entry.side === 'up' ? 'long' : 'short'} (${traders} found traders read)`,
      evidence: [`top-traders:${entry.coin}`],
      unit: Math.floor(madeAt / 86_400),
      versions
    })
  }
  return out
}
