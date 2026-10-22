import { describe, expect, it } from 'vitest'
import { UNIVERSE_LINES, forecastUniverseOf, scannerMovers } from '../shared/forecast/universe'
import type { ScannerPair } from '../shared/marketScanner'

// THE PAIRS THE FORECAST READS (shared/forecast/universe.ts; V7.2-R Stage 4): Bitcoin and ether, the research's pairs in
// their order, then the scanner's movers over the liquidity floor, each once, at most UNIVERSE_LINES.maxPairs.

const pair = (symbol: string, band: ScannerPair['band'], score: number, quoteVolume24h: number | null, quoteAsset = 'USDT'): Pick<ScannerPair, 'symbol' | 'quoteAsset' | 'band' | 'score' | 'quoteVolume24h'> => ({ symbol, quoteAsset, band, score, quoteVolume24h })

describe("the scanner's movers", () => {
  it('are its pairs at candidate or urgent, trading over the floor, in USDT, strongest first', () => {
    const pairs = [
      pair('AAAUSDT', 'urgent', 70, 50_000_000),
      pair('BBBUSDT', 'candidate', 90, 30_000_000),
      pair('CCCUSDT', 'watch', 99, 90_000_000),
      pair('DDDUSDT', 'urgent', 80, 5_000_000),
      pair('EEEUSDT', 'candidate', 60, null),
      pair('FFFBTC', 'urgent', 95, 80_000_000, 'BTC')
    ]
    expect(scannerMovers(pairs)).toEqual(['BBBUSDT', 'AAAUSDT'])
    expect(UNIVERSE_LINES.moverMinQuoteVolume).toBe(20_000_000)
    expect(scannerMovers([pair('GGGUSDT', 'urgent', 50, 20_000_000)])).toEqual(['GGGUSDT'])
  })
})

describe('the universe', () => {
  it('reads the pairs always read, the research in its order, then the movers, each once, at most sixty', () => {
    expect(forecastUniverseOf(['BTCUSDT', 'ETHUSDT'], ['SOLUSDT', 'BTCUSDT', 'XRPUSDT'], ['PEPEUSDT', 'SOLUSDT'])).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'PEPEUSDT'])
    const research = Array.from({ length: 58 }, (_, k) => `R${k}USDT`)
    const universe = forecastUniverseOf(['BTCUSDT', 'ETHUSDT'], research, ['M1USDT', 'M2USDT'])
    expect(UNIVERSE_LINES.maxPairs).toBe(60)
    expect(universe).toHaveLength(60)
    // The research's pairs come before a mover.
    expect(universe.includes('M1USDT')).toBe(false)
    expect(forecastUniverseOf(['BTCUSDT', 'ETHUSDT'], research.slice(0, 57), ['M1USDT', 'M2USDT']).at(-1)).toBe('M1USDT')
  })
})
