// What a selected trade looks like on the chart: the two signals, the two price levels, and the
// band covering the bars the position was actually open for.
//
// COLOUR MEANS ONE THING HERE. The accent marks the OPEN -- the buy that starts a long, or the
// sell that starts a short -- and green/red marks the CLOSE and how it went. The earlier version
// coloured both ends by side, which put a red arrow on a short entry and a red arrow on a losing
// exit and gave the viewer no way to tell those apart at a glance. Direction is already carried by
// the arrow and spelled out in the label, so colour is free to carry the outcome instead.
//
// KNOWN LIMIT OF THE COLORBLIND PALETTE. There `accent` is indigo and `up` is blue, so a WINNING
// trade draws both ends in near enough the same hue -- checked in the app, and it is real. What
// has to survive is winner vs loser, and that does: the band and the closing arrow are blue for a
// win and amber for a loss. Entry vs exit is then carried by the arrow direction and the word in
// the label, which are unambiguous in every theme. Fixing the hue properly means changing
// `accent`, which every other screen in the app also draws with.
//
// Kept pure and free of any lightweight-charts runtime import -- only erased `import type` -- so
// these can be tested in a plain node environment without pulling a canvas library into the suite.
// `dashed` rather than `LineStyle` in the returned spec exists for exactly that reason; the view
// maps it to the enum.

import type { SeriesMarker, Time, UTCTimestamp } from 'lightweight-charts'
import type { ChartPalette } from '../theme/palette'
import type { Trade } from './engine'

/** Price as it goes on a marker, at the precision the symbol deserves.
 *
 * This app trades BTC near $63,000 and DOGE near $0.06 through the same panel. A fixed 2 decimals
 * prints "0.06" for DOGE, which hides the difference between an entry and an exit, and prints
 * "63214.12" for BTC, where the cents are noise on a marker two characters from a candle. */
export function formatSignalPrice(price: number): string {
  if (!Number.isFinite(price)) return ''
  const abs = Math.abs(price)
  const decimals = abs >= 1000 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : abs >= 0.0001 ? 6 : 8
  return price.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** `+4.25%` / `-1.80%`. The sign is always shown: a return printed bare reads as a price. */
export function formatSignedPct(pct: number): string {
  if (!Number.isFinite(pct)) return ''
  // Rounding before the sign test keeps a hair below zero from printing as "-0.00%".
  const rounded = Number(pct.toFixed(2))
  return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(2)}%`
}

/** Green for a trade that made money, red for one that lost it. Break-even counts as green, the
 * same way the trade list's PNL column already treats it. */
export function outcomeColor(trade: Trade, palette: ChartPalette): string {
  return trade.returnPct >= 0 ? palette.up : palette.down
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/** A palette colour at a given opacity, for fills that must not bury the candles behind them.
 *
 * Returns the input untouched when it isn't hex. The chart palette is all hex today, so that path
 * only opens if someone adds an `rgb()` entry -- and an opaque band is a visible mistake worth
 * seeing, where a silently swapped colour would just look like a different design. */
export function withAlpha(color: string, alpha: number): string {
  const match = HEX.exec(color.trim())
  if (!match) return color
  const digits =
    match[1].length === 3
      ? match[1]
          .split('')
          .map((c) => c + c)
          .join('')
      : match[1]
  const r = parseInt(digits.slice(0, 2), 16)
  const g = parseInt(digits.slice(2, 4), 16)
  const b = parseInt(digits.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`
}

/** The two arrows: where the position opened and where it closed, each labelled with its price,
 * the closing one also with what the round trip returned. */
export function tradeMarkers(trade: Trade, palette: ChartPalette): SeriesMarker<Time>[] {
  const long = trade.side === 'long'
  return [
    {
      time: trade.entryTime as UTCTimestamp,
      position: long ? 'belowBar' : 'aboveBar',
      shape: long ? 'arrowUp' : 'arrowDown',
      color: palette.accent,
      size: 2,
      text: `${long ? 'BUY' : 'SELL'} ${formatSignalPrice(trade.entryPrice)}`
    },
    {
      time: trade.exitTime as UTCTimestamp,
      position: long ? 'aboveBar' : 'belowBar',
      shape: long ? 'arrowDown' : 'arrowUp',
      color: outcomeColor(trade, palette),
      size: 2,
      text: `${long ? 'SELL' : 'BUY'} ${formatSignalPrice(trade.exitPrice)} · ${formatSignedPct(trade.returnPct)}`
    }
  ]
}

