// Renders a finished backtest to a single PNG: the price chart with every entry and exit marked,
// and the portfolio curve against buy & hold, under a heading that says which run produced them.
//
// WHY IT DRAWS ITS OWN CHARTS instead of screenshotting the ones on screen. The Charts tab shows
// one selected trade at a time and is sized by the window, so a screenshot of it would be a
// picture of whatever the user last clicked at whatever size their window happened to be. The
// export is a different artefact: the whole run, every trade, at a fixed resolution that does not
// depend on the display it was exported from.
//
// ALWAYS LIGHT. The sheet uses the light palette whatever theme the app is in, because this file
// leaves the app -- into documents, chat messages and print -- where a dark rectangle is a
// liability, and because the up/down colours need a known background to stay legible.
//
// takeScreenshot(true) is deliberate: the position bands and the trade markers are both series
// primitives, and the default `false` omits primitives entirely, which would return a bare
// candlestick chart with none of the trades on it.

import {
  createChart,
  CandlestickSeries,
  LineSeries,
  createSeriesMarkers,
  type UTCTimestamp
} from 'lightweight-charts'
import type { Candle } from '../../shared/ipc'
import type { BacktestResult } from './engine'
import type { ResultsGeneralInfo } from './BacktestResultsView'
import { CHART_PALETTE } from '../theme/palette'
import { PositionBandPrimitive } from './positionBandPrimitive'
import { tradeBands, tradeMarkers } from './tradeOverlay'
import { imageCaption, imageLayout, labelledTrades, statCells } from './chartImageLayout'

const CHART_WIDTH = 1360
const PRICE_HEIGHT = 560
const EQUITY_HEIGHT = 300

const PORTFOLIO_COLOR = '#5b63d3'
const BENCHMARK_COLOR = '#c98a10'

const SANS = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
const MONO = 'ui-monospace, "Cascadia Mono", "SF Mono", Consolas, monospace'

const SHEET = '#ffffff'
const INK = '#111820'
const MUTED = '#6b7885'
const RULE = '#d8dfe6'

const palette = CHART_PALETTE.light

/** Hands the event loop back once so React can paint the button's busy label before the render
 * below blocks the thread for a second or two.
 *
 * This was first written as a double requestAnimationFrame, on the assumption that a screenshot
 * taken in the same tick as setData would come back empty. The assumption is wrong: takeScreenshot
 * renders the chart model into a fresh canvas synchronously rather than copying whatever frame was
 * last presented, so there is no frame to wait for. A plain yield is also the safer primitive --
 * rAF does not fire at all while the window is occluded or hidden. */
function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** A detached, laid-out host for a chart that must never be seen. Off to the left rather than
 * `display:none`, which would give the chart a zero-sized container and nothing to draw into. */
