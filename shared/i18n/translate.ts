import { DEFAULT_LANGUAGE, LANGUAGE_INFO, type Language } from './languages'
import { CATALOGS, type Entry, type PluralForms } from './catalogs'
import { formatDate, formatDateTime, formatDollars, formatList, formatMoney, formatNumber, formatPercent, formatSigned, formatSignedMoney, formatTime, formatUtcDay, formatUtcTime } from './format'

// TRANSLATION (the V6 document, §82-89; V6 Stage 14, 13 October 2026).
//
// A KEY IS ITS ENGLISH TEXT, with each value a {name} in braces: "Stop at {price}", with the price. The
// English is in the code where it is used; each language's catalog (shared/i18n/locales/<code>.json)
// maps it to that language's text. A text that reads two ways in English carries its sense after "@@"
// ('Open@@a position'), which English does not show. A count is a {count}: where its words change with
// it, the catalog gives the forms by Intl's plural rules -- English's one and other in en.json, which
// holds nothing else, Arabic's six, Chinese's one.
//
// A VALUE IS NEVER TRANSLATED TEXT (§89): a price, a percentage or a time is formatted by the language's
// own rules (./format.ts) and put in its place. In Arabic each value is isolated (U+2068 ... U+2069), so a
// "+2.4%" or a "SOL/USDT" inside right-to-left words is read as written.
//
// A KEY A CATALOG LACKS reads in English, and is noted (missedKeys): the tests hold every catalog to
// every key, so a translated page never falls back to English unexpectedly (§111).
//
// WHERE ONE IS CHOSEN: a function that words something takes an I18n, English by default, so a sentence
// built for a model's prompt, a record or an English page stays English, and only a translated page, or a
// notice built in the person's language, passes theirs.

export type Params = Readonly<Record<string, string | number>>

/** Marks a text as a key, to be translated where it is shown: a table's labels, held as English. */
export function msg<T extends string>(key: T): T {
  return key
}

/** What English shows of a key: the text before its sense. */
export function englishOf(key: string): string {
  const at = key.indexOf('@@')
  return at < 0 ? key : key.slice(0, at)
}

const misses = new Map<Language, Set<string>>()

/** The keys a language's catalog was asked for and lacked, since the last clearing. */
export function missedKeys(language: Language): string[] {
  return [...(misses.get(language) ?? [])].sort()
}

export function clearMissedKeys(): void {
  misses.clear()
}

const pluralRules = new Map<Language, Intl.PluralRules>()

function pluralOf(language: Language, forms: PluralForms, count: number): string {
  let rules = pluralRules.get(language)
  if (rules === undefined) {
    rules = new Intl.PluralRules(language)
    pluralRules.set(language, rules)
  }
  return forms[rules.select(count)] ?? forms.other
}

const FSI = '⁨'
const PDI = '⁩'

function interpolate(language: Language, text: string, params: Params | undefined): string {
  if (params === undefined) return text
  const isolate = LANGUAGE_INFO[language].dir === 'rtl'
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    if (value === undefined) return whole
    const shown = typeof value === 'number' ? formatNumber(language, value, 0, 2) : value
    return isolate ? `${FSI}${shown}${PDI}` : shown
  })
}

/** A key in a language: its catalog's text, else English's, with its values put in. */
export function translate(language: Language, key: string, params?: Params): string {
  const own: Entry | undefined = language === DEFAULT_LANGUAGE ? undefined : CATALOGS[language][key]
  if (own === undefined && language !== DEFAULT_LANGUAGE) {
    let set = misses.get(language)
    if (set === undefined) {
      set = new Set()
      misses.set(language, set)
    }
    set.add(key)
  }
  const speaking = own === undefined ? DEFAULT_LANGUAGE : language
  const entry: Entry = own ?? CATALOGS.en[key] ?? englishOf(key)
  const count = typeof params?.count === 'number' ? params.count : 0
  const text = typeof entry === 'string' ? entry : pluralOf(speaking, entry, count)
  return interpolate(language, text, params)
}

/** Everything a translated text needs: its words, and its numbers and times in the language's form. */
export interface I18n {
  language: Language
  dir: 'ltr' | 'rtl'
  t: (key: string, params?: Params) => string
  /** A number with grouping, at between `min` and `max` decimals. */
  num: (value: number, min?: number, max?: number) => string
  /** A number with its sign. */
  signed: (value: number, digits?: number) => string
  /** A percentage given in percent, signed: pct(2.4) is "+2.4%". */
  pct: (percent: number, digits?: number) => string
  /** The same unsigned: "2.4%". */
  pctPlain: (percent: number, digits?: number) => string
  /** A setting's percentage, unsigned, with only the decimals it has, up to `digits`: "0.25%", "1%". */
  share: (percent: number, digits?: number) => string
  /** A figure in an asset at its precision: money(182.4, 'USDT') is "$182.40". At `decimals`, or
   * between `minDecimals` and `decimals`. */
  money: (value: number, asset: string, decimals?: number, minDecimals?: number) => string
  signedMoney: (value: number, asset: string, decimals?: number) => string
  /** A price in dollars at six significant figures: dollars(182.4) is "$182.4". */
  dollars: (value: number) => string
  time: (ms: number) => string
  utcTime: (ms: number) => string
  /** A day of the UTC calendar, short: "5 Oct". */
  utcDay: (ms: number) => string
  date: (ms: number) => string
  dateTime: (ms: number) => string
  list: (items: readonly string[]) => string
}

const made = new Map<Language, I18n>()

/** A language's I18n, made once. */
export function i18nFor(language: Language): I18n {
  const known = made.get(language)
  if (known !== undefined) return known
  const i18n: I18n = {
    language,
    dir: LANGUAGE_INFO[language].dir,
    t: (key, params) => translate(language, key, params),
    num: (value, min, max) => formatNumber(language, value, min, max),
    signed: (value, digits) => formatSigned(language, value, digits),
    pct: (percent, digits) => formatPercent(language, percent, digits, true),
    pctPlain: (percent, digits) => formatPercent(language, percent, digits, false),
    share: (percent, digits = 2) => formatPercent(language, percent, digits, false, 0),
    money: (value, asset, decimals, minDecimals) => formatMoney(language, value, asset, decimals, minDecimals),
    signedMoney: (value, asset, decimals) => formatSignedMoney(language, value, asset, decimals),
    dollars: (value) => formatDollars(language, value),
    time: (ms) => formatTime(language, ms),
    utcTime: (ms) => formatUtcTime(language, ms),
    utcDay: (ms) => formatUtcDay(language, ms),
    date: (ms) => formatDate(language, ms),
    dateTime: (ms) => formatDateTime(language, ms),
    list: (items) => formatList(language, items)
  }
  made.set(language, i18n)
  return i18n
}

/** English: what a function that words something speaks unless handed another language. */
export const ENGLISH: I18n = i18nFor(DEFAULT_LANGUAGE)
