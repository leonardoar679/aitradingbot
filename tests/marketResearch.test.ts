import { describe, expect, it } from 'vitest'
import { BTC_REGIME_PCT } from '../shared/aiEventMarket'
import type { Candle, SymbolInfo, Ticker24h } from '../shared/ipc'
import {
  RESEARCH_MIN_QUOTE_VOLUME,
  RESEARCH_UNIVERSE_SIZE,
  RISK_LINES,
  describeMarketRegime,
  describeMarketStatus,
  emptyResearchState,
  markTrending,
  marketRegimeOf,
  marketStatusOf,
  parseTrending,
  rankMovers,
  readResearchPair,
  researchUniverse,
  returnsOf,
  withStep,
  type ResearchPair
} from '../shared/marketResearch'

// shared/marketResearch.ts: what the app studies as it opens (the second V3 document, §4 and §9).
// electron/services/marketResearchService.ts reads; this is the arithmetic, held here on fixtures.

const DAY = 86_400
const NOW = Date.parse('2026-10-06T12:00:00Z') / 1000
const TODAY = Math.floor(NOW / DAY) * DAY

const info = (base: string, quote = 'USDT'): SymbolInfo => ({ symbol: `${base}${quote}`, baseAsset: base, quoteAsset: quote })
const ticker = (symbol: string, over: Partial<Ticker24h> = {}): Ticker24h => ({
  symbol,
  lastPrice: 100,
  priceChange: 0,
  priceChangePercent: 0,
  highPrice: 0,
  lowPrice: 0,
  volume: 1000,
  quoteVolume: 30_000_000,
  ...over
})
const bar = (time: number, open: number, high: number, low: number, close: number, volume = 1): Candle => ({ time, open, high, low, close, volume })

/** Completed 15-minute bars ending just before NOW, all at 100 unless `at` -- bars back from the
 * last one -- says otherwise; and one still forming, which must be ignored. */
function bars15(at: Record<number, number> = {}, count = 98): Candle[] {
  const lastOpen = Math.floor(NOW / 900) * 900 - 900
  const closed = Array.from({ length: count }, (_, k) => {
    const back = count - 1 - k
    const close = at[back] ?? 100
    return bar(lastOpen - back * 900, close, close, close, close)
  })
  return [...closed, bar(lastOpen + 900, 1, 1, 1, 1)]
}

function researched(symbol: string, over: Partial<ResearchPair> = {}): ResearchPair {
  return {
    symbol,
    baseAsset: symbol.replace('USDT', ''),
    price: 100,
    change24hPct: 0,
    quoteVolume24h: 30_000_000,
    change7dPct: 0,
    volumeExpansion: 1,
    upDays: 3,
    fromHigh7dPct: -1,
    trending: false,
    ...over
  }
}

describe('the pairs researched', () => {
  it('are the scanner\'s scannable USDT pairs by volume, the first fifty, each over $20M a day', () => {
    const bases = Array.from({ length: 70 }, (_, k) => `C${k}`)
    const symbols = [info('BTC'), info('USDC'), info('ETH', 'BTC'), ...bases.map((base) => info(base))]
    const tickers = [
      ticker('BTCUSDT', { quoteVolume: 9e9 }),
      ticker('USDCUSDT', { quoteVolume: 8e9 }),
      ticker('ETHBTC', { quoteVolume: 7e9 }),
      ...bases.map((base, k) => ticker(`${base}USDT`, { quoteVolume: 100_000_000 - k * 1_000_000 }))
    ]
    const universe = researchUniverse(symbols, tickers)
    expect(universe).toHaveLength(RESEARCH_UNIVERSE_SIZE)
    expect(universe[0].symbol).toBe('BTCUSDT')
    expect(universe.map((pair) => pair.symbol)).not.toContain('USDCUSDT')
    expect(universe.map((pair) => pair.symbol)).not.toContain('ETHBTC')
    // Below the floor is left out, even inside the first fifty.
    const thin = researchUniverse(symbols, [ticker('BTCUSDT', { quoteVolume: RESEARCH_MIN_QUOTE_VOLUME }), ticker('C0USDT', { quoteVolume: RESEARCH_MIN_QUOTE_VOLUME - 1 })])
    expect(thin.map((pair) => pair.symbol)).toEqual(['BTCUSDT'])
  })

  it('leave out a stock token, whose moves are its stock market\'s and not the altcoins\'', () => {
    const symbols = [info('BTC'), { ...info('SPCXB'), stockToken: true }, info('SOL')]
    const tickers = [ticker('BTCUSDT', { quoteVolume: 9e9 }), ticker('SPCXBUSDT', { quoteVolume: 5e9 }), ticker('SOLUSDT', { quoteVolume: 1e9 })]
    expect(researchUniverse(symbols, tickers).map((pair) => pair.symbol)).toEqual(['BTCUSDT', 'SOLUSDT'])
  })
})

