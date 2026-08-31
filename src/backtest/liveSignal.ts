import type { Candle } from '../../shared/ipc'
import {
  REGIME_VOTE,
  inferBarSeconds,
  regimeAgreement
} from './strategies/trendRegimeEnsemble'
import { CHANNEL_BAND, channelPositionSeries } from './strategies/shortTermChannel'

// What a strategy is looking at RIGHT NOW, and how far it is from acting.
//
// A backtest answers "what would this have done". It cannot answer the question someone watching a
// live market actually has, which is "is anything about to happen". Those are different questions:
// a strategy that is flat has been flat for weeks and will report exactly the same thing tomorrow,
// whether the market is one bar from a signal or nowhere near one.
//
// EVERY NUMBER HERE IS READ FROM THE STRATEGY, NEVER RESTATED. The readings come from the same
// exported regimeAgreement() and channelPositionSeries() the engine's own signals are built from,
// and the thresholds from REGIME_VOTE and CHANNEL_BAND rather than from a "0.95" typed in beside a
// copy of the rule. A readout that hardcodes a threshold is a second implementation of the rule,
// free to drift silently the moment the strategy changes -- which is the exact failure the
// strategies already export regimeAgreement() to prevent.
//
// THE GATED STRATEGY IS WHY THIS IS NOT A SINGLE NUMBER. Short-Term Channel + Trend Regime needs
// the channel AND the regime to open, but its exits pass through UNGATED from the channel alone --
// a deliberate choice, because an exit blocked by a falling regime is blocked exactly when it is
// needed. So a reading has to say separately whether it gates entries and whether it gates exits,
// or a panel showing "regime 2 of 4" beside a long position would imply an exit that the rule will
// never produce.

export interface SignalReading {
  /** Stable key, for React lists and tests. */
  id: string
  label: string
  /** Current value on the same 0..1 scale as its thresholds. NaN while still warming up. */
  value: number
  enterAt: number
  exitAt: number
  /** The value rendered the way the rule expresses it: "3 of 4" reads better than "0.75". */
  display: string
  /** How to render the two thresholds in the same units as `display`. */
  describe: (v: number) => string
  lookbackDays: readonly number[]
  /** True when this reading can block an entry. */
  gatesEntry: boolean
  /** True when this reading can force an exit. False for the regime half of the gated strategy. */
  gatesExit: boolean
  /** One line on what the reading means, shown under the gauge. */
  note: string
}

const votes = (v: number): string => (Number.isFinite(v) ? `${Math.round(v * 4)} of 4` : '—')
const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '—')

function regimeReading(candles: Candle[], gatesExit: boolean): SignalReading | null {
  const barSeconds = inferBarSeconds(candles)
  if (barSeconds <= 0) return null
  const series = regimeAgreement(candles, barSeconds)
  const value = series.length ? series[series.length - 1] : NaN
  return {
    id: 'regime',
    label: 'Trend agreement',
    value,
    enterAt: REGIME_VOTE.enterAt,
    exitAt: REGIME_VOTE.exitAt,
    display: votes(value),
    describe: votes,
    lookbackDays: REGIME_VOTE.lookbackDays,
    gatesEntry: true,
    gatesExit,
    note: `How many of the ${REGIME_VOTE.lookbackDays.join('/')}-day averages price is above.`
  }
}

function channelReading(candles: Candle[]): SignalReading | null {
  const series = channelPositionSeries(candles)
  const value = series.length ? series[series.length - 1] : NaN
  return {
    id: 'channel',
    label: 'Channel position',
    value,
    enterAt: CHANNEL_BAND.enterAt,
    exitAt: CHANNEL_BAND.exitAt,
    display: pct(value),
    describe: pct,
    lookbackDays: CHANNEL_BAND.lookbackDays,
    gatesEntry: true,
    gatesExit: true,
    note: `Where price sits inside its ${CHANNEL_BAND.lookbackDays.join('/')}-day ranges, averaged. 100% is at the highs.`
  }
}

/** Every reading that governs `strategyId`, in the order a reader should scan them.
 *
 * Returns [] for strategies that publish no reading rather than inventing one. The three shipped
 * trend strategies are the ones this exists for; EMA/RSI/Bollinger would each need their own
 * exported internals, and a made-up proxy for them would be worse than showing nothing. */
export function readLiveSignals(candles: Candle[], strategyId: string): SignalReading[] {
  if (candles.length === 0) return []
  const out: SignalReading[] = []
  if (strategyId === 'trend-regime-ensemble') {
    const r = regimeReading(candles, true)
    if (r) out.push(r)
  }
  if (strategyId === 'short-term-channel' || strategyId === 'short-term-channel-regime') {
    const c = channelReading(candles)
    if (c) out.push(c)
  }
  if (strategyId === 'short-term-channel-regime') {
    // gatesExit: false -- the gate suppresses entries only. See the header.
    const r = regimeReading(candles, false)
    if (r) out.push(r)
  }
  return out
}

export interface NextAction {
  /** What the strategy is waiting for. */
  kind: 'entry' | 'exit' | 'unknown'
  /** Plain sentence for the panel. */
  summary: string
  /** The readings that are currently holding the action back, if any. */
  blocking: SignalReading[]
}

/** What has to change for the strategy to do something, given where it stands now.
 *
 * Deliberately phrased as a condition rather than a prediction. "Needs 4 of 4, has 3" is a fact
 * about the rule; "likely to enter soon" would be a forecast this app has no basis for. */
export function describeNextAction(readings: SignalReading[], inPosition: boolean): NextAction {
  const relevant = readings.filter((r) => (inPosition ? r.gatesExit : r.gatesEntry))
  if (relevant.length === 0 || relevant.some((r) => !Number.isFinite(r.value))) {
    return {
      kind: 'unknown',
      summary: inPosition
        ? 'Holding. This strategy publishes no live reading, so the exit cannot be previewed here.'
        : 'Flat. This strategy publishes no live reading, so the entry cannot be previewed here.',
      blocking: []
    }
  }

  if (inPosition) {
    // Any exit-gating reading falling to its exit level closes the position.
    const nearest = [...relevant].sort((a, b) => a.value - a.exitAt - (b.value - b.exitAt))[0]
    return {
      kind: 'exit',
      summary: `Holding. Exits when ${nearest.label.toLowerCase()} falls to ${nearest.describe(nearest.exitAt)} or below — it is ${nearest.display} now.`,
      blocking: []
    }
  }

  const short = relevant.filter((r) => r.value < r.enterAt)
  if (short.length === 0) {
    return {
      kind: 'entry',
      summary: 'Every entry condition is met on the latest candle. The engine opens on a candle close, so a position should appear on the next poll.',
      blocking: []
    }
  }
  const parts = short.map((r) => `${r.label.toLowerCase()} ${r.display} (needs ${r.describe(r.enterAt)})`)
  return {
    kind: 'entry',
    summary: `Flat. Waiting on ${parts.join(' and ')}.`,
    blocking: short
  }
}
