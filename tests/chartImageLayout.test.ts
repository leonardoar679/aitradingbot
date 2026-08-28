import { describe, expect, it } from 'vitest'
import {
  imageCaption,
  imageLayout,
  labelledTrades,
  statCells,
  type ImageLayout
} from '../src/backtest/chartImageLayout'
import type { BacktestResult, Trade } from '../src/backtest/engine'
import type { ResultsGeneralInfo } from '../src/backtest/BacktestResultsView'

const OPTS = { chartWidth: 1360, priceHeight: 560, equityHeight: 300 }

function trade(over: Partial<Trade> = {}): Trade {
  return {
    side: 'long',
    entryTime: 1_760_000_000,
    exitTime: 1_760_400_000,
    entryPrice: 100,
    exitPrice: 110,
    qty: 1,
    pnl: 10,
    returnPct: 10,
    exitReason: 'signal',
    ...over
  }
}

function result(over: Partial<BacktestResult['stats']> = {}, trades: Trade[] = [trade()]): BacktestResult {
  return {
    equityCurve: [],
    benchmarkCurve: [],
    trades,
    monthlyBreakdown: [],
    openPositionAtEnd: null,
    stats: {
      totalClosedTrades: trades.length,
      totalNetProfit: 2611,
      totalNetProfitPct: 26.11,
      startingBalance: 10_000,
      finishingBalance: 12_611,
      openTrades: 0,
      totalPaidFees: 158.4,
      maxDrawdownPct: -19.93,
      winRatePct: 61.5,
      ...over
    } as BacktestResult['stats']
  } as BacktestResult
}

const info: ResultsGeneralInfo = {
  periodDays: 91,
  startDate: '2026-05-30',
  endDate: '2026-08-28',
  exchangeName: 'Binance',
  symbolLabel: 'BTC-USDT',
  intervalLabel: '4H',
  strategyLabel: 'Trend Regime Ensemble',
  splitDate: null,
  leverage: 1
}

// Overlap is the failure mode that matters: a chart drawn over its own heading, or a footer past
// the bottom edge, is invisible in code review and obvious only once someone opens the PNG.
function bottom(r: { y: number; height: number }): number {
  return r.y + r.height
}

describe('imageLayout', () => {
  const layout: ImageLayout = imageLayout(OPTS)

  it('pads the sheet equally either side of the charts', () => {
    expect(layout.width).toBeGreaterThan(OPTS.chartWidth)
    const padLeft = layout.price.x
    const padRight = layout.width - (layout.price.x + layout.price.width)
    expect(padLeft).toBe(padRight)
  })

  it('keeps the charts at the size they were rendered at', () => {
    expect(layout.price.width).toBe(OPTS.chartWidth)
    expect(layout.price.height).toBe(OPTS.priceHeight)
    expect(layout.equity.height).toBe(OPTS.equityHeight)
  })

  it('stacks title, stats, price chart, equity chart and footer without overlapping', () => {
    expect(layout.titleY).toBeLessThan(layout.subtitleY)
    expect(layout.subtitleY).toBeLessThan(layout.statsLabelY)
    expect(layout.statsLabelY).toBeLessThan(layout.statsValueY)
    expect(layout.statsValueY).toBeLessThanOrEqual(layout.rule1Y)
    expect(layout.rule1Y).toBeLessThan(layout.priceHeadingY)
    expect(layout.priceHeadingY).toBeLessThan(layout.price.y)
    expect(bottom(layout.price)).toBeLessThan(layout.equityHeadingY)
    expect(layout.equityHeadingY).toBeLessThan(layout.equity.y)
    expect(bottom(layout.equity)).toBeLessThan(layout.footerY)
  })

  it('leaves the footer inside the sheet', () => {
    expect(layout.footerY).toBeLessThan(layout.height)
  })

  it('grows the sheet when a chart grows, rather than clipping it', () => {
    const taller = imageLayout({ ...OPTS, priceHeight: OPTS.priceHeight + 200 })
    expect(taller.height).toBe(layout.height + 200)
    expect(bottom(taller.equity)).toBeLessThan(taller.footerY)
  })

  it('puts both rules on the content column, not the full sheet width', () => {
    expect(layout.statsX).toBe(layout.price.x)
    expect(layout.statsWidth).toBe(layout.price.width)
  })
})

