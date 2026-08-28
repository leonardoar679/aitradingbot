import type { Candle } from '../../shared/ipc'
import { getStrategy, DEFAULT_STRATEGY_ID } from './strategies'
import { FEE_RATE, buyFillPrice, sellFillPrice } from '../../shared/fees'
import { computeRiskRatios } from './riskStats'
import {
  ASSUMED_FUNDING_RATE,
  fundingCost,
  fundingPeriodsBetween,
  liquidationPrice,
  notionalFor,
  resolveLeverage
} from '../../shared/perp'

// The actual entry/exit/stop logic is pluggable — see src/backtest/strategies/. This engine only
// owns execution: position tracking, fees, the equity curve, and the full stats panel below. Any
// open position is force-closed on the final candle (unless forceCloseAtEnd is off). Fee is a
// flat rate applied to both entry and exit notional, shared with the executor paper simulations
// via shared/fees.ts so the two engines can never disagree on what a trade costs.
//
// SLIPPAGE IS CHARGED HERE AND NOT IN THE EXECUTORS, which is a real asymmetry and is called out
// rather than left to be discovered. Every fill in this engine is market-like -- an entry at the
// signal bar's close, a signal exit at a close, a stop that becomes a market order when touched --
// so all of them give up the spread. The executor simulations are a mixture: a Grid rung, a DCA
// level, a take-profit target and both sides of a Market Making quote all fill at their own
// resting price and slip nothing, while an Order executor's market fill, a Position executor's
// market entry, every TWAP slice and every stop exit do. An executor card is therefore
// fractionally more optimistic than a backtest of the same idea, in the flattering direction.
//
// THE FIX WAS BUILT AND DELIBERATELY NOT LANDED, so the next person weighs the same evidence
// rather than rediscovering it. The distinction is clean and small: slippage inside stopFillPrice
// (a stop is a market order once triggered), inside limitFillPrice's marketable-at-open branch
// only (a resting fill keeps its price; one that crossed the spread pays for it), and at the four
// explicit market fills -- Order's market/limit_chaser, Position's market entry, TWAP's slices,
// and the two time-limit exits. Note the two helpers take `isBuy` with OPPOSITE meanings: the
// position's side for a stop, whose fill is the exit, and the fill's own direction for a limit.
//
// What stopped it was the cost of being right about it. The change breaks 56 tests, every one of
// them a hard-coded expected value shifting by exactly 2bps (`expected 100.02 to be 100`) -- no
// hidden regressions, but 56 assertions that would have to be re-derived from buyFillPrice /
// sellFillPrice rather than re-pasted, since re-pasting would leave the suite full of magic
// numbers that no longer say why they are what they are. That is worth doing deliberately. It is
// not worth doing as a footnote to something else, for a 2bps correction to a paper-trading card,
// when the same edit made carelessly is how a suite stops catching things.
/** What a run starts with when the caller does not say. Kept as the fallback rather than
 * removed, because callers that have no capital of their own deliberately still use it --
 * see resolveStartingBalance. */
export const DEFAULT_STARTING_BALANCE = 10000

/** Every currency figure on the results page is derived from the starting balance, so a bad one
 * does not fail loudly -- it prints "NaN" beside real-looking percentages, or reports a 0% return
 * on a strategy that doubled. Both bad values arrive as ordinary numbers rather than as obvious
 * bugs: the paper account balance this is defaulted from is legitimately 0 when every asset is
 * committed to running strategies, and settings.json cannot store NaN, so one written there
 * returns as null and reads back as 0. Falling back beats simulating with money that isn't there. */
export function resolveStartingBalance(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : DEFAULT_STARTING_BALANCE
}
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
  exitReason: 'signal' | 'stop_loss' | 'trailing' | 'end_of_data' | 'liquidation'
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

export interface TrailingExit {
  /** How far up the trade must be, in percent of entry, before the give-back rule arms at all.
   *
   * Without an arming threshold the rule fires on ordinary noise straight after entry and turns
   * every trade into a scratch. It exists so the rule only protects a gain already worth
   * protecting. */
  armAtPct: number
  /** Exit once the close falls this far, in percent, below the highest close seen since entry. */
  giveBackPct: number
}

