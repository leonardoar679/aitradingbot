import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CATALOGS, type Entry } from '../shared/i18n/catalogs'
import { assetDecimals, formatDate, formatDollars, formatList, formatMoney, formatNumber, formatPercent, formatSigned, formatUtcDay, formatUtcTime, numberLocale } from '../shared/i18n/format'
import { keysIn } from '../shared/i18n/keys'
import { LANGUAGES, LANGUAGE_INFO, healLanguage, languageForLocale, languageForLocales, type Language } from '../shared/i18n/languages'
import { TERMS, type TranslatedLanguage } from '../shared/i18n/terms'
import { ENGLISH, clearMissedKeys, englishOf, i18nFor, missedKeys, msg, translate, type I18n } from '../shared/i18n/translate'
import { budgetProblem } from '../shared/aiCost'
import { forecastProposal, describeAiProposal } from '../shared/aiProposal'
import { watchNotice } from '../shared/aiWatch'
import type { AiSignalDecision } from '../shared/aiSignal'
import { crashNotice } from '../shared/alerts'
import { describePause, emptyHealthState, healthVerdict } from '../shared/exchangeHealth'
import type { ForecastRange, PricePrediction } from '../shared/forecast/prediction'
import { predictionChangedNotice } from '../shared/forecast/predictionChange'
import type { RankedForecast } from '../shared/forecast/ranking'
import type { TradeDecision } from '../shared/forecast/tradeDecision'
import { describeUntrustedLossTally } from '../shared/liveLimits'
import { emptyLiveState } from '../shared/liveMarket'
import type { MarketEvent } from '../shared/marketEvent'
import { newsHolderNotice, newsShortNotice } from '../shared/newsActions'
import type { NewsItem } from '../shared/newsFeed'
import { breakerNotice, confirmNotice, disagreementNotice, liveExitNotice, marketEventNotice, nearStopNotice, paperCloseNotice, reconciliationNotice, systemFailureNotice, tradeBlockedNotice } from '../shared/notices'
import { paperDigestNotice, type PaperDigest } from '../shared/paperDigest'
import { paperPauseNotice } from '../shared/paperPause'
import { describeReconciliation, describeUnknownOrder } from '../shared/reconcileLive'
import { SIMULATED_EVENTS } from '../shared/sounds'
import { reviewNote, scopeNote } from '../src/i18n/languageNotes'
import { DELISTING_STUDY } from '../shared/delistingStudy'
import { PRIMARY_CALL_VERSION, delistingCardOf, type PrimaryCallState, type PrimaryCard } from '../shared/forecast/primaryCall'
import type { UrlRecord } from '../shared/newsUrl'
import type { ArticleReading as ArticleReadingAnswer } from '../shared/aiAdditions'

// TEN LANGUAGES ON THE NORMAL-USER PAGES (the V6 document, §81-89 and §111; V6 Stage 14, 13 October
// 2026). Every text the app translates is a key in the code (shared/i18n/keys.ts); these tests hold the
// nine catalogs to the code and to the dictionary (shared/i18n/terms.ts), say where English may stay,
// and render the translated pages and build the notices in every language to see none falls back.

const ROOT = join(__dirname, '..')
const TRANSLATED = LANGUAGES.filter((language): language is TranslatedLanguage => language !== 'en')

function sourcesUnder(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourcesUnder(path)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [path] : []
  })
}

const CODE_KEYS = [...new Set(['src', 'shared', 'electron'].flatMap(sourcesUnder).flatMap((file) => keysIn(readFileSync(join(ROOT, file), 'utf-8'))))]
const formsOf = (entry: Entry): string[] => (typeof entry === 'string' ? [entry] : Object.values(entry).filter((form): form is string => form !== undefined))
const holes = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