describe('labelledTrades', () => {
  const NINETY_DAYS = 90 * 86_400
  const WIDTH = 1360
  const day = (n: number): number => 1_760_000_000 + n * 86_400
  const at = (from: number, to: number): { entryTime: number; exitTime: number } => ({
    entryTime: day(from),
    exitTime: day(to)
  })

  it('labels a lone trade however briefly it was held', () => {
    // Its entry and exit are drawn below and above the bar, so they cannot collide with each other.
    expect(labelledTrades([{ entryTime: day(10), exitTime: day(10) + 3600 }], NINETY_DAYS, WIDTH)).toEqual([true])
  })

  it('labels trades that are far enough apart', () => {
    expect(labelledTrades([at(0, 5), at(30, 35), at(60, 65)], NINETY_DAYS, WIDTH)).toEqual([true, true, true])
  })

  it('strips the text from a crowded trade only, not from the whole chart', () => {
    // The case that produced an unreadable smear: one isolated trade, then a cluster. The isolated
    // one has half the chart to itself and keeps its labels.
    expect(labelledTrades([at(0, 5), at(36, 38), at(39, 41), at(42, 44)], NINETY_DAYS, WIDTH)).toEqual([
      true,
      false,
      false,
      false
    ])
  })

  it('judges by the gap, not the number of trades', () => {
    // Four trades can be fine and four can be unreadable; only the spacing decides.
    const far = [0, 25, 50, 75].map((d) => at(d, d + 2))
    const near = [0, 4, 8, 12].map((d) => at(d, d + 2))
    expect(labelledTrades(far, NINETY_DAYS, WIDTH).every(Boolean)).toBe(true)
    expect(labelledTrades(near, NINETY_DAYS, WIDTH).some(Boolean)).toBe(false)
  })

  it('looks at both neighbours, so a trade tight against the next one is stripped too', () => {
    // Checking only the preceding gap would label the first of a tight pair and overlap it with
    // the second.
    expect(labelledTrades([at(0, 5), at(6, 8), at(60, 65)], NINETY_DAYS, WIDTH)).toEqual([false, false, true])
  })

  it('scales with the width the chart is actually drawn at', () => {
    const trades = [at(0, 2), at(12, 14)]
    expect(labelledTrades(trades, NINETY_DAYS, 400).some(Boolean)).toBe(false)
    expect(labelledTrades(trades, NINETY_DAYS, 4000).every(Boolean)).toBe(true)
  })

  it('has nothing to label when nothing traded', () => {
    expect(labelledTrades([], NINETY_DAYS, WIDTH)).toEqual([])
  })

  it('declines rather than dividing by zero on a degenerate window', () => {
    const trades = [at(0, 2), at(12, 14)]
    expect(labelledTrades(trades, 0, WIDTH)).toEqual([false, false])
    expect(labelledTrades(trades, NINETY_DAYS, 0)).toEqual([false, false])
  })
})

describe('statCells', () => {
  it('signs the return and formats money without cents', () => {
    const [net, final] = statCells(result(), 10_000)
    expect(net.value).toBe('+26.11%')
    expect(net.tone).toBe('gain')
    expect(final.value).toBe('$12,611')
  })

  it('marks a losing run in the loss tone', () => {
    const cells = statCells(result({ totalNetProfitPct: -8.4, finishingBalance: 9_160 }), 10_000)
    expect(cells[0].value).toBe('-8.40%')
    expect(cells[0].tone).toBe('loss')
    expect(cells[1].tone).toBe('loss')
  })

  it('shows a dash for win rate when nothing traded, not 0%', () => {
    // 0% reads as "lost every trade" when it means no trade was taken -- the same distinction the
    // comparison table makes with its no-trades row.
    const cells = statCells(result({ totalClosedTrades: 0, winRatePct: 0 }, []), 10_000)
    expect(cells.find((c) => c.label === 'Win rate')!.value).toBe('—')
    expect(cells.find((c) => c.label === 'Trades')!.value).toBe('0')
  })

  it('always reports the same six figures, so two exported sheets line up', () => {
    expect(statCells(result(), 10_000).map((c) => c.label)).toEqual([
      'Net return',
      'Final balance',
      'Trades',
      'Win rate',
      'Max drawdown',
      'Fees paid'
    ])
  })
})

describe('imageCaption', () => {
  const at = new Date('2026-08-28T09:15:42Z')

  it('names the run so the image stands alone once it leaves the app', () => {
    const c = imageCaption(result(), info, at)
    expect(c.title).toBe('Trend Regime Ensemble')
    expect(c.subtitle).toContain('BTC-USDT')
    expect(c.subtitle).toContain('4H')
    expect(c.subtitle).toContain('2026-05-30 → 2026-08-28')
    expect(c.subtitle).toContain('Binance')
  })

  it('mentions leverage only when there was some', () => {
    expect(imageCaption(result(), info, at).subtitle).not.toContain('leverage')
    expect(imageCaption(result(), { ...info, leverage: 3 }, at).subtitle).toContain('3x leverage')
  })

  it('counts the marked trades and gets the singular right', () => {
    expect(imageCaption(result({}, [trade()]), info, at).priceHeading).toContain('1 trade,')
    expect(imageCaption(result({}, [trade(), trade()]), info, at).priceHeading).toContain('2 trades,')
  })

  it('says so plainly when the run took no trades', () => {
    // Otherwise the heading promises markers over a chart that has none, which reads as a broken
    // export rather than a strategy that stayed flat.
    const c = imageCaption(result({ totalClosedTrades: 0 }, []), info, at)
    expect(c.priceHeading).toContain('no trades')
    expect(c.priceHeading).not.toContain('0 trades, entry and exit marked')
  })

  it('stamps the export time in UTC to the minute', () => {
    expect(imageCaption(result(), info, at).footer).toContain('2026-08-28 09:15 UTC')
  })

  it('states the cost model on the sheet', () => {
    // The image is the artefact most likely to be shown to someone who never saw the app, so the
    // assumption that most flatters the numbers travels with it.
    const footer = imageCaption(result(), info, at).footer
    expect(footer).toContain('0.1% fee')
    expect(footer).toContain('slippage')
  })
})
