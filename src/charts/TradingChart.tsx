import { useEffect, useRef, useState } from 'react'
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createSeriesMarkers,
  type IChartApi,
  type IPaneApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp
} from 'lightweight-charts'
import { EMA, RSI, MACD } from 'technicalindicators'
import { Card } from '../components/Card'
import { TimeframeToolbar } from '../components/TimeframeToolbar'
import type { TimeAnchorSettings } from '../components/timeTools/TimeToolsModal'
import type { IndicatorSettings } from '../components/indicators/IndicatorsPopover'
import { requestAiSignal } from '../ai/aiClient'
import { GPT_INTRADAY_INTERVAL } from '../../shared/aiSignal'
import { formatQuotePrice } from '../utils/formatCurrency'
import { describeError } from '../utils/ipcError'
import { useTheme } from '../theme/ThemeContext'
import { CHART_PALETTE } from '../theme/palette'
import { DEFAULT_INTERVAL, type Candle, type Exchange, type Interval } from '../../shared/ipc'

const EMA_PERIOD = 20
const RSI_PERIOD = 14
const MAX_MARKERS = 50

function toTime(seconds: number): UTCTimestamp {
  return seconds as UTCTimestamp
}

interface TradingChartProps {
  exchange: Exchange
  symbol: string
  quoteAsset: string
}

