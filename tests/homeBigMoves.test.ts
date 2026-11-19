import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PricePrediction } from '../shared/forecast/prediction'
import type { PrimaryCallState } from '../shared/forecast/primaryCall'
import { expectedMove } from '../shared/forecast/size'

// HOME'S BIG MOVERS AND BITCOIN TODAY (V9 Stage 1, 6 November 2026; src/forecast/BigMoversCard.tsx,
// src/home/BitcoinTodayTile.tsx). Home lists the coins most likely to move 2% within four hours and 5% within a day, each
// with how soon such a move came when it came, and a way only where a measured source's card calls one; Bitcoin's day
// says its move since the open and its big days over the last 90 as a frequency of the past, never a chance or a way.

vi.mock('electron', () => ({}))

async function render(element: ReactElement): Promise<string> {
  const { I18nProvider } = await import('../src/i18n/I18nProvider')
  const { ThemeProvider } = await import('../src/theme/ThemeContext')
  const html = renderToStaticMarkup(createElement(ThemeProvider, null, createElement(I18nProvider, { language: 'en' }, element)))
  return html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

const rates = (either: number, minutes4: number, minutes24: number): PricePrediction['moveRates'] => ({
  version: 'v',
  fromSec: 0,
  toSec: 0,
  days: 90,
  horizons: [
    { horizon: 'hours4', moments: 2000, close: [{ pct: 2, up: either / 2, down: either / 2, either }], touch: [{ pct: 2, up: 0.2, down: 0.2, either: 0.4, medianMinutes: minutes4 }] },
    { horizon: 'hours24', moments: 2000, close: [{ pct: 5, up: either / 2, down: either / 2, either }], touch: [{ pct: 5, up: 0.2, down: 0.2, either: 0.4, medianMinutes: minutes24 }] }
  ]
})

const prediction = (pair: string, either: number): PricePrediction => ({ pair, currentPrice: 100, horizons: {}, moveRates: rates(either, 95, 400) }) as unknown as PricePrediction

describe("Home's big movers", () => {
  it('ranks by the 90-day rate, says how soon the move came at each size, and gives a way only from a card', async () => {
    const { BigMoversView } = await import('../src/forecast/BigMoversCard')
    const calls = { cards: [{ pair: 'PEPEUSDT', side: 'down', source: 'delisting-rule' }] } as unknown as PrimaryCallState
    const html = await render(createElement(BigMoversView, { predictions: [prediction('SOLUSDT', 0.2), prediction('PEPEUSDT', 0.4)], onOpen: () => undefined, horizons: ['hours4', 'hours24'], times: true, calls }))
    // Four hours and a day only; the more often first.
    expect(html).toContain('2% or more within four hours')
    expect(html).toContain('5% or more within a day')
    expect(html).not.toContain('within an hour')
    expect(html.indexOf('PEPE')).toBeLessThan(html.indexOf('SOL'))
    expect(html).toContain('When it moved 2% within four hours, the first touch came after 1.6 h (median).')
    expect(html).toContain('When it moved 5% within a day, the first touch came after 6.7 h (median).')
    // A way from the card's source, for its coin alone; none said unknown while one is shown.
    expect(html.match(/Down, by The delisting rule/g)?.length).toBe(2)
    expect(html).not.toContain('Which way is unknown')
    // No card: the way is said unknown, once.
    const none = await render(createElement(BigMoversView, { predictions: [prediction('SOLUSDT', 0.2)], onOpen: () => undefined, horizons: ['hours4', 'hours24'], times: true, calls: { cards: [] } as unknown as PrimaryCallState }))
    expect(none.match(/Which way is unknown/g)?.length).toBe(1)
    expect(none).not.toContain('Down, by')
    // On Predictions: all three horizons, no times, no way line.
    const plain = await render(createElement(BigMoversView, { predictions: [prediction('SOLUSDT', 0.2)], onOpen: () => undefined }))
    expect(plain).not.toContain('first touch')
    expect(plain).not.toContain('Which way is unknown')
  })

  it("says each coin's expected move either way at the list's horizon, where its forecast has one (V10 Stage 2)", async () => {
    const { BigMoversView } = await import('../src/forecast/BigMoversCard')
    const sol = { ...prediction('SOLUSDT', 0.2), horizons: { hours4: { quantilesPct: [-3, -1.5, 0, 1.5, 3] } } } as unknown as PricePrediction
    const html = await render(createElement(BigMoversView, { predictions: [sol, prediction('PEPEUSDT', 0.4)], onOpen: () => undefined, horizons: ['hours4', 'hours24'], times: true, calls: { cards: [] } as unknown as PrimaryCallState }))
    expect(html).toContain(`Expected move ±${expectedMove([-3, -1.5, 0, 1.5, 3]).toFixed(2)}% within four hours`)
    // Only where the coin's forecast has the horizon: none at a day here, none for PEPE.
    expect(html.match(/Expected move/g)?.length).toBe(1)
  })
})

describe('Bitcoin today', () => {
  it("says the day's move and the last 90 days' big days as a frequency of the past, and no way", async () => {
    const { BitcoinTodayCard } = await import('../src/home/BitcoinTodayTile')
    const view = { at: 1_793_900_000, today: { day: 1_793_836_800, open: 80_000, high: 81_000, low: 79_000, last: 80_800, lastSec: 1_793_900_000, movePct: 1 }, bigDays: { days: 90, close2: 27, close4: 8, fall4: 9 } }
    const html = await render(createElement(BitcoinTodayCard, { view, marketState: 'PRE_EVENT' }))
    expect(html).toContain('+1.00% since the 00:00 UTC open')
    expect(html).toContain('In the last 90 days, Bitcoin closed 2% or more from its open on 27 days and 4% or more on 8, and fell 4% below its open at some point on 9.')
    expect(html).toContain('Market now: before a scheduled release')
    expect(html).toContain("Which way: unknown. No measured source calls Bitcoin's way now.")
    expect(html).toContain('not a chance for today')
    // Nothing read yet: the way and the note still said, no figures.
    const empty = await render(createElement(BitcoinTodayCard, { view: null, marketState: null }))
    expect(empty).not.toContain('since the 00:00 UTC open')
    expect(empty).toContain('Which way: unknown')
  })
})
