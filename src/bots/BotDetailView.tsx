import { useEffect, useRef } from 'react'
import {
  createChart,
  CandlestickSeries,
  createSeriesMarkers,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type IPriceLine,
  type SeriesMarker,
  type Time,
  type UTCTimestamp
} from 'lightweight-charts'
import { ArrowLeft } from 'lucide-react'
import { EXCHANGES } from '../../shared/ipc'
import { useDryRun, summarizePaperTrades, classifyBotOpenPosition } from './useDryRun'
import { useTheme } from '../theme/ThemeContext'
import { CHART_PALETTE } from '../theme/palette'
import { PositionBandPrimitive } from '../backtest/positionBandPrimitive'
import { openPositionBand, tradeBands } from '../backtest/tradeOverlay'
import type { Trade } from '../backtest/engine'
import type { Bot } from './types'
import { formatQuotePrice } from '../utils/formatCurrency'

interface BotDetailViewProps {
  bot: Bot
  onBack: () => void
}

function pctColor(pct: number): string {
  return pct >= 0 ? 'var(--up)' : 'var(--down)'
}

function exitReasonLabel(reason: Trade['exitReason']): string {
  if (reason === 'stop_loss') return 'Stop Loss'
  if (reason === 'trailing') return 'Give-Back'
  if (reason === 'end_of_data') return 'Force Close'
  return 'Signal'
}