describe('the catalogs against the code', () => {
  it('reads the keys from the code: hundreds of them, each a t() or msg() with a literal', () => {
    expect(CODE_KEYS.length).toBeGreaterThan(1700)
    expect(keysIn(`t('Open@@a position') + msg("A \\"quoted\\" word") + t(\`Two\nlines\`) + it('no') + count(t)`)).toEqual(['Open@@a position', 'A "quoted" word', 'Two\nlines'])
  })

  // A walk over every source file: unhurried, as the whole suite runs beside it.
  it('sees every key: none hidden in a t() argument, none with values written outside t() and msg()', { timeout: 60_000 }, () => {
    const hidden: string[] = []
    const calleeName = (call: ts.CallExpression): string => (ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '')
    for (const file of ['src', 'shared', 'electron'].flatMap(sourcesUnder)) {
      const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf-8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      const at = (node: ts.Node): string => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
      const visit = (node: ts.Node): void => {
        // t(cond ? 'one' : 'other'): the reader sees only a literal that is the argument itself.
        if (ts.isCallExpression(node) && calleeName(node) === 't' && node.arguments.length > 0 && !ts.isStringLiteralLike(node.arguments[0])) {
          const inside = (child: ts.Node): void => {
            if (ts.isCallExpression(child) && ['t', 'msg'].includes(calleeName(child))) return
            if (ts.isElementAccessExpression(child)) return inside(child.expression)
            if (ts.isStringLiteralLike(child) && /[A-Za-z]/.test(child.text)) hidden.push(`${at(child)} ${child.text}`)
            ts.forEachChild(child, inside)
          }
          inside(node.arguments[0])
        }
        // A text with {values} is a key, and is written as one.
        if (ts.isStringLiteralLike(node) && /\{[a-zA-Z]\w*\}/.test(node.text) && /[A-Za-z]{2}/.test(node.text.replace(/\{\w+\}/g, ''))) {
          const parent = node.parent
          const key = ts.isCallExpression(parent) && parent.arguments[0] === node && ['t', 'msg', 'translate'].includes(calleeName(parent))
          const translated = ts.isCallExpression(parent) && parent.arguments[1] === node && calleeName(parent) === 'translate'
          const named = ts.isLiteralTypeNode(parent) || (ts.isPropertyAssignment(parent) && parent.name === node)
          if (!key && !translated && !named) hidden.push(`${at(node)} ${node.text}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(hidden).toEqual([])
  })

  it('has every key in every catalog', () => {
    for (const language of TRANSLATED) expect({ language, missing: CODE_KEYS.filter((key) => !(key in CATALOGS[language])) }).toEqual({ language, missing: [] })
  })

  it('holds no key the code no longer writes', () => {
    const written = new Set(CODE_KEYS)
    for (const language of LANGUAGES) expect({ language, unused: Object.keys(CATALOGS[language]).filter((key) => !written.has(key)) }).toEqual({ language, unused: [] })
  })

  it("keeps in English's catalog only the forms a count needs, the other being the key's own text", () => {
    for (const [key, entry] of Object.entries(CATALOGS.en)) {
      expect(englishOf(key)).toContain('{count}')
      expect(typeof entry).toBe('object')
      if (typeof entry === 'string') continue
      expect(Object.keys(entry).sort()).toEqual(['one', 'other'])
      expect(entry.other).toBe(englishOf(key))
    }
  })

  it("keeps every value the English has, and no sense marker; a count's form may leave the count unsaid", () => {
    for (const language of TRANSLATED) {
      for (const [key, entry] of Object.entries(CATALOGS[language])) {
        const want = holes(englishOf(key))
        for (const form of formsOf(entry)) {
          const got = holes(form)
          const need = typeof entry === 'string' ? want : want.filter((name) => name !== 'count')
          expect({ language, key, missing: need.filter((name) => !got.includes(name)), extra: got.filter((name) => !want.includes(name)) }).toEqual({ language, key, missing: [], extra: [] })
          expect(form).not.toContain('@@')
          // Only a sign may be a space: Thai ends a sentence with one, not a full stop.
          expect({ language, key, blank: form.trim() === '' && /[A-Za-z]/.test(englishOf(key)) }).toEqual({ language, key, blank: false })
        }
      }
    }
  })

  it("gives a count's forms by the language's own plural rules, always with the other", () => {
    for (const language of TRANSLATED) {
      const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories as string[]
      for (const [key, entry] of Object.entries(CATALOGS[language])) {
        if (typeof entry === 'string') continue
        expect({ language, key, other: 'other' in entry }).toEqual({ language, key, other: true })
        for (const form of Object.keys(entry)) expect({ language, key, form, known: categories.includes(form) }).toEqual({ language, key, form, known: true })
      }
    }
  })

  it('translates each term of the dictionary as the dictionary has it, wherever the English uses it', () => {
    let checked = 0
    for (const term of TERMS) {
      for (const language of TRANSLATED) expect(term.forms[language].length).toBeGreaterThan(0)
      if (term.pin === undefined) continue
      for (const key of CODE_KEYS) {
        if (!term.pin.test(englishOf(key).replace(/\{\w+\}/g, ' '))) continue
        for (const language of TRANSLATED) {
          const accepted = term.forms[language].map((form) => form.toLocaleLowerCase())
          for (const form of formsOf(CATALOGS[language][key])) {
            const lower = form.toLocaleLowerCase()
            expect({ term: term.en, language, key, translated: accepted.some((needle) => lower.includes(needle)) }).toEqual({ term: term.en, language, key, translated: true })
            checked++
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(5000)
  })
})

// WHERE ENGLISH MAY STAY. A value the same as its English is either language-neutral -- values,
// punctuation, tickers -- or one of the words the language itself writes as English does (Indonesian
// and Vietnamese traders' "pump", "bot", "airdrop"). Elsewhere a Latin word in a translation is a
// ticker or an acronym, a name, a unit, or the label of a button on an English page, quoted as it reads.

/** Indonesian's and Vietnamese's own words that are spelled as the English ones. */
const LOANWORDS: Partial<Record<TranslatedLanguage, ReadonlySet<string>>> = {
  id: new Set(
    'airdrop alt backtest bearish bullish bitcoin bot breakdown breakout delisting dump ether grid horizon listing long mainnet media median minimal momentum normal order pump short spread status target trade trading trailing stop valid volume'.split(' ')
  ),
  vi: new Set('airdrop arbitrage bitcoin bot ether mainnet'.split(' '))
}

/** Names, units and conventions a translation writes in Latin letters. */
const LATIN_NAMES = new Set(['OpenAI', 'OpenRouter', 'Binance', 'Bitget', 'CoinGecko', 'Coinbase', 'Kraken', 'Bithumb', 'Upbit', 'Coinone', 'Korbit', 'Bollinger', 'TraderSpider', 'Hyperliquid', 'Bybit', 'ms', 's', 'h', 'x', 'bps'])
const LATIN_BY_LANGUAGE: Partial<Record<TranslatedLanguage, ReadonlySet<string>>> = { 'zh-CN': new Set(['token']), 'zh-TW': new Set(['token']) }
/** The label of a button on an English page, which a notice quotes as the button reads. */
const ENGLISH_LABELS = ['Prepare an order from this call']
/** English's own small words: in a Latin-script translation, a sign of English left in it. Vietnamese
 * writes "so", "an" and "to" as words of its own. */
const ENGLISH_WORDS = new Set(
  'the and of with is are for this that from which when has have will your you was were been its into than then there their they what where who why how would should could these those not but all any each more most some such only also over under after before about between'.split(' ')
)
const LATIN_SCRIPT: ReadonlySet<TranslatedLanguage> = new Set(['vi', 'id'])

/** What of a text is words: its values, paths and quoted English labels taken out. */
function wordsOf(text: string): string[] {
  let rest = text.replace(/\{\w+\}/g, ' ').replace(/[\w.-]+\/[\w./-]+/g, ' ')
  for (const label of ENGLISH_LABELS) rest = rest.split(label).join(' ')
  return rest.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []
}

/** The English left in a translated text: for a Latin-script language its small English words, for
 * any other a Latin word that is not a ticker, an acronym, a name or a unit. */
function englishIn(language: TranslatedLanguage, text: string): string[] {
  const words = wordsOf(text)
  if (LATIN_SCRIPT.has(language)) return words.filter((word) => ENGLISH_WORDS.has(word.toLowerCase()))
  return words.filter((word) => !/^[A-Z0-9]+$/.test(word.replace(/[’'-]/g, '')) && !LATIN_NAMES.has(word) && !(LATIN_BY_LANGUAGE[language]?.has(word) ?? false))
}

describe('no English left in a translation', () => {
  it('leaves a value the same as its English only where it is values and signs, or the language writes it so', () => {
    for (const language of TRANSLATED) {
      for (const [key, entry] of Object.entries(CATALOGS[language])) {
        const english = CATALOGS.en[key] ?? englishOf(key)
        const same = (typeof entry === 'string' ? entry : entry.other) === (typeof english === 'string' ? english : english.other)
        if (!same) continue
        const words = wordsOf(englishOf(key)).filter((word) => !/^[A-Z0-9]+$/.test(word))
        const own = words.filter((word) => !(LOANWORDS[language]?.has(word.toLowerCase()) ?? false))
        expect({ language, key, english: own }).toEqual({ language, key, english: [] })
      }
    }
  })

  it('writes no English word into a translation beyond tickers, names, units and quoted labels', () => {
    for (const language of TRANSLATED) {
      for (const [key, entry] of Object.entries(CATALOGS[language])) {
        for (const form of formsOf(entry)) expect({ language, key, english: englishIn(language, form) }).toEqual({ language, key, english: [] })
      }
    }
  })

  it('quotes the English label it names, in every language', () => {
    const key = '{model} at {confidence} confidence. Nothing has been placed. An order form is on offer until {time} UTC: open Bots and press Prepare an order from this call.'
    for (const language of TRANSLATED) expect(formsOf(CATALOGS[language][key])[0]).toMatch(/[“「'«]Prepare an order from this call[”」'»]/)
  })

  it('catches what it is there to catch', () => {
    expect(englishIn('ja', 'これは the 予測')).toEqual(['the'])
    expect(englishIn('ja', 'BTC/USDT の SOL、OpenRouter、5 ms')).toEqual([])
    expect(englishIn('id', 'Prediksi teratas: the pair')).toEqual(['the'])
    expect(englishIn('id', 'Trading simulasi dibuka')).toEqual([])
    expect(englishIn('zh-CN', '每百万 token')).toEqual([])
    expect(englishIn('ja', '每百万 token')).toEqual(['token'])
  })
})

describe('numbers, prices and times in each language', () => {
  const NON_LATIN_DIGITS = /[٠-٩۰-۹०-९๐-๙]/
  const DAY = Date.UTC(2026, 9, 5, 13, 5)

  it("asks Intl for Latin digits in every language, rather than trusting its data's default, which for Arabic has been Arabic's own", () => {
    for (const language of LANGUAGES) {
      expect(numberLocale(language)).toBe(`${language}-u-nu-latn`)
      expect(new Intl.NumberFormat(numberLocale(language)).resolvedOptions().numberingSystem).toBe('latn')
    }
    // Where the data's default is a language's own digits, the request is what keeps them Latin.
    expect(new Intl.NumberFormat('ar-EG-u-nu-latn').format(1234.5)).toBe('1,234.5')
  })

  it('writes every figure in Latin digits, in every language (§86)', () => {
    for (const language of LANGUAGES) {
      const shown = [formatNumber(language, 1234567.891, 0, 2), formatPercent(language, 2.4), formatMoney(language, 182.4, 'USDT'), formatDollars(language, 182.4), formatUtcTime(language, DAY), formatUtcDay(language, DAY), formatDate(language, DAY)]
      for (const text of shown) expect({ language, text, foreign: NON_LATIN_DIGITS.test(text) }).toEqual({ language, text, foreign: false })
    }
  })

  it("separates and groups by the language's own rule", () => {
    expect(formatNumber('en', 1234.5, 1, 1)).toBe('1,234.5')
    expect(formatNumber('id', 1234.5, 1, 1)).toBe('1.234,5')
    expect(formatNumber('vi', 1234.5, 1, 1)).toBe('1.234,5')
    expect(formatNumber('hi', 1234567)).toBe('12,34,567')
    expect(formatNumber('ja', 1234.5, 1, 1)).toBe('1,234.5')
    expect(formatPercent('en', 2.4)).toBe('+2.4%')
    expect(formatPercent('en', -2.4, 1, false)).toBe('-2.4%')
    expect(formatPercent('id', 2.4)).toMatch(/^\+2,4\s?%$/)
    for (const language of LANGUAGES) {
      expect(formatPercent(language, 2.4)).toMatch(/\+/)
      expect(formatPercent(language, 0)).not.toMatch(/[+-]/)
      expect(formatSigned(language, -0.4, 2)).toMatch(/[-−]0[.,]40/)
    }
  })

  it('keeps the precision a price needs, whatever the language', () => {
    expect(formatMoney('en', 182.4, 'USDT')).toBe('$182.40')
    expect(formatMoney('en', 0.5, 'BTC')).toBe('0.50000000 BTC')
    expect(assetDecimals('USDT', 0.000123)).toBe(7)
    expect(formatMoney('en', 0.000123, 'USDT')).toBe('$0.0001230')
    expect(assetDecimals('KRW')).toBe(0)
    for (const language of LANGUAGES) {
      expect(formatMoney(language, 0.5, 'BTC')).toMatch(/0[.,]50000000/)
      expect(formatMoney(language, 0.000123, 'USDT')).toMatch(/0[.,]0001230/)
      expect(formatDollars(language, 182.4)).toMatch(/182[.,]4/)
    }
  })

  it("writes a day and a time as the language does: the records' English, the Buddhist era in Thai, the UTC clock in 24 hours", () => {
    expect(formatUtcDay('en', DAY)).toBe('5 Oct')
    expect(formatUtcDay('ja', DAY)).toBe('10月5日')
    expect(formatUtcDay('zh-CN', DAY)).toBe('10月5日')
    expect(formatDate('th', DAY)).toContain('2569')
    for (const language of LANGUAGES) expect(formatUtcTime(language, DAY)).toContain('13')
    expect(formatUtcTime('en', DAY)).toBe('13:05')
  })

  it('joins a list as the language joins one', () => {
    expect(formatList('en', ['a', 'b', 'c'])).toMatch(/^a, b,? and c$/)
    expect(formatList('ja', ['a', 'b', 'c'])).toContain('、')
    expect(formatList('zh-CN', ['a', 'b'])).toContain('和')
  })
})

describe('putting a text together', () => {
  it("chooses a count's form by the language's rules: English's two, Hindi's, Arabic's", () => {
    expect(translate('en', '{count} paper trades', { count: 1 })).toBe('1 paper trade')
    expect(translate('en', '{count} paper trades', { count: 2 })).toBe('2 paper trades')
    expect(translate('en', '{count} paper trades', { count: 1234 })).toBe('1,234 paper trades')
    expect(translate('hi', '{count} are open now.', { count: 1 })).toBe('अभी 1 खुला है।')
    expect(translate('hi', '{count} are open now.', { count: 3 })).toBe('अभी 3 खुले हैं।')
    // Arabic's: one, two, a few, many and the rest -- the last two the same word for seconds; zero, which
    // has no form of its own here, reads as the rest.
    const forms = CATALOGS.ar['{count} seconds']
    expect(typeof forms).toBe('object')
    if (typeof forms === 'string') return
    const strip = (text: string): string => text.replace(/[\u2068\u2069]/g, '')
    for (const [count, form] of [[0, 'other'], [1, 'one'], [2, 'two'], [3, 'few'], [11, 'many'], [100, 'other']] as const) {
      expect(strip(translate('ar', '{count} seconds', { count }))).toBe((forms[form] ?? forms.other).replace('{count}', String(count)))
    }
    expect(new Set([1, 2, 3, 11, 100].map((count) => strip(translate('ar', '{count} seconds', { count })).replace(/\d+/, '#'))).size).toBe(4)
  })

  it('formats a number put into a text by the language, and isolates each value in Arabic (§85, §89)', () => {
    expect(translate('id', '{count} paper trades', { count: 1234 })).toBe('1.234 trading simulasi')
    expect(translate('ar', 'Top prediction: {pair}', { pair: 'SOL/USDT' })).toBe('التنبؤ الأول: \u2068SOL/USDT\u2069')
    expect(translate('ja', 'Top prediction: {pair}', { pair: 'SOL/USDT' })).toBe('トップの予測：SOL/USDT')
  })

  it("reads a key a catalog lacks in English, without its sense, and notes it", () => {
    clearMissedKeys()
    expect(translate('ja', 'Not a key the app has@@a test')).toBe('Not a key the app has')
    expect(missedKeys('ja')).toEqual(['Not a key the app has@@a test'])
    expect(translate('en', 'Not a key either@@a test')).toBe('Not a key either')
    expect(missedKeys('en')).toEqual([])
    clearMissedKeys()
    expect(missedKeys('ja')).toEqual([])
    expect(msg('Kept as written')).toBe('Kept as written')
  })
})

describe('the ten languages and their choosing (§87)', () => {
  it('offers the computer\'s language where it is one of the ten, else English', () => {
    expect(languageForLocale('zh-Hant-HK')).toBe('zh-TW')
    expect(languageForLocale('zh_TW')).toBe('zh-TW')
    expect(languageForLocale('zh-SG')).toBe('zh-CN')
    expect(languageForLocale('zh-Hans')).toBe('zh-CN')
    expect(languageForLocale('in-ID')).toBe('id')
    expect(languageForLocale('ar-EG')).toBe('ar')
    expect(languageForLocale('pt-BR')).toBeNull()
    expect(languageForLocales(['pt-BR', 'th-TH', 'en-US'])).toBe('th')
    expect(languageForLocales(['pt-BR'])).toBe('en')
    expect(healLanguage('ko')).toBe('ko')
    for (const stored of [undefined, null, 'fr', 7, 'EN']) expect(healLanguage(stored)).toBeNull()
  })

  it('writes Arabic right to left and every other left to right', () => {
    for (const language of LANGUAGES) expect(LANGUAGE_INFO[language].dir).toBe(language === 'ar' ? 'rtl' : 'ltr')
  })

  it('says, in each language, what it covers, and that no native speaker has reviewed it', () => {
    for (const language of TRANSLATED) {
      expect(LANGUAGE_INFO[language].nativeReview).toBe(false)
      clearMissedKeys()
      const i18n = i18nFor(language)
      expect(reviewNote(i18n)).not.toBeNull()
      expect(scopeNote(i18n)).not.toBe(scopeNote(ENGLISH))
      expect(missedKeys(language)).toEqual([])
    }
    expect(reviewNote(ENGLISH)).toBeNull()
  })
})

// EVERY NOTICE IN THE CHOSEN LANGUAGE (§111): each the app tells, built as its teller builds it, in each
// language, with nothing read from English and no value left unfilled.

const T = Date.parse('2026-09-10T12:07:00Z') / 1000
const EVENT: MarketEvent = {
  id: `binance:SOLUSDT:${T}`,
  exchange: 'binance',
  symbol: 'SOLUSDT',
  baseAsset: 'SOL',
  quoteAsset: 'USDT',
  time: T,
  type: 'breakout',
  direction: 'up',
  band: 'urgent',
  score: 91,
  components: { price: 90, volume: 95, volatility: 85, pressure: 90, breakout: 95 },
  price: 100,
  returnsPct: { m1: 0.4, m5: 1.5, m15: 3, h1: 3.2, h4: 2.5 },
  moveSigmas: 6,
  volumeRatio: 4.7,
  rangeRatio: 3,
  live: { detectedAt: T + 8, quoteVolume24h: 80_000_000, spreadPct: 0.01, candidateScore: 93, rank: 1 }
}
const DECISION: AiSignalDecision = {
  candleTime: T,
  recommendation: 'buy',
  confidence: 0.8,
  rationale: 'Cleared the range on volume.',
  model: 'openai/gpt-5-mini',
  cached: false,
  error: null,
  rejected: null,
  detail: { marketRegime: 'bull', riskLevel: 'medium', horizonBars: 4, stopLoss: 98.5, takeProfit: 103, reasonCodes: ['breakout'], levelsNote: null, entry: { min: 99.8, max: 100.2, validMinutes: 15 } },
  usage: { promptTokens: 2400, completionTokens: 500, costUsd: 0.003, latencyMs: 14_000 }
}
const DELISTING: NewsItem = { id: 301, catalog: 161, title: 'Binance Will Delist ICX, SCRT, STORJ on 2026-09-03', releaseSec: T, seenAt: T + 3, category: 'DELISTING', tickers: ['ICX', 'SCRT', 'STORJ'] }
const GROUP = { opened: 4, closed: 2, neverEntered: 1, ahead: 1, pnl: [{ asset: 'USDT', amount: 0.85 }], r: 0.5, rTrades: 2, unmeasured: 0 }
const DIGEST: PaperDigest = { day: '2026-10-05', watch: GROUP, news: { ...GROUP, opened: 2, r: -0.86, rTrades: 1, unmeasured: 1 }, openNow: 1 }
const PLAN = { version: 'trade-plan-v1', pair: 'SOLUSDT', side: 'BUY' as const, horizon: 'hour1' as const, entryPrice: 100, entryMin: 99.8, entryMax: 100.2, stopPct: 1.4, stopPrice: 98.6, targetPct: 2.1, targetPrice: 102.1, targetLevel: 'P75' as const, holdSec: 3600, validUntil: T + 300 }

/** Each notice the app tells, in a language: a title and a body, or a line it is built from. */
function noticesIn(i18n: I18n): Record<string, string[]> {
  const pair = (notice: { title: string; body: string } | null): string[] => (notice === null ? [] : [notice.title, notice.body])
  const trade = { id: 'paper-1', symbol: 'SOLUSDT', side: 'buy' as const, quoteAsset: 'USDT' }
  const exits = ['take_profit', 'stop_loss', 'trailing_stop', 'time_limit', 'manual'] as const
  const health = { ...emptyHealthState(), measuredAt: T, restFailures: 4, clockSkewMs: 2600, keyOk: false }
  return {
    marketEvent: pair(marketEventNotice(EVENT, i18n.t('the watch is off.'), i18n)),
    disagreement: pair(disagreementNotice(EVENT, [{ model: 'GPT-5 mini', side: 'long' }, { model: 'Claude', side: 'short' }], i18n)),
    paperClose: [...pair(paperCloseNotice(trade, { exit: 'take_profit', pnlQuote: 2.4, r: 2.1 }, i18n)), ...pair(paperCloseNotice({ ...trade, side: 'sell' }, { exit: 'time_limit', pnlQuote: 0.3, r: null }, i18n))],
    nearStop: pair(nearStopNotice({ id: 'paper-1', symbol: 'SOLUSDT', side: 'buy', real: false }, 0.8, 98.4, i18n)),
    liveExit: exits.flatMap((exitReason) => pair(liveExitNotice({ executorId: 'live-1', symbol: 'SOLUSDT', exitReason, exitPrice: 101.2, realizedPnl: 1.25, quoteAsset: 'USDT' }, i18n))),
    systemFailure: (['scanner', 'stream', 'feed', 'ai-key'] as const).flatMap((what) => pair(systemFailureNotice(what, i18n.t('The pass failed.'), i18n))),
    breaker: (['ai-budget', 'model', 'live-loss', 'health', 'health-ok', 'degraded', 'strategy'] as const).flatMap((what) => pair(breakerNotice(what, i18n.t('Live trading is paused.'), what, i18n))),
    tradeBlocked: pair(tradeBlockedNotice('SOLUSDT', 'blocked', i18n, i18n.t('Live trading is paused.'))),
    reconciliation: [...pair(reconciliationNotice('order', describeUnknownOrder({ orderId: 77, symbol: 'SOLUSDT', side: 'sell', status: 'NEW', origQty: 1.5, executedQty: 0, price: 101, placedAt: T }, 'Binance', i18n), 'order:77', i18n)), ...pair(reconciliationNotice('asset', describeReconciliation({ at: T, unknownOrders: [], discrepancies: [], unchecked: ['DOGE'], resolvedByCheck: 2, keyStored: true, error: null }, 'Binance', i18n).line, 'asset:SOL', i18n))],
    confirm: pair(confirmNotice(EVENT, { who: 'GPT-5 mini', confidence: 0.82 }, i18n)),
    watch: pair(watchNotice(EVENT, DECISION, i18n)),
    crash: pair(crashNotice(-6.2, i18n)),
    newsShort: pair(newsShortNotice(DELISTING, 'ICX', { amountQuote: 250, stopLossPct: null, takeProfitPct: null } as never, 'USDT', i18n)),
    newsTag: pair(newsShortNotice({ ...DELISTING, category: 'MONITORING_TAG' }, 'ICX', { amountQuote: 100, stopLossPct: 2.4, takeProfitPct: 3.1 } as never, 'USDT', i18n)),
    newsHolder: pair(newsHolderNotice(DELISTING, { live: [{ asset: 'ICX', free: 100, locked: 20.5 }], paperAccount: null, heldPositions: [], executors: [] }, i18n)),
    digest: pair(paperDigestNotice(DIGEST, i18n)),
    pause: [...pair(paperPauseNotice('watch', { trades: 3, r: -3.2 }, 3, i18n)), ...pair(paperPauseNotice('news', { trades: 1, r: -1.4 }, 1, i18n)), ...pair(paperPauseNotice('forecast', { trades: 2, r: -2.5 }, 2, i18n))],
    predictionChanged: pair(
      predictionChangedNotice(
        {
          pair: 'SOLUSDT',
          from: { direction: 'BULLISH', horizon: 'hour1', lowPct: -1, highPct: 2, regime: 'sideways', medians: {} },
          to: { direction: 'BEARISH', horizon: 'hour1', lowPct: -3, highPct: -0.5, regime: 'bear', medians: {} },
          reasons: [],
          reasonCodes: [{ code: 'median', model: 'gbt', change: -1.8 }, { code: 'regime', from: 'sideways', to: 'bear' }, { code: 'market' }]
        },
        i18n
      )
    ),
    budget: [budgetProblem(5, 5.2, i18n) ?? ''],
    health: [describePause(healthVerdict(health, i18n), i18n) ?? ''],
    lossTally: [describeUntrustedLossTally(Number.NaN, i18n) ?? ''],
    tradePlan: describeAiProposal(forecastProposal({ plan: PLAN, confidence: 0.64, barTime: T }), i18n),
    simulator: SIMULATED_EVENTS.map((event) => i18n.t(event.title))
  }
}

describe('every notice in the chosen language', () => {
  const english = noticesIn(ENGLISH)

  it('is built in English as the English tests pin it', () => {
    expect(english.digest[0]).toBe('Paper trades on 5 Oct (UTC)')
    expect(english.watch[0]).toBe('SOLUSDT: BUY')
    for (const [name, lines] of Object.entries(english)) {
      expect({ name, some: lines.length > 0 && lines.every((line) => line !== '') }).toEqual({ name, some: true })
    }
  })

  it("puts each value in as the language writes it: the digest's day, a notice's percentages", () => {
    const day = Date.UTC(2026, 9, 5)
    for (const language of TRANSLATED) {
      const told = noticesIn(i18nFor(language))
      expect({ language, day: told.digest[0].includes(formatUtcDay(language, day)) }).toEqual({ language, day: true })
      expect({ language, english: told.digest[0].includes('5 Oct') }).toEqual({ language, english: false })
    }
    expect(noticesIn(i18nFor('id')).marketEvent[1]).toContain('+3,00%')
  })

  it('is built in each language from its catalog alone, every value in its place', () => {
    for (const language of TRANSLATED) {
      clearMissedKeys()
      const told = noticesIn(i18nFor(language))
      expect({ language, missed: missedKeys(language) }).toEqual({ language, missed: [] })
      for (const [name, lines] of Object.entries(told)) {
        expect({ language, name, count: lines.length }).toEqual({ language, name, count: english[name].length })
        lines.forEach((line, at) => {
          expect({ language, name, line, unfilled: /\{\w+\}/.test(line) }).toEqual({ language, name, line, unfilled: false })
          expect({ language, name, line, same: line === english[name][at] }).toEqual({ language, name, line, same: false })
        })
      }
    }
  })
})

// THE TRANSLATED PAGES, RENDERED IN EACH LANGUAGE (§111): the sidebar, Home, Predictions,
// Opportunities, Positions, Performance, Settings, the language chooser and the trade plan's Position
// form, before any data arrives. Nothing may be read from English that the catalog should have given,
// and what a reader sees outside an English-only part, a value or a model's words is in the language.

const neverResolves = (): Promise<never> => new Promise(() => undefined)
const API: unknown = new Proxy({}, { get: () => new Proxy(neverResolves, { get: (_target, name: string) => (name.startsWith('on') ? () => () => undefined : neverResolves) }) })
const storage = new Map<string, string>()
const LOCAL_STORAGE = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value), removeItem: (key: string) => void storage.delete(key) }
Object.assign(globalThis, {
  window: { api: API, localStorage: LOCAL_STORAGE, addEventListener: () => undefined, removeEventListener: () => undefined, matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) },
  localStorage: LOCAL_STORAGE
})

const VOID_ELEMENTS = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i

/** The text a reader sees in the window's language: outside an element in another language (an
 * English-only card, a language's own name), one shown as written (dir="auto": a model's words, a
 * record), a value (bdi) and code. */
function textInLanguage(html: string, language: Language): string {
  const out: string[] = []
  const asWritten: boolean[] = []
  let depth = 0
  for (const match of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>|([^<]+)/g)) {
    if (match[5] !== undefined) {
      if (depth === 0) out.push(match[5])
      continue
    }
    if (match[1] === '/') {
      if (asWritten.pop() === true) depth--
      continue
    }
    if (match[4] === '/' || VOID_ELEMENTS.test(match[2])) continue
    const lang = /\slang="([^"]+)"/.exec(match[3])?.[1]
    const written = (lang !== undefined && lang !== language) || /\sdir="auto"/.test(match[3]) || match[2] === 'bdi' || match[2] === 'code'
    asWritten.push(written)
    if (written) depth++
  }
  return out.join(' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

async function surfaces(): Promise<{ name: string; element: (language: Language) => ReactElement }[]> {
  const { HomePage } = await import('../src/home/HomePage')
  const { PredictionsPage } = await import('../src/forecast/PredictionsPage')
  const { OpportunitiesPage } = await import('../src/opportunities/OpportunitiesPage')
  const { PositionsPage } = await import('../src/positions/PositionsPage')
  const { PerformancePage } = await import('../src/performance/PerformancePage')
  const { SettingsPanel } = await import('../src/settings/SettingsPanel')
  const { Sidebar } = await import('../src/components/Sidebar')
  const { LanguageChooser } = await import('../src/i18n/LanguageChooser')
  const { NewExecutorModal } = await import('../src/executors/NewExecutorModal')
  const { NewsUrlsPage } = await import('../src/articles/NewsUrlsPage')
  const { CopyTradersPage } = await import('../src/traders/CopyTradersPage')
  const none = (): undefined => undefined
  const proposal = forecastProposal({ plan: PLAN, confidence: 0.64, barTime: T })
  return [
    { name: 'Home', element: () => createElement(HomePage, { onPrepareOrder: none, onNavigate: none }) },
    { name: 'Predictions', element: () => createElement(PredictionsPage, {}) },
    { name: 'Opportunities', element: () => createElement(OpportunitiesPage, { onPrepareOrder: none } as never) },
    { name: 'Positions', element: () => createElement(PositionsPage) },
    { name: 'Performance', element: () => createElement(PerformancePage) },
    { name: 'Settings', element: () => createElement(SettingsPanel, { onNavigate: none, onUiModeChange: none, onLanguageChange: async () => undefined } as never) },
    { name: 'the sidebar', element: () => createElement(Sidebar, { activeId: 'home', onChoose: none, collapsed: false, onToggleCollapsed: none, uiMode: 'normal' } as never) },
    { name: 'the expert sidebar', element: () => createElement(Sidebar, { activeId: 'home', onChoose: none, collapsed: false, onToggleCollapsed: none, uiMode: 'expert' } as never) },
    { name: 'the language chooser', element: (language) => createElement(LanguageChooser, { offered: language, onChoose: async () => undefined }) },
    { name: 'the trade plan', element: () => createElement(NewExecutorModal, { account: null, existingExecutors: [], proposal, onCreate: none, onClose: none }) },
    // Translated, and in the normal sidebar, since V8 Stage 5.
    { name: 'News URLs', element: () => createElement(NewsUrlsPage, { onPrepareOrder: none }) },
    // And since Stage 8.
    { name: 'Copy Traders', element: () => createElement(CopyTradersPage) }
  ]
}

async function render(element: ReactElement, language: Language): Promise<string> {
  const { I18nProvider } = await import('../src/i18n/I18nProvider')
  const { ThemeProvider } = await import('../src/theme/ThemeContext')
  return renderToStaticMarkup(createElement(ThemeProvider, null, createElement(I18nProvider, { language }, element)))
}

describe('the translated pages in every language', () => {
  // The first render loads every page's modules: unhurried, as the whole suite runs beside it.
  it('renders each in English', async () => {
    for (const { name, element } of await surfaces()) {
      const html = await render(element('en'), 'en')
      expect({ name, rendered: html.length > 200 }).toEqual({ name, rendered: true })
    }
  }, 60_000)

  it('renders each in every other language from its catalog alone, with no English in what is read', async () => {
    const list = await surfaces()
    for (const language of TRANSLATED) {
      for (const { name, element } of list) {
        clearMissedKeys()
        const html = await render(element(language), language)
        expect({ language, name, missed: missedKeys(language) }).toEqual({ language, name, missed: [] })
        expect({ language, name, english: englishIn(language, textInLanguage(html, language)) }).toEqual({ language, name, english: [] })
      }
    }
  }, 60_000)

  it("keeps the English-only cards left to right in Arabic's right-to-left window, and each language's name in its own (§85, §87)", { timeout: 60_000 }, async () => {
    const list = await surfaces()
    const html = async (name: string): Promise<string> => render(list.find((surface) => surface.name === name)!.element('ar'), 'ar')
    expect(await html('Performance')).toContain('dir="ltr" lang="en"')
    // The trade plan's form is translated inside the English page it opens on.
    expect(await html('the trade plan')).toContain('dir="rtl" lang="ar"')
    const settings = await html('Settings')
    for (const language of LANGUAGES) expect(settings).toContain(`lang="${language}" dir="${LANGUAGE_INFO[language].dir}"`)
  })

  it('sees English where it is left by mistake', () => {
    expect(englishIn('ja', textInLanguage('<p>予測<span>the pair</span></p>', 'ja'))).toEqual(['the', 'pair'])
    expect(englishIn('ja', textInLanguage('<p>予測<div dir="ltr" lang="en">The pair</div><bdi dir="ltr">SOL/USDT</bdi><span dir="auto">a model said so</span></p>', 'ja'))).toEqual([])
  })
})

// THE FORECAST'S CARDS WITH A FORECAST IN THEM: Home's best prediction and top three, and the
// Predictions drawer, for a call to trade and one not to, with every reason a decision gives.

const BAR = Date.parse('2026-10-13T15:00:00Z') / 1000

function rangeOf(quantilesPct: number[], patch: Partial<ForecastRange> = {}): ForecastRange {
  const prices = quantilesPct.map((pct) => 180 * (1 + pct / 100))
  return {
    lowPct: quantilesPct[1],
    highPct: quantilesPct[3],
    lowerPrice: prices[1],
    upperPrice: prices[3],
    medianPct: quantilesPct[2],
    confidenceLevel: 50,
    quantilesPct,
    quantilePrices: prices,
    bearPct: quantilesPct[0],
    bullPct: quantilesPct[4],
    pUp: 0.62,
    pUpMapped: 0.62,
    direction: 'BULLISH',
    strong: false,
    uncertain: false,
    confidence: 62,
    reliability: 'MEDIUM',
    reliabilityReasons: [],
    quality: { score: 66, parts: { direction: 60, range: 80, calibration: 90, news: null, confirmation: null, agreement: 100, freshness: 100 } },
    width80Pct: 5,
    usualWidth80Pct: 4,
    skill: 0.03,
    directionSkill: 0.02,
    ownClass: true,
    expiresAt: (BAR + 3600) * 1000,
    contributions: [
      { model: 'gbt', weight: 0.6, medianLogPct: 0.9 },
      { model: 'technical', weight: 0.4, medianLogPct: 0.4 }
    ],
    calibrationShiftLogPct: 0,
    newsShiftLogPct: 0,
    news: { v3: null, v4: null },
    spreadStretch: 1,
    variants: {},
    rangeDrivers: [],
    ...patch
  }
}

const PREDICTION: PricePrediction = {
  pair: 'SOLUSDT',
  generatedAt: BAR * 1000 + 7000,
  direction: 'BULLISH',
  horizons: {
    minutes15: rangeOf([-1, -0.5, 0.1, 0.7, 1.2], { expiresAt: (BAR + 900) * 1000, direction: 'NEUTRAL' }),
    hour1: rangeOf([-1.5, -0.2, 0.9, 1.8, 2.9]),
    hours4: rangeOf([-3, -2, 0.5, 3, 4], { expiresAt: (BAR + 14_400) * 1000, direction: 'NEUTRAL', uncertain: true })
  },
  currentPrice: 180,
  confidence: 62,
  reliability: 'MEDIUM',
  invalidationConditions: [],
  modelVersion: 'models-v1 run-x',
  id: `SOLUSDT:${BAR}`,
  strong: false,
  uncertain: false,
  bestHorizon: 'hour1',
  pairClass: 'large',
  regime: 'bull',
  barTime: BAR,
  market: { z1h: 1.4, breadth1h: 0.6, volRatio1h: 3.7 },
  versions: { prediction: 'prediction-v1', models: 'models-v1', features: 'features-v1', ensemble: 'ensemble-v1', calibration: 'calibration-v1', runCalibration: 'run-calibration-v2', news: 'news-effect-v1', quality: 'quality-v1', run: 'run-x', foldsRun: 'run-y' }
} as PricePrediction

const NO_TRADE: TradeDecision = {
  version: 'decision-v1',
  pair: 'SOLUSDT',
  horizon: 'hour1',
  side: null,
  decision: 'NO_TRADE',
  reasons: [
    { code: 'NO_CALL', text: 'The 1-hour forecast calls no way.', values: {} },
    { code: 'UNCERTAIN', text: '', values: {} },
    { code: 'EDGE_UNDER_COSTS', text: '', values: { expectedPct: 0.1, costPct: 0.24 } },
    { code: 'UNLIKELY_PROFIT', text: '', values: { pProfit: 0.41 } },
    { code: 'SPREAD', text: '', values: { spreadPct: 0.31 } },
    { code: 'STALE_PRICE', text: '', values: {} },
    { code: 'STALE_BARS', text: '', values: {} },
    { code: 'REGIME_AGAINST', text: '', values: { side: 'BUY', regime: 'bear' } },
    { code: 'QUALITY_LOW', text: '', values: { score: 40 } },
    { code: 'CLASS_NOT_APPROVED', text: '', values: { classKey: 'large/hour1/trend', verdict: 'DISABLED' } }
  ],
  edge: null,
  quality: 40,
  classKey: 'large/hour1/trend',
  classVerdict: 'DISABLED',
  at: BAR * 1000
}
const TRADE: TradeDecision = { ...NO_TRADE, side: 'BUY', decision: 'TRADE', reasons: [], edge: { side: 'BUY', costPct: 0.24, expectedPct: 0.9, edgePct: 0.66, pProfit: 0.61 }, quality: 66, classVerdict: 'PROBATION' }
const RANKED: RankedForecast = { pair: 'SOLUSDT', horizon: 'hour1', score: 0.42, quality: 66, quoteVolume24h: 80_000_000, parts: { edge: 0.6, reliability: 0.7, news: 1, liquidity: 0.9, execution: 0.95, uncertainty: 0.1, marketRisk: 0, cost: 0.05 }, decision: TRADE }

describe("the forecast's cards with a forecast in them, in every language", () => {
  it('reads each from its catalog, with no English in what is read', async () => {
    const { BestPredictionCard, TopPredictions } = await import('../src/forecast/BestPredictionCard')
    const { PredictionDrawer } = await import('../src/forecast/PredictionDrawer')
    const none = (): undefined => undefined
    const btc = { ...PREDICTION, pair: 'BTCUSDT', id: `BTCUSDT:${BAR}` }
    const cards: { name: string; element: ReactElement }[] = [
      { name: 'the best prediction, to trade', element: createElement(BestPredictionCard, { prediction: PREDICTION, ranked: RANKED, live: null, onDetails: none, onPrepareOrder: none }) },
      { name: 'the best prediction, not to', element: createElement(BestPredictionCard, { prediction: PREDICTION, ranked: { ...RANKED, decision: NO_TRADE }, live: null, onDetails: none }) },
      { name: 'no prediction yet', element: createElement(BestPredictionCard, { prediction: null, ranked: null, live: null, onDetails: none }) },
      {
        name: 'the top three',
        element: createElement(TopPredictions, {
          ranked: [RANKED, { ...RANKED, pair: 'BTCUSDT', decision: { ...NO_TRADE, pair: 'BTCUSDT' } }],
          predictions: new Map([
            ['SOLUSDT', PREDICTION],
            ['BTCUSDT', btc]
          ]),
          onDetails: none
        })
      },
      { name: 'the drawer, to trade', element: createElement(PredictionDrawer, { prediction: PREDICTION, decision: TRADE, live: null, onClose: none, onPrepareOrder: none }) },
      { name: 'the drawer, not to', element: createElement(PredictionDrawer, { prediction: PREDICTION, decision: NO_TRADE, live: null, onClose: none }) },
      // Its range widened for Bitcoin's sharp move (V6.1).
      {
        name: "the drawer, widened for Bitcoin's move",
        element: createElement(PredictionDrawer, {
          prediction: { ...PREDICTION, horizons: { ...PREDICTION.horizons, hour1: { ...PREDICTION.horizons.hour1!, shock: { btc15: -2.84, k80: 1.43, k50: 1.41, held: { before: 0.633, after: 0.793 } } } } },
          decision: NO_TRADE,
          live: null,
          onClose: none
        })
      },
      // Its range widened by the market's state (V7.1 Stage 11).
      {
        name: "the drawer, widened by the market's state",
        element: createElement(PredictionDrawer, {
          prediction: { ...PREDICTION, marketState: 'RECOVERY', horizons: { ...PREDICTION.horizons, hour1: { ...PREDICTION.horizons.hour1!, shock: { btc15: 0.3, k80: 1.3, k50: 1.1, held: { before: 0.7, after: 0.81 }, state: 'RECOVERY' } } } },
          decision: NO_TRADE,
          live: null,
          onClose: none
        })
      }
    ]
    for (const language of LANGUAGES) {
      for (const { name, element } of cards) {
        clearMissedKeys()
        const html = await render(element, language)
        expect({ language, name, rendered: html.length > 300 }).toEqual({ language, name, rendered: true })
        if (language === 'en') continue
        expect({ language, name, missed: missedKeys(language) }).toEqual({ language, name, missed: [] })
        expect({ language, name, english: englishIn(language, textInLanguage(html, language)) }).toEqual({ language, name, english: [] })
      }
    }
  }, 60_000)
})

// V6.1: the drawer says a range was widened for Bitcoin's sharp move, by how much, and how such moments held.
describe("the drawer's range widened for Bitcoin's sharp move", () => {
  it('says the move, the factor and what the walk forward held before and after', async () => {
    const { PredictionDrawer } = await import('../src/forecast/PredictionDrawer')
    const none = (): undefined => undefined
    const widened = { ...PREDICTION, horizons: { ...PREDICTION.horizons, hour1: { ...PREDICTION.horizons.hour1!, shock: { btc15: -2.84, k80: 1.434, k50: 1.41, held: { before: 0.633, after: 0.793 } } } } }
    const html = await render(createElement(PredictionDrawer, { prediction: widened, decision: NO_TRADE, live: null, onClose: none }), 'en')
    expect(html).toContain('sharp move (2.8 usual moves in fifteen minutes) widened it ×1.43: on the weeks tested, after such moves it held 63% of the time, widened 79%')
    // Not widened: not said.
    const plain = await render(createElement(PredictionDrawer, { prediction: PREDICTION, decision: NO_TRADE, live: null, onClose: none }), 'en')
    expect(plain).not.toContain('sharp move')
    // Widened by a market state's rule (V7.1 Stage 11): the state named, Bitcoin's move not.
    const byState = { ...PREDICTION, horizons: { ...PREDICTION.horizons, hour1: { ...PREDICTION.horizons.hour1!, shock: { btc15: 0.3, k80: 1.3, k50: 1.1, held: { before: 0.7, after: 0.81 }, state: 'RECOVERY' as const } } } }
    const stated = await render(createElement(PredictionDrawer, { prediction: byState, decision: NO_TRADE, live: null, onClose: none }), 'en')
    expect(stated).toContain('state (recovering from a shock) widened it ×1.30: on the weeks tested, in that state it held 70% of the time, widened 81%')
    expect(stated).not.toContain('sharp move')
  }, 60_000)
})

// Found by V6 Stage 16's 12-hour run: Home said there was no live price newer than ten seconds beside the
// live price it showed. The decision was the pass's, made on the books the stream held then.
// THE PRIMARY CALL AND A NEWS LINK WITH DATA IN THEM (V8 Stage 5): the card of a Binance delisting and the
// no-opportunity state with every reason, every coin's line, a pasted link's record with each lookup, its own view's
// form, and an article reading -- in every language, from its catalog alone, with what the record holds as written.

const RELEASE = 1_793_030_430
const CALL_CARD = delistingCardOf({
  candidate: { articleId: 4242, title: 'Binance Will Delist ABC on 2026-11-02', releaseSec: RELEASE, ticker: 'ABC', pair: 'ABCUSDT' },
  nowSec: RELEASE + 60,
  livePrice: 2,
  gate: { ok: true, trip: { venue: 'binance', feePct: 0.1, spreadPct: 0.3, impactPct: 0.2, totalPct: 0.7, basis: 'book' }, depthQuote: 5000 },
  stakeQuote: 100,
  study: DELISTING_STUDY,
  live: { hours: 12, coins: 15, meanPct: 6, low: 2, high: 9, state: 'weaker' },
  predictionId: 'delisting-rule:ABCUSDT:1793030430'
}) as PrimaryCard
const CALLS: PrimaryCallState = { v: PRIMARY_CALL_VERSION, at: RELEASE + 60, cards: [], late: [], refused: [], delistLive: null, readerOn: true, modelSources: 0 }
const REFUSAL_CODES = ['withdrawn', 'no-price', 'no-pair', 'no-book', 'thin', 'cost-share', 'under-lines', 'no-evidence'] as const
const LINE_FORECAST = (pair: string): PricePrediction =>
  ({
    ...PREDICTION,
    pair,
    moveRates: { version: 'v', fromSec: 0, toSec: 0, days: 90, horizons: [{ horizon: 'hours4', moments: 2000, close: [{ pct: 2, up: 0.1, down: 0.1, either: 0.2 }], touch: [] }] }
  }) as unknown as PricePrediction

const URL_RECORD = {
  v: 'url-record-v1',
  id: 'abcdefabcdef0123',
  origin: 'manual',
  at: RELEASE,
  url: 'https://www.coindesk.com/markets/abc-listing',
  originalHash: 'h',
  host: 'www.coindesk.com',
  credibility: 'outlet',
  binance: { code: 'c0de', articleId: 4242, title: 'Binance Will List ABC', releaseSec: RELEASE, delisting: false },
  retrieval: 'fetched',
  readFailure: 'the page answered 403',
  finalUrl: null,
  readAt: RELEASE,
  title: 'Binance will list ABC on Monday',
  siteName: 'CoinDesk',
  author: 'Jane Doe',
  canonical: null,
  bodyHash: 'b',
  snippets: [
    { n: 1, text: 'Binance said it will list ABC on Monday.' },
    { n: 2, text: 'Trading opens at noon.' }
  ],
  time: {
    sec: RELEASE - 600,
    source: 'jsonld',
    field: 'datePublished',
    candidates: [],
    future: [{ sec: RELEASE + 9000, source: 'meta', field: 'article:modified_time' }],
    disagree: true,
    check: { source: 'feed', sec: RELEASE - 500, agrees: false }
  },
  kind: 'LISTING',
  corroboration: { stories: 2, sources: ['CoinDesk', 'The Block'] },
  coins: [
    { ticker: 'ABC', relationship: 'DIRECT', pair: 'ABCUSDT', venue: 'binance' },
    { ticker: 'ETH', relationship: 'INDIRECT', pair: 'ETHUSDT', venue: 'bitget' }
  ],
  rejected: [
    { ticker: 'XYZ', why: 'no-pair' },
    { ticker: 'QRS', why: 'thin' },
    { ticker: 'TUV', why: 'over-cap' }
  ],
  reactions: [
    { pair: 'ABCUSDT', refPrice: 2, beforePct: 1.5, afterPct: { m5: 3.1, m15: 4.2, h1: null, h4: null }, final: false },
    { pair: 'ETHUSDT', refPrice: 2500, beforePct: -0.4, afterPct: { m5: 0.1, m15: 0.2, h1: 0.3, h4: 0.5 }, final: true }
  ],
  verdict: { cards: [], none: 'No measured source calls a way for news of this kind (listing).' },
  predictionIds: [],
  executorIds: [],
  analysisId: null,
  lookups: { archive: { status: 'found', firstSec: RELEASE - 7200, note: 'The Internet Archive captured the page before the time it states.' }, x: { status: 'found', name: 'Jane Doe', url: 'https://x.com/jane' } },
  trail: [{ at: RELEASE, status: 'read', note: 'The page was read: 768,915 bytes.' }]
} as unknown as UrlRecord

const ARTICLE_ANSWER: ArticleReadingAnswer = {
  summary: 'Binance says it will list ABC on Monday.',
  cites: [1, 2],
  stance: 'official',
  novelty: 'new',
  coins: [
    { ticker: 'ABC', about: 'subject' },
    { ticker: 'ETH', about: 'mentioned' }
  ],
  bigMove: { hour: false, fourHours: true, day: false },
  instructions: true,
  confidence: 0.55,
  reasons: 'An exchange announcement of a listing.'
}

describe('the primary call and a news link with data in them, in every language (V8 Stage 5)', () => {
  it('reads each from its catalog, with no English in what is read but what the record holds as written', async () => {
    const { PrimaryCallCard } = await import('../src/calls/PrimaryCallCard')
    const { CallLines } = await import('../src/calls/CallLines')
    const { RecordView, OwnView } = await import('../src/articles/NewsUrlsPage')
    const { ArticleReading, ReadingView } = await import('../src/articles/ArticleReading')
    const none = (): undefined => undefined
    const pairs = ['BTCUSDT', 'SOLUSDT', ...REFUSAL_CODES.map((_, k) => `C${k}USDT`)]
    const forecasts = new Map(pairs.map((pair) => [pair, LINE_FORECAST(pair)]))
    const refusals = REFUSAL_CODES.map((code, k) => ({ refused: code, source: 'delisting-rule', pair: `C${k}USDT`, eventAt: RELEASE, expectedNet: null }))
    const late = [
      { pair: 'LATEUSDT', ticker: 'LATE', eventAt: RELEASE, exitAt: RELEASE + 14_400, movedSincePct: -6 },
      { pair: 'NONEUSDT', ticker: 'NONE', eventAt: RELEASE, exitAt: RELEASE + 14_400, movedSincePct: null }
    ]
    const views: { name: string; element: ReactElement }[] = [
      { name: 'the card, with one more', element: createElement(PrimaryCallCard, { state: { ...CALLS, cards: [CALL_CARD, { ...CALL_CARD, pair: 'DEFUSDT' }] }, predictions: [PREDICTION], livePrice: 1.98 }) },
      {
        name: 'no opportunity, with why',
        element: createElement(PrimaryCallCard, {
          state: { ...CALLS, late, refused: refusals, readerOn: false, modelSources: 2, delistLive: { hours: 6, coins: 9, meanPct: -3, low: -5, high: -1, state: 'withdrawn' } },
          predictions: [PREDICTION, { ...PREDICTION, pair: 'BTCUSDT' }]
        })
      },
      { name: 'no opportunity, nothing called', element: createElement(PrimaryCallCard, { state: { ...CALLS, delistLive: { hours: 0, coins: 0, meanPct: null, low: null, high: null, state: 'ok' } }, predictions: [] }) },
      { name: 'weighing', element: createElement(PrimaryCallCard, { state: null, predictions: [] }) },
      { name: "every coin's call", element: createElement(CallLines, { state: { ...CALLS, cards: [CALL_CARD], late, refused: refusals }, predictions: forecasts, pairs, onOpen: none }) },
      { name: "every coin's call, before a forecast", element: createElement(CallLines, { state: null, predictions: new Map(), pairs: [], onOpen: none }) },
      { name: "a link's record", element: createElement(RecordView, { record: URL_RECORD }) },
      {
        name: 'a delisting with no card, its lookups not yet made',
        element: createElement(RecordView, { record: { ...URL_RECORD, binance: { ...URL_RECORD.binance!, delisting: true }, lookups: undefined, reactions: [], verdict: { cards: ['delisting-rule:ABCUSDT:1793030430'], none: null } } })
      },
      {
        name: 'a discovered story, nothing read',
        element: createElement(RecordView, {
          record: { ...URL_RECORD, origin: 'automatic', lookups: undefined, coins: [], rejected: [], time: null, author: null, readFailure: null, snippets: [], binance: null, corroboration: { stories: 0, sources: [] }, retrieval: 'none' }
        })
      },
      {
        name: 'each other lookup',
        element: createElement(RecordView, { record: { ...URL_RECORD, lookups: { archive: { status: 'off', firstSec: null, note: null }, x: { status: 'failed', name: null, url: null } }, time: { ...URL_RECORD.time!, check: { source: 'announcement', sec: RELEASE, agrees: true } } } })
      },
      { name: 'no capture', element: createElement(RecordView, { record: { ...URL_RECORD, lookups: { archive: { status: 'none', firstSec: null, note: null }, x: null }, time: { ...URL_RECORD.time!, check: { source: 'feed', sec: RELEASE, agrees: true } } } }) },
      { name: 'not asked', element: createElement(RecordView, { record: { ...URL_RECORD, lookups: { archive: null, x: null }, time: { ...URL_RECORD.time!, check: { source: 'announcement', sec: RELEASE, agrees: false } } } }) },
      { name: 'the archive failed', element: createElement(RecordView, { record: { ...URL_RECORD, lookups: { archive: { status: 'failed', firstSec: null, note: 'timeout' }, x: null } } }) },
      { name: 'the archive found it, the time agreeing', element: createElement(RecordView, { record: { ...URL_RECORD, lookups: { archive: { status: 'found', firstSec: RELEASE - 60, note: null }, x: null } } }) },
      { name: 'your own view', element: createElement(OwnView, { record: URL_RECORD, onPrepareOrder: none }) },
      { name: 'the article reading, before its status', element: createElement(ArticleReading, { record: URL_RECORD }) },
      { name: 'the article reading, no coin in its title', element: createElement(ArticleReading, { record: { ...URL_RECORD, coins: [URL_RECORD.coins[1]] } }) },
      { name: 'the article reading, nothing read', element: createElement(ArticleReading, { record: { ...URL_RECORD, snippets: [] } }) },
      { name: 'a reading', element: createElement(ReadingView, { reading: ARTICLE_ANSWER, subject: 'ABC', passage: (n: number) => URL_RECORD.snippets.find((snippet) => snippet.n === n)?.text ?? null }) },
      {
        name: 'each other reading',
        element: createElement(ReadingView, {
          reading: { ...ARTICLE_ANSWER, stance: 'unconfirmed', novelty: 'unclear', instructions: false, coins: [{ ticker: 'ABC', about: 'unrelated' }], bigMove: { hour: true, fourHours: false, day: true } },
          subject: 'ABC',
          passage: () => null
        })
      },
      { name: 'a reported reading', element: createElement(ReadingView, { reading: { ...ARTICLE_ANSWER, stance: 'reported', novelty: 'known' }, subject: null, passage: () => null }) },
      { name: 'an opinion', element: createElement(ReadingView, { reading: { ...ARTICLE_ANSWER, stance: 'opinion' }, subject: null, passage: () => null }) }
    ]
    for (const language of LANGUAGES) {
      for (const { name, element } of views) {
        clearMissedKeys()
        const html = await render(element, language)
        expect({ language, name, rendered: html.length > 100 }).toEqual({ language, name, rendered: true })
        if (language === 'en') continue
        expect({ language, name, missed: missedKeys(language) }).toEqual({ language, name, missed: [] })
        expect({ language, name, english: englishIn(language, textInLanguage(html, language)) }).toEqual({ language, name, english: [] })
      }
    }
  }, 60_000)
})

// COPY TRADERS WITH A RECORD IN IT (V8 Stage 8): the page's views with a trader of each source in them -- every
// verdict of the three tests and each of their reasons, every feature a clone's rule can read, each answer of the
// Bitget check -- and the paper panel in each of its states.
const TRADER_MS = Date.parse('2026-10-27T09:30:00Z')
const HL_ID = `0x0b4b6bea${'0'.repeat(28)}1234`
const traderMeta = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 'trader-store-v2',
  ref: { venue: 'hyperliquid', id: HL_ID, key: `hyperliquid-${HL_ID}` },
  importedAt: TRADER_MS / 1000,
  source: 'hyperliquid',
  label: 'VERIFIED',
  records: 10_000,
  firstMs: TRADER_MS - 90 * 86_400_000,
  lastMs: TRADER_MS,
  capped: true,
  name: null,
  fileKind: null,
  fileRefused: null,
  ...over
})
const OKX_META = traderMeta({ ref: { venue: 'okx', id: '35E22983F436F55B', key: 'okx-35E22983F436F55B' }, source: 'okx', label: 'REPORTED', records: 230, capped: false })
const FILE_META = traderMeta({ ref: { venue: 'file', id: '0123456789abcdef', key: 'file-0123456789abcdef' }, source: 'file', label: 'UNVERIFIABLE', records: 310, capped: false, name: 'my trades.csv', fileKind: 'trips', fileRefused: { count: 3, reasons: ['line 4: no time', 'line 9: a size of 0'] } })
const position = (coin: string, size: number, leverage: { type: string; value: number } | null): Record<string, unknown> => ({ coin, size, entryPx: 100, positionValue: Math.abs(size) * 102, unrealizedPnl: 2, leverage, liquidationPx: null, marginUsed: 10, fundingSinceOpen: null })
const TRADER_FIGURES = {
  trips: 412,
  partial: 3,
  spotFills: 2,
  span: { fromMs: TRADER_MS - 88 * 86_400_000, toMs: TRADER_MS, calendarDays: 88.4, tradingDays: 61 },
  money: { realized: 5230.5, fees: 812.25, rebates: 14.1, funding: -120.4, net: 4297.85 },
  winRate: 0.553,
  drawdown: { usdc: 1840.2, pctOfAccount: 12.4 },
  holdMin: { p10: 0.5, median: 25, p90: 300, max: 4000 },
  stake: { medianUsdc: 2150 },
  leverage: { median: 1.8, max: 12.5, trips: 400 },
  reportedLeverage: null,
  ledger: { deposits: 20_000, withdrawals: 5000 },
  coins: [
    { coin: 'BTC', trips: 200, net: 3000 },
    { coin: 'HYPE', trips: 150, net: 1500 },
    { coin: 'kPEPE', trips: 62, net: -202.15 }
  ],
  open: { positions: [position('BTC', 0.5, { type: 'cross', value: 5 }), position('HYPE', -100, { type: 'isolated', value: 3 }), position('SOL', 10, null), position('ETH', -1, { type: 'other', value: 2 })], unrealized: 950.5, accountValue: 25_000 }
}
const SKILL = { version: 'trader-skill-v1', verdict: 'MARKET OR LUCK', reasons: ['in English'], trips: 412, withoutBars: 3, tradingDays: 61, spanDays: 88.4, edgePct: 0.021, interval: { low: -0.01, high: 0.05 }, halvesPct: [0.03, -0.01], pShift: 0.21, pFlip: 0.04, betaOfOne: 2, draws: 10_000 }
const delayRow = (delayMin: number, costMultiplier: number, aboveZero: boolean, over: Record<string, unknown> = {}): Record<string, unknown> => ({ delayMin, costMultiplier, n: 120, missing: 0, meanNetPct: aboveZero ? 0.08 : -0.02, interval: aboveZero ? { low: 0.01, high: 0.15 } : { low: -0.06, high: 0.02 }, aboveZero, ...over })
const DELAY = {
  version: 'trader-delay-v1',
  rows: [delayRow(2, 1, true), delayRow(2, 2, false), delayRow(5, 1, false, { missing: 4 }), delayRow(5, 2, false), delayRow(15, 1, false, { meanNetPct: null, interval: null }), delayRow(15, 2, false)],
  trips: 120,
  sinceMs: TRADER_MS - 30 * 86_400_000,
  noVenue: 4,
  impactAssumed: ['kPEPE'],
  fundingAssumed: 7
}
const condition = (feature: string, op: '<=' | '>=', threshold: number): Record<string, unknown> => ({ feature, op, threshold })
const CLONE = {
  version: 'trader-clone-v1',
  verdict: 'REPLICABLE',
  reasons: [],
  entries: 270,
  withoutFeatures: 5,
  trainEntries: 180,
  testEntries: 90,
  rule: { side: 'short', conditions: [condition('weekdayUtc', '>=', 4.6), condition('vol24h', '<=', 0.0042)], holdBars: 8 },
  training: { tpr: 0.62, fpr: 0.21, positives: 180, negatives: 720 },
  outOfTime: { tpr: 0.58, fpr: 0.22, auc: 0.71, interval: { low: 0.64, high: 0.78 }, positives: 90, negatives: 360 },
  trades: { n: 44, meanNetPct: 0.12, interval: { low: 0.02, high: 0.2 }, coins: ['BTC', 'HYPE'] }
}
const TRADER_ANALYSIS = {
  v: 'trader-analysis-v2',
  key: `hyperliquid-${HL_ID}`,
  ref: (traderMeta() as { ref: unknown }).ref,
  at: TRADER_MS / 1000,
  versions: { engine: 'f8ec0052263b', config: 'c0ffee' },
  record: traderMeta(),
  figures: TRADER_FIGURES,
  okx: null,
  mapping: [
    { coin: 'BTC', venue: 'binance', symbol: 'BTCUSDT' },
    { coin: 'HYPE', venue: 'bitget', symbol: 'HYPEUSDT' }
  ],
  unmapped: ['kPEPE'],
  skill: SKILL,
  delay: DELAY,
  clone: CLONE,
  problems: ['Binance answered 451 for kPEPEUSDT']
}
const OKX_ANALYSIS = {
  ...TRADER_ANALYSIS,
  key: 'okx-35E22983F436F55B',
  ref: (OKX_META as { ref: unknown }).ref,
  record: OKX_META,
  figures: { ...TRADER_FIGURES, leverage: null, reportedLeverage: { median: 10, max: 20, trips: 200 }, open: { positions: [], unrealized: 0, accountValue: null } },
  okx: {
    positions: 230,
    notPriced: 3,
    reportedPnl: 1520.4,
    estimate: { gross: 1700, fees: 150.2, funding: -20.5, net: 1529.3, fundingUnknown: 2 },
    open: { atMs: TRADER_MS, positions: [position('ETH', 2, { type: 'cross', value: 10 })], hidden: 2, unrealized: 33.3 },
    series: [
      { timeMs: TRADER_MS - 300 * 86_400_000, pnl: -50, pnlRatio: null },
      { timeMs: TRADER_MS - 150 * 86_400_000, pnl: 400, pnlRatio: null },
      { timeMs: TRADER_MS, pnl: 1520.4, pnlRatio: null }
    ],
    stats: { winRatio: 0.61, profitDays: 200, lossDays: 120, investAmt: 50_000, avgSubPosNotional: 1200, curCopyTraderPnl: null }
  },
  problems: []
}
const FILE_ANALYSIS = {
  ...TRADER_ANALYSIS,
  key: 'file-0123456789abcdef',
  ref: (FILE_META as { ref: unknown }).ref,
  record: FILE_META,
  figures: { ...TRADER_FIGURES, leverage: null, drawdown: { usdc: 300, pctOfAccount: null }, holdMin: { p10: 3000, median: 4000, p90: 9000, max: 9500 }, ledger: { deposits: 0, withdrawals: 0 }, open: { positions: [], unrealized: 0, accountValue: null } },
  skill: { ...SKILL, verdict: 'TOO FEW', trips: 12, tradingDays: 5, spanDays: 9.5, pShift: null, pFlip: null },
  delay: { ...DELAY, trips: 0, rows: [] },
  clone: null,
  problems: []
}
const BITGET = { at: TRADER_MS / 1000, configured: true, accountMode: 'uta', modeProblem: null, followerRead: { ok: true, endpoint: '/api/v2/copy/mix-follower/query-traders', traders: [{ id: 'b1a2', name: 'Ace' }, { id: 'c3d4', name: null }] } }
const FOLLOW_STAMP = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ traderKey: `hyperliquid-${HL_ID}`, positionId: 'BTC', coin: 'BTC', venue: 'binance', symbol: 'BTCUSDT', side: 'long', leaderSize: 0.5, size: 0.01, avgPx: 100_000, maxStakeQuote: 1000, legs: [], realizedQuote: 0, feesQuote: 0.5, openedOnKey: 'k', openedAtMs: TRADER_MS, delaySec: 45, maxHoldSec: 240_000, closeReason: null, ...over })
const bookTrade = (id: string, stamp: Record<string, unknown>, closed: boolean): Record<string, unknown> => ({
  id,
  type: 'position',
  mode: 'paper',
  exchange: 'binance',
  symbol: stamp.symbol,
  createdAt: TRADER_MS / 1000,
  status: closed ? 'stopped' : 'active',
  params: {},
  book: { id: 'copy', startedAt: TRADER_MS / 1000 - 3600, ledger: 'follow', ...(closed ? { result: { netQuote: 12.5, netPct: 1.25, feesQuote: 1, fundingQuote: -0.2, closedAt: TRADER_MS / 1000 + 600 } } : {}) },
  ...('signalKey' in stamp ? { clone: stamp } : { follow: stamp })
})
const CLONE_STAMP = { traderKey: `hyperliquid-${HL_ID}`, coin: 'HYPE', venue: 'bitget', symbol: 'HYPEUSDT', side: 'short', signalKey: 's', openedAtMs: TRADER_MS, entryPx: 40, qty: 25, stakeQuote: 1000, holdSec: 7200, feesQuote: 0.5, closeReason: null }
const HELD = {
  copy: {
    follows: { [`hyperliquid-${HL_ID}`]: { since: TRADER_MS - 3_600_000, maxHoldSec: 240_000 }, 'okx-35E22983F436F55B': { since: TRADER_MS - 3_600_000, maxHoldSec: 86_400 } },
    clones: { [`hyperliquid-${HL_ID}`]: { since: TRADER_MS - 3_600_000, rule: CLONE.rule, coins: [{ coin: 'HYPE', venue: 'bitget', symbol: 'HYPEUSDT' }] } }
  },
  executors: [bookTrade('f1', FOLLOW_STAMP(), false), bookTrade('f2', FOLLOW_STAMP({ delaySec: 30 }), true), bookTrade('c1', CLONE_STAMP, false), bookTrade('c2', CLONE_STAMP, true)],
  running: false,
  stakeShare: 0.1
}
const FOLLOW_STATUS = { key: `hyperliquid-${HL_ID}`, venue: 'hyperliquid', mode: 'stream', since: TRADER_MS - 3_600_000, lastReadMs: TRADER_MS, missedReads: 0, lost: false, hidden: false, eventsToday: 14 }
const COPY_MISSES = [
  { v: 'miss-v1', at: TRADER_MS / 1000, book: 'copy', writer: 'follow', pair: 'BTCUSDT', side: 'up', refPrice: 100_000, stage: 'off', reason: 'the copy book is not running', predictionId: null, shadow: false },
  { v: 'miss-v1', at: TRADER_MS / 1000, book: 'copy', writer: 'clone', pair: 'HYPEUSDT', side: 'down', refPrice: 40, stage: 'late', reason: '121 s after its close was read', predictionId: null, shadow: false }
]

describe('Copy Traders with a record in it, in every language (V8 Stage 8)', () => {
  it('reads each from its catalog, with no English in what is read but what a venue, a file or a verdict holds as written', async () => {
    const { TraderCards, TradersOnFile, PasteNote, SkillView, DelayView, CloneView, BitgetCheckView } = await import('../src/traders/CopyTradersPage')
    const { PaperCopyView } = await import('../src/traders/PaperCopyPanel')
    const { traderRefOf } = await import('../shared/traders/traderRef')
    const none = (): undefined => undefined
    const cards = (meta: unknown, analysis: unknown): ReactElement => createElement(TraderCards, { meta, analysis, analysed: 7 } as never)
    const skill = (over: Record<string, unknown>, medianHoldMin: number | null = null): ReactElement => createElement(SkillView, { skill: { ...SKILL, ...over }, analysed: 1, medianHoldMin } as never)
    const clone = (over: Record<string, unknown>): ReactElement => createElement(CloneView, { clone: { ...CLONE, ...over } } as never)
    const rule = (side: string, ...conditions: Record<string, unknown>[]): Record<string, unknown> => ({ rule: { side, conditions, holdBars: 3 } })
    const bitget = (check: unknown, busy = false, problem: string | null = null): ReactElement => createElement(BitgetCheckView, { check, busy, problem, onAsk: none } as never)
    const panel = (over: Record<string, unknown>): ReactElement =>
      createElement(PaperCopyView, { meta: traderMeta(), analysis: TRADER_ANALYSIS, held: HELD, status: FOLLOW_STATUS, misses: COPY_MISSES, busy: false, problem: null, onFollow: none, onClone: none, ...over } as never)
    const views: { name: string; element: ReactElement }[] = [
      { name: 'a Hyperliquid trader', element: cards(traderMeta(), TRADER_ANALYSIS) },
      { name: 'an OKX lead trader', element: cards(OKX_META, OKX_ANALYSIS) },
      { name: "an OKX lead trader's year without its figures", element: cards({ ...OKX_META, capped: true }, { ...OKX_ANALYSIS, okx: { ...OKX_ANALYSIS.okx, notPriced: 0, open: null, series: [], stats: { winRatio: null, profitDays: null, lossDays: null, investAmt: null, avgSubPosNotional: null, curCopyTraderPnl: null } } }) },
      { name: 'a file of round trips', element: cards(FILE_META, FILE_ANALYSIS) },
      { name: 'a file of fills, one row refused', element: cards(FILE_META, { ...FILE_ANALYSIS, record: { ...FILE_META, fileKind: 'fills', fileRefused: { count: 1, reasons: [] } }, skill: null, delay: null, figures: { ...FILE_ANALYSIS.figures, span: null, winRate: null, holdMin: null, stake: null } }) },
      { name: 'the traders on file', element: createElement(TradersOnFile, { list: { traders: [{ meta: traderMeta(), latest: TRADER_ANALYSIS }, { meta: OKX_META, latest: null }, { meta: FILE_META, latest: FILE_ANALYSIS }], analysed: 3 }, open: `hyperliquid-${HL_ID}`, busy: false, onOpen: none, onAgain: none } as never) },
      { name: 'one trader on file', element: createElement(TradersOnFile, { list: { traders: [{ meta: traderMeta({ records: 1 }), latest: null }], analysed: 1 }, open: null, busy: true, onOpen: none, onAgain: none } as never) },
      { name: 'a pasted address', element: createElement(PasteNote, { parsed: traderRefOf(HL_ID) }) },
      { name: "a pasted lead trader's code", element: createElement(PasteNote, { parsed: traderRefOf('35E22983F436F55B') }) },
      ...['', 'x'.repeat(501), 'not a trader', 'ftp://okx.com/a', 'https://www.bitget.com/copy-trading/trader/x', 'https://www.binance.com/en/copy-trading', 'https://www.bybit.com/copyTrade', 'https://x.com/someone/status/1', 'https://app.hyperliquid.xyz/trade', 'https://www.okx.com/copy-trading', 'https://example.com/trader'].map((paste) => ({
        name: `a refused paste: ${paste.slice(0, 40)}`,
        element: createElement(PasteNote, { parsed: traderRefOf(paste) })
      })),
      { name: 'skill', element: skill({ verdict: 'SKILL', reasons: [], pShift: 0.005, pFlip: 0.002, interval: { low: 0.01, high: 0.05 }, halvesPct: [0.03, 0.01] }, 12) },
      { name: 'market or luck, nothing measured', element: skill({ pShift: null, pFlip: null, interval: null, halvesPct: null, edgePct: null, withoutBars: 0, betaOfOne: 0 }) },
      { name: 'too few', element: skill({ verdict: 'TOO FEW', trips: 3, tradingDays: 2, spanDays: 1.5, pShift: null, pFlip: null }) },
      { name: 'the delay, nothing copied', element: createElement(DelayView, { analysis: { ...TRADER_ANALYSIS, delay: { ...DELAY, trips: 0, rows: [] } } } as never) },
      { name: 'the delay, every cost known', element: createElement(DelayView, { analysis: { ...TRADER_ANALYSIS, delay: { ...DELAY, noVenue: 0, impactAssumed: [], fundingAssumed: 0 } } } as never) },
      { name: 'partly, a long rule', element: clone({ verdict: 'PARTLY', ...rule('long', condition('ret4h', '<=', -0.04), condition('rangePos24h', '>=', 0.8)), outOfTime: { ...CLONE.outOfTime, interval: { low: 0.55, high: 0.7 } }, trades: { ...CLONE.trades, n: 12, interval: null } }) },
      { name: 'not replicable', element: clone({ verdict: 'NOT REPLICABLE', ...rule('short', condition('ret1h', '>=', 0.01), condition('ret24h', '<=', -0.05)), outOfTime: { ...CLONE.outOfTime, interval: null }, trades: { ...CLONE.trades, interval: null } }) },
      { name: 'not replicable, its net at 0', element: clone({ verdict: 'NOT REPLICABLE', ...rule('long', condition('volRatio', '>=', 1.4), condition('fromMean24h', '<=', -0.02)), outOfTime: { ...CLONE.outOfTime, interval: { low: 0.5, high: 0.62 } }, trades: { ...CLONE.trades, interval: { low: -0.05, high: 0.1 } } }) },
      { name: "Bitcoin's moves", element: clone(rule('short', condition('btcRet1h', '<=', -0.01), condition('btcRet24h', '>=', 0.03))) },
      { name: "the coin's day and the hour", element: clone({ ...rule('long', condition('relRet24h', '>=', 0.02), condition('hourUtc', '<=', 6.5)), withoutFeatures: 0, outOfTime: { ...CLONE.outOfTime, interval: null }, trades: { ...CLONE.trades, meanNetPct: null, interval: null } }) },
      { name: 'too few to fit', element: clone({ verdict: 'TOO FEW', reasons: ['no side has 10 entries in the first two thirds to fit a rule on'], rule: null, training: null, outOfTime: null, trades: null }) },
      { name: 'too few to test', element: clone({ verdict: 'TOO FEW', reasons: ['14 long entries in the last third, under 30'], outOfTime: null, trades: null }) },
      { name: 'too few to test, short', element: clone({ verdict: 'TOO FEW', reasons: ['3 short entries in the last third, under 30'], outOfTime: null, trades: null }) },
      { name: 'too few, its reason not read again', element: clone({ verdict: 'TOO FEW', reasons: ['a reason of another version'], outOfTime: null, trades: null }) },
      { name: 'no clone', element: createElement(CloneView, { clone: null }) },
      { name: 'the Bitget check, not asked', element: bitget(null) },
      { name: 'the Bitget check, asking', element: bitget(null, true) },
      { name: 'the Bitget check, failed', element: bitget(null, false, 'Bitget did not answer') },
      { name: 'the Bitget check, no key', element: bitget({ ...BITGET, configured: false, accountMode: null, followerRead: null }) },
      { name: 'the Bitget check, two traders', element: bitget(BITGET) },
      { name: 'the Bitget check, no trader', element: bitget({ ...BITGET, accountMode: 'classic', followerRead: { ...BITGET.followerRead, traders: [] } }) },
      { name: 'the Bitget check, refused', element: bitget({ ...BITGET, accountMode: 'unknown', modeProblem: 'mode not given', followerRead: { ok: false, endpoint: '/x', code: '40014', message: 'Incorrect permissions' } }) },
      { name: 'the Bitget check, nothing read', element: bitget({ ...BITGET, accountMode: null, followerRead: { ok: false, endpoint: '/x', code: null, message: 'timeout' } }) },
      { name: 'on paper, reading', element: panel({ held: null, status: null, misses: [] }) },
      { name: 'on paper, following and cloning, the books stopped', element: panel({}) },
      { name: 'on paper, the follow lost and polled', element: panel({ status: { ...FOLLOW_STATUS, mode: 'poll', lost: true, eventsToday: 1 }, held: { ...HELD, running: true } }) },
      { name: 'on paper, followable', element: panel({ analysis: { ...TRADER_ANALYSIS, delay: { ...DELAY, rows: [delayRow(2, 1, true)] } } }) },
      { name: 'on paper, no delay to read it at', element: panel({ analysis: { ...TRADER_ANALYSIS, delay: null } }) },
      { name: 'on paper, an OKX trader hiding', element: panel({ meta: OKX_META, status: { ...FOLLOW_STATUS, key: 'okx-35E22983F436F55B', venue: 'okx', mode: 'poll', hidden: true }, problem: 'OKX answered 50011' }) },
      { name: 'on paper, nothing switched on', element: panel({ held: { ...HELD, copy: { follows: {}, clones: {} }, executors: [] }, status: null, misses: [] }) },
      { name: 'on paper, a file', element: panel({ meta: FILE_META, analysis: null, status: null }) }
    ]
    for (const language of LANGUAGES) {
      for (const { name, element } of views) {
        clearMissedKeys()
        const html = await render(element, language)
        expect({ language, name, rendered: html.length > 50 }).toEqual({ language, name, rendered: true })
        if (language === 'en') continue
        expect({ language, name, missed: missedKeys(language) }).toEqual({ language, name, missed: [] })
        expect({ language, name, english: englishIn(language, textInLanguage(html, language)) }).toEqual({ language, name, english: [] })
      }
    }
  }, 120_000)
})

describe("the forecast's cards on the book the window holds", () => {
  it("decide on it where the window holds one, and show the pass's decision where it holds none", async () => {
    const { BestPredictionCard } = await import('../src/forecast/BestPredictionCard')
    const { PredictionDrawer } = await import('../src/forecast/PredictionDrawer')
    const none = (): undefined => undefined
    const neutral: PricePrediction = { ...PREDICTION, barTime: Math.floor(Date.now() / 1000) - 60, horizons: { ...PREDICTION.horizons, hour1: rangeOf([-1.5, -0.2, 0.1, 0.4, 2.9], { direction: 'NEUTRAL' }) } }
    const atPass: TradeDecision = { ...NO_TRADE, reasons: [NO_TRADE.reasons[0], { code: 'STALE_PRICE', text: '', values: {} }], classKey: null, classVerdict: null }
    // Read a minute from now, so that no clock the render reads finds it old.
    const live = { ...emptyLiveState(), books: { SOLUSDT: { symbol: 'SOLUSDT', bid: 179.99, bidQty: 10, ask: 180.01, askQty: 10, updatedAt: Date.now() + 60_000, source: 'stream' as const } } }
    const ranked = { ...RANKED, decision: atPass }
    const stale = 'There is no live price newer than ten seconds.'
    for (const [name, element, said] of [
      ['the card, the window holding no book', createElement(BestPredictionCard, { prediction: neutral, ranked, live: null, onDetails: none }), true],
      ['the card, the window holding a fresh one', createElement(BestPredictionCard, { prediction: neutral, ranked, live, onDetails: none }), false],
      ['the drawer, the window holding no book', createElement(PredictionDrawer, { prediction: neutral, decision: atPass, live: null, onClose: none }), true],
      ['the drawer, the window holding a fresh one', createElement(PredictionDrawer, { prediction: neutral, decision: atPass, live, onClose: none }), false]
    ] as const) {
      const html = await render(element, 'en')
      expect({ name, calls: html.includes('The 1-hour forecast calls no way.'), stale: html.includes(stale) }).toEqual({ name, calls: true, stale: said })
    }
  }, 60_000)
})

// NO ENGLISH WRITTEN INTO A TRANSLATED PAGE (§111): the components the translated surfaces show, followed
// from each through every component it renders outside <EnglishOnly>, carry no English of their own --
// no JSX text, no shown attribute, no sentence -- except what is English by design, listed here.

const WALK_ROOTS: readonly [string, string][] = [
  ['src/App.tsx', 'App'],
  ['src/components/Sidebar.tsx', 'Sidebar'],
  ['src/home/HomePage.tsx', 'HomePage'],
  ['src/forecast/PredictionsPage.tsx', 'PredictionsPage'],
  ['src/opportunities/OpportunitiesPage.tsx', 'OpportunitiesPage'],
  ['src/positions/PositionsPage.tsx', 'PositionsPage'],
  ['src/performance/PerformancePage.tsx', 'PerformancePage'],
  ['src/settings/SettingsPanel.tsx', 'SettingsPanel'],
  ['src/executors/NewExecutorModal.tsx', 'NewExecutorModal']
]

/** What stays English on a translated page, and why: each component's English, by the start of each text. */
const ENGLISH_BY_DESIGN: Readonly<Record<string, { why: string; texts: readonly string[] }>> = {
  'src/components/Sidebar.tsx#Sidebar': { why: "the app's name", texts: ['TraderSpider'] },
  // News URLs (V8 Stage 5): the form a link is written in, and the host a pasted link is sent to when the Archive is asked.
  'src/articles/NewsUrlsPage.tsx#NewsUrlsPage': { why: "a link's own form, and the Internet Archive's host", texts: ['https://…', 'web.archive.org'] },
  'src/articles/NewsUrlsPage.tsx#OwnView': { why: "the prediction record's own reason, kept in English as every record's is", texts: ['My own view on '] },
  'src/livetrading/LiveOrderScheduler.tsx#LiveOrderScheduler': {
    why: "an executor's own record of what went wrong, shown only on Strategies › Execution",
    texts: ['filled, but no open ', ' position was found to arm an exit watcher against']
  },
  'src/executors/NewExecutorModal.tsx#ExecutorFormModal': {
    why: "the live words of the expert executor types -- DCA, TWAP, Grid and Order -- whose forms are English; a trade plan opens a Position",
    texts: [
      'Live Trading — places a real ladder of resting orders',
      'Live Trading — places a real series of market buy orders over time',
      'Live Trading — places a real bounded ladder of resting orders',
      'Live Trading — places a real order with real money',
      'Live trading only supports market and limit orders so far.',
      'Set a limit price first.',
      'Live DCA is buy-only',
      'Live TWAP is buy-only',
      'Live Grid is buy-only',
      'This will place ',
      ' on Binance, one per level',
      ' minutes — the first fires immediately',
      "This is NOT full Grid",
      ' configured levels closest to the current price',
      ' each. Once any level fills',
      '% from the SHARED average fill',
      'This will place a real resting LIMIT ',
      ' — it may not fill immediately',
      'This will immediately place a real ',
      ' market order for ',
      'The largest level',
      'Each slice',
      'The per-level amount',
      ' exceeds the configured max live order size ('
    ]
  }
}

const NOT_SHOWN = new Set(['style', 'className', 'key', 'id', 'href', 'src', 'type', 'role', 'value', 'dir', 'lang', 'name', 'htmlFor', 'target', 'rel', 'inputMode', 'autoComplete', 'fill', 'stroke', 'viewBox', 'd', 'width', 'height', 'strokeWidth', 'step', 'min', 'max', 'pattern', 'accept', 'tabIndex', 'page', 'anchor', 'view', 'tone', 'variant', 'size', 'kind', 'align', 'side', 'mode', 'where'])
const SHOWN_ARIA = new Set(['aria-label', 'aria-description', 'aria-valuetext', 'aria-roledescription'])
const SENTENCE = /[A-Z][a-z]+[ ,’'][ ]?[A-Za-z]|[a-z]{2,} [a-z]{2,} [a-z]{2,}/
const CSS_VALUE = /var\(--|\d(px|rem|em|ms|s)\b|rgba?\(|^#[0-9a-f]{3,8}$|solid|dashed|ease|cubic-bezier|sans-serif|monospace/i
const QUIET_CALLS = new Set(['t', 'msg', 'error', 'warn', 'log', 'info', 'debug', 'Error', 'invoke', 'querySelector', 'getElementById', 'addEventListener', 'removeEventListener', 'setItem', 'getItem', 'removeItem', 'matchMedia'])

interface WalkFinding {
  where: string
  text: string
}

function walkTranslatedSurfaces(): { findings: WalkFinding[]; walked: Set<string> } {
  const sources = new Map<string, ts.SourceFile>()
  const sourceOf = (file: string): ts.SourceFile => {
    let source = sources.get(file)
    if (source === undefined) {
      source = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf-8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      sources.set(file, source)
    }
    return source
  }
  const resolve = (from: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null
    const parts = [...from.split('/').slice(0, -1)]
    for (const part of spec.split('/')) {
      if (part === '..') parts.pop()
      else if (part !== '.') parts.push(part)
    }
    const base = parts.join('/')
    for (const candidate of [`${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
      try {
        readFileSync(join(ROOT, candidate))
        return candidate
      } catch {
        // not this one
      }
    }
    return null
  }
  const definitions = (source: ts.SourceFile): Map<string, ts.Node> => {
    const out = new Map<string, ts.Node>()
    for (const statement of source.statements) {
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined) out.set(statement.name.text, statement)
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const init = declaration.initializer
          if (ts.isIdentifier(declaration.name) && init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isCallExpression(init))) out.set(declaration.name.text, declaration)
        }
      }
    }
    return out
  }
  const importsOf = (source: ts.SourceFile): Map<string, [string, string]> => {
    const out = new Map<string, [string, string]>()
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || statement.importClause === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const target = resolve(source.fileName, statement.moduleSpecifier.text)
      if (target === null) continue
      const clause = statement.importClause
      if (clause.name !== undefined) out.set(clause.name.text, [target, 'default'])
      if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) out.set(element.name.text, [target, (element.propertyName ?? element.name).text])
    }
    return out
  }
  const definitionIn = (file: string, name: string, depth = 0): [string, string] | null => {
    const source = sourceOf(file)
    if (definitions(source).has(name)) return [file, name]
    if (depth > 3) return null
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier) || statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) continue
      for (const element of statement.exportClause.elements) {
        if (element.name.text !== name) continue
        const target = resolve(file, statement.moduleSpecifier.text)
        if (target !== null) return definitionIn(target, (element.propertyName ?? element.name).text, depth + 1)
      }
    }
    return null
  }
  const quietParent = (node: ts.Node): boolean => {
    for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
      if (ts.isCallExpression(at) || ts.isNewExpression(at)) {
        const callee = at.expression
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
        if (QUIET_CALLS.has(name)) return true
      }
      if (ts.isJsxAttribute(at) && at.name.getText() === 'style') return true
      if (ts.isImportDeclaration(at) || ts.isExportDeclaration(at) || ts.isTypeNode(at)) return true
    }
    return false
  }

  const findings: WalkFinding[] = []
  const walked = new Set<string>()
  const queue: [string, string][] = [...WALK_ROOTS]
  while (queue.length > 0) {
    const [file, name] = queue.shift()!
    const id = `${file}#${name}`
    if (walked.has(id)) continue
    walked.add(id)
    const source = sourceOf(file)
    const locals = definitions(source)
    const definition = locals.get(name)
    if (definition === undefined) continue
    const imports = importsOf(source)
    const follow = (tag: string): void => {
      if (locals.has(tag) && tag !== name) queue.push([file, tag])
      else if (imports.has(tag)) {
        const [target, exported] = imports.get(tag)!
        const found = definitionIn(target, exported)
        if (found !== null && found[0].startsWith('src/') && found[0] !== 'src/i18n/I18nProvider.tsx') queue.push(found)
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'EnglishOnly') return
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && /^[A-Z]/.test(node.tagName.getText())) follow(node.tagName.getText().split('.')[0])
      if (ts.isIdentifier(node) && /^[A-Z]/.test(node.text) && !ts.isJsxOpeningElement(node.parent) && !ts.isJsxSelfClosingElement(node.parent) && !ts.isJsxClosingElement(node.parent)) follow(node.text)
      if (ts.isIdentifier(node) && locals.has(node.text) && node.text !== name && ts.isCallExpression(node.parent) && node.parent.expression === node) queue.push([file, node.text])
      if (ts.isJsxText(node)) {
        const text = node.text.trim()
        if (/[A-Za-z]{2,}/.test(text)) findings.push({ where: id, text })
      } else if (ts.isJsxAttribute(node) && node.initializer !== undefined) {
        const attribute = node.name.getText()
        const init = node.initializer
        const literal = ts.isStringLiteral(init) ? init : ts.isJsxExpression(init) && init.expression !== undefined && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression)) ? init.expression : null
        if (literal !== null) {
          const shown = !NOT_SHOWN.has(attribute) && !attribute.startsWith('data-') && (!attribute.startsWith('aria-') || SHOWN_ARIA.has(attribute))
          if (shown && /[A-Za-z]{2,}/.test(literal.text) && !CSS_VALUE.test(literal.text)) findings.push({ where: id, text: literal.text })
          return
        }
      } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        const parent = node.parent
        const aName = (ts.isPropertyAssignment(parent) && parent.name === node) || ts.isLiteralTypeNode(parent) || (ts.isElementAccessExpression(parent) && parent.argumentExpression === node)
        const compared = ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(parent.operatorToken.kind)
        if (!ts.isJsxAttribute(parent) && !aName && !compared && SENTENCE.test(node.text) && !CSS_VALUE.test(node.text) && !quietParent(node)) findings.push({ where: id, text: node.text })
      }
      ts.forEachChild(node, visit)
    }
    visit(definition)
  }
  return { findings, walked }
}

