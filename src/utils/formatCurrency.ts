import type { I18n } from '../../shared/i18n/translate'
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  USDT: '$',
  USDC: '$',
  BUSD: '$',
  KRW: '₩',
  EUR: '€',
  GBP: '£',
  JPY: '¥'
}

// KRW/JPY aren't traded in fractional units in practice; crypto-denominated figures (e.g. a
// price in BTC, or a coin's own trading volume) need far more precision since the values are
// often tiny fractions of one coin.
const ZERO_DECIMAL_ASSETS = new Set(['KRW', 'JPY'])
const HIGH_PRECISION_ASSETS = new Set(['BTC', 'ETH'])

function decimalsFor(asset: string, value?: number): number {
  const code = asset.toUpperCase()
  if (ZERO_DECIMAL_ASSETS.has(code)) return 0
  if (HIGH_PRECISION_ASSETS.has(code)) return 8
  // Plenty of coins trade below a cent. At a flat 2 decimals every one of them renders as
  // "$0.00" -- information-free, and identical for prices orders of magnitude apart, which makes
  // an entry price or a P&L figure meaningless on those pairs. Widen the precision just for
  // sub-cent values so roughly four significant digits survive; anything at or above a cent is
  // formatted exactly as before.
  if (value !== undefined && value !== 0 && Math.abs(value) < 0.01) {
    const leadingZeros = Math.floor(-Math.log10(Math.abs(value)))
    return Math.min(8, leadingZeros + 4)
  }
  return 2
}

/** Formats a plain number using the decimal precision appropriate for the given asset,
 * without any currency symbol — for figures like volume where a "$"/"₩" prefix doesn't apply. */
export function formatAssetNumber(value: number, asset: string): string {
  const decimals = decimalsFor(asset, value)
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })
}

/** Formats a price in its actual quote currency — "$64,010.10" for USD, "₩91,100,000" for
 * KRW, "0.03000000 BTC" for a crypto-quoted pair — instead of assuming everything is USD. Handed a
 * language (V6 Stage 14), in that language's own separators and currency placing, at the same
 * precision. */
export function formatQuotePrice(value: number, quoteAsset: string, i18n?: I18n): string {
  if (i18n !== undefined && i18n.language !== 'en') return i18n.money(value, quoteAsset)
  const quote = quoteAsset.toUpperCase()
  const symbol = CURRENCY_SYMBOLS[quote]
  const formatted = formatAssetNumber(value, quoteAsset)
  return symbol ? `${symbol}${formatted}` : `${formatted} ${quote}`
}

/** Whether a quote asset is one of the dollar-family currencies this app treats as directly
 * summable (USD/USDT/USDC/BUSD) — used to decide what can safely be folded into a single
 * dollar total without a real exchange rate (e.g. a KRW-quoted holding can't be). */
export function isUsdLikeQuote(quoteAsset: string): boolean {
  return CURRENCY_SYMBOLS[quoteAsset.toUpperCase()] === '$'
}