describe('a pair over a day and a week', () => {
  // Eight complete days and today's, forming. Each day closes a little higher than the one before.
  const week = (todayHigh = 110): Candle[] => [
    ...Array.from({ length: 8 }, (_, k) => {
      const time = TODAY - (8 - k) * DAY
      const close = 80 + k
      // Days 1, 2, 4, 6 and 7 close above their open: five of the last seven. Day 3 closes where it
      // opened, which is not up.
      const open = [1, 2, 4, 6, 7].includes(k) ? close - 1 : k === 3 ? close : close + 1
      return bar(time, open, k === 5 ? 120 : close + 2, close - 2, close, 100)
    }),
    bar(TODAY, 99, todayHigh, 95, 100, 40)
  ]

  it('reads the week from the close eight days back, the volume against the week, the up days and the fall from the high', () => {
    const read = readResearchPair({ ...info('SOL'), quoteVolume24h: 50_000_000 }, ticker('SOLUSDT', { lastPrice: 100, priceChangePercent: 2.5, volume: 300 }), week(), NOW)
    expect(read).toMatchObject({ symbol: 'SOLUSDT', baseAsset: 'SOL', price: 100, change24hPct: 2.5, quoteVolume24h: 50_000_000, upDays: 5, trending: false })
    // From the close of the first of the eight, 80.
    expect(read.change7dPct).toBeCloseTo(25, 10)
    expect(read.volumeExpansion).toBeCloseTo(3, 10)
    // The highest of the seven days and today is 120 -- or today's, when today has gone higher.
    expect(read.fromHigh7dPct).toBeCloseTo((100 / 120 - 1) * 100, 10)
    const higher = readResearchPair({ ...info('SOL'), quoteVolume24h: 50_000_000 }, ticker('SOLUSDT', { lastPrice: 100 }), week(125), NOW)
    expect(higher.fromHigh7dPct).toBeCloseTo((100 / 125 - 1) * 100, 10)
  })

  it('says nothing it cannot read', () => {
    const short = week().slice(3)
    const read = readResearchPair({ ...info('SOL'), quoteVolume24h: 50_000_000 }, ticker('SOLUSDT'), short, NOW)
    expect(read).toMatchObject({ change7dPct: null, volumeExpansion: null, upDays: null, fromHigh7dPct: null })
  })
})

