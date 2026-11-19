import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { accuracyBoardOf, addToTally, boardEntryOf, emptyTally, type BoardDay } from '../shared/evaluation/accuracyBoard'
import type { OutcomeLine } from '../shared/forecast/forecastRecord'
import { AccuracyBoardView } from '../src/performance/AccuracyBoardCard'
import { PerformanceTileView } from '../src/home/HomeTiles'

// HOW THE FORECAST DID (src/performance/AccuracyBoardCard.tsx; V10 Stage 2), drawn in English: the way it pointed on the
// rises and the falls apart, the real size against the expected, the range, the latest forecasts one by one; and Home's
// tile with the forecast's line. tests/i18n.test.ts draws the translated ones.

const DAY = 86_400
const T0 = 1_795_000_000 - (1_795_000_000 % DAY)
const draw = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element).replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')

function outcome(move: number, over: Partial<OutcomeLine> = {}): OutcomeLine {
  return { v: 'forecast-record-v1', id: 'x', pair: 'BTCUSDT', h: 'hours24', t: T0, due: T0 + DAY, at: T0 + DAY, move, best: 0, worst: 0, below: move >= 0 ? '00011' : '00111', v1below: '', in80: true, in50: true, up: move > 0, dir: 'NEUTRAL', pUp: 0.5, cell: 'pooled', cls: 'btc', errors: [], mid: -1.7, size: 4, ...over }
}

/** Two days of the seven-day run's lean: every 24-hour middle below no move. */
function leaningBoard() {
  const days: BoardDay[] = [0, 1].map((d) => {
    const tally = emptyTally()
    for (let k = 0; k < 12; k++) addToTally(tally, outcome(k < 9 ? -3 : 3, { size: 4 }))
    return { day: T0 + d * DAY, h: 'hours24', tally }
  })
  const recent = [boardEntryOf(outcome(-2.8, { size: 3.1, pair: 'ETHUSDT', at: T0 + DAY + 60 })), boardEntryOf(outcome(5, { in80: false, h: 'hours4', pair: 'SOLUSDT', at: T0 + DAY }))]
  return accuracyBoardOf(days, recent, ['hours4', 'hours24'], T0 + 2 * DAY)
}

describe('how the forecast did', () => {
  it('shows the way pointed on the rises and the falls apart, the size against the real moves, the range, and each forecast checked', () => {
    const html = draw(createElement(AccuracyBoardView, { board: leaningBoard(), span: 'month', onSpan: () => undefined }))
    expect(html).toContain('How the forecast did')
    expect(html).toContain('a forecast that always points one way is right on every move one way and on none the other')
    for (const head of ['Checked', 'Points a way', 'Right when it rose', 'Right when it fell', 'Real move against expected', 'Inside the 80% range']) expect(html).toContain(head)
    // The lean shows at once: right on none of the rises, every fall.
    expect(html).toContain('>0% (0% to 0%)<')
    expect(html).toContain('>100% (100% to 100%)<')
    expect(html.indexOf('>0% (0% to 0%)<')).toBeLessThan(html.indexOf('>100% (100% to 100%)<'))
    // The real moves came to three quarters of the size expected.
    expect(html).toContain('>0.75× (0.75× to 0.75×)<')
    expect(html).toContain('The app called no way, UP or DOWN, in these days')
    expect(html).toContain('ETHUSDT</bdi> · 24 hours · expected ±3.10%, moved -2.80%, inside the 80% range, way not called')
    expect(html).toContain('SOLUSDT</bdi> · 4 hours · expected ±4.00%, moved +5.00%, outside the 80% range, way not called')
  })

  it('says when nothing is checked yet, and when the days before are still being read', () => {
    expect(draw(createElement(AccuracyBoardView, { board: null, span: 'month', onSpan: () => undefined }))).toContain('Reading the record…')
    const empty = accuracyBoardOf([], [], ['hours24'], null)
    expect(draw(createElement(AccuracyBoardView, { board: empty, span: 'month', onSpan: () => undefined }))).toContain('Nothing checked yet')
    expect(draw(createElement(AccuracyBoardView, { board: { ...empty, filling: true }, span: 'month', onSpan: () => undefined }))).toContain('Reading the days before from the record…')
  })

  it("puts the forecast's size and range on Home's tile", () => {
    const html = draw(createElement(PerformanceTileView, { rows: [], board: leaningBoard(), onOpen: () => undefined }))
    expect(html).toContain('The forecast at 24 hours: real moves 0.75× the size it expected, 100% inside its 80% range')
  })
})