export function TradingChart({ exchange, symbol, quoteAsset }: TradingChartProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const candlesRef = useRef<Map<number, Candle>>(new Map())
  const lastClosedTimeRef = useRef<number | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const [status, setStatus] = useState<'loading' | 'live' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  // Bumping this re-runs the whole chart effect, which is what actually retries the fetch.
  const [reloadNonce, setReloadNonce] = useState(0)
  const [lastPrice, setLastPrice] = useState<number | null>(null)
  const [interval, setChartInterval] = useState<Interval>(DEFAULT_INTERVAL)
  const { theme } = useTheme()
  const palette = CHART_PALETTE[theme]
  const [anchorSettings, setAnchorSettings] = useState<TimeAnchorSettings>({
    enabled: true,
    anchorLine: false,
    acrossTokens: true
  })
  const anchorSettingsRef = useRef(anchorSettings)
  useEffect(() => {
    anchorSettingsRef.current = anchorSettings
  }, [anchorSettings])

  const [indicatorSettings, setIndicatorSettings] = useState<IndicatorSettings>({
    ema: false,
    rsi: false,
    macd: false
  })
  const indicatorSettingsRef = useRef(indicatorSettings)
  const emaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const rsiPaneRef = useRef<IPaneApi<Time> | null>(null)
  const rsiSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const macdPaneRef = useRef<IPaneApi<Time> | null>(null)
  const macdLineSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const macdSignalSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const macdHistSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)

  function applyIndicatorVisibility(settings: IndicatorSettings): void {
    emaSeriesRef.current?.applyOptions({ visible: settings.ema })
    rsiSeriesRef.current?.applyOptions({ visible: settings.rsi })
    rsiPaneRef.current?.setStretchFactor(settings.rsi ? 1.5 : 0.0001)
    macdLineSeriesRef.current?.applyOptions({ visible: settings.macd })
    macdSignalSeriesRef.current?.applyOptions({ visible: settings.macd })
    macdHistSeriesRef.current?.applyOptions({ visible: settings.macd })
    macdPaneRef.current?.setStretchFactor(settings.macd ? 1.5 : 0.0001)
  }

  useEffect(() => {
    indicatorSettingsRef.current = indicatorSettings
    applyIndicatorVisibility(indicatorSettings)
  }, [indicatorSettings])

  function handleIndicatorToggle(key: keyof IndicatorSettings): void {
    setIndicatorSettings((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  // Tracks the center/width of whatever the user last had in view, so a Time Anchor /
  // Across Tokens restore (see below) can put the new interval or symbol's chart back in
  // roughly the same place instead of resetting to "show everything".
  const prevKeyRef = useRef<{ exchange: Exchange; symbol: string; interval: Interval } | null>(null)
  const anchorTimeRef = useRef<number | null>(null)
  const anchorSpanRef = useRef<number | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const prevKey = prevKeyRef.current
    const changeType: 'interval' | 'symbol' | 'initial' =
      !prevKey
        ? 'initial'
        : prevKey.exchange !== exchange || prevKey.symbol !== symbol
          ? 'symbol'
          : 'interval'
    prevKeyRef.current = { exchange, symbol, interval }

    candlesRef.current.clear()
    lastClosedTimeRef.current = null
    setStatus('loading')
    setLastPrice(null)

    const chart: IChartApi = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: palette.background },
        textColor: palette.text,
        panes: {
          separatorColor: palette.grid,
          separatorHoverColor: `${palette.accent}26`,
          enableResize: true
        }
      },
      grid: {
        vertLines: { color: palette.grid },
        horzLines: { color: palette.grid }
      },
      timeScale: { timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 }
    })
    chartRef.current = chart

    chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      if (!range) return
      const from = range.from as number
      const to = range.to as number
      anchorTimeRef.current = (from + to) / 2
      anchorSpanRef.current = to - from
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: palette.up,
      downColor: palette.down,
      borderVisible: false,
      wickUpColor: palette.up,
      wickDownColor: palette.down
    })

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      priceLineVisible: false,
      lastValueVisible: false
    })
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })

    const emaSeries = chart.addSeries(LineSeries, {
      color: palette.gold,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false
    })
    emaSeriesRef.current = emaSeries

    const rsiPane = chart.addPane()
    const rsiSeries: ISeriesApi<'Line'> = rsiPane.addSeries(LineSeries, {
      color: '#8b5cf6',
      lineWidth: 2
    })
    rsiPaneRef.current = rsiPane
    rsiSeriesRef.current = rsiSeries

    const macdPane = chart.addPane()
    const macdLineSeries: ISeriesApi<'Line'> = macdPane.addSeries(LineSeries, {
      color: palette.accent,
      lineWidth: 1
    })
    const macdSignalSeries: ISeriesApi<'Line'> = macdPane.addSeries(LineSeries, {
      color: '#f97316',
      lineWidth: 1
    })
    const macdHistSeries: ISeriesApi<'Histogram'> = macdPane.addSeries(HistogramSeries, {
      priceLineVisible: false,
      lastValueVisible: false
    })
    macdPaneRef.current = macdPane
    macdLineSeriesRef.current = macdLineSeries
    macdSignalSeriesRef.current = macdSignalSeries
    macdHistSeriesRef.current = macdHistSeries

    const panes = chart.panes()
    panes[0]?.setStretchFactor(4)
    rsiPane.setStretchFactor(1.5)
    macdPane.setStretchFactor(1.5)
    applyIndicatorVisibility(indicatorSettingsRef.current)

    const markers: ISeriesMarkersPluginApi<Time> = createSeriesMarkers(candleSeries, [])
    let markerList: SeriesMarker<Time>[] = []
    let anchorMarker: SeriesMarker<Time> | null = null

    function updateMarkers(): void {
      markers.setMarkers(anchorMarker ? [...markerList, anchorMarker] : markerList)
    }

    function recompute(): void {
      const candles = Array.from(candlesRef.current.values()).sort((a, b) => a.time - b.time)
      if (candles.length === 0) return

      candleSeries.setData(
        candles.map((c) => ({
          time: toTime(c.time),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close
        }))
      )
      volumeSeries.setData(
        candles.map((c) => ({
          time: toTime(c.time),
          value: c.volume,
          color: c.close >= c.open ? `${palette.up}80` : `${palette.down}80`
        }))
      )

      const closes = candles.map((c) => c.close)

      const emaValues = EMA.calculate({ period: EMA_PERIOD, values: closes })
      const emaOffset = candles.length - emaValues.length
      emaSeries.setData(
        emaValues.map((value, i) => ({ time: toTime(candles[i + emaOffset].time), value }))
      )

      const rsiValues = RSI.calculate({ period: RSI_PERIOD, values: closes })
      const rsiOffset = candles.length - rsiValues.length
      rsiSeries.setData(
        rsiValues.map((value, i) => ({ time: toTime(candles[i + rsiOffset].time), value }))
      )

      const macdValues = MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false
      })
      const macdOffset = candles.length - macdValues.length
      const macdLineData: { time: UTCTimestamp; value: number }[] = []
      const macdSignalData: { time: UTCTimestamp; value: number }[] = []
      const macdHistData: { time: UTCTimestamp; value: number; color: string }[] = []
      macdValues.forEach((entry, i) => {
        const time = toTime(candles[i + macdOffset].time)
        if (entry.MACD !== undefined) macdLineData.push({ time, value: entry.MACD })
        if (entry.signal !== undefined) macdSignalData.push({ time, value: entry.signal })
        if (entry.histogram !== undefined) {
          macdHistData.push({
            time,
            value: entry.histogram,
            color: entry.histogram >= 0 ? `${palette.up}99` : `${palette.down}99`
          })
        }
      })
      macdLineSeries.setData(macdLineData)
      macdSignalSeries.setData(macdSignalData)
      macdHistSeries.setData(macdHistData)

      const latest = candles[candles.length - 1]
      setLastPrice(latest.close)
    }

    async function markClosedCandle(time: number): Promise<void> {
      try {
        if (interval !== GPT_INTRADAY_INTERVAL) return
        const signalCandles = [...candlesRef.current.values()].sort((a, b) => a.time - b.time)
        const executionIndex = signalCandles.findIndex((candle) => candle.time === time)
        const signal = await requestAiSignal(symbol, { exchange, candles: signalCandles, executionIndex })
        if (signal.recommendation === 'hold') return
        const isBuy = signal.recommendation === 'buy'
        const newMarker: SeriesMarker<Time> = {
          time: toTime(time),
          position: isBuy ? 'belowBar' : 'aboveBar',
          shape: isBuy ? 'arrowUp' : 'arrowDown',
          color: isBuy ? palette.up : palette.down,
          text: signal.recommendation.toUpperCase()
        }
        markerList = [...markerList, newMarker].slice(-MAX_MARKERS)
        updateMarkers()
      } catch (error) {
        console.error('AI signal request failed:', error)
      }
    }

    function ingest(candle: Candle): void {
      const previousTimes = Array.from(candlesRef.current.keys())
      const maxPreviousTime = previousTimes.length > 0 ? Math.max(...previousTimes) : null

      candlesRef.current.set(candle.time, candle)
      recompute()

      if (maxPreviousTime !== null && candle.time > maxPreviousTime) {
        lastClosedTimeRef.current = maxPreviousTime
        void markClosedCandle(maxPreviousTime)
      }
    }

    function restoreAnchoredView(anchorSec: number, spanSec: number | null): void {
      const candles = Array.from(candlesRef.current.values()).sort((a, b) => a.time - b.time)
      if (candles.length === 0) return
      let nearest = candles[0].time
      let minDiff = Infinity
      for (const c of candles) {
        const diff = Math.abs(c.time - anchorSec)
        if (diff < minDiff) {
          minDiff = diff
          nearest = c.time
        }
      }
      const span = spanSec ?? 3600
      chart.timeScale().setVisibleRange({
        from: toTime(nearest - span / 2),
        to: toTime(nearest + span / 2)
      })
      if (anchorSettingsRef.current.anchorLine) {
        anchorMarker = { time: toTime(nearest), position: 'aboveBar', shape: 'circle', color: palette.text, text: 'Anchor' }
        updateMarkers()
      }
    }

    let unsubscribeUpdates: (() => void) | null = null
    let cancelled = false

    // Every other data path in this app retries — Positions every 15s, the portfolio snapshot
    // every 2 minutes, executor simulations every minute. The chart was the one that gave up
    // permanently: a single connect timeout (binance.us takes 10s to time out, and it really
    // does happen) left it reading "Failed to load market data." until the user happened to
    // navigate away and back. Retry a few times with backoff, then leave a button.
    const RETRY_DELAYS_MS = [2000, 5000, 15000]
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0

    async function start(): Promise<void> {
      try {
        const history = await window.api.market.subscribeCandles(exchange, symbol, interval)
        if (cancelled) return
        for (const candle of history) {
          candlesRef.current.set(candle.time, candle)
        }
        recompute()
        setStatus('live')
        setLoadError(null)

        const settings = anchorSettingsRef.current
        const shouldRestore =
          (changeType === 'interval' && settings.enabled) || (changeType === 'symbol' && settings.acrossTokens)
        if (shouldRestore && anchorTimeRef.current !== null) {
          restoreAnchoredView(anchorTimeRef.current, anchorSpanRef.current)
        }

        unsubscribeUpdates = window.api.market.onCandleUpdate(ingest)
      } catch (error) {
        console.error('Failed to load market data:', error)
        if (cancelled) return
        const delay = RETRY_DELAYS_MS[attempt]
        if (delay !== undefined) {
          attempt += 1
          retryTimer = setTimeout(() => {
            if (!cancelled) void start()
          }, delay)
          return
        }
        // Out of automatic attempts — say what went wrong and hand the user the retry.
        setLoadError(describeError(error))
        setStatus('error')
      }
    }

    void start()

    return (): void => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      unsubscribeUpdates?.()
      void window.api.market.unsubscribeCandles()
      chart.remove()
      chartRef.current = null
      emaSeriesRef.current = null
      rsiPaneRef.current = null
      rsiSeriesRef.current = null
      macdPaneRef.current = null
      macdLineSeriesRef.current = null
      macdSignalSeriesRef.current = null
      macdHistSeriesRef.current = null
      // candlesRef holds a Map created once at mount (line 45) and never reassigned -- a data
      // store, not the DOM node ref this rule is written for. Its identity is stable for the
      // component's lifetime, so the cleanup clears exactly the Map the effect filled, and the
      // copy-to-a-local the rule suggests would change nothing.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      candlesRef.current.clear()
    }
  }, [exchange, symbol, interval, palette, reloadNonce])

  function handleJumpToDate(date: Date): void {
    const chart = chartRef.current
    if (!chart) return
    const candles = Array.from(candlesRef.current.values()).sort((a, b) => a.time - b.time)
    if (candles.length === 0) return

    const targetSec = Math.floor(date.getTime() / 1000)
    const clamped = Math.min(Math.max(targetSec, candles[0].time), candles[candles.length - 1].time)
    let nearest = candles[0].time
    let minDiff = Infinity
    for (const c of candles) {
      const diff = Math.abs(c.time - clamped)
      if (diff < minDiff) {
        minDiff = diff
        nearest = c.time
      }
    }

    const currentRange = chart.timeScale().getVisibleRange()
    const spanSec = currentRange ? (currentRange.to as number) - (currentRange.from as number) : 3600
    chart.timeScale().setVisibleRange({
      from: toTime(nearest - spanSec / 2),
      to: toTime(nearest + spanSec / 2)
    })
  }

  function handleSetRange(from: Date, to: Date): void {
    const chart = chartRef.current
    if (!chart) return
    const fromSec = Math.floor(from.getTime() / 1000)
    const toSec = Math.floor(to.getTime() / 1000)
    const [lo, hi] = fromSec <= toSec ? [fromSec, toSec] : [toSec, fromSec]
    chart.timeScale().setVisibleRange({ from: toTime(lo), to: toTime(hi) })
  }

  return (
    <Card title={symbol}>
      <TimeframeToolbar
        interval={interval}
        onSelect={setChartInterval}
        onJumpToDate={handleJumpToDate}
        onSetRange={handleSetRange}
        anchorSettings={anchorSettings}
        onAnchorSettingsChange={setAnchorSettings}
        indicatorSettings={indicatorSettings}
        onIndicatorToggle={handleIndicatorToggle}
      />
      <p
        style={{
          margin: '0 0 0.75rem',
          fontSize: '1.1rem',
          fontWeight: 600,
          color:
            status === 'error'
              ? 'var(--down)'
              : status === 'live'
                ? 'var(--text-primary)'
                : 'var(--text-secondary)'
        }}
      >
        {status === 'loading' && 'Loading market data...'}
        {status === 'error' && (
          <>
            Couldn&apos;t load market data{loadError ? `: ${loadError}` : '.'}{' '}
            <button
              onClick={() => {
                setStatus('loading')
                setLoadError(null)
                setReloadNonce((n) => n + 1)
              }}
              style={{
                background: 'transparent',
                border: '1px solid var(--down)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--down)',
                fontSize: '0.72rem',
                fontWeight: 700,
                padding: '0.15rem 0.5rem',
                marginLeft: '0.3rem',
                cursor: 'pointer'
              }}
            >
              Retry
            </button>
          </>
        )}
        {status === 'live' && lastPrice !== null && formatQuotePrice(lastPrice, quoteAsset)}
      </p>
      <div ref={containerRef} style={{ width: '100%', height: 400 }} />
      <p style={{ margin: '0.6rem 0 0', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
        AI buy/sell markers are a stub (see Agents) — every signal currently returns hold, so none will appear.
      </p>
    </Card>
  )
}
