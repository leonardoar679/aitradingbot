import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { sourceFiguresRows, type SourceOutcome, type SourcePrediction } from '../shared/evaluation/predictionRecord'
import type { BookRunReport } from '../shared/paperBooksReport'
import type { PaperTestingState } from '../shared/paperTesting'
import { ENGLISH } from '../shared/i18n/translate'
import { CameTrueView, moveText, shareText } from '../src/performance/CameTrueCard'
import { BooksReportView, benchmarkText, verdictText } from '../src/performance/BooksReportCard'
import { ChampionView } from '../src/performance/ChampionCard'
import { PerformanceTileView, PortfolioTileView } from '../src/home/HomeTiles'
import { DayMovesView } from '../src/forecastLab/DayMovesCard'

// STAGE 10'S CARDS, DRAWN (V8 Stage 10): Performance's "Did it come true?", the books against their benchmarks and the
// champion; Home's tiles; the Forecast Lab's day moves. In English here: tests/i18n.test.ts draws the translated ones in
// every language.

const draw = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element)
const figure = (value: number, low: number, high: number) => ({ value, low, high, sd: 1 })

describe('the record by source', () => {
  it('is a line a source and kind, its scored and owed counted, in the order the sources first predicted', () => {
    const prediction = (id: string, source: string, kind: 'direction' | 'size', madeAt: number) => ({ id, source, kind, madeAt, unit: Math.floor(madeAt / 86_400), side: kind === 'size' ? null : 'down', movePct: 2, cost: null }) as unknown as SourcePrediction
    const outcome = (id: string, right: boolean | null) => ({ id, status: 'settled', right, netPct: right ? 1 : -1, sizeErrorPct: 0.5, touched: right }) as unknown as SourceOutcome
    const rows = sourceFiguresRows([
      { prediction: prediction('a', 'user', 'direction', 200), outcome: outcome('a', true) },
      { prediction: prediction('b', 'delisting-rule', 'direction', 100), outcome: outcome('b', false) },
      { prediction: prediction('c', 'user', 'direction', 300), outcome: null },
      { prediction: prediction('d', 'big-movers', 'size', 400), outcome: outcome('d', null) }
    ])
    expect(rows.map((row) => [row.source, row.kind, row.total, row.owed, row.figures.n])).toEqual([
      ['delisting-rule', 'direction', 1, 0, 1],
      ['user', 'direction', 2, 1, 1],
      ['big-movers', 'size', 1, 0, 1]
    ])
  })
})

describe("Performance's cards", () => {
  it('"Did it come true?" says each figure with its interval, the side of a size call not at all', () => {
    expect(shareText(figure(0.62, 0.48, 0.75), ENGLISH)).toBe('62% (48% to 75%)')
    expect(shareText(figure(0.5, Number.NaN, Number.NaN), ENGLISH)).toBe('50%')
    expect(moveText(figure(1.234, -0.5, 2), ENGLISH)).toBe('+1.23% (-0.50% to +2.00%)')
    expect(shareText(null, ENGLISH)).toBe('—')
    const rows = [
      { source: 'delisting-rule', kind: 'direction' as const, total: 4, owed: 1, firstAt: 1, lastAt: 2, figures: { n: 3, units: 2, missing: 0, right: figure(0.67, 0.2, 1), net: figure(5, -1, 9), sizeError: null, touched: null } },
      { source: 'big-movers', kind: 'size' as const, total: 15, owed: 15, firstAt: 3, lastAt: 3, figures: { n: 0, units: 0, missing: 0, right: null, net: null, sizeError: null, touched: null } }
    ]
    const html = draw(createElement(CameTrueView, { rows }))
    expect(html).toContain('The delisting rule · side and size')
    expect(html).toContain('3 of 4')
    expect(html).toContain('The big-mover list · size alone')
    expect(draw(createElement(CameTrueView, { rows: [] }))).toContain('Nothing recorded yet')
  })

  const report = (over: Partial<BookRunReport> = {}): BookRunReport => ({
    book: 'news',
    startedAt: 1_793_000_000,
    endedAt: 1_793_086_400,
    running: true,
    trades: 3,
    events: 2,
    open: 1,
    meanPct: figure(1.5, -0.5, 3),
    meanR: figure(0.25, -0.1, 0.6),
    equityReturnPct: 0.4,
    benchmark: { kind: 'cash', pct: 0, difference: figure(1.5, -0.5, 3), compared: 3, notCompared: 0 },
    btcPct: -2.1,
    noVenue: 2,
    profitable: 'too few',
    better: 'too few',
    ...over
  })

  it('the books against their benchmarks say each benchmark and verdict as registered, and too few short of the counts', () => {
    expect(benchmarkText(report(), ENGLISH)).toBe('cash: 0%')
    expect(benchmarkText(report({ book: 'copy', benchmark: { kind: 'leader', pct: 4.2, difference: null, compared: 1, notCompared: 0 } }), ENGLISH)).toBe("the leaders' own trades: +4.20% on 1 follow")
    expect(benchmarkText(report({ book: 'copy', benchmark: { kind: 'leader', pct: null, difference: null, compared: 0, notCompared: 2 } }), ENGLISH)).toBe("the leaders' own trades: none compared yet")
    expect(benchmarkText(report({ book: 'baseline', benchmark: { kind: 'hold', pct: -1.5, difference: null, compared: 2, notCompared: 0 } }), ENGLISH)).toBe('holding the eight symbols: -1.50%')
    expect(verdictText(report(), ENGLISH)).toBe('too few to call: 3 of 30 closed trades, 2 of 10 events')
    expect(verdictText(report({ trades: 40, events: 12, profitable: 'yes', better: 'no' }), ENGLISH)).toBe('profitable; not shown better than its benchmark')
    const html = draw(createElement(BooksReportView, { report: { startedAt: 1_793_000_000, running: true, reports: [report(), report({ book: 'copy', noVenue: 0, benchmark: { kind: 'leader', pct: null, difference: null, compared: 0, notCompared: 2 } })] } }))
    expect(html).toContain('+0.25R (-0.10R to +0.60R)')
    expect(html).toContain('Bitcoin moved -2.10% over it: context, never a benchmark.')
    expect(html).toContain('2 trades no venue could take, counted apart and called nothing.')
    expect(html).toContain('2 follows not set against their leader')
    expect(draw(createElement(BooksReportView, { report: { startedAt: null, running: false, reports: [] } }))).toContain('Paper testing has not been started')
  })

  it('the champion card says the run in use, the last challenge and a shadow week', () => {
    const html = draw(
      createElement(ChampionView, {
        training: {
          current: { runId: 'run-20261101-0030', fittedAt: 1_793_000_000, foldsRunId: null },
          challenge: null,
          shadow: { runId: 'run-20261102-0030', since: 1_793_100_000, until: 1_793_700_000, championRunId: 'run-20261101-0030', summary: 'within noise' },
          shadowVerdict: null
        } as never
      })
    )
    expect(html).toContain('In use: run-20261101-0030')
    expect(html).toContain('No refit has challenged it yet.')
    expect(html).toContain('In its shadow week: run-20261102-0030')
  })
})

