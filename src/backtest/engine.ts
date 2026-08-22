import type { Candle } from '../../shared/ipc'
import { getStrategy, DEFAULT_STRATEGY_ID } from './strategies'
import { FEE_RATE } from '../../shared/fees'

// The actual entry/exit/stop logic is pluggable — see src/backtest/strategies/. This engine only
// owns execution: position tracking, fees, the equity curve, and the full stats panel below. Any
// open position is force-closed on the final candle (unless forceCloseAtEnd is off). Fee is a
// flat rate applied to both entry and exit notional, shared with the executor paper simulations
// via shared/fees.ts so the two engines can never disagree on what a trade costs.
const STARTING_BALANCE = 10000
// Below this, a compound annual growth rate stops being a description of the strategy and becomes
// a description of the sample. A week that happened to return +5% annualizes to +1,160%; the same
// week at -5% annualizes to -93%. Neither number tells a beginner anything true about a year, so
// the stat is reported as null and the UI says why instead of printing a fantasy.
export const MIN_ANNUALIZATION_DAYS = 30

export interface Trade {
  side: 'long' | 'short'
  entryTime: number
  exitTime: number
  entryPrice: number
  exitPrice: number
  qty: number
  pnl: number
  returnPct: number
  exitReason: 'signal' | 'stop_loss' | 'end_of_data'
}

export interface EquityPoint {
  time: number
  value: number
}

export interface BacktestStats {
  totalClosedTrades: number
  totalNetProfit: number
  totalNetProfitPct: number
  startingBalance: number
  finishingBalance: number
  openTrades: number
  totalPaidFees: number
  maxDrawdownPct: number
  /** Actual span of the returned candle data, which can be shorter than the requested date range
   * (a symbol listed mid-range, or an exchange that capped the response). */
  periodDays: number
  /** Leading candles the strategy structurally cannot trade in, because its indicators are not
   * warmed up yet. Surfaced so the results panel can explain the flat opening stretch of the
   * equity curve rather than leaving it looking like the strategy simply found nothing. */
  warmupBars: number
  /** Compound annual growth rate. `null` when the sample is shorter than MIN_ANNUALIZATION_DAYS —
   * extrapolating a 3-day result to a year multiplies noise by 120x and produces numbers like
   * "+4,000% annual return" that mean nothing. */
  annualReturnPct: number | null
  expectancy: number
  expectancyPct: number
  avgWin: number
  avgLoss: number
  avgWinLossRatio: number
  winRatePct: number
  longPct: number
  shortPct: number
  avgHoldingSec: number
  winningAvgHoldingSec: number
  losingAvgHoldingSec: number
  sharpeRatio: number
  /** Annual return / max drawdown. `null` whenever annualReturnPct is null, since it is derived
   * from it and would inherit the same short-sample distortion. */
  calmarRatio: number | null
  sortinoRatio: number
  /** Sum of positive period returns / sum of negative ones. `Infinity` if the equity curve never
   * had a down period; `0` if it never had an up one. */
  omegaRatio: number
  winningStreak: number
  losingStreak: number
  largestWinningTrade: number
  largestLosingTrade: number
  totalWinningTrades: number
  totalLosingTrades: number
  losingMonthsCount: number
  maxConsecutiveLosingMonths: number
  /** Gross profit / gross loss across all closed trades. `Infinity` if there were winners and no
   * losers at all; `0` if there were no closed trades. */
  profitFactor: number
  /** Of all net profit earned in profitable months, the % contributed by just the 3 best months —
   * a high number means the result depends on a handful of outlier months rather than a broad,
   * repeatable edge. `0` if there were no profitable months. */
  topThreeMonthsProfitSharePct: number
}

export interface MonthlyBreakdownRow {
  /** UTC calendar month, e.g. "2025-03" */
  month: string
  trades: number
  netProfit: number
  returnPct: number
}

export interface SegmentSummary {
  label: string
  startTime: number
  endTime: number
  trades: number
  netProfitPct: number
  winRatePct: number
  maxDrawdownPct: number
}