export function BotDetailView({ bot, onBack }: BotDetailViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const stopLineRef = useRef<IPriceLine | null>(null)
  const entryLineRef = useRef<IPriceLine | null>(null)
  const bandRef = useRef<PositionBandPrimitive | null>(null)

  const dryRun = useDryRun(bot.exchange, bot.symbol, bot.enabled, bot.enabledAt, bot.strategyId)
  const exchangeName = EXCHANGES.find((e) => e.id === bot.exchange)?.name ?? bot.exchange
  const { theme } = useTheme()
  const palette = CHART_PALETTE[theme]

  // Was a hand-rolled copy of summarizePaperTrades. Two copies of the same rule is exactly the
  // drift the shared helper exists to prevent.
  const { paperTrades, paperWins, paperNetPct } = summarizePaperTrades(dryRun.result?.trades ?? [], bot.enabledAt)
  const openClassified = classifyBotOpenPosition(dryRun.result?.openPositionAtEnd ?? null, bot.enabledAt)
  const openPosition = openClassified.kind === 'bot' ? openClassified.position : null
  // The chart draws whatever the strategy is actually holding, including a position that predates
  // this bot: its entry and stop are real levels the replay will exit at, and hiding them would
  // make the chart less truthful, not more. Only the attribution below is filtered.
  const chartPosition = openClassified.kind === 'none' ? null : openClassified.position

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const chart = createChart(container, {
      autoSize: true,
      layout: { background: { color: palette.background }, textColor: palette.text },
      grid: {
        vertLines: { color: palette.grid },
        horzLines: { color: palette.grid }
      },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: palette.border }
    })
    chartRef.current = chart

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: palette.up,
      downColor: palette.down,
      borderVisible: false,
      wickUpColor: palette.up,
      wickDownColor: palette.down
    })
    seriesRef.current = candleSeries
    markersRef.current = createSeriesMarkers(candleSeries, [])

    const bands = new PositionBandPrimitive()
    candleSeries.attachPrimitive(bands)
    bandRef.current = bands

    return (): void => {
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      markersRef.current = null
      bandRef.current = null
      stopLineRef.current = null
      entryLineRef.current = null
    }
  }, [palette])

  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    const markers = markersRef.current
    if (!chart || !series || !markers || dryRun.candles.length === 0) return

    series.setData(
      dryRun.candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      }))
    )

    const tradeMarkers: SeriesMarker<Time>[] = []
    for (const t of paperTrades) {
      tradeMarkers.push({
        time: t.entryTime as UTCTimestamp,
        position: 'belowBar',
        shape: 'arrowUp',
        color: palette.accent,
        text: 'BUY'
      })
      tradeMarkers.push({
        time: t.exitTime as UTCTimestamp,
        position: 'aboveBar',
        shape: 'arrowDown',
        color: t.pnl >= 0 ? palette.up : palette.down,
        text: exitReasonLabel(t.exitReason).toUpperCase()
      })
    }
    if (chartPosition) {
      tradeMarkers.push({
        time: chartPosition.entryTime as UTCTimestamp,
        position: 'belowBar',
        shape: 'arrowUp',
        color: palette.accent,
        text: 'BUY'
      })
    }
    markers.setMarkers(tradeMarkers)

    // Shading every closed paper trade turns a scatter of arrows into the thing someone checking
    // on a bot actually wants to read: when it was in the market, and when it sat out.
    const bands = tradeBands(paperTrades, palette)
    // The open position runs to the newest candle rather than stopping at its entry arrow -- a bot
    // holding right now is the state the chart most needs to show, and previously only the text
    // panel said so.
    const lastCandleTime = dryRun.candles[dryRun.candles.length - 1].time
    const running = chartPosition ? openPositionBand(chartPosition.entryTime, lastCandleTime, palette) : null
    if (running) bands.push(running)
    bandRef.current?.setBands(bands)

    for (const ref of [stopLineRef, entryLineRef]) {
      if (ref.current) {
        series.removePriceLine(ref.current)
        ref.current = null
      }
    }
    if (chartPosition) {
      stopLineRef.current = series.createPriceLine({
        price: chartPosition.stopPrice,
        color: palette.down,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Stop Loss'
      })
      // Drawn alongside the stop because the stop alone says how far there is to fall without
      // saying what it would cost -- the gap between these two lines is the open risk.
      entryLineRef.current = series.createPriceLine({
        price: chartPosition.entryPrice,
        color: palette.accent,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Entry'
      })
    }

    chart.timeScale().fitContent()
    // paperTrades is derived fresh each render from dryRun.result — depend on that instead
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dryRun.candles, dryRun.result, chartPosition, palette])

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
        <button
          onClick={onBack}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
            background: 'var(--bg-app)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.5rem 0.8rem',
            color: 'var(--text-primary)',
            fontSize: '0.8rem',
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          <ArrowLeft size={14} /> Back to Bots
        </button>
        <div>
          <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)' }}>{bot.name}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            {exchangeName} • {bot.baseAsset}-{bot.quoteAsset} • {bot.strategy}
          </div>
        </div>
      </div>

      {dryRun.status === 'error' && (
        <p style={{ color: 'var(--down)', fontSize: '0.85rem' }}>Dry-run error: {dryRun.error}</p>
      )}

      <div style={{ display: 'flex', gap: '1.25rem', height: 520 }}>
        <div
          style={{
            width: 320,
            display: 'flex',
            flexDirection: 'column',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
            flexShrink: 0
          }}
        >
          <div style={{ padding: '0.7rem 0.9rem', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: '0.65rem', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
              Dry Run (paper)
            </span>
            <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem' }}>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: openPosition ? 'var(--up)' : 'var(--text-muted)',
                  flexShrink: 0
                }}
              />
              {openClassified.kind === 'bot' && (
                <span style={{ color: 'var(--text-primary)' }}>Long @ {formatQuotePrice(openClassified.position.entryPrice, bot.quoteAsset)}</span>
              )}
              {openClassified.kind === 'preexisting' && (
                <span style={{ color: 'var(--text-secondary)' }}>
                  Flat — the strategy entered before you enabled this bot (shown on the chart), so it is not counted as
                  yours
                </span>
              )}
              {openClassified.kind === 'none' && <span style={{ color: 'var(--text-secondary)' }}>Flat — waiting for signal</span>}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', padding: '0.7rem 0.9rem', gap: '0.6rem', borderBottom: '1px solid var(--border)' }}>
            <div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Paper Trades</div>
              <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                {paperTrades.length}
                {paperTrades.length > 0 ? ` (${paperWins}W)` : ''}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Net P&L</div>
              <div style={{ fontSize: '0.9rem', fontWeight: 700, color: pctColor(paperNetPct) }}>
                {paperTrades.length === 0 ? '—' : `${paperNetPct >= 0 ? '+' : ''}${paperNetPct.toFixed(2)}%`}
              </div>
            </div>
          </div>

          <div style={{ padding: '0.5rem 0.9rem', fontSize: '0.72rem', fontStyle: 'italic', color: 'var(--text-secondary)' }}>
            {paperTrades.length === 0 ? 'No paper trades yet' : `Since ${bot.enabledAt ? new Date(bot.enabledAt * 1000).toLocaleString() : ''}`}
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {paperTrades.length === 0 && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', padding: '0 0.9rem' }}>
                Trades will appear here once the strategy enters a position after this bot was enabled.
              </p>
            )}
            {[...paperTrades].reverse().map((t, i) => (
              <div
                key={i}
                style={{
                  padding: '0.55rem 0.9rem',
                  fontSize: '0.8rem',
                  borderBottom: '1px solid var(--border)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.2rem'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-primary)' }}>
                    {formatQuotePrice(t.entryPrice, bot.quoteAsset)} → {formatQuotePrice(t.exitPrice, bot.quoteAsset)}
                  </span>
                  <span style={{ color: pctColor(t.returnPct), fontWeight: 600 }}>{t.returnPct.toFixed(2)}%</span>
                </div>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{exitReasonLabel(t.exitReason)}</span>
              </div>
            ))}
          </div>
        </div>

        <div ref={containerRef} style={{ flex: 1 }} />
      </div>
    </div>
  )
}
