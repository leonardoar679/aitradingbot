import { describe, expect, it } from 'vitest'
import { CHART_PALETTE } from '../src/theme/palette'
import type { Trade } from '../src/backtest/engine'
import {
  formatSignalPrice,
  formatSignedPct,
  openPositionBand,
  outcomeColor,
  positionBand,
  tradeBands,
  signalSummary,
  tradeMarkers,
  tradePriceLines,
  withAlpha
} from '../src/backtest/tradeOverlay'

const palette = CHART_PALETTE.dark

function trade(over: Partial<Trade> = {}): Trade {
  return {
    side: 'long',
    entryTime: Date.UTC(2026, 5, 12, 14, 45) / 1000,
    exitTime: Date.UTC(2026, 5, 17, 19, 30) / 1000,
    entryPrice: 63_214.12,
    exitPrice: 65_900.5,
    qty: 0.158,
    pnl: 424.5,
    returnPct: 4.25,
    exitReason: 'signal',
    ...over
  }
}

describe('formatSignalPrice', () => {
  it('drops cents on a four-figure price and keeps them on a small one', () => {
    // The same panel shows BTC near $63,000 and DOGE near $0.06. Cents are noise on one and the
    // entire signal on the other.
    expect(formatSignalPrice(63_214.12)).toBe('63,214')
    expect(formatSignalPrice(12.3456)).toBe('12.35')
  })

  it('keeps a sub-dollar price distinguishable from its own exit', () => {
    const entry = formatSignalPrice(0.061234)
    const exit = formatSignalPrice(0.068901)
    expect(entry).toBe('0.0612')
    expect(exit).toBe('0.0689')
    expect(entry).not.toBe(exit)
  })

  it('does not round a very small price away to zero', () => {
    expect(formatSignalPrice(0.00000812)).toBe('0.00000812')
  })

  it('is empty rather than "NaN" for an unusable price', () => {
    expect(formatSignalPrice(NaN)).toBe('')
    expect(formatSignalPrice(Infinity)).toBe('')
  })
})

describe('formatSignedPct', () => {
  it('always carries a sign so a return cannot read as a price', () => {
    expect(formatSignedPct(4.25)).toBe('+4.25%')
    expect(formatSignedPct(-1.8)).toBe('-1.80%')
    expect(formatSignedPct(0)).toBe('+0.00%')
  })

  it('never prints -0.00%', () => {
    expect(formatSignedPct(-0.001)).toBe('+0.00%')
  })

  it('is empty for an unusable number', () => {
    expect(formatSignedPct(NaN)).toBe('')
  })
})

describe('withAlpha', () => {
  it('turns a palette hex into a translucent rgba', () => {
    expect(withAlpha('#26a69a', 0.1)).toBe('rgba(38, 166, 154, 0.1)')
  })

  it('expands shorthand hex', () => {
    expect(withAlpha('#abc', 0.5)).toBe('rgba(170, 187, 204, 0.5)')
  })

  it('clamps alpha into range instead of emitting an invalid colour', () => {
    expect(withAlpha('#000000', 5)).toBe('rgba(0, 0, 0, 1)')
    expect(withAlpha('#000000', -1)).toBe('rgba(0, 0, 0, 0)')
  })

  it('leaves a non-hex colour alone', () => {
    expect(withAlpha('rgba(1, 2, 3, 0.4)', 0.1)).toBe('rgba(1, 2, 3, 0.4)')
  })

  it('handles every colour the chart palettes actually use', () => {
    for (const p of Object.values(CHART_PALETTE)) {
      for (const key of ['up', 'down', 'accent', 'gold'] as const) {
        expect(withAlpha(p[key], 0.1)).toMatch(/^rgba\(\d+, \d+, \d+, 0\.1\)$/)
      }
    }
  })
})

describe('outcomeColor', () => {
  it('is green for a winner and red for a loser, with break-even counted as green', () => {
    expect(outcomeColor(trade({ returnPct: 4.25 }), palette)).toBe(palette.up)
    expect(outcomeColor(trade({ returnPct: -1.5 }), palette)).toBe(palette.down)
    expect(outcomeColor(trade({ returnPct: 0 }), palette)).toBe(palette.up)
  })
})

