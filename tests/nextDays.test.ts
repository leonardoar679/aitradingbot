import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DailyForecastView } from '../shared/forecast/daily/dailyRecord'
import { accuracyBoardOf, addToTally, emptyTally } from '../shared/evaluation/accuracyBoard'

// THE NEXT DAYS (src/forecast/NextDaysCard.tsx, src/home/BitcoinTodayTile.tsx; V10 Stage 4), drawn in English: each coin's
// expected move and 80% range over one, three and seven days, the largest movers first, the way said unknown; Bitcoin's
// on Home; and the daily horizons on the accuracy board.

vi.mock('electron', () => ({}))

async function render(element: ReactElement): Promise<string> {
  const { I18nProvider } = await import('../src/i18n/I18nProvider')
  const { ThemeProvider } = await import('../src/theme/ThemeContext')
  const html = renderToStaticMarkup(createElement(ThemeProvider, null, createElement(I18nProvider, { language: 'en' }, element)))
  return html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

const DAY = 86_400
const T0 = Date.UTC(2026, 10, 19) / 1000
const levels = (half: number): { q: number[]; size: number } => ({ q: [-half, -half / 2, 0, half / 2, half], size: half * 0.6 })
const view: DailyForecastView = {
  day: T0,
  at: T0 + 600,
  rows: [
    { pair: 'BTCUSDT', price: 64_000, h: { day1: levels(3), days3: levels(5), days7: levels(8) } },
    { pair: 'PEPEUSDT', price: 0.00001, h: { day1: levels(9), days3: levels(15), days7: levels(24) } }
  ],
  problem: null
}

describe('the next days', () => {
  it("lists each coin's expected move and 80% range over one, three and seven days, the largest first, and no way", async () => {
    const { NextDaysView } = await import('../src/forecast/NextDaysCard')
    const html = await render(createElement(NextDaysView, { view, onOpen: () => undefined }))
    expect(html).toContain('The next days')
    for (const head of ['1 day', '3 days', '7 days']) expect(html).toContain(head)
    expect(html.indexOf('PEPE/USDT')).toBeLessThan(html.indexOf('BTC/USDT'))
    expect(html).toContain('±4.80%')
    expect(html).toContain('-8.00% to +8.00%')
    expect(html).toContain('Which way is unknown: the test of a way over these days failed.')
    expect(html).toContain('Made 19 Nov 00:10 UTC')
    const empty = await render(createElement(NextDaysView, { view: { day: null, at: null, rows: [], problem: null }, onOpen: () => undefined }))
    expect(empty).toContain('No daily forecast yet')
  })

  it("says Bitcoin's expected move over the coming days on Home, where the daily forecast has one", async () => {
    const { BitcoinTodayCard } = await import('../src/home/BitcoinTodayTile')
    const html = await render(createElement(BitcoinTodayCard, { view: null, marketState: null, daily: view }))
    expect(html).toContain("Expected move either way from today's open: ±1.80% in a day, ±3.00% in three, ±4.80% in seven.")
    expect(await render(createElement(BitcoinTodayCard, { view: null, marketState: null }))).not.toContain('Expected move either way')
  })

  it('reads the daily horizons on the accuracy board by name', async () => {
    const { AccuracyBoardView } = await import('../src/performance/AccuracyBoardCard')
    const tally = emptyTally()
    addToTally(tally, { move: 2, below: '00011', in80: true, mid: 0, size: 3 })
    const board = accuracyBoardOf([{ day: T0 - DAY, h: 'days3', tally }], [], ['hours24', 'days3'], T0)
    const html = await render(createElement(AccuracyBoardView, { board, span: 'month', onSpan: () => undefined }))
    expect(html).toContain('>3 days<')
  })
})