describe('no English written into a translated page', () => {
  const { findings, walked } = walkTranslatedSurfaces()

  it('follows each translated surface through what it shows', () => {
    for (const id of ['src/forecast/BestPredictionCard.tsx#BestPredictionCard', 'src/forecast/PredictionDrawer.tsx#PredictionDrawer', 'src/agents/OpportunityTableCard.tsx#OpportunityTableCard', 'src/positions/HeldPositionRow.tsx#HeldPositionRow', 'src/executors/PositionForm.tsx#PositionForm', 'src/components/SymbolSearch.tsx#SymbolSearch', 'src/settings/NotificationsCard.tsx#NotificationsCard', 'src/news/AlertBanner.tsx#AlertBanner', 'src/sound/NoticeSounds.tsx#NoticeSounds', 'src/components/ErrorBoundary.tsx#ErrorBoundary']) {
      expect({ id, walked: walked.has(id) }).toEqual({ id, walked: true })
    }
    // An English-only card is not followed: the portfolio's history, under the summary on Performance.
    expect(walked.has('src/portfolio/PortfolioSections.tsx#PortfolioHistory')).toBe(false)
    expect(walked.size).toBeGreaterThan(120)
  })

  it('finds no English but what is English by design', () => {
    const unexpected = findings.filter(({ where, text }) => !(ENGLISH_BY_DESIGN[where]?.texts.some((start) => text.startsWith(start)) ?? false))
    expect(unexpected).toEqual([])
  })

  it('lists nothing English by design that is no longer there', () => {
    for (const [where, { texts }] of Object.entries(ENGLISH_BY_DESIGN)) {
      for (const start of texts) expect({ where, start, there: findings.some((finding) => finding.where === where && finding.text.startsWith(start)) }).toEqual({ where, start, there: true })
    }
  })

  it('lays them out by the sides of reading, not left and right, so Arabic mirrors them (§85)', () => {
    const files = [...new Set([...walked].map((id) => id.split('#')[0]))]
    const PHYSICAL = /\b(marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight|borderTopLeftRadius|borderTopRightRadius|borderBottomLeftRadius|borderBottomRightRadius)\s*:|\b(left|right)\s*:\s*['\d-]|textAlign:\s*'(left|right)'|float:\s*'(left|right)'/
    for (const file of files) {
      const lines = readFileSync(join(ROOT, file), 'utf-8').split('\n')
      const physical = lines.map((line, at) => ({ line: at + 1, text: line.trim() })).filter(({ text }) => !text.startsWith('//') && !text.startsWith('*') && PHYSICAL.test(text))
      expect({ file, physical }).toEqual({ file, physical: [] })
    }
  })
})