describe('tradeMarkers', () => {
  it('points the entry arrow into the trade and the exit arrow out of it', () => {
    const [entry, exit] = tradeMarkers(trade(), palette)
    expect(entry.shape).toBe('arrowUp')
    expect(entry.position).toBe('belowBar')
    expect(exit.shape).toBe('arrowDown')
    expect(exit.position).toBe('aboveBar')
  })

  it('mirrors both arrows for a short', () => {
    const [entry, exit] = tradeMarkers(trade({ side: 'short' }), palette)
    expect(entry.shape).toBe('arrowDown')
    expect(entry.position).toBe('aboveBar')
    expect(exit.shape).toBe('arrowUp')
    expect(exit.position).toBe('belowBar')
  })

  it('colours the open by accent and the close by outcome', () => {
    // The point of the scheme: a short's opening SELL and a long's losing closing SELL are both
    // sells, and must not be the same colour, or red stops meaning "lost money".
    const shortEntry = tradeMarkers(trade({ side: 'short' }), palette)[0]
    const losingExit = tradeMarkers(trade({ returnPct: -2 }), palette)[1]
    expect(shortEntry.color).toBe(palette.accent)
    expect(losingExit.color).toBe(palette.down)
    expect(shortEntry.color).not.toBe(losingExit.color)
  })

  it('colours a winning close green whichever side it was', () => {
    expect(tradeMarkers(trade({ returnPct: 3 }), palette)[1].color).toBe(palette.up)
    expect(tradeMarkers(trade({ side: 'short', returnPct: 3 }), palette)[1].color).toBe(palette.up)
  })

  it('names the action and the fill price on each arrow', () => {
    const [entry, exit] = tradeMarkers(trade(), palette)
    expect(entry.text).toBe('BUY 63,214')
    expect(exit.text).toBe('SELL 65,901 · +4.25%')
  })

  it('says SELL to open and BUY to close on a short', () => {
    const [entry, exit] = tradeMarkers(trade({ side: 'short', returnPct: -1.25 }), palette)
    expect(entry.text).toBe('SELL 63,214')
    expect(exit.text).toBe('BUY 65,901 · -1.25%')
  })

  it('sits the markers at the trade times, in order', () => {
    const t = trade()
    const [entry, exit] = tradeMarkers(t, palette)
    expect(entry.time).toBe(t.entryTime)
    expect(exit.time).toBe(t.exitTime)
    expect(Number(entry.time)).toBeLessThan(Number(exit.time))
  })

  it('enlarges both arrows above the default marker size', () => {
    for (const marker of tradeMarkers(trade(), palette)) expect(marker.size).toBeGreaterThan(1)
  })
})

describe('tradePriceLines', () => {
  it('rules both fills, labelled with the action and the result', () => {
    const [entry, exit] = tradePriceLines(trade(), palette)
    expect(entry.price).toBe(63_214.12)
    expect(entry.title).toBe('BUY')
    expect(entry.color).toBe(palette.accent)
    expect(exit.price).toBe(65_900.5)
    expect(exit.title).toBe('SELL +4.25%')
    expect(exit.color).toBe(palette.up)
  })

  it('flips the labels for a short', () => {
    const [entry, exit] = tradePriceLines(trade({ side: 'short', returnPct: -3 }), palette)
    expect(entry.title).toBe('SELL')
    expect(exit.title).toBe('BUY -3.00%')
    expect(exit.color).toBe(palette.down)
  })

  it('draws nothing rather than a line at NaN', () => {
    // createPriceLine with a non-finite price puts a line at the top of the pane with a blank axis
    // label, which reads as a real level the trade never touched.
    expect(tradePriceLines(trade({ exitPrice: NaN }), palette)).toEqual([])
    expect(tradePriceLines(trade({ entryPrice: Infinity }), palette)).toEqual([])
  })
})

