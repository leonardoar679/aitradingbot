import { BTC_REGIME_PCT, btcRegimeOf } from '../../shared/aiEventMarket'
import type { ScannerPair } from '../../shared/marketScanner'

/** `+1.40%`, `-0.25%`. */
export function signedPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

/** What Bitcoin's last four hours say about the market, by the rule the event benchmark slices its
 * results by (shared/aiEventMarket.ts): rising or falling past BTC_REGIME_PCT either way, flat
 * inside it. */
export function describeBtcRegime(btc: Pick<ScannerPair, 'returnsPct'>): string {
  const regime = btcRegimeOf({ btc: { m15: btc.returnsPct.m15, h1: btc.returnsPct.h1, h4: btc.returnsPct.h4, h24: null } })
  if (regime === 'rising') return `Bitcoin is rising: ${signedPct(btc.returnsPct.h4)} over four hours.`
  if (regime === 'falling') return `Bitcoin is falling: ${signedPct(btc.returnsPct.h4)} over four hours.`
  return `Bitcoin is flat: ${signedPct(btc.returnsPct.h4)} over four hours, inside ${BTC_REGIME_PCT}% either way.`
}
