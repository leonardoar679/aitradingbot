import type { Language } from './languages'

// NUMBERS, PRICES AND TIMES IN A LANGUAGE (the V6 document, §86 and §89; V6 Stage 14). Each language's own
// decimal separator, grouping, currency placing and date order, by Intl, but always in Latin digits
// ("+2.4%" stays numerically clear in every language: Arabic's and Hindi's own digits are not used), and
// at the precision a price needs: two decimals from a cent up, about four significant digits below one,
// eight for a figure in BTC or ETH. A number is a value given to the formatter, never translated text.

/** The locale tag Intl formats a language's numbers and dates by: the language, in Latin digits. */
export function numberLocale(language: Language): string {
  return `${language}-u-nu-latn`
}

const numberFormats = new Map<string, Intl.NumberFormat>()
const dateFormats = new Map<string, Intl.DateTimeFormat>()

function numberFormat(language: Language, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${language}|${JSON.stringify(options)}`
  let format = numberFormats.get(key)
  if (format === undefined) {
    format = new Intl.NumberFormat(numberLocale(language), options)
    numberFormats.set(key, format)
  }
  return format
}

function dateFormat(language: Language, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${language}|${JSON.stringify(options)}`
  let format = dateFormats.get(key)
  if (format === undefined) {
    format = new Intl.DateTimeFormat(numberLocale(language), options)
    dateFormats.set(key, format)
  }
  return format
}

// KRW and JPY are not traded in fractions; a figure in BTC or ETH is often a small fraction of one.
const ZERO_DECIMAL_ASSETS = new Set(['KRW', 'JPY'])
const HIGH_PRECISION_ASSETS = new Set(['BTC', 'ETH'])
const DOLLAR_ASSETS = new Set(['USD', 'USDT', 'USDC', 'BUSD'])

/** The decimals a figure in an asset is shown at. Below a cent, enough for about four significant
 * digits: at a flat two every sub-cent price reads "$0.00". */
export function assetDecimals(asset: string, value?: number): number {
  const code = asset.toUpperCase()
  if (ZERO_DECIMAL_ASSETS.has(code)) return 0
  if (HIGH_PRECISION_ASSETS.has(code)) return 8
  if (value !== undefined && value !== 0 && Number.isFinite(value) && Math.abs(value) < 0.01) {
    const leadingZeros = Math.floor(-Math.log10(Math.abs(value)))
    return Math.min(8, leadingZeros + 4)
  }
  return 2
}

/** A number with grouping, at between `min` and `max` decimals. */
export function formatNumber(language: Language, value: number, min = 0, max = 2): string {
  if (!Number.isFinite(value)) return '—'
  return numberFormat(language, { minimumFractionDigits: min, maximumFractionDigits: Math.max(min, max) }).format(value)
}

/** A number with its sign always shown, but none on zero: "+1.25", "-0.40", "0.00". */
export function formatSigned(language: Language, value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—'
  return numberFormat(language, { minimumFractionDigits: digits, maximumFractionDigits: digits, signDisplay: 'exceptZero' }).format(value)
}

/** A percentage given in percent (2.4 for 2.4%), signed unless asked not to be: "+2.4%", "2,4%". At
 * `digits` decimals, or between `minDigits` and `digits`. */
export function formatPercent(language: Language, percent: number, digits = 1, signed = true, minDigits = digits): string {
  if (!Number.isFinite(percent)) return '—'
  return numberFormat(language, { style: 'percent', minimumFractionDigits: Math.min(minDigits, digits), maximumFractionDigits: digits, signDisplay: signed ? 'exceptZero' : 'auto' }).format(percent / 100)
}

/** A figure in an asset at its precision: dollar-family assets as dollars where the language puts its
 * dollar sign, KRW and JPY in their own currency, anything else as the number and the asset's code. */
export function formatMoney(language: Language, value: number, asset: string, decimals = assetDecimals(asset, value), minDecimals = decimals): string {
  if (!Number.isFinite(value)) return '—'
  const code = asset.toUpperCase()
  const digits = { minimumFractionDigits: Math.min(minDecimals, decimals), maximumFractionDigits: decimals }
  if (DOLLAR_ASSETS.has(code)) return numberFormat(language, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', ...digits }).format(value)
  if (ZERO_DECIMAL_ASSETS.has(code)) return numberFormat(language, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol', ...digits }).format(value)
  return `${numberFormat(language, digits).format(value)} ${code}`
}

/** The same with its sign always shown, but none on zero: "+$1.20", "-$0.40". */
export function formatSignedMoney(language: Language, value: number, asset: string, decimals = assetDecimals(asset, value)): string {
  if (!Number.isFinite(value)) return '—'
  const code = asset.toUpperCase()
  const digits = { minimumFractionDigits: decimals, maximumFractionDigits: decimals, signDisplay: 'exceptZero' as const }
  if (DOLLAR_ASSETS.has(code)) return numberFormat(language, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', ...digits }).format(value)
  if (ZERO_DECIMAL_ASSETS.has(code)) return numberFormat(language, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol', ...digits }).format(value)
  return `${numberFormat(language, digits).format(value)} ${code}`
}

/** A price in dollars at six significant figures, as the forecast writes its levels: "$182.4". */
export function formatDollars(language: Language, value: number): string {
  if (!Number.isFinite(value)) return '—'
  return numberFormat(language, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', maximumSignificantDigits: 6 }).format(value)
}

/** A time of the computer's day, hours and minutes. */
export function formatTime(language: Language, ms: number): string {
  return dateFormat(language, { hour: '2-digit', minute: '2-digit' }).format(ms)
}

/** A day of the computer's calendar. Thai's is the Buddhist era, as Thai dates are written. */
export function formatDate(language: Language, ms: number): string {
  return dateFormat(language, { dateStyle: 'medium' }).format(ms)
}

/** A day and a time, short. */
export function formatDateTime(language: Language, ms: number): string {
  return dateFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
}

/** A time in UTC, hours and minutes, for the records' clock. */
export function formatUtcTime(language: Language, ms: number): string {
  return dateFormat(language, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hourCycle: 'h23' }).format(ms)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A day of the UTC calendar, short: "5 Oct" in English, as the records write it; the language's own
 * order and names elsewhere. */
export function formatUtcDay(language: Language, ms: number): string {
  if (language === 'en') {
    const date = new Date(ms)
    return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`
  }
  return dateFormat(language, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(ms)
}

/** Items joined as the language joins a list: "a, b and c". */
export function formatList(language: Language, items: readonly string[]): string {
  return new Intl.ListFormat(numberLocale(language), { type: 'conjunction' }).format(items)
}
