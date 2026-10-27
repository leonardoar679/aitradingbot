import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CallLines } from '../src/calls/CallLines'
import { PrimaryCallCard } from '../src/calls/PrimaryCallCard'
import { cardLabel, liveCheckText, noCardText, pairWords, refusalText, sizeSpanText, sourcesText, utcText } from '../src/calls/callText'
import { DELISTING_STUDY } from '../shared/delistingStudy'
import { PRIMARY_CALL_VERSION, delistingCardOf, type PrimaryCallState, type PrimaryCard, type RefusalCode } from '../shared/forecast/primaryCall'
import type { PricePrediction } from '../shared/forecast/prediction'

// THE PRIMARY CALL ON SCREEN (src/calls; V8 Stage 3): the card's words and figures, the no-opportunity state with why,
// the measured size and where calls come from, and every coin's line; in English here, every language in tests/i18n.test.ts
// (V8 Stage 5).

const RELEASE = 1_793_030_430
const card = delistingCardOf({
  candidate: { articleId: 4242, title: 'Binance Will Delist ABC on 2026-11-02', releaseSec: RELEASE, ticker: 'ABC', pair: 'ABCUSDT' },
  nowSec: RELEASE + 60,
  livePrice: 2,
  gate: { ok: true, trip: { venue: 'binance', feePct: 0.1, spreadPct: 0.3, impactPct: 0.2, totalPct: 0.7, basis: 'book' }, depthQuote: 5000 },
  stakeQuote: 100,
  study: DELISTING_STUDY,
  live: { hours: 2, coins: 2, meanPct: 11, low: 5, high: 16, state: 'ok' },
  predictionId: 'delisting-rule:ABCUSDT:1793030430'
}) as PrimaryCard

const base: PrimaryCallState = { v: PRIMARY_CALL_VERSION, at: RELEASE + 60, cards: [], late: [], refused: [], delistLive: null, readerOn: true, modelSources: 0 }
const forecast = (pair: string, half: number, rate: number): PricePrediction =>
  ({
    pair,
    horizons: { hours4: { quantilesPct: [-half, -half / 2, 0, half / 2, half] }, hour1: { quantilesPct: [-1, -0.5, 0, 0.5, 1] } },
    moveRates: { version: 'v', fromSec: 0, toSec: 0, days: 90, horizons: [{ horizon: 'hours4', moments: 2000, close: [{ pct: 2, up: rate / 2, down: rate / 2, either: rate }], touch: [] }] }
  }) as unknown as PricePrediction

describe('the words', () => {
  it('say the call, its sign and its price plainly', () => {
    // Its figures in the language's own form (V8 Stage 5): English writes a minus as a hyphen.
    expect(cardLabel(card)).toMatch(/^BEARISH -15\.\d\d%$/)
    expect(cardLabel({ side: 'up', movePct: 1.2 })).toBe('BULLISH +1.20%')
    expect(pairWords('ABCUSDT')).toBe('ABC/USDT')
    expect(utcText(RELEASE)).toBe('16:00 UTC')
  })
  it('give every refusal a reason, and the cost not measured where no book holds the stake', () => {
    const codes: RefusalCode[] = ['late', 'withdrawn', 'no-price', 'no-pair', 'no-book', 'stale-book', 'cannot-hold', 'thin', 'cost-share', 'under-lines', 'no-evidence']
    for (const code of codes) expect(refusalText(code).length, code).toBeGreaterThan(20)
    expect(refusalText('no-book')).toMatch(/^Cost not measured/)
    expect(refusalText('no-pair')).toMatch(/decentralised exchange/)
  })
  it('say where calls come from, and that the reader is off when it is', () => {
    expect(sourcesText({ readerOn: true, modelSources: 0 })).toMatch(/read every minute/)
    expect(sourcesText({ readerOn: false, modelSources: 0 })).toMatch(/the reader is off/)
    expect(sourcesText({ readerOn: true, modelSources: 0 })).toMatch(/No direction model has cleared/)
    expect(noCardText({ refused: [], late: [] })).toBe('No measured source calls a way for any coin now.')
    expect(noCardText({ refused: [{ refused: 'thin', source: 'delisting-rule', pair: 'ABCUSDT', eventAt: RELEASE, expectedNet: null }], late: [] })).toMatch(/^ABC\/USDT: The book is too thin/)
    // A coin late for the rule is said on its own line: the reason given is the first other refusal, else the late one.
    const lateOne = { refused: 'late' as const, source: 'delisting-rule', pair: 'LATEUSDT', eventAt: RELEASE, expectedNet: null }
    expect(noCardText({ refused: [lateOne, { refused: 'no-book', source: 'delisting-rule', pair: 'ABCUSDT', eventAt: RELEASE, expectedNet: null }], late: [] })).toMatch(/^ABC\/USDT: Cost not measured/)
    expect(noCardText({ refused: [lateOne], late: [] })).toMatch(/^LATE\/USDT: Late for the rule/)
    expect(liveCheckText(null)).toBeNull()
    expect(liveCheckText({ hours: 0, coins: 0, meanPct: null, low: null, high: null, state: 'ok' })).toMatch(/no delisting since 1 October/)
    expect(liveCheckText({ hours: 6, coins: 9, meanPct: -3, low: -5, high: -1, state: 'withdrawn' })).toBe("The rule's live check since 1 October: 9 coins in 6 announcement hours, -3.00% on hourly means. The card is withdrawn.")
    expect(liveCheckText({ hours: 12, coins: 15, meanPct: 6, low: 2, high: 9, state: 'weaker' })).toMatch(/It is weaker than its study\.$/)
    expect(liveCheckText({ hours: 3, coins: 4, meanPct: null, low: null, high: null, state: 'ok' })).toBe("The rule's live check since 1 October: 4 coins in 3 announcement hours.")
  })
  it('give the measured size from the smallest to the largest likely move at four hours', () => {
    expect(sizeSpanText([forecast('BTCUSDT', 1.2, 0.1), forecast('PEPEUSDT', 3.4, 0.4)])).toMatch(/about ±1\.2% \(BTC\/USDT\) to ±3\.4% \(PEPE\/USDT\)/)
    expect(sizeSpanText([])).toBeNull()
  })
})