// Summarizes a time slice of an already-run backtest — used to compare an in-sample period
// against an out-of-sample period without re-running the simulation (which would need extra
// lookback candles before the slice start to warm up EMA/ATR correctly). Net profit and
// drawdown are read off the equity curve (mark-to-market); trade count and win rate count
// trades that exited within the slice.
export function summarizeSegment(
  equityCurve: EquityPoint[],
  trades: Trade[],
  startTime: number,
  endTime: number,
  label: string
): SegmentSummary {
  const points = equityCurve.filter((p) => p.time >= startTime && p.time <= endTime)
  if (points.length === 0) {
    return { label, startTime, endTime, trades: 0, netProfitPct: 0, winRatePct: 0, maxDrawdownPct: 0 }
  }

  const startEquity = points[0].value
  const endEquity = points[points.length - 1].value
  const netProfitPct = startEquity > 0 ? ((endEquity - startEquity) / startEquity) * 100 : 0

  let peak = -Infinity
  let maxDrawdownPct = 0
  for (const point of points) {
    peak = Math.max(peak, point.value)
    if (peak > 0) maxDrawdownPct = Math.min(maxDrawdownPct, ((point.value - peak) / peak) * 100)
  }

  const segmentTrades = trades.filter((t) => t.exitTime >= startTime && t.exitTime <= endTime)
  const wins = segmentTrades.filter((t) => t.pnl > 0).length
  const winRatePct = segmentTrades.length > 0 ? (wins / segmentTrades.length) * 100 : 0

  return { label, startTime, endTime, trades: segmentTrades.length, netProfitPct, winRatePct, maxDrawdownPct }
}

export interface OpenPositionSnapshot {
  entryTime: number
  entryPrice: number
  qty: number
  stopPrice: number
}

export interface BacktestResult {
  equityCurve: EquityPoint[]
  benchmarkCurve: EquityPoint[]
  trades: Trade[]
  stats: BacktestStats
  monthlyBreakdown: MonthlyBreakdownRow[]
  /** The position still open at the last candle, before any end-of-data force-close. */
  openPositionAtEnd: OpenPositionSnapshot | null
}

export interface RunBacktestOptions {
  /** Force-close any open position on the final candle (default true). A live/dry-run caller
   * that wants to know the strategy's actual current position should pass false — otherwise
   * that position shows up as a synthetic closed trade that never really happened. */
  forceCloseAtEnd?: boolean
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

function stdDev(values: number[]): number {
  if (values.length === 0) return 0
  const m = mean(values)
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)))
}

interface OpenPosition {
  entryPrice: number
  entryTime: number
  qty: number
  cashBefore: number
  stopPrice: number
}

// Groups closed trades by the UTC calendar month they exited in, so a strategy that looks
// profitable overall can be checked for how many months it actually lost money, and how many
// of those losing months ran back to back. Both netProfit and returnPct are trade-realized —
// a trade's full PnL is attributed to its exit month (matching how Freqtrade's own
// --breakdown month works) — rather than mark-to-market equity drift, so the two figures
// never disagree in sign for a trade that happened to be opened in an earlier month.
function computeMonthlyBreakdown(equityCurve: EquityPoint[], trades: Trade[]): MonthlyBreakdownRow[] {
  if (equityCurve.length === 0) return []

  const monthKey = (timeSec: number): string => new Date(timeSec * 1000).toISOString().slice(0, 7)

  const startEquityByMonth = new Map<string, number>()
  for (const point of equityCurve) {
    const key = monthKey(point.time)
    if (!startEquityByMonth.has(key)) startEquityByMonth.set(key, point.value)
  }

  const tradesByMonth = new Map<string, { count: number; netProfit: number }>()
  for (const trade of trades) {
    const key = monthKey(trade.exitTime)
    const entry = tradesByMonth.get(key) ?? { count: 0, netProfit: 0 }
    entry.count += 1
    entry.netProfit += trade.pnl
    tradesByMonth.set(key, entry)
  }

  return Array.from(startEquityByMonth.keys())
    .sort()
    .map((month) => {
      const startEquity = startEquityByMonth.get(month) ?? 0
      const tradeInfo = tradesByMonth.get(month)
      const netProfit = tradeInfo?.netProfit ?? 0
      return {
        month,
        trades: tradeInfo?.count ?? 0,
        netProfit,
        returnPct: startEquity > 0 ? (netProfit / startEquity) * 100 : 0
      }
    })
}