describe('the movers', () => {
  const pairs = [
    researched('AUSDT', { change24hPct: 5, change7dPct: null, volumeExpansion: 2 }),
    researched('BUSDT', { change24hPct: -3, change7dPct: 10, volumeExpansion: 4 }),
    researched('CUSDT', { change24hPct: 1, change7dPct: -12, volumeExpansion: null }),
    researched('DUSDT', { change24hPct: 0, change7dPct: 3, volumeExpansion: 1 }),
    researched('EUSDT', { change24hPct: -7, change7dPct: -2, volumeExpansion: 0.5 })
  ]

  it('rank the rises and the falls apart, most first, leaving out a pair without the figure', () => {
    const day = rankMovers(pairs, '24h', 5)
    expect(day.up.map((pair) => pair.symbol)).toEqual(['AUSDT', 'CUSDT'])
    expect(day.down.map((pair) => pair.symbol)).toEqual(['EUSDT', 'BUSDT'])
    const weekly = rankMovers(pairs, '7d', 1)
    expect(weekly).toEqual({ up: [pairs[1]], down: [pairs[2]] })
    const volume = rankMovers(pairs, 'volume', 3)
    expect(volume.up.map((pair) => pair.symbol)).toEqual(['BUSDT', 'AUSDT', 'DUSDT'])
    expect(volume.down).toEqual([])
  })
})

describe('trending', () => {
  const symbols = [info('SOL'), info('PEPE'), info('ETH', 'BTC')]

  it("matches CoinGecko's list to Binance's USDT pairs, and leaves out what it cannot read", () => {
    const json = {
      coins: [
        { item: { symbol: 'sol', name: 'Solana', market_cap_rank: 5 } },
        { item: { symbol: 'XYZ', name: 'Xyz' } },
        { item: { symbol: 'ETH', name: 'Ethereum', market_cap_rank: 2 } },
        { item: null },
        { item: { symbol: 7 } },
        {}
      ]
    }
    expect(parseTrending(json, symbols)).toEqual([
      { symbol: 'SOL', name: 'Solana', marketCapRank: 5, pair: 'SOLUSDT' },
      { symbol: 'XYZ', name: 'Xyz', marketCapRank: null, pair: null },
      // Ether is listed against BTC here, not USDT.
      { symbol: 'ETH', name: 'Ethereum', marketCapRank: 2, pair: null }
    ])
    expect(parseTrending({ status: { error_code: 429 } }, symbols)).toEqual([])
    expect(parseTrending(null, symbols)).toEqual([])
  })

  it('marks the researched pairs it names', () => {
    const marked = markTrending([researched('SOLUSDT'), researched('PEPEUSDT')], [{ symbol: 'SOL', name: 'Solana', marketCapRank: 5, pair: 'SOLUSDT' }])
    expect(marked.map((pair) => pair.trending)).toEqual([true, false])
    expect(markTrending([researched('SOLUSDT', { trending: true })], null)[0].trending).toBe(false)
  })
})