describe('positionBand', () => {
  it('spans exactly the time the position was open', () => {
    const t = trade()
    const band = positionBand(t, palette)!
    expect(band.from).toBe(t.entryTime)
    expect(band.to).toBe(t.exitTime)
  })

  it('stays ordered even if the stamps arrive reversed', () => {
    const band = positionBand(trade({ entryTime: 200, exitTime: 100 }), palette)!
    expect(band.from).toBe(100)
    expect(band.to).toBe(200)
  })

  it('tints by outcome and stays translucent enough to see candles through', () => {
    const won = positionBand(trade({ returnPct: 4.25 }), palette)!
    const lost = positionBand(trade({ returnPct: -4.25 }), palette)!
    expect(won.fill).toBe(withAlpha(palette.up, 0.1))
    expect(lost.fill).toBe(withAlpha(palette.down, 0.1))
    // A band that hides the price action defeats the purpose of drawing it.
    expect(Number(/([\d.]+)\)$/.exec(won.fill)![1])).toBeLessThan(0.25)
  })

  it('draws its edges more strongly than its fill, so entry and exit read as boundaries', () => {
    const band = positionBand(trade(), palette)!
    expect(Number(/([\d.]+)\)$/.exec(band.border)![1])).toBeGreaterThan(
      Number(/([\d.]+)\)$/.exec(band.fill)![1])
    )
  })

  it('is null for an unusable timestamp instead of a band at the origin', () => {
    expect(positionBand(trade({ exitTime: NaN }), palette)).toBeNull()
  })
})

describe('tradeBands', () => {
  it('bands every trade it is given, in order', () => {
    const trades = [trade({ entryTime: 100, exitTime: 200 }), trade({ entryTime: 300, exitTime: 400 })]
    expect(tradeBands(trades, palette).map((b) => [b.from, b.to])).toEqual([
      [100, 200],
      [300, 400]
    ])
  })

  it('drops a band it cannot place instead of returning a hole in the array', () => {
    // The bot chart pushes an open-position band onto this result, so a null in the middle would
    // reach the renderer rather than being skipped at the call site.
    const bands = tradeBands([trade(), trade({ exitTime: NaN }), trade()], palette)
    expect(bands).toHaveLength(2)
    expect(bands.every((b) => b !== null)).toBe(true)
  })

  it('is empty for no trades', () => {
    expect(tradeBands([], palette)).toEqual([])
  })

  it('keeps winners and losers visually apart within one set', () => {
    const [won, lost] = tradeBands([trade({ returnPct: 2 }), trade({ returnPct: -2 })], palette)
    expect(won.fill).not.toBe(lost.fill)
  })
})

describe('openPositionBand', () => {
  it('runs from the entry to the newest candle', () => {
    const band = openPositionBand(100, 900, palette)!
    expect(band.from).toBe(100)
    expect(band.to).toBe(900)
  })

  it('is accent, not green or red', () => {
    // An open position has no result. Tinting it by unrealised P&L would put the same green on a
    // banked win and on a paper gain the position can still give back.
    const band = openPositionBand(100, 900, palette)!
    expect(band.fill).toBe(withAlpha(palette.accent, 0.1))
    expect(band.fill).not.toBe(withAlpha(palette.up, 0.1))
    expect(band.fill).not.toBe(withAlpha(palette.down, 0.1))
  })

  it('survives an entry on the newest candle', () => {
    // A bot that just opened has entryTime === the last candle, which must draw, not vanish.
    expect(openPositionBand(900, 900, palette)).not.toBeNull()
  })

  it('is null when the newest candle predates the entry', () => {
    // Happens while a shorter refetch is in flight; a band running backwards is not a drawing bug
    // worth rendering.
    expect(openPositionBand(900, 100, palette)).toBeNull()
    expect(openPositionBand(NaN, 900, palette)).toBeNull()
  })
})

describe('signalSummary', () => {
  it('reads as the sentence the chart caption needs', () => {
    const s = signalSummary(trade())
    expect(s).toEqual({
      entryAction: 'BUY',
      entryPrice: '63,214',
      exitAction: 'SELL',
      exitPrice: '65,901',
      resultPct: '+4.25%',
      won: true
    })
  })

  it('reverses the actions for a short and marks a loss', () => {
    const s = signalSummary(trade({ side: 'short', returnPct: -2.5 }))
    expect(s.entryAction).toBe('SELL')
    expect(s.exitAction).toBe('BUY')
    expect(s.won).toBe(false)
  })

  it('agrees with the markers about what happened', () => {
    // The caption and the arrows are built by different functions and sit on the same screen; a
    // caption saying BUY over an arrow saying SELL is the failure this guards.
    const t = trade({ side: 'short' })
    const s = signalSummary(t)
    const [entry, exit] = tradeMarkers(t, palette)
    expect(entry.text).toContain(s.entryAction)
    expect(entry.text).toContain(s.entryPrice)
    expect(exit.text).toContain(s.exitAction)
    expect(exit.text).toContain(s.resultPct)
  })
})