export interface PriceLineSpec {
  price: number
  color: string
  title: string
  dashed: boolean
}

/** Horizontal rules at the two fills, so the distance the trade actually captured is readable off
 * the price axis instead of estimated by eye from two arrows at different heights. */
export function tradePriceLines(trade: Trade, palette: ChartPalette): PriceLineSpec[] {
  if (!Number.isFinite(trade.entryPrice) || !Number.isFinite(trade.exitPrice)) return []
  const long = trade.side === 'long'
  return [
    { price: trade.entryPrice, color: palette.accent, title: long ? 'BUY' : 'SELL', dashed: true },
    {
      price: trade.exitPrice,
      color: outcomeColor(trade, palette),
      title: `${long ? 'SELL' : 'BUY'} ${formatSignedPct(trade.returnPct)}`,
      dashed: true
    }
  ]
}

export interface PositionBand {
  /** Unix seconds, always the earlier of the two stamps. */
  from: number
  to: number
  fill: string
  border: string
}

/** The shaded span the position was open for.
 *
 * Two arrows tell you a trade happened; they don't tell you it was held across the drop in the
 * middle. The band is what turns a pair of signals into a position. */
export function positionBand(trade: Trade, palette: ChartPalette): PositionBand | null {
  if (!Number.isFinite(trade.entryTime) || !Number.isFinite(trade.exitTime)) return null
  const base = outcomeColor(trade, palette)
  return {
    from: Math.min(trade.entryTime, trade.exitTime),
    to: Math.max(trade.entryTime, trade.exitTime),
    fill: withAlpha(base, 0.1),
    border: withAlpha(base, 0.5)
  }
}

/** Bands for a whole set of closed trades, for a chart that shows all of them at once rather than
 * one at a time. Reads as when the strategy was in the market and when it sat out. */
export function tradeBands(trades: readonly Trade[], palette: ChartPalette): PositionBand[] {
  const bands: PositionBand[] = []
  for (const trade of trades) {
    const band = positionBand(trade, palette)
    if (band) bands.push(band)
  }
  return bands
}

/** The band for a position that has not closed yet, running from its entry to the newest candle.
 *
 * Drawn in accent rather than green or red on purpose: this trade has no result. Tinting it by
 * unrealised P&L would put the same green on a banked win and on a paper gain the position can
 * still give back, which is the one distinction someone watching a live bot most needs. */
export function openPositionBand(
  entryTime: number,
  throughTime: number,
  palette: ChartPalette
): PositionBand | null {
  if (!Number.isFinite(entryTime) || !Number.isFinite(throughTime)) return null
  if (throughTime < entryTime) return null
  return {
    from: entryTime,
    to: throughTime,
    fill: withAlpha(palette.accent, 0.1),
    border: withAlpha(palette.accent, 0.5)
  }
}

export interface SignalSummary {
  entryAction: 'BUY' | 'SELL'
  entryPrice: string
  exitAction: 'BUY' | 'SELL'
  exitPrice: string
  resultPct: string
  won: boolean
}

/** One line naming the trade the chart is currently showing. Marker text sits at candle height and
 * scrolls away; this stays put, so the chart says which trade it is without a trip back to the
 * list on the left. */
export function signalSummary(trade: Trade): SignalSummary {
  const long = trade.side === 'long'
  return {
    entryAction: long ? 'BUY' : 'SELL',
    entryPrice: formatSignalPrice(trade.entryPrice),
    exitAction: long ? 'SELL' : 'BUY',
    exitPrice: formatSignalPrice(trade.exitPrice),
    resultPct: formatSignedPct(trade.returnPct),
    won: trade.returnPct >= 0
  }
}
