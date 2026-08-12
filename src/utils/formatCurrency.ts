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

function decimalsFor(asset: string): number {
  const code = asset.toUpperCase()
  if (ZERO_DECIMAL_ASSETS.has(code)) return 0
  if (HIGH_PRECISION_ASSETS.has(code)) return 8
  return 2
}

/** Formats a plain number using the decimal precision appropriate for the given asset,
 * without any currency symbol — for figures like volume where a "$"/"₩" prefix doesn't apply. */
export function formatAssetNumber(value: number, asset: string): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimalsFor(asset),
    maximumFractionDigits: decimalsFor(asset)
  })
}

/** Formats a price in its actual quote currency — "$64,010.10" for USD, "₩91,100,000" for
 * KRW, "0.03000000 BTC" for a crypto-quoted pair — instead of assuming everything is USD. */
export function formatQuotePrice(value: number, quoteAsset: string): string {
  const quote = quoteAsset.toUpperCase()
  const symbol = CURRENCY_SYMBOLS[quote]
  const formatted = formatAssetNumber(value, quoteAsset)
  return symbol ? `${symbol}${formatted}` : `${formatted} ${quote}`
}