describe("Home's tiles", () => {
  it('say how the scored calls came out, a line a source with a side, on the rises and the falls apart', () => {
    const rows = [
      { source: 'delisting-rule', kind: 'direction' as const, total: 4, owed: 0, firstAt: 1, lastAt: 2, figures: { n: 4, units: 2, missing: 0, right: figure(0.75, 0.3, 1), net: null, sizeError: null, touched: null, rightOnRising: figure(1, 1, 1), rightOnFalling: figure(0.5, 0, 1), balanced: figure(0.75, 0.5, 1) } },
      { source: 'big-movers', kind: 'size' as const, total: 9, owed: 0, firstAt: 1, lastAt: 2, figures: { n: 9, units: 3, missing: 0, right: null, net: null, sizeError: null, touched: figure(0.4, 0.2, 0.6) } }
    ]
    const html = draw(createElement(PerformanceTileView, { rows, onOpen: () => undefined }))
    expect(html).toContain('The delisting rule: right on 100% of the rises and 50% of the falls, 4 scored')
    expect(html).not.toContain('big-mover')
    expect(draw(createElement(PerformanceTileView, { rows: [], onOpen: () => undefined }))).toContain('No call has been scored yet')
  })

  it("show the books' starting money and Start before a run, and each book's money during one", () => {
    const state = { running: false, startedAt: null, started: null, standings: [], switches: {}, tagShort: false, reader: {}, follows: 0, clones: 0 } as unknown as PaperTestingState
    const before = draw(createElement(PortfolioTileView, { state, onStart: () => undefined, onOpen: () => undefined }))
    expect(before).toContain('Starting balance $10,000 a book · Not yet running')
    expect(before).toContain('Start paper testing')
    const standing = (id: 'news' | 'copy' | 'baseline', equity: number | null) => ({ id, startQuote: 10_000, realizedQuote: 0, unrealizedQuote: 0, settledEquity: 10_000, equity, open: 0, openStakeQuote: 0, closed: 0, dayStartEquity: 10_000 })
    const during = draw(createElement(PortfolioTileView, { state: { ...state, running: true, standings: [standing('news', 10_012.5), standing('copy', null), standing('baseline', 9_990)] }, onStart: () => undefined, onOpen: () => undefined }))
    expect(during).toContain('$10,012.50')
    expect(during).toContain('$10,000.00')
    expect(during).toContain('Open Paper Trading')
  })
})

describe("the Forecast Lab's day moves", () => {
  it('list the pairs that most often moved 10% in a day, with 5% beside it', () => {
    const html = draw(createElement(DayMovesView, { moves: { at: 1, sizes: [5, 10], rows: [{ pair: 'DOGEUSDT', moments: 2136, rates: { 5: 0.31, 10: 0.072 } }] } }))
    expect(html).toContain('Moves of 5% and 10% in a day')
    expect(html).toContain('DOGE/USDT')
    expect(html).toContain('31.0%')
    expect(html).toContain('7.2%')
    expect(html).toContain('2,136')
    expect(draw(createElement(DayMovesView, { moves: { at: 1, sizes: [5, 10], rows: [] } }))).toContain('No pair has thirty days of bars on file yet.')
  })
})