export function runBacktest(
  candles: Candle[],
  strategyId: string = DEFAULT_STRATEGY_ID,
  options: RunBacktestOptions = {}
): BacktestResult {
  const forceCloseAtEnd = options.forceCloseAtEnd ?? true
  const signals = getStrategy(strategyId).generateSignals(candles)

  let cash = STARTING_BALANCE
  const posBox: { current: OpenPosition | null } = { current: null }
  let totalFees = 0
  const trades: Trade[] = []
  const equityCurve: EquityPoint[] = []
  const benchmarkCurve: EquityPoint[] = []
  // Buy & hold is measured from the first candle the STRATEGY could actually trade on, not from
  // the first candle fetched. Anchoring it at candles[0] handed the benchmark every bit of the
  // move that happened while the strategy was still warming up its indicators and structurally
  // forced to sit in cash -- and this is the line the user compares their equity curve against.
  // Measured on real BTC data: a 1d backtest of 2023 spends 200 of 366 candles (55% of the range)
  // in warm-up, over which BTC rose 79.4%. Buy & hold was credited with all of it before the
  // strategy was allowed to place a single order, so the comparison was not one.
  const benchmarkStartIndex = candles.length > 0 ? Math.min(signals.warmupBars, candles.length - 1) : 0
  const benchmarkQty = candles.length > 0 ? STARTING_BALANCE / candles[benchmarkStartIndex].close : 0

  function equityAt(price: number): number {
    const position = posBox.current
    return position ? position.qty * price : cash
  }

  function openLong(time: number, price: number, stopPrice: number): void {
    const fee = cash * FEE_RATE
    totalFees += fee
    const notional = cash - fee
    posBox.current = { entryPrice: price, entryTime: time, qty: notional / price, cashBefore: cash, stopPrice }
    cash = 0
  }

  function closePosition(time: number, price: number, exitReason: Trade['exitReason']): void {
    const position = posBox.current
    if (!position) return
    const grossProceeds = position.qty * price
    const fee = grossProceeds * FEE_RATE
    totalFees += fee
    const netProceeds = grossProceeds - fee
    const pnl = netProceeds - position.cashBefore
    trades.push({
      side: 'long',
      entryTime: position.entryTime,
      exitTime: time,
      entryPrice: position.entryPrice,
      exitPrice: price,
      qty: position.qty,
      pnl,
      returnPct: (pnl / position.cashBefore) * 100,
      exitReason
    })
    cash = netProceeds
    posBox.current = null
  }

  for (let i = 0; i < candles.length; i++) {
    const { time, open, low, close } = candles[i]
    let justStoppedOut = false

    if (i >= signals.warmupBars) {
      const position = posBox.current
      if (position) {
        if (low <= position.stopPrice) {
          // A gap-down can open below the stop price — fill at the worse of open/stop, as a real stop order would.
          closePosition(time, Math.min(open, position.stopPrice), 'stop_loss')
          justStoppedOut = true
        } else if (signals.exits[i]) {
          closePosition(time, close, 'signal')
        }
      }

      if (!posBox.current && !justStoppedOut && signals.entries[i] && signals.stopPrices[i] !== null) {
        openLong(time, close, signals.stopPrices[i] as number)
      }
    }

    equityCurve.push({ time, value: equityAt(close) })
    // Flat at the starting balance until that point, matching the uninvested cash the strategy
    // itself is holding, so both curves start together at the same value on the same candle.
    // Mutating `<` to `<=` here survives the test suite, and is an equivalent mutant rather than a
    // gap: at i === benchmarkStartIndex the other branch computes (STARTING_BALANCE / close) *
    // close, which is the same number. Checked across 237k prices from 1e-5 to 2e5 -- it differs
    // at all for 2.66% of them and never by more than 1.8e-12, well under one ulp of 10000. A test
    // pinning that would be asserting on floating-point noise.
    benchmarkCurve.push({ time, value: i < benchmarkStartIndex ? STARTING_BALANCE : benchmarkQty * close })
  }

  const openPositionAtEnd: OpenPositionSnapshot | null = posBox.current
    ? {
        entryTime: posBox.current.entryTime,
        entryPrice: posBox.current.entryPrice,
        qty: posBox.current.qty,
        stopPrice: posBox.current.stopPrice
      }
    : null

  if (forceCloseAtEnd && posBox.current && candles.length > 0) {
    const last = candles[candles.length - 1]
    closePosition(last.time, last.close, 'end_of_data')
    equityCurve[equityCurve.length - 1] = { time: last.time, value: cash }
  }

  const finishingBalance = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].value : STARTING_BALANCE
  const monthlyBreakdown = computeMonthlyBreakdown(equityCurve, trades)
  // Counted after the force-close block, so it is 0 for a normal backtest and 1 only when a
  // caller passed forceCloseAtEnd: false and a position really is still open.
  const openTrades = posBox.current ? 1 : 0
  const stats = computeStats(trades, equityCurve, totalFees, finishingBalance, monthlyBreakdown, openTrades, signals.warmupBars)

  return { equityCurve, benchmarkCurve, trades, stats, monthlyBreakdown, openPositionAtEnd }
}

