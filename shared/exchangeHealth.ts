import { ENGLISH, type I18n } from './i18n/translate'
import { LIVE_GAP_SECONDS } from './liveMarket'

// EXCHANGE HEALTH, AND WHEN LIVE ENTRIES PAUSE (the V4 document, §12 and §92-93).
//
// The main process measures Binance's data host once a minute -- how long a request takes, how far
// the machine's clock is from Binance's -- and keeps the live-price socket's state and the key's
// last test beside it (electron/services/exchangeHealthService.ts). This module is the rule that
// reads those figures: when they say the exchange cannot be trusted for a NEW real order, live
// entries are paused, and the bar says so.
//
// AN EXIT IS NEVER PAUSED BY THIS. A position already open is protected by its watcher, and a
// closing order goes through the gate for closing (canCloseLivePosition), which reads none of
// this: stale data is no reason to leave a real position unprotected. What is refused is opening
// another.
//
// The lines are deliberate, and each is pinned by a test:
// - the stream has delivered nothing for a minute (a gap, shared/liveMarket.ts) AND REST has failed
//   three reads running: no price can be had at all;
// - the clock is more than five seconds off Binance's: a signed request would be refused anyway
//   (Binance's -1021), and a fill time would be wrong;
// - REST has taken over five seconds three reads running: an order's own round trip would be
//   as slow, and its price as old;
// - the key's last test failed: the order would be refused with a worse message.

export const HEALTH_LINES = {
  /** Seconds without a frame from the stream before its data counts as stale: the gap line. */
  staleDataSeconds: LIVE_GAP_SECONDS,
  /** REST reads failed in a row before the data host counts as failing. */
  restFailuresToPause: 3,
  /** The clock's difference from Binance's, in milliseconds, past which it is off. */
  clockSkewMs: 5000,
  /** A REST read longer than this is slow. */
  slowReadMs: 5000,
  /** Slow reads in a row before the data host counts as slow. */
  slowReadsToPause: 3
} as const

export interface HealthState {
  /** When the figures below were last measured, in seconds; null before the first measurement. */
  measuredAt: number | null
  /** The data host measured, by name. */
  host: string | null
  /** The last REST round trip, in milliseconds; null when the last read failed or none was made. */
  restLatencyMs: number | null
  /** REST reads failed in a row. */
  restFailures: number
  /** Slow REST reads in a row. */
  slowReads: number
  /** Binance's clock less this machine's, in milliseconds; null until measured. */
  clockSkewMs: number | null
  /** The live-price socket, as it stands now. */
  streamOpen: boolean
  /** Seconds since the stream's last frame; null before its first. */
  dataAgeS: number | null
  /** The Binance key's last test: true, false, or null with no key stored. */
  keyOk: boolean | null
}

export interface HealthVerdict {
  degraded: boolean
  /** Why, each in words; empty when not degraded. */
  reasons: string[]
}

export function emptyHealthState(): HealthState {
  return { measuredAt: null, host: null, restLatencyMs: null, restFailures: 0, slowReads: 0, clockSkewMs: null, streamOpen: false, dataAgeS: null, keyOk: null }
}

const seconds = (value: number, i18n: I18n = ENGLISH): string =>
  i18n.language === 'en' ? `${Number(value.toFixed(1))} s` : i18n.t('{seconds} s', { seconds: i18n.num(Number(value.toFixed(1)), 0, 1) })

/** The rule: what, if anything, makes the exchange one not to open a real position on now. Its reasons
 * in English, as the gate gives them, unless handed a language (V6 Stage 14). */
export function healthVerdict(state: HealthState, i18n: I18n = ENGLISH): HealthVerdict {
  const { t } = i18n
  const reasons: string[] = []
  const noStream = !state.streamOpen || state.dataAgeS === null || state.dataAgeS >= HEALTH_LINES.staleDataSeconds
  if (noStream && state.restFailures >= HEALTH_LINES.restFailuresToPause) {
    reasons.push(
      state.dataAgeS === null
        ? t('no market data: the stream has delivered nothing and REST has failed {count} reads running', { count: state.restFailures })
        : t('market data stale {age} and REST has failed {count} reads running', { age: seconds(state.dataAgeS, i18n), count: state.restFailures })
    )
  }
  if (state.clockSkewMs !== null && Math.abs(state.clockSkewMs) > HEALTH_LINES.clockSkewMs) {
    const skew = seconds(Math.abs(state.clockSkewMs) / 1000, i18n)
    reasons.push(state.clockSkewMs > 0 ? t("the clock is {skew} behind Binance's", { skew }) : t("the clock is {skew} ahead of Binance's", { skew }))
  }
  if (state.slowReads >= HEALTH_LINES.slowReadsToPause) {
    reasons.push(t('REST has taken over {limit} {count} reads running', { limit: seconds(HEALTH_LINES.slowReadMs / 1000, i18n), count: state.slowReads }))
  }
  if (state.keyOk === false) reasons.push(t("the Binance key's last test failed"))
  return { degraded: reasons.length > 0, reasons }
}

/** The sentence the bar and the gate give: what is paused, and why. */
export function describePause(verdict: HealthVerdict, { t }: I18n = ENGLISH): string | null {
  return verdict.degraded ? t('Live trading is paused: {reasons}. Exits are not paused by this.', { reasons: verdict.reasons.join(t('; ')) }) : null
}

/** The figures in a few words each, for the card. */
export function describeHealth(state: HealthState): { latency: string; clock: string; stream: string; key: string } {
  return {
    latency:
      state.restLatencyMs === null
        ? state.restFailures > 0
          ? `the last ${state.restFailures === 1 ? 'read' : `${state.restFailures} reads`} failed`
          : 'not measured yet'
        : `${Math.round(state.restLatencyMs)} ms${state.slowReads > 0 ? ` (${state.slowReads} slow in a row)` : ''}`,
    clock: state.clockSkewMs === null ? 'not measured yet' : `${state.clockSkewMs >= 0 ? '+' : '-'}${Math.round(Math.abs(state.clockSkewMs))} ms against Binance's`,
    stream: !state.streamOpen ? 'closed' : state.dataAgeS === null ? 'open, no frame yet' : `open, last frame ${seconds(state.dataAgeS)} ago`,
    key: state.keyOk === null ? 'no key stored' : state.keyOk ? 'last test passed' : 'last test failed'
  }
}