describe('the card', () => {
  const render = (state: PrimaryCallState | null, predictions: PricePrediction[] = []): string => renderToStaticMarkup(createElement(PrimaryCallCard, { state, predictions, livePrice: 1.98 }))
  it('shows the best card with every part the V8 document asks for', () => {
    const html = render({ ...base, cards: [card] })
    for (const part of ['ABC/USDT', 'BEARISH', 'Target and window', 'Arrival', 'Risk scenarios', 'Costs', 'Net at the target', 'Expected net', 'Why', 'What you can do', 'paper only', card.predictionId, 'now $1.98', 'a sell of $100']) {
      expect(html, part).toContain(part)
    }
    expect(html).not.toContain('No profitable opportunity identified')
  })
  it('says No profitable opportunity identified, with why, the size and where calls come from', () => {
    const html = render(
      { ...base, late: [{ pair: 'ABCUSDT', ticker: 'ABC', eventAt: RELEASE, exitAt: RELEASE + 14_400, movedSincePct: -6 }], refused: [{ refused: 'late', source: 'delisting-rule', pair: 'ABCUSDT', eventAt: RELEASE, expectedNet: null }] },
      [forecast('BTCUSDT', 1.2, 0.1)]
    )
    expect(html).toContain('No profitable opportunity identified')
    expect(html).toContain('Late for the rule')
    expect(html).toContain('it has moved -6.00% since')
    expect(html).toContain('likely to move about ±1.2%')
    expect(html).toContain('A card comes only from a measured source')
  })
  it('waits before its first answer', () => {
    expect(render(null)).toContain('Weighing the sources')
  })
})

describe("every coin's line", () => {
  it('puts the cards first, then the coins by how often they moved that much', () => {
    const predictions = new Map([
      ['BTCUSDT', forecast('BTCUSDT', 1.2, 0.1)],
      ['PEPEUSDT', forecast('PEPEUSDT', 3.4, 0.4)]
    ])
    const html = renderToStaticMarkup(createElement(CallLines, { state: { ...base, cards: [card] }, predictions, pairs: ['BTCUSDT', 'PEPEUSDT'], onOpen: () => undefined }))
    const at = (text: string): number => html.indexOf(text)
    expect(at('ABC/USDT')).toBeGreaterThan(-1)
    expect(at('ABC/USDT')).toBeLessThan(at('PEPE/USDT'))
    expect(at('PEPE/USDT')).toBeLessThan(at('BTC/USDT'))
    expect(html).toContain('40% of four-hour spans')
    expect(html).toContain('No measured source calls its way.')
    expect(html).toContain('none')
  })
})