export interface ReentryCooldown {
  /** Bars that must pass after an exit before a new position may open. */
  bars: number
  /** Wait only after a LOSING exit, and re-enter immediately after a winning one. */
  afterLossOnly?: boolean
}

export interface RunBacktestOptions {
  /** Force-close any open position on the final candle (default true). A live/dry-run caller
   * that wants to know the strategy's actual current position should pass false — otherwise
   * that position shows up as a synthetic closed trade that never really happened. */
  forceCloseAtEnd?: boolean
  /** Capital the run starts with, in the pair's quote asset. Defaults to
   * DEFAULT_STARTING_BALANCE. Anything that is not a positive finite number falls back to it. */
  startingBalance?: number
  /** Bank more of a move that has already been won, by exiting when it gives too much back.
   *
   * Absent means the run is bit-for-bit what it always was. This is deliberately an engine feature
   * rather than a strategy one: `generateSignals` sees only candles, so it cannot know when the
   * position opened or how far it is up, and the stop in `stopPrices` is fixed at entry by
   * construction. A path-dependent exit has to live where the position does.
   *
   * WHY IT EXISTS. Measured over the training window on three symbols, both shipped strategies
   * bank about 40% of the peak gain their winners reach, and roughly half of their losing trades
   * had been up more than 3% at some point before rolling over. See research/diag.ts. */
  trailing?: TrailingExit
  /** Refuse to re-enter for a while after closing, to sit out chop instead of trading it.
   *
   * WHY IT EXISTS. On the training window, Trend Regime's trades opened within a day of the
   * previous exit won 26% of the time against 46% for those opened after ten days or more. See
   * research/diag.ts. Path-dependent for the same reason the give-back exit is: a strategy's
   * signals are computed from candles alone and cannot know when the last position closed. */
  reentryCooldown?: ReentryCooldown
  /** Simulated leverage. Absent, or anything outside the usable range, means 1x -- the run is
   * then bit-for-bit the spot backtest it always was. Above 1x the run can be liquidated, and a
   * liquidated run ends with nothing and takes no further trades, which is the point of offering
   * it at all. */
  leverage?: number
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

interface OpenPosition {
  entryPrice: number
  entryTime: number
  /** Base-asset quantity. Sized on the NOTIONAL, so at 5x it is five times what the cash could
   * have bought outright -- which is the whole of what leverage does. */
  qty: number
  /** The account before the position was opened. At 1x this is what bought the position; above
   * 1x it is the margin backing it, and the most that can be lost. */
  cashBefore: number
  /** Charged when the position opened, on the notional. Kept so equity and P&L can be stated as
   * "margin plus the move, minus what it cost" -- the only form that is right at every leverage. */
  entryFee: number
  stopPrice: number
  /** Null at 1x, where nothing can close the position for you. */
  liquidationPrice: number | null
  /** Highest CLOSE since entry, not highest high: the give-back rule is evaluated at the close, so
   * anchoring it to a wick would measure the drop from a price the position was never offered. */
  peakClose: number
}

// Groups closed trades by the UTC calendar month they exited in, so a strategy that looks
// profitable overall can be checked for how many months it actually lost money, and how many
// of those losing months ran back to back. Both netProfit and returnPct are trade-realized —
// a trade's full PnL is attributed to its exit month (matching how Freqtrade's own
// --breakdown month works) — rather than mark-to-market equity drift, so the two figures
// never disagree in sign for a trade that happened to be opened in an earlier month.
/** What each calendar month did, measured on the equity curve rather than on trade exits.
 *
 * Attributing a trade's whole P&L to the month it CLOSED in is what this used to do, and it makes
 * the table say the opposite of the truth for any position held across a month boundary. Measured
 * on a run that gained 7-10% every month for five months: January through April each reported
 * 0.00% and May reported +28.48%, because the single trade closed in May. Worse,
 * topThreeMonthsProfitSharePct then read 100% -- a statistic whose entire purpose is to warn that
 * a result leans on a few outlier months -- about the smoothest possible gain.
 *
 * So netProfit and returnPct are now mark-to-market: what the account was worth at the end of the
 * month against what it was worth at the start, which is what every monthly return table means and
 * what the equity curve above it already shows. `trades` stays a count of positions CLOSED in the
 * month, because that is a fact about the month and is labelled as one.
 *
 * Each month's base is the previous month's closing equity, so no candle's move is counted twice
 * and none is dropped in the gap between months. The `.sort()` below is redundant today -- a Map
 * keeps insertion order and the curve arrives chronological -- and is kept because the base
 * chaining depends on the order being right, not on where it happened to come from. Mutation
 * testing records it as an equivalent mutant rather than an untested line. */
function computeMonthlyBreakdown(equityCurve: EquityPoint[], trades: Trade[]): MonthlyBreakdownRow[] {
  if (equityCurve.length === 0) return []

  const monthKey = (timeSec: number): string => new Date(timeSec * 1000).toISOString().slice(0, 7)

  const lastEquityByMonth = new Map<string, number>()
  for (const point of equityCurve) lastEquityByMonth.set(monthKey(point.time), point.value)

  const closedByMonth = new Map<string, number>()
  for (const trade of trades) {
    const key = monthKey(trade.exitTime)
    closedByMonth.set(key, (closedByMonth.get(key) ?? 0) + 1)
  }

  let base = equityCurve[0].value
  return Array.from(lastEquityByMonth.keys())
    .sort()
    .map((month) => {
      const end = lastEquityByMonth.get(month) as number
      const netProfit = end - base
      // A month that opens with nothing left has no percentage to report -- a liquidated run
      // would otherwise divide by zero and fill the column with NaN.
      const returnPct = base > 0 ? (netProfit / base) * 100 : 0
      base = end
      return { month, trades: closedByMonth.get(month) ?? 0, netProfit, returnPct }
    })
}

export function runBacktest(
  candles: Candle[],
  strategyId: string = DEFAULT_STRATEGY_ID,
  options: RunBacktestOptions = {}
): BacktestResult {
  const forceCloseAtEnd = options.forceCloseAtEnd ?? true
  const startingBalance = resolveStartingBalance(options.startingBalance)
  const leverage = resolveLeverage(options.leverage)
  // Nonsense settings are dropped rather than clamped: a give-back of 0% would exit on any tick
  // down and one of 100% can never fire, and silently substituting a working value for either
  // would run a strategy the caller did not ask for.
  const trailing =
    options.trailing &&
    Number.isFinite(options.trailing.armAtPct) &&
    options.trailing.armAtPct >= 0 &&
    Number.isFinite(options.trailing.giveBackPct) &&
    options.trailing.giveBackPct > 0 &&
    options.trailing.giveBackPct < 100
      ? options.trailing
      : undefined
  const cooldown =
    options.reentryCooldown && Number.isFinite(options.reentryCooldown.bars) && options.reentryCooldown.bars > 0
      ? options.reentryCooldown
      : undefined
  const signals = getStrategy(strategyId).generateSignals(candles)

  let cash = startingBalance
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
  const benchmarkQty = candles.length > 0 ? startingBalance / candles[benchmarkStartIndex].close : 0

  /** Funding owed on an open position up to `time`. Always 0 at 1x -- spot has no funding. */
  function fundingSoFar(position: OpenPosition, time: number): number {
    if (leverage === 1) return 0
    return fundingCost({
      notionalQuote: position.qty * position.entryPrice,
      fundingRate: ASSUMED_FUNDING_RATE,
      periods: fundingPeriodsBetween(position.entryTime, time),
      side: 'buy'
    })
  }

  // Margin, plus what the position has made, minus what holding it has cost. Identical to the
  // old `qty * price` at 1x -- the algebra cancels exactly -- but that form is only right when
  // the position was bought outright, since at 5x `qty * price` is five times the money that
  // exists. Deliberately NOT floored at zero: a caller reading 0 when the true figure is negative
  // cannot tell that the position needs closing, and the loop below closes it on exactly that
  // signal. The curve never shows a negative value because the position is gone by then.
  function equityAt(price: number, time: number): number {
    const position = posBox.current
    if (!position) return cash
    return (
      position.cashBefore - position.entryFee + position.qty * (price - position.entryPrice) - fundingSoFar(position, time)
    )
  }

  function openLong(time: number, price: number, stopPrice: number): void {
    // Nothing left to trade with. Without this a liquidated run keeps opening zero-sized
    // positions for the rest of the history and fills the trade list with empty round trips.
    if (cash <= 0) return
    // Applied here rather than at the call site, so no future entry path can forget it. `price`
    // is the reference the signal was computed from; `fill` is what the order actually pays, and
    // everything downstream -- quantity, liquidation level, the recorded entry -- has to be built
    // from the second one, because that is the price the position really has.
    const fill = buyFillPrice(price)
    const notional = notionalFor(cash, leverage)
    const fee = notional * FEE_RATE
    totalFees += fee
    posBox.current = {
      entryPrice: fill,
      entryTime: time,
      // At 1x this is (cash - fee) / price, exactly as before: the fee comes out of the money
      // before it buys anything. Above 1x the fee is paid out of margin instead, because the
      // notional is borrowed and the position size is what the leverage says it is.
      qty: leverage === 1 ? (cash - fee) / fill : notional / fill,
      cashBefore: cash,
      entryFee: fee,
      stopPrice,
      liquidationPrice: liquidationPrice({ entryPrice: fill, leverage, side: 'buy' }),
      // Seeded with the reference price, not the fill: the fill is already worse by the slippage,
      // and starting the peak above where the position can ever close arms the rule a fraction
      // early on the very first bar.
      peakClose: price
    }
    cash = 0
  }

  /** True once the trade has been up by `armAtPct` and has since fallen `giveBackPct` from its
   * best close. Both are measured against the entry FILL, so the figures mean what the trade
   * actually made rather than what the signal price suggested it would. */
  function givesBackTooMuch(position: OpenPosition, close: number): boolean {
    if (!trailing) return false
    const peakGainPct = ((position.peakClose - position.entryPrice) / position.entryPrice) * 100
    if (peakGainPct < trailing.armAtPct) return false
    return close <= position.peakClose * (1 - trailing.giveBackPct / 100)
  }

  /** Bar index the last position closed on, and whether it closed at a loss. Null until the first
   * exit, so the opening trade of a run is never held back. */
  let lastExit: { index: number; lost: boolean } | null = null
  /** The bar being processed. closePosition is called from several places and from after the loop,
   * and needs the index to stamp the cooldown without every call site passing it. */
  let barIndex = 0

  function coolingDown(i: number): boolean {
    if (!cooldown || lastExit === null) return false
    if (cooldown.afterLossOnly && !lastExit.lost) return false
    return i - lastExit.index < cooldown.bars
  }

  function closePosition(time: number, referencePrice: number, exitReason: Trade['exitReason']): void {
    const position = posBox.current
    if (!position) return
    // Which exits give up the spread, stated once:
    //
    //   liquidation  no. Not a fill this account chose or received -- the exchange closes at the
    //                liquidation level and the P&L below is pinned to -cashBefore regardless, so
    //                slipping it would report a price the account never traded at for a loss that
    //                is already fixed.
    //   stop_loss    already slipped by the caller, which needs the true fill to decide whether
    //                the stop beat the liquidation level. Applying it twice would charge the
    //                spread on both sides of one sell.
    //   signal /     yes. An ordinary market sell, here.
    //   end_of_data
    const price =
      exitReason === 'liquidation' || exitReason === 'stop_loss' ? referencePrice : sellFillPrice(referencePrice)
    const exitFee = position.qty * price * FEE_RATE
    totalFees += exitFee
    const funding = fundingSoFar(position, time)
    // Margin plus the move, minus both fees and the funding. At 1x this is arithmetically the
    // same number the old `netProceeds - cashBefore` produced.
    const rawPnl = position.qty * (price - position.entryPrice) - position.entryFee - exitFee - funding
    // A liquidation costs the whole margin, and the arithmetic above does not say so on its own:
    // priced at the liquidation level the position still nominally holds the maintenance margin
    // back, which at 50x is a fifth of the deposit. The exchange keeps it, along with a
    // liquidation fee -- nobody is handed a fifth of their money back for being wiped out. This
    // also keeps the figure identical to the paper Position executor, which books -amountQuote:
    // two engines disagreeing about what the worst outcome costs is worse than either answer.
    //
    // Every other exit is clamped rather than replaced, so a gap that fills far through a stop
    // cannot report the account owing money it never had.
    const pnl = exitReason === 'liquidation' ? -position.cashBefore : Math.max(rawPnl, -position.cashBefore)
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
    cash = position.cashBefore + pnl
    posBox.current = null
    lastExit = { index: barIndex, lost: pnl < 0 }
  }

  for (let i = 0; i < candles.length; i++) {
    barIndex = i
    const { time, open, low, close } = candles[i]
    let justStoppedOut = false

    if (i >= signals.warmupBars) {
      const position = posBox.current
      if (position) {
        // Updated before the exit checks read it. Moving it after them is an EQUIVALENT mutant
        // rather than a bug, and it is worth saying why so nobody "fixes" it in either direction:
        // on a bar that raises the peak the test becomes close <= close * (1 - giveBack), false
        // for any positive give-back, and on a bar that does not raise it both orderings see the
        // same peak. Before is kept because it reads as what the rule means -- the best close so
        // far, including this one.
        position.peakClose = Math.max(position.peakClose, close)
        const stopHit = low <= position.stopPrice
        // A gap-down can open below the stop price — fill at the worse of open/stop, as a real stop order would.
        // Slippage is applied HERE rather than left to closePosition, because the comparison just
        // below decides whether the stop beat the liquidation level by looking at the price the
        // stop actually got. Comparing an idealised fill against the level and then recording a
        // slipped one would let a trade report a stop_loss exit at a price below its own
        // liquidation level -- the engine saying the stop saved the position and, in the same
        // row, that it filled past the point where there was nothing left to save.
        const stopFill = stopHit ? sellFillPrice(Math.min(open, position.stopPrice)) : null
        const liq = position.liquidationPrice
        const liqHit = liq !== null && low <= liq
        // A stop set inside the liquidation level is exactly what it is for: price reaches it
        // first on the way down and the position exits there. A candle that gaps through both
        // fills the stop at the open, which is already past the level -- the stop came too late,
        // and reporting it as a stop-loss would tell the user their stop protected them when the
        // position had already been closed out from under it.
        const savedByStop = stopFill !== null && liq !== null && stopFill > liq

        // Margin can run out without the price ever reaching the liquidation level, because the
        // price is not the only thing taking from it. At 100x, funding alone is 1% of the margin
        // every eight hours while the entry fee is another 10% up front -- a position held long
        // enough is finished by the cost of holding it, on a chart that never went against it.
        // The level above cannot see any of that, so equity is checked as well, and reaching zero
        // is a liquidation by the same name and for the same reason: there is nothing left to
        // hold the position with.
        if (liqHit && !savedByStop) {
          closePosition(time, liq as number, 'liquidation')
          justStoppedOut = true
        } else if (stopHit) {
          closePosition(time, stopFill as number, 'stop_loss')
          justStoppedOut = true
        } else if (signals.exits[i]) {
          closePosition(time, close, 'signal')
        } else if (givesBackTooMuch(position, close)) {
          // After the strategy's own exit, never before it. The strategy's rule is the primary
          // one; this only catches a position the rule is still holding while the gain that made
          // it worth holding drains away.
          closePosition(time, close, 'trailing')
        } else if (equityAt(close, time) <= 0) {
          // Last, and only for a position that survived everything the candle's prices did to it.
          // Ahead of the stop it would override a stop that had already filled higher up, turning
          // a protected exit into a wipeout on the strength of a price the position never saw.
          closePosition(time, close, 'liquidation')
          justStoppedOut = true
        }
      }

      if (
        !posBox.current &&
        !justStoppedOut &&
        signals.entries[i] &&
        signals.stopPrices[i] !== null &&
        !coolingDown(i)
      ) {
        openLong(time, close, signals.stopPrices[i] as number)
      }
    }

    equityCurve.push({ time, value: equityAt(close, time) })
    // Flat at the starting balance until that point, matching the uninvested cash the strategy
    // itself is holding, so both curves start together at the same value on the same candle.
    // Mutating `<` to `<=` here survives the test suite, and is an equivalent mutant rather than a
    // gap: at i === benchmarkStartIndex the other branch computes (startingBalance / close) *
    // close, which is the same number. Checked across 237k prices from 1e-5 to 2e5 -- it differs
    // at all for 2.66% of them and never by more than 1.8e-12, well under one ulp of 10000. A test
    // pinning that would be asserting on floating-point noise.
    benchmarkCurve.push({ time, value: i < benchmarkStartIndex ? startingBalance : benchmarkQty * close })
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

  const finishingBalance = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].value : startingBalance
  const monthlyBreakdown = computeMonthlyBreakdown(equityCurve, trades)
  // Counted after the force-close block, so it is 0 for a normal backtest and 1 only when a
  // caller passed forceCloseAtEnd: false and a position really is still open.
  const openTrades = posBox.current ? 1 : 0
  const stats = computeStats(trades, equityCurve, totalFees, startingBalance, finishingBalance, monthlyBreakdown, openTrades, signals.warmupBars)

  return { equityCurve, benchmarkCurve, trades, stats, monthlyBreakdown, openPositionAtEnd }
}

function computeStats(
  trades: Trade[],
  equityCurve: EquityPoint[],
  totalPaidFees: number,
  startingBalance: number,
  finishingBalance: number,
  monthlyBreakdown: MonthlyBreakdownRow[],
  openTrades: number,
  warmupBars: number
): BacktestStats {
  const totalClosedTrades = trades.length
  const totalNetProfit = finishingBalance - startingBalance
  const totalNetProfitPct = (totalNetProfit / startingBalance) * 100

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
      ? ((finishingBalance / startingBalance) ** (365 / periodDays) - 1) * 100
      : null

  const expectancy = totalClosedTrades > 0 ? totalNetProfit / totalClosedTrades : 0
  const expectancyPct = (expectancy / startingBalance) * 100

  const winners = trades.filter((t) => t.pnl > 0)
  const losers = trades.filter((t) => t.pnl <= 0)
  const avgWin = mean(winners.map((t) => t.pnl))
  const avgLoss = Math.abs(mean(losers.map((t) => t.pnl)))
  // Unbounded rather than 0 when nothing lost. Reported as 0, a flawless run showed the WORST
  // possible value in this row while the profit factor immediately below it showed the best --
  // two adjacent rows contradicting each other about the same fact. Infinity is the convention
  // already used there, and formatRatio already prints it as an infinity sign.
  const avgWinLossRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0
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

  // Measured from the first candle the strategy could trade on, not from the first candle fetched
  // -- the warm-up stretch contributes only structural zeros, and they drag every ratio toward
  // zero. Same correction the benchmark curve above already gets, for the same reason.
  const { sharpeRatio, sortinoRatio, omegaRatio } = computeRiskRatios(equityCurve, warmupBars)

  const calmarRatio =
    annualReturnPct !== null && maxDrawdownPct !== 0 ? annualReturnPct / Math.abs(maxDrawdownPct) : null

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
    startingBalance,
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
    // Guarded like longPct above: 100 - 0 claimed '100% shorts' on a run with no trades.
    shortPct: totalClosedTrades > 0 ? 100 - longPct : 0,
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
