import type { EventBand } from '../marketEvent'
import { RESEARCH_MIN_QUOTE_VOLUME } from '../marketResearch'
import type { ScannerPair } from '../marketScanner'

// THE PAIRS THE FORECAST READS (V7.2-R Stage 4, 22 October 2026). Bitcoin and ether always, then the research's pairs --
// the fifty most traded USDT pairs that trade at least the liquidity floor a day, most traded first -- and since this
// stage the scanner's movers beside them: a pair the scanner holds at candidate or urgent, over the same floor, not
// already in, strongest first. A coin moving hard is the one a trade worth its costs is most likely on, and the research
// leaves out a pair ranked past fiftieth by volume however it moves. At most FORECAST_MAX_PAIRS in all: each pair is
// ninety days of bars to keep and a row of every fit.

export const UNIVERSE_VERSION = 'universe-v2'

export const UNIVERSE_LINES = {
  maxPairs: 60,
  moverBands: ['candidate', 'urgent'] as readonly EventBand[],
  /** The day's quote volume a mover needs: the research's floor. */
  moverMinQuoteVolume: RESEARCH_MIN_QUOTE_VOLUME
} as const

/** The scanner's movers: its pairs at a mover's band, trading over the floor, in USDT, strongest first. */
export function scannerMovers(pairs: readonly Pick<ScannerPair, 'symbol' | 'quoteAsset' | 'band' | 'score' | 'quoteVolume24h'>[]): string[] {
  return pairs
    .filter((pair) => pair.quoteAsset === 'USDT' && UNIVERSE_LINES.moverBands.includes(pair.band) && typeof pair.quoteVolume24h === 'number' && pair.quoteVolume24h >= UNIVERSE_LINES.moverMinQuoteVolume)
    .sort((a, b) => b.score - a.score)
    .map((pair) => pair.symbol)
}

/** The universe: the pairs always read, the research's in its order, then the movers, each once, at most maxPairs. */
export function forecastUniverseOf(always: readonly string[], research: readonly string[], movers: readonly string[]): string[] {
  return [...new Set([...always, ...research, ...movers])].slice(0, UNIVERSE_LINES.maxPairs)
}