function offscreenHost(width: number, height: number): HTMLDivElement {
  const host = document.createElement('div')
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;height:${height}px;pointer-events:none;`
  document.body.appendChild(host)
  return host
}

const BASE_OPTIONS = {
  autoSize: false,
  layout: { background: { color: SHEET }, textColor: '#3c4450', attributionLogo: false },
  grid: { vertLines: { color: 'rgba(60,68,80,0.10)' }, horzLines: { color: 'rgba(60,68,80,0.10)' } },
  timeScale: { timeVisible: true, secondsVisible: false, borderColor: RULE },
  rightPriceScale: { borderColor: RULE },
  handleScroll: false,
  handleScale: false
}

function renderPriceChart(candles: Candle[], result: BacktestResult): HTMLCanvasElement {
  const host = offscreenHost(CHART_WIDTH, PRICE_HEIGHT)
  const chart = createChart(host, { ...BASE_OPTIONS, width: CHART_WIDTH, height: PRICE_HEIGHT })
  try {
    const series = chart.addSeries(CandlestickSeries, {
      upColor: palette.up,
      downColor: palette.down,
      borderVisible: false,
      wickUpColor: palette.up,
      wickDownColor: palette.down,
      priceLineVisible: false,
      lastValueVisible: false
    })
    series.setData(
      candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }))
    )

    const bands = new PositionBandPrimitive()
    series.attachPrimitive(bands)
    bands.setBands(tradeBands(result.trades, palette))

    const windowSeconds = candles.length > 1 ? candles[candles.length - 1].time - candles[0].time : 0
    const labelled = labelledTrades(result.trades, windowSeconds, CHART_WIDTH)
    createSeriesMarkers(
      series,
      result.trades.flatMap((t, i) =>
        // A crowded trade keeps its arrow and loses its text, rather than the whole chart losing
        // its labels because two trades somewhere happened to land close together.
        tradeMarkers(t, palette).map((m) => (labelled[i] ? m : { ...m, text: undefined, size: 1 }))
      )
    )

    chart.timeScale().fitContent()
    return chart.takeScreenshot(true)
  } finally {
    chart.remove()
    host.remove()
  }
}

function renderEquityChart(result: BacktestResult, symbolLabel: string): HTMLCanvasElement {
  const host = offscreenHost(CHART_WIDTH, EQUITY_HEIGHT)
  const chart = createChart(host, { ...BASE_OPTIONS, width: CHART_WIDTH, height: EQUITY_HEIGHT })
  try {
    const portfolio = chart.addSeries(LineSeries, {
      color: PORTFOLIO_COLOR,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      title: 'Portfolio'
    })
    portfolio.setData(result.equityCurve.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })))

    const benchmark = chart.addSeries(LineSeries, {
      color: BENCHMARK_COLOR,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      title: symbolLabel
    })
    benchmark.setData(result.benchmarkCurve.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })))

    chart.timeScale().fitContent()
    return chart.takeScreenshot(true)
  } finally {
    chart.remove()
    host.remove()
  }
}

function drawSwatch(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, text: string): number {
  ctx.fillStyle = color
  ctx.fillRect(x, y - 7, 18, 3)
  ctx.fillStyle = MUTED
  ctx.font = `400 12px ${SANS}`
  ctx.textAlign = 'left'
  ctx.fillText(text, x + 25, y)
  return x + 25 + ctx.measureText(text).width + 22
}

/** Composes the sheet and returns it as base64 PNG bytes, without the `data:` prefix -- the IPC
 * request carries base64 and the main process turns it back into bytes. */
export async function renderBacktestImage(
  candles: Candle[],
  result: BacktestResult,
  info: ResultsGeneralInfo,
  startingBalance: number
): Promise<string> {
  await yieldToPaint()
  const priceShot = renderPriceChart(candles, result)
  const equityShot = renderEquityChart(result, info.symbolLabel)

  const layout = imageLayout({ chartWidth: CHART_WIDTH, priceHeight: PRICE_HEIGHT, equityHeight: EQUITY_HEIGHT })
  // The chart canvases come back at the display's pixel ratio. Matching the sheet to them keeps a
  // retina export sharp instead of upscaling a 1x screenshot into a 2x page.
  const scale = priceShot.width / CHART_WIDTH || 1

  const out = document.createElement('canvas')
  out.width = Math.round(layout.width * scale)
  out.height = Math.round(layout.height * scale)
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('Could not create a drawing surface for the export')
  ctx.scale(scale, scale)

  ctx.fillStyle = SHEET
  ctx.fillRect(0, 0, layout.width, layout.height)

  const caption = imageCaption(result, info, new Date())

  ctx.textAlign = 'left'
  ctx.fillStyle = INK
  ctx.font = `700 27px ${SANS}`
  ctx.fillText(caption.title, layout.statsX, layout.titleY)

  ctx.fillStyle = MUTED
  ctx.font = `400 13px ${SANS}`
  ctx.fillText(caption.subtitle, layout.statsX, layout.subtitleY)

  const cells = statCells(result, startingBalance)
  const cellWidth = layout.statsWidth / cells.length
  cells.forEach((cell, i) => {
    const x = layout.statsX + cellWidth * i
    ctx.fillStyle = MUTED
    ctx.font = `600 10px ${MONO}`
    ctx.fillText(cell.label.toUpperCase(), x, layout.statsLabelY)
    ctx.fillStyle = cell.tone === 'gain' ? palette.up : cell.tone === 'loss' ? palette.down : INK
    ctx.font = `700 21px ${MONO}`
    ctx.fillText(cell.value, x, layout.statsValueY)
  })

  ctx.strokeStyle = RULE
  ctx.lineWidth = 1
  for (const y of [layout.rule1Y, layout.rule2Y]) {
    ctx.beginPath()
    ctx.moveTo(layout.statsX, y + 0.5)
    ctx.lineTo(layout.statsX + layout.statsWidth, y + 0.5)
    ctx.stroke()
  }

  ctx.fillStyle = MUTED
  ctx.font = `600 11px ${MONO}`
  ctx.fillText(caption.priceHeading, layout.statsX, layout.priceHeadingY)
  ctx.fillText(caption.equityHeading, layout.statsX, layout.equityHeadingY)

  // Legend for the two curves, right-aligned on the equity heading's line. lightweight-charts puts
  // series titles on the price scale, which the export crops differently to the live chart.
  let legendX = layout.statsX + layout.statsWidth - 340
  legendX = drawSwatch(ctx, legendX, layout.equityHeadingY, PORTFOLIO_COLOR, 'Portfolio')
  drawSwatch(ctx, legendX, layout.equityHeadingY, BENCHMARK_COLOR, `${info.symbolLabel} buy & hold`)

  ctx.drawImage(priceShot, layout.price.x, layout.price.y, layout.price.width, layout.price.height)
  ctx.drawImage(equityShot, layout.equity.x, layout.equity.y, layout.equity.width, layout.equity.height)

  ctx.strokeStyle = RULE
  for (const r of [layout.price, layout.equity]) {
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width - 1, r.height - 1)
  }

  ctx.fillStyle = MUTED
  ctx.font = `400 11px ${SANS}`
  ctx.fillText(caption.footer, layout.statsX, layout.footerY)

  return out.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
}