function computeStats(
  trades: Trade[],
  equityCurve: EquityPoint[],
  totalPaidFees: number,
  finishingBalance: number,
  monthlyBreakdown: MonthlyBreakdownRow[],
  openTrades: number,
  warmupBars: number
): BacktestStats {
  const totalClosedTrades = trades.length
  const totalNetProfit = finishingBalance - STARTING_BALANCE
  const totalNetProfitPct = (totalNetProfit / STARTING_BALANCE) * 100

  let peak = -Infinity
  let maxDrawdownPct = 0
  for (const point of equityCurve) {
    peak = Math.max(peak, point.value)
    if (peak > 0) maxDrawdownPct = Math.min(maxDrawdownPct, ((point.value - peak) / peak) * 100)
  }

  const periodDays =
    equityCurve.length > 1 ? (equityCurve[equityCurve.length - 1].time - equityCurve[0].time) / 86400 : 0
  const annualReturnPct =
    periodDays >= MIN_ANNUALIZATION_DAYS
      ? ((finishingBalance / STARTING_BALANCE) ** (365 / periodDays) - 1) * 100
      : null

  const expectancy = totalClosedTrades > 0 ? totalNetProfit / totalClosedTrades : 0
  const expectancyPct = (expectancy / STARTING_BALANCE) * 100

  const winners = trades.filter((t) => t.pnl > 0)
  const losers = trades.filter((t) => t.pnl <= 0)
  const avgWin = mean(winners.map((t) => t.pnl))
  const avgLoss = Math.abs(mean(losers.map((t) => t.pnl)))
  const avgWinLossRatio = avgLoss > 0 ? avgWin / avgLoss : 0
  const winRatePct = totalClosedTrades > 0 ? (winners.length / totalClosedTrades) * 100 : 0

  const grossProfit = winners.reduce((a, t) => a + t.pnl, 0)
  const grossLoss = Math.abs(losers.reduce((a, t) => a + t.pnl, 0))
  const profitFactor = totalClosedTrades === 0 ? 0 : grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0

  const positiveMonths = [...monthlyBreakdown].filter((m) => m.netProfit > 0).sort((a, b) => b.netProfit - a.netProfit)
  const totalPositiveMonthProfit = positiveMonths.reduce((a, m) => a + m.netProfit, 0)
  const topThreeMonthsProfitSharePct =
    totalPositiveMonthProfit > 0
      ? (positiveMonths.slice(0, 3).reduce((a, m) => a + m.netProfit, 0) / totalPositiveMonthProfit) * 100
      : 0

  const longTrades = trades.filter((t) => t.side === 'long')
  const longPct = totalClosedTrades > 0 ? (longTrades.length / totalClosedTrades) * 100 : 0

  const holdingSec = (t: Trade): number => t.exitTime - t.entryTime
  const avgHoldingSec = mean(trades.map(holdingSec))
  const winningAvgHoldingSec = mean(winners.map(holdingSec))
  const losingAvgHoldingSec = mean(losers.map(holdingSec))

  const periodReturns: number[] = []
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].value
    if (prev > 0) periodReturns.push(equityCurve[i].value / prev - 1)
  }
  const avgIntervalSec =
    equityCurve.length > 1 ? (equityCurve[equityCurve.length - 1].time - equityCurve[0].time) / (equityCurve.length - 1) : 0
  const periodsPerYear = avgIntervalSec > 0 ? (365 * 24 * 3600) / avgIntervalSec : 0
  const returnMean = mean(periodReturns)
  const returnStd = stdDev(periodReturns)
  const sharpeRatio = returnStd > 0 ? (returnMean / returnStd) * Math.sqrt(periodsPerYear) : 0

  const downsideDev = Math.sqrt(mean(periodReturns.map((r) => (r < 0 ? r * r : 0))))
  const sortinoRatio = downsideDev > 0 ? (returnMean / downsideDev) * Math.sqrt(periodsPerYear) : 0

  const calmarRatio =
    annualReturnPct !== null && maxDrawdownPct !== 0 ? annualReturnPct / Math.abs(maxDrawdownPct) : null

  const gains = periodReturns.filter((r) => r > 0).reduce((a, b) => a + b, 0)
  const losses = Math.abs(periodReturns.filter((r) => r < 0).reduce((a, b) => a + b, 0))
  const omegaRatio = losses > 0 ? gains / losses : gains > 0 ? Infinity : 0

  let winningStreak = 0
  let losingStreak = 0
  let curWin = 0
  let curLoss = 0
  for (const t of trades) {
    if (t.pnl > 0) {
      curWin++
      curLoss = 0
    } else {
      curLoss++
      curWin = 0
    }
    winningStreak = Math.max(winningStreak, curWin)
    losingStreak = Math.max(losingStreak, curLoss)
  }

  let losingMonthsCount = 0
  let maxConsecutiveLosingMonths = 0
  let curLosingMonths = 0
  for (const m of monthlyBreakdown) {
    if (m.returnPct < 0) {
      losingMonthsCount++
      curLosingMonths++
      maxConsecutiveLosingMonths = Math.max(maxConsecutiveLosingMonths, curLosingMonths)
    } else {
      curLosingMonths = 0
    }
  }

  return {
    totalClosedTrades,
    totalNetProfit,
    totalNetProfitPct,
    startingBalance: STARTING_BALANCE,
    finishingBalance,
    openTrades,
    totalPaidFees,
    maxDrawdownPct,
    periodDays,
    warmupBars,
    annualReturnPct,
    expectancy,
    expectancyPct,
    avgWin,
    avgLoss,
    avgWinLossRatio,
    winRatePct,
    longPct,
    shortPct: 100 - longPct,
    avgHoldingSec,
    winningAvgHoldingSec,
    losingAvgHoldingSec,
    sharpeRatio,
    calmarRatio,
    sortinoRatio,
    omegaRatio,
    winningStreak,
    losingStreak,
    largestWinningTrade: winners.length > 0 ? Math.max(...winners.map((t) => t.pnl)) : 0,
    largestLosingTrade: losers.length > 0 ? Math.min(...losers.map((t) => t.pnl)) : 0,
    totalWinningTrades: winners.length,
    totalLosingTrades: losers.length,
    losingMonthsCount,
    maxConsecutiveLosingMonths,
    profitFactor,
    topThreeMonthsProfitSharePct
  }
}
