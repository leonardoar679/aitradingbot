// Draws the held-position band behind the candles.
//
// WHY A PRIMITIVE. lightweight-charts has no "shade this time range" option, and the usual
// workaround -- a constant-value histogram series on an overlay price scale -- draws one bar per
// candle with a gap between each, so a held position renders as a picket fence rather than a
// region. A series primitive gets one rectangle in canvas coordinates, which is what a span of
// time actually is.
//
// `zOrder: 'bottom'` puts it beneath the series, so the band tints the background without ever
// dulling a candle body or wick.
//
// The geometry that can be reasoned about without a canvas -- which colours, which time range --
// lives in `tradeOverlay.ts` and is tested there. What remains here is coordinate conversion the
// library owns, which is verified by running the app and looking at it.

import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
  UTCTimestamp
} from 'lightweight-charts'
import type { PositionBand } from './tradeOverlay'

type RenderTarget = Parameters<IPrimitivePaneRenderer['draw']>[0]

interface PlacedBand {
  band: PositionBand
  xFrom: number
  xTo: number
}

class BandRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly placed: readonly PlacedBand[]) {}

  draw(target: RenderTarget): void {
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context
      const ratio = scope.horizontalPixelRatio
      const edge = Math.max(1, Math.round(ratio))
      const height = scope.bitmapSize.height

      for (const { band, xFrom, xTo } of this.placed) {
        const left = Math.round(Math.min(xFrom, xTo) * ratio)
        const right = Math.round(Math.max(xFrom, xTo) * ratio)
        // A position opened and closed on the same bar still has to be visible, so the band never
        // collapses below the width of its own two edges.
        const width = Math.max(right - left, edge * 2)

        ctx.fillStyle = band.fill
        ctx.fillRect(left, 0, width, height)
        ctx.fillStyle = band.border
        ctx.fillRect(left, 0, edge, height)
        ctx.fillRect(left + width - edge, 0, edge, height)
      }
    })
  }
}

export class PositionBandPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null
  private requestUpdate: (() => void) | null = null
  private bands: readonly PositionBand[] = []

  // Held as one stable array: the library caches pane views by reference and re-reads them when
  // the reference changes, so handing back a fresh array every frame defeats that cache.
  private readonly views: readonly IPrimitivePaneView[] = [
    {
      zOrder: () => 'bottom',
      renderer: (): IPrimitivePaneRenderer | null => {
        const { chart, bands } = this
        if (!chart || bands.length === 0) return null
        const timeScale = chart.timeScale()
        const placed: PlacedBand[] = []
        for (const band of bands) {
          const xFrom = timeScale.timeToCoordinate(band.from as UTCTimestamp)
          const xTo = timeScale.timeToCoordinate(band.to as UTCTimestamp)
          // One band whose times fall outside the current data must not blank the others.
          if (xFrom === null || xTo === null) continue
          placed.push({ band, xFrom, xTo })
        }
        return placed.length > 0 ? new BandRenderer(placed) : null
      }
    }
  ]

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart
    this.requestUpdate = param.requestUpdate
  }

  detached(): void {
    this.chart = null
    this.requestUpdate = null
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views
  }

  /** An empty array clears the bands -- what "Hide Trades" and an empty result both need. */
  setBands(bands: readonly PositionBand[]): void {
    this.bands = bands
    this.requestUpdate?.()
  }
}