describe('the market', () => {
  it("reads returns from completed fifteen-minute bars, ignoring the one forming", () => {
    // Each stretch from a bar unlike its neighbours, so that one bar off is seen.
    const read = returnsOf(bars15({ 0: 102, 1: 101, 2: 100.8, 4: 100.5, 5: 100.4, 15: 99.5, 16: 100, 17: 99.8, 96: 98, 97: 97 }), NOW)
    expect(read?.price).toBe(102)
    expect(read?.returns.m15).toBeCloseTo((102 / 101 - 1) * 100, 10)
    expect(read?.returns.h1).toBeCloseTo((102 / 100.5 - 1) * 100, 10)
    expect(read?.returns.h4).toBeCloseTo(2, 10)
    expect(read?.returns.h24).toBeCloseTo((102 / 98 - 1) * 100, 10)
    expect(returnsOf(bars15({}, 20), NOW)?.returns.h24).toBeNull()
    expect(returnsOf(bars15({}, 16), NOW)).toBeNull()
  })

  it("calls Bitcoin and ether by the benchmark's four-hour rule, the alts against Bitcoin, and how many rose", () => {
    const up = 100 * (1 + BTC_REGIME_PCT / 100) + 0.01
    const down = 100 * (1 - BTC_REGIME_PCT / 100) - 0.01
    const pairs = [
      researched('BTCUSDT', { change24hPct: 1 }),
      researched('ETHUSDT', { change24hPct: 0.5 }),
      researched('AUSDT', { change24hPct: 4 }),
      researched('BUSDT', { change24hPct: 3.5 }),
      researched('CUSDT', { change24hPct: -1 })
    ]
    const status = marketStatusOf({ btc15m: bars15({ 0: up }), eth15m: bars15({ 0: down }), pairs, nowSec: NOW })
    expect(status.btc?.regime).toBe('rising')
    // Up past the line over four hours and the day, the hour quiet: a bull market.
    expect(status.regime).toBe('bull')
    expect(status.eth?.regime).toBe('falling')
    // The others' median day (3.5) less Bitcoin's (1): 2.5 points, past the line.
    expect(status.altVsBtcPct).toBeCloseTo(2.5, 10)
    expect(status.alt).toBe('strong')
    expect(status.breadth).toBeCloseTo(4 / 5, 10)
    expect(marketStatusOf({ btc15m: bars15(), eth15m: bars15(), pairs: pairs.map((pair) => ({ ...pair, change24hPct: pair.symbol === 'BTCUSDT' ? 3 : 0.5 })), nowSec: NOW }).alt).toBe('weak')
    expect(marketStatusOf({ btc15m: bars15(), eth15m: bars15(), pairs: [], nowSec: NOW })).toMatchObject({ btc: { regime: 'flat' }, alt: null, breadth: null })
  })

  it('is at risk by the lines it is drawn at, and says why', () => {
    const calm = [researched('BTCUSDT', { change24hPct: 0.5 }), researched('AUSDT', { change24hPct: 1 })]
    expect(marketStatusOf({ btc15m: bars15(), eth15m: bars15(), pairs: calm, nowSec: NOW })).toMatchObject({ risk: 'normal', riskReasons: [] })
    // Bitcoin down 3.5% in the hour: a panic.
    const falling = marketStatusOf({ btc15m: bars15({ 0: 96.5 }), eth15m: bars15(), pairs: calm, nowSec: NOW })
    expect(falling.risk).toBe('panic')
    expect(falling.riskReasons[0]).toBe('Bitcoin fell 3.50% in the last hour')
    // Up 2% in the hour: elevated, not a panic.
    const rising = marketStatusOf({ btc15m: bars15({ 0: 100 + RISK_LINES.elevatedH1Pct + 0.5 }), eth15m: bars15(), pairs: calm, nowSec: NOW })
    expect(rising.risk).toBe('elevated')
    // Down 9% over the day, the hour quiet: a panic.
    expect(marketStatusOf({ btc15m: bars15({ 0: 91, 1: 91, 4: 91, 16: 91 }), eth15m: bars15(), pairs: calm, nowSec: NOW }).risk).toBe('panic')
    // One pair in ten rose: elevated.
    const narrow = [researched('BTCUSDT'), ...Array.from({ length: 9 }, (_, k) => researched(`P${k}USDT`, { change24hPct: k === 0 ? 1 : -1 }))]
    const thin = marketStatusOf({ btc15m: bars15(), eth15m: bars15(), pairs: narrow, nowSec: NOW })
    expect(thin.risk).toBe('elevated')
    expect(thin.riskReasons).toEqual(['only 10% of the pairs rose over the day'])
  })

  it('names the regime from Bitcoin alone, by the first of six rules that applies', () => {
    const at = (h1: number, h4: number, h24: number | null): string | null => marketRegimeOf({ h1, h4, h24 })
    expect(marketRegimeOf(null)).toBeNull()
    // PANIC at the panic lines, before anything else.
    expect(at(RISK_LINES.panicH1Pct, -5, -1)).toBe('panic')
    expect(at(0, 0, RISK_LINES.panicH24Pct)).toBe('panic')
    expect(at(-2.99, 0, -7.99)).toBe('high-vol')
    // HIGH-VOL at the elevated hour, either way, before a direction.
    expect(at(RISK_LINES.elevatedH1Pct, 3, 5)).toBe('high-vol')
    expect(at(-RISK_LINES.elevatedH1Pct, -3, -5)).toBe('high-vol')
    expect(at(1.49, 3, 5)).toBe('bull')
    // RECOVERY: rising over four hours after a day down past the elevated line.
    expect(at(0.5, BTC_REGIME_PCT, -RISK_LINES.elevatedH24Pct)).toBe('recovery')
    expect(at(0.5, BTC_REGIME_PCT, -3.99)).toBe('sideways')
    // BULL and BEAR when the four hours and the day agree, or the day is not known.
    expect(at(0, BTC_REGIME_PCT, 0)).toBe('bull')
    expect(at(0, BTC_REGIME_PCT, null)).toBe('bull')
    expect(at(0, -BTC_REGIME_PCT, 0)).toBe('bear')
    expect(at(0, -BTC_REGIME_PCT, null)).toBe('bear')
    expect(at(0, -BTC_REGIME_PCT, 0.01)).toBe('sideways')
    // SIDEWAYS: flat over four hours, whatever the day did.
    expect(at(0, 0.99, 6)).toBe('sideways')
    expect(at(0, -0.99, -6)).toBe('sideways')
    expect(describeMarketRegime('high-vol')).toEqual({ word: 'HIGH-VOL', tone: 'gold' })
    expect(describeMarketRegime('recovery')).toEqual({ word: 'RECOVERY', tone: 'up' })
  })

  it('reads the day from the ticker where the bars do not reach it, as the risk state does', () => {
    // Twenty bars: four hours of them, no day. Bitcoin's ticker says it fell 9% over the day.
    const short = bars15({}, 20)
    const status = marketStatusOf({ btc15m: short, eth15m: short, pairs: [researched('BTCUSDT', { change24hPct: -9 })], nowSec: NOW })
    expect(status.btc?.returns.h24).toBeNull()
    expect(status.regime).toBe('panic')
    expect(marketStatusOf({ btc15m: bars15({}, 10), eth15m: short, pairs: [], nowSec: NOW }).regime).toBeNull()
  })

  it('says itself in five words', () => {
    const status = marketStatusOf({ btc15m: bars15({ 0: 96.5 }), eth15m: bars15(), pairs: [researched('BTCUSDT', { change24hPct: -2 }), researched('AUSDT', { change24hPct: -1 })], nowSec: NOW })
    const chips = describeMarketStatus(status)
    expect(chips.map((chip) => `${chip.label} ${chip.value}`)).toEqual(['REGIME PANIC', 'BTC FALLING', 'ETH FLAT', 'ALT IN LINE', 'RISK PANIC'])
    expect(chips[0]).toMatchObject({ tone: 'down', detail: 'Bitcoin -3.50% in the last hour, -3.50% over the day: past the panic lines (-3% in an hour, -8% in a day).' })
    expect(chips[4]).toMatchObject({ tone: 'down', detail: 'Bitcoin fell 3.50% in the last hour; only 0% of the pairs rose over the day.' })
    expect(chips[1].detail).toBe('-3.50% over four hours, -3.50% over the day.')
    // Unread, it says so.
    expect(describeMarketStatus({ ...status, btc: null, regime: null })[0]).toMatchObject({ value: '—', detail: 'Bitcoin could not be read.', tone: 'muted' })
  })
})

describe('the steps shown while it reads', () => {
  it('start waiting, and change one at a time', () => {
    const empty = emptyResearchState()
    expect(empty.steps.map((step) => [step.id, step.status])).toEqual([
      ['universe', 'waiting'],
      ['movers', 'waiting'],
      ['market', 'waiting'],
      ['trending', 'waiting']
    ])
    const next = withStep(empty, 'movers', 'failed', 'timeout')
    expect(next.steps[1]).toMatchObject({ status: 'failed', detail: 'timeout' })
    expect(empty.steps[1].status).toBe('waiting')
  })
})
