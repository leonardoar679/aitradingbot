// The arithmetic and the wording behind an exported chart image, kept away from the canvas.
//
// Everything here is a number or a string: where each block sits, how tall the whole sheet ends
// up, and what the caption and stat strip say. The drawing module consumes this and does nothing
// but paint it, so the part that can be got wrong silently -- a chart overlapping its own heading,
// a total height that leaves the footer off the bottom edge -- is the part that is tested.
//
// Units are CSS pixels. The exporter multiplies by whatever pixel ratio the chart canvases came
// back at, so a 1400-wide sheet is 1400 on a plain display and 2800 on a retina one without any
// of these numbers changing.

import type { BacktestResult } from './engine'
import type { ResultsGeneralInfo } from './BacktestResultsView'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface ImageLayout {
  width: number
  height: number
  /** Where the strategy name sits. */
  titleY: number
  subtitleY: number
  /** Baseline of the stat strip's labels and values. */
  statsLabelY: number
  statsValueY: number
  statsX: number
  statsWidth: number
  priceHeadingY: number
  price: Rect
  equityHeadingY: number
  equity: Rect
  footerY: number
  rule1Y: number
  rule2Y: number
}

export interface LayoutOptions {
  chartWidth: number
  priceHeight: number
  equityHeight: number
}

const PAD = 40
const TITLE_TOP = 52
const SUBTITLE_GAP = 30
const STATS_GAP = 42
const STATS_BLOCK = 46
const HEADING_GAP = 34
const CHART_GAP = 16
const SECTION_GAP = 34
const FOOTER_GAP = 30

/** Stacks the sheet top to bottom. Nothing is positioned by a hard-coded y: each block is placed
 * after the one above it, so changing a chart's height cannot leave a gap or an overlap. */
export function imageLayout(opts: LayoutOptions): ImageLayout {
  const { chartWidth, priceHeight, equityHeight } = opts
  const width = chartWidth + PAD * 2

  const titleY = TITLE_TOP
  const subtitleY = titleY + SUBTITLE_GAP
  const statsLabelY = subtitleY + STATS_GAP
  const statsValueY = statsLabelY + 24
  const rule1Y = statsValueY + STATS_BLOCK - 24

  const priceHeadingY = rule1Y + HEADING_GAP
  const price = { x: PAD, y: priceHeadingY + CHART_GAP, width: chartWidth, height: priceHeight }

  const equityHeadingY = price.y + price.height + SECTION_GAP
  const equity = { x: PAD, y: equityHeadingY + CHART_GAP, width: chartWidth, height: equityHeight }

  const rule2Y = equity.y + equity.height + 26
  const footerY = rule2Y + FOOTER_GAP

  return {
    width,
    height: footerY + PAD,
    titleY,
    subtitleY,
    statsLabelY,
    statsValueY,
    statsX: PAD,
    statsWidth: chartWidth,
    priceHeadingY,
    price,
    equityHeadingY,
    equity,
    footerY,
    rule1Y,
    rule2Y
  }
}

/** Roughly how wide a marker label draws: "SELL 64,290 · +0.28%" at the size the chart renders it. */
const LABEL_WIDTH = 120

/** Which trades can carry their price and return on the arrow, one answer per trade.
 *
 * MEASURED AS SPACING, NOT COUNT, AND PER TRADE. Two earlier versions were wrong in different
 * ways. The first asked whether there were at most a dozen trades: the wrong quantity, and wrong
 * on the first real export, where seven trades over 90 days sounded sparse right up until five of
 * them landed in the same fortnight and the middle of the chart became an unreadable smear. The
 * second measured spacing but answered once for the whole chart, so a single tight pair stripped
 * the labels off every other trade including ones with half the chart to themselves.
 *
 * A trade is labelled when both its neighbours are far enough away, in pixels at the width the
 * chart is actually drawn at. A trade's own entry and exit are never compared with each other:
 * those two are drawn on opposite sides of the bar, below and above, so they cannot collide
 * however short the hold. A lone trade is therefore always labelled.
 *
 * Where the labels come off, the arrows still mark every trade and the numbers are in the CSV,
 * which is where anyone reading trade by trade would look. */
export function labelledTrades(
  trades: ReadonlyArray<{ entryTime: number; exitTime: number }>,
  windowSeconds: number,
  chartWidth: number
): boolean[] {
  if (!(windowSeconds > 0) || !(chartWidth > 0)) return trades.map(() => false)
  const minGapSeconds = (LABEL_WIDTH / chartWidth) * windowSeconds
  return trades.map((trade, i) => {
    const before = i === 0 ? Infinity : trade.entryTime - trades[i - 1].exitTime
    const after = i === trades.length - 1 ? Infinity : trades[i + 1].entryTime - trade.exitTime
    return Math.min(before, after) >= minGapSeconds
  })
}

export interface StatCell {
  label: string
  value: string
  tone: 'gain' | 'loss' | 'neutral'
}

function usd(v: number): string {
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

function signedPct(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

/** The strip under the title. Six figures, chosen so the image answers "was this any good" without
 * the CSV beside it: what it returned, what that left, how often it traded, how well, how far down
 * it went, and what the trading cost. */
export function statCells(result: BacktestResult, startingBalance: number): StatCell[] {
  const s = result.stats
  const traded = s.totalClosedTrades > 0
  return [
    { label: 'Net return', value: signedPct(s.totalNetProfitPct), tone: s.totalNetProfitPct >= 0 ? 'gain' : 'loss' },
    { label: 'Final balance', value: usd(s.finishingBalance), tone: s.finishingBalance >= startingBalance ? 'gain' : 'loss' },
    { label: 'Trades', value: String(s.totalClosedTrades), tone: 'neutral' },
    // A win rate of 0% reads as "lost every trade" when it actually means no trade was taken.
    { label: 'Win rate', value: traded ? `${s.winRatePct.toFixed(1)}%` : '—', tone: 'neutral' },
    { label: 'Max drawdown', value: `${s.maxDrawdownPct.toFixed(2)}%`, tone: s.maxDrawdownPct < 0 ? 'loss' : 'neutral' },
    { label: 'Fees paid', value: usd(s.totalPaidFees), tone: 'neutral' }
  ]
}

export interface ImageCaption {
  title: string
  subtitle: string
  priceHeading: string
  equityHeading: string
  footer: string
}

/** Everything written on the sheet. Generated here so the image is self-describing: a PNG that
 * leaves the file it came from cannot say which symbol or window produced it, and a chart with no
 * axis context is a picture rather than a result. */
export function imageCaption(
  result: BacktestResult,
  info: ResultsGeneralInfo,
  exportedAt: Date
): ImageCaption {
  const leverage = info.leverage > 1 ? ` · ${info.leverage}x leverage` : ''
  const marked = result.trades.length
  return {
    title: info.strategyLabel,
    subtitle: `${info.symbolLabel} · ${info.intervalLabel} · ${info.startDate} → ${info.endDate} · ${info.exchangeName}${leverage}`,
    priceHeading:
      marked > 0
        ? `PRICE — ${marked} ${marked === 1 ? 'trade' : 'trades'}, entry and exit marked`
        : 'PRICE — no trades were taken in this window',
    equityHeading: 'PORTFOLIO vs BUY & HOLD',
    footer:
      `Exported ${exportedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC · all times UTC · ` +
      `fills modelled at the signal bar's close, 0.1% fee and 0.02% slippage per fill`
  }
}
