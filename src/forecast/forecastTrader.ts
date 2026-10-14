import { ENGLISH, type I18n } from '../../shared/i18n/translate'
import { classKeyWords, HORIZON_NAME } from '../../shared/forecast/words'
import { noticeI18n } from '../i18n/current'
import type { AppSettings, Candle, ExecutorConfig, PositionExecutorParams } from '../../shared/ipc'
import { riskModeOf, targetLevelOf } from '../../shared/appDefaults'
import { SLIPPAGE_RATE } from '../../shared/fees'
import { classTradable } from '../../shared/forecast/opportunityClass'
import type { PricePrediction } from '../../shared/forecast/prediction'
import type { ForecastRanking } from '../../shared/forecast/ranking'
import { planValid, tradePlanOf, type TradePlan } from '../../shared/forecast/tradePlan'
import type { ForecastTradeMark } from '../../shared/forecast/trader'
import { healForecastSettings } from '../../shared/forecast/training'
import { bookSpreadPct, livePaperBlock, type LiveBook } from '../../shared/liveMarket'
import { paperCloseNotice, type NoticeExtra } from '../../shared/notices'
import { correlatedExposureBlock, readBtcCorrelation } from '../../shared/paperExposure'
import { healPaperPause, paperPauseBlock } from '../../shared/paperPause'
import { healPaperRisk, paperEquity, paperOutBlock, rMultiple, sizePaperTrade } from '../../shared/paperRisk'
import { settleExecutorOnStop } from '../account/settleExecutor'
import { runExecutorSimulation } from '../executors/engine'
import { settingsWrites } from '../utils/settingsWrites'

// THE ONE FILE OF THE FORECAST TRADER'S THAT WRITES ANYTHING (the V6 document, §66-68; V6 Stage 12, 13
// October 2026; the rules are shared/forecast/{tradePlan,opportunityClass,trader}.ts).
//
// START AI TRADING. Switched on (off until a person does), after each of the forecast's passes, each
// TRADE decision in the ranking's order -- in an APPROVED or a PROBATION opportunity class -- becomes a
// PAPER Position executor from its trade plan, appended to the executors on file, unless: the trader's
// own losing run has paused it (shared/paperPause.ts); it has as many open as the risk mode keeps, or
// as many on that side, or one on the pair already; the live price is stale or its spread too wide
// (shared/liveMarket.ts); the plan is no longer good at the live price; sized by the risk mode it would
// stake under what an order on Binance must be worth (shared/paperRisk.ts); or it would take what the
// app's own paper trades stake together past the cap, or past it on one side on coins that move with
// Bitcoin (shared/paperExposure.ts). And a trade of its own that has closed -- its stop, its target or
// its clock ended it, or its entry expired unfilled -- is stopped and its result settled into the paper
// account, as pressing Stop on its card would.
//
// PAPER IS WRITTEN HERE AS A LITERAL. forecastPaperExecutor takes no mode and has no way to be given
// one. Nothing in this file mentions the bridge a real order travels over, nor hands anything to an
// order form; tests/aiNoLivePath.test.ts reads this file to make sure of both.
//
// EVERY WRITE GOES THROUGH THE ONE QUEUE (src/utils/settingsWrites.ts), on executors read inside it.

export interface ForecastTraderDeps {
  getSettings: () => Promise<Pick<AppSettings, 'executors' | 'paperAccount' | 'paperRisk' | 'paperPause' | 'forecast'>>
  setExecutors: (executors: ExecutorConfig[]) => Promise<void>
  ranking: () => Promise<ForecastRanking>
  predictions: () => Promise<PricePrediction[]>
  /** The live book now (shared/liveMarket.ts), or null when none can be had: no trade is opened then. */
  liveBook: (symbol: string) => Promise<LiveBook | null>
  /** The pair's hourly moves over the last week against Bitcoin's (shared/paperExposure.ts), or null. */
  btcCorrelation: (symbol: string) => Promise<number | null>
  /** One-minute candles of [startSec, endSec], for settling. */
  fetchCandles: (symbol: string, startSec: number, endSec: number) => Promise<Candle[]>
  settle: (executor: ExecutorConfig, nowSec: number) => Promise<unknown>
  notify: (title: string, body: string, extra?: NoticeExtra) => void
  nowSec: () => number
  newId: () => string
  queue: <T>(work: () => Promise<T>) => Promise<T>
  /** The language its card's lines and its notices are in (V6 Stage 14); English where absent. */
  i18n?: () => I18n
}

/** The forecast trader's paper trades among the executors: paper Positions carrying its mark. */
export function forecastPaperExecutors(executors: readonly ExecutorConfig[]): ExecutorConfig[] {
  return executors.filter((executor) => executor.mode === 'paper' && executor.type === 'position' && executor.forecast !== undefined)
}

/** The executor a plan becomes. Paper, unlevered, entered at market inside the plan's zone until its
 * next close, with its stop, target and horizon, and its position not kept when it stops. */
export function forecastPaperExecutor(input: {
  id: string
  plan: TradePlan
  prediction: PricePrediction
  mark: ForecastTradeMark
  amountQuote: number
  nowSec: number
}): ExecutorConfig {
  const { plan } = input
  const params: PositionExecutorParams = {
    side: plan.side === 'BUY' ? 'buy' : 'sell',
    entryPrice: null,
    amountQuote: input.amountQuote,
    takeProfitPct: Math.round(plan.targetPct * 100) / 100,
    stopLossPct: Math.round(plan.stopPct * 100) / 100,
    timeLimitSec: plan.holdSec,
    trailingStop: null,
    entryExpiresAt: plan.validUntil,
    entryRange: { min: plan.entryMin, max: plan.entryMax },
    slippageRate: SLIPPAGE_RATE
  }
  return {
    id: input.id,
    name: `Forecast ${plan.side} ${plan.pair}`,
    type: 'position',
    exchange: 'binance',
    symbol: plan.pair,
    baseAsset: plan.pair.replace(/USDT$/, ''),
    quoteAsset: 'USDT',
    createdAt: input.nowSec,
    status: 'active',
    stoppedAt: null,
    keepPosition: false,
    mode: 'paper',
    forecast: input.mark,
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params
  }
}

export interface ForecastTraderResult {
  opened: string[]
  /** Each TRADE decision not opened, and why: said in the trader's language, for its card. */
  refused: { pair: string; why: string }[]
}

const mid = (book: LiveBook): number => (book.bid + book.ask) / 2

/** One pass: every TRADE decision the trader may open, opened. Nothing while it is switched off. */
export async function openForecastTrades(deps: ForecastTraderDeps): Promise<ForecastTraderResult> {
  const result: ForecastTraderResult = { opened: [], refused: [] }
  // Its card's lines and its notices in the person's language (V6 Stage 14); nothing decides by them.
  const say = deps.i18n?.() ?? ENGLISH
  const { t } = say
  const settings = await deps.getSettings()
  const forecast = healForecastSettings(settings.forecast)
  if (!forecast.trader.enabled) return result
  const ranking = await deps.ranking()
  const trades = ranking.ranked.filter((entry) => entry.decision.decision === 'TRADE')
  if (trades.length === 0) return result
  const paused = paperPauseBlock({ setting: healPaperPause(settings.paperPause), executors: settings.executors, source: 'forecast' }, say)
  if (paused !== null) {
    for (const entry of trades) result.refused.push({ pair: entry.pair, why: paused })
    return result
  }
  const predictions = new Map((await deps.predictions()).map((prediction) => [prediction.pair, prediction]))
  const risk = healPaperRisk(settings.paperRisk)
  const targetLevel = targetLevelOf(riskModeOf({ paperRisk: risk, paperPause: healPaperPause(settings.paperPause), trader: forecast.trader }))
  for (const entry of trades) {
    const refuse = (why: string): void => void result.refused.push({ pair: entry.pair, why })
    const decision = entry.decision
    const prediction = predictions.get(entry.pair)
    if (prediction === undefined) {
      refuse(t('Its forecast is no longer held.'))
      continue
    }
    if (decision.classVerdict === null || !classTradable(decision.classVerdict)) {
      refuse(t('Its kind of opportunity ({kind}) is not approved or on probation.', { kind: decision.classKey === null ? t('not read') : classKeyWords(decision.classKey, say) }))
      continue
    }
    const book = await deps.liveBook(entry.pair)
    const nowSec = deps.nowSec()
    const blocked = livePaperBlock(book, nowSec * 1000, say)
    if (blocked !== null || book === null) {
      refuse(blocked ?? t('No live price.'))
      continue
    }
    const price = mid(book)
    const plan = tradePlanOf({ decision, prediction, livePrice: price, atr5mPct: prediction.market?.atr5mPct ?? null, targetLevel })
    if (plan === null || !planValid(plan, price, nowSec)) {
      refuse(t('Its plan does not hold at the live price: no target clears a round trip, or the next close has come.'))
      continue
    }
    const correlation = await deps.btcCorrelation(entry.pair)
    const opened = await deps.queue(async (): Promise<string | null> => {
      // Everything that counts what is open is read again here, inside the queue.
      const fresh = await deps.getSettings()
      const trader = healForecastSettings(fresh.forecast).trader
      if (!trader.enabled) return t('The forecast trader was switched off.')
      const open = forecastPaperExecutors(fresh.executors).filter((executor) => executor.status === 'active')
      if (open.some((executor) => executor.symbol === entry.pair)) return t('It already has a paper trade open on the pair.')
      if (open.length >= trader.maxOpen) return t('It has {count} paper trades open, the most the risk mode keeps.', { count: open.length })
      const sameSide = open.filter((executor) => executor.forecast?.side === plan.side).length
      if (sameSide >= trader.maxSameSide) {
        return plan.side === 'BUY'
          ? t('It has {count} paper BUYs open, the most the risk mode keeps on one side.', { count: sameSide })
          : t('It has {count} paper SELLs open, the most the risk mode keeps on one side.', { count: sameSide })
      }
      const freshRisk = healPaperRisk(fresh.paperRisk)
      const size = sizePaperTrade({ risk: freshRisk, stakeQuote: trader.stakeQuote, stopPct: plan.stopPct, quoteAsset: 'USDT', slippageRate: SLIPPAGE_RATE, equityQuote: paperEquity(fresh.paperAccount, fresh.executors, 'USDT') }, say)
      if (!size.ok) return size.reason
      const out = paperOutBlock({ risk: freshRisk, executors: fresh.executors, quoteAsset: 'USDT', amountQuote: size.amountQuote }, say)
      if (out !== null) return out
      const side = plan.side === 'BUY' ? 'buy' : 'sell'
      const correlated = correlatedExposureBlock({ account: fresh.paperAccount, risk: freshRisk, executors: fresh.executors, quoteAsset: 'USDT', side, amountQuote: size.amountQuote, correlation }, say)
      if (correlated !== null) return correlated
      const range = prediction.horizons[decision.horizon]!
      const spread = bookSpreadPct(book)
      const mark: ForecastTradeMark = {
        predictionId: prediction.id,
        barTime: prediction.barTime,
        openedAt: nowSec,
        horizon: decision.horizon,
        side: plan.side,
        classKey: decision.classKey ?? '',
        verdict: decision.classVerdict ?? 'NOT_ENOUGH',
        quantilesPct: [...range.quantilesPct],
        pUp: range.pUp,
        edgePct: decision.edge?.edgePct ?? 0,
        pProfit: decision.edge?.pProfit ?? 0,
        plan: { entryMin: plan.entryMin, entryMax: plan.entryMax, stopPct: plan.stopPct, targetPct: plan.targetPct, targetLevel: plan.targetLevel, holdSec: plan.holdSec, validUntil: plan.validUntil },
        ...(spread === null ? {} : { book: { bid: book.bid, ask: book.ask, spreadPct: spread } }),
        btcCorrelation: correlation
      }
      const executor = forecastPaperExecutor({ id: deps.newId(), plan, prediction, mark, amountQuote: size.amountQuote, nowSec })
      await deps.setExecutors([...fresh.executors, executor])
      return null
    })
    if (opened !== null) {
      refuse(opened)
      continue
    }
    result.opened.push(entry.pair)
    try {
      const values = {
        pair: entry.pair,
        horizon: say.language === 'en' ? decision.horizon : t(HORIZON_NAME[decision.horizon]),
        price: say.language === 'en' ? price.toPrecision(6) : say.num(Number(price.toPrecision(6)), 0, 10),
        stop: say.pctPlain(plan.stopPct, 2),
        target: say.pctPlain(plan.targetPct, 2),
        level: plan.targetLevel,
        minutes: Math.round(plan.holdSec / 60)
      }
      deps.notify(
        plan.side === 'BUY' ? t('Forecast paper trade: BUY {pair}', values) : t('Forecast paper trade: SELL {pair}', values),
        t('The {horizon} forecast traded, on paper: in around {price}, stop {stop} away, target {target} at its {level}, held at most {minutes} minutes. Nothing real was placed.', values),
        { kind: 'TRADE_EXECUTED', severity: 'watch', thread: `forecast-trade:${entry.pair}` }
      )
    } catch {
      // A desktop that cannot show it is not a reason to report a trade that opened as not.
    }
  }
  return result
}

/** Every open trade of the trader's that has closed, stopped and settled; what it made on its mark. */
export async function settleForecastTrades(deps: ForecastTraderDeps): Promise<string[]> {
  const settled: string[] = []
  const { executors } = await deps.getSettings()
  for (const executor of forecastPaperExecutors(executors).filter((entry) => entry.status === 'active')) {
    try {
      const nowSec = deps.nowSec()
      const candles = (await deps.fetchCandles(executor.symbol, executor.createdAt, nowSec)).filter((bar) => bar.time + 60 <= nowSec)
      if (candles.length === 0) continue
      const state = runExecutorSimulation(candles, executor, candles[0].close)
      if (state.kind !== 'position' || state.status !== 'closed' || state.exitReason === null) continue
      const ended = { exit: state.exitReason, pnlQuote: state.realizedPnl ?? 0, closedAt: state.closedAt ?? nowSec }
      const stopped = await deps.queue(async (): Promise<boolean> => {
        const fresh = await deps.getSettings()
        const current = fresh.executors.find((entry) => entry.id === executor.id)
        if (current?.status !== 'active' || current.forecast === undefined) return false
        const done: ExecutorConfig = { ...current, status: 'stopped', stoppedAt: nowSec, forecast: { ...current.forecast, result: ended } }
        await deps.setExecutors(fresh.executors.map((entry) => (entry.id === executor.id ? done : entry)))
        return true
      })
      if (!stopped) continue
      await deps.settle(executor, nowSec)
      settled.push(executor.name)
      if (ended.exit !== 'entry_expired') {
        const params = executor.params as PositionExecutorParams
        const closed = paperCloseNotice(
          { id: executor.id, symbol: executor.symbol, side: params.side, quoteAsset: executor.quoteAsset },
          { exit: ended.exit, pnlQuote: ended.pnlQuote, r: rMultiple(ended.pnlQuote, params) },
          deps.i18n?.() ?? ENGLISH
        )
        try {
          deps.notify(closed.title, closed.body, closed.extra)
        } catch {
          // A desktop that cannot show it is not a reason to report a trade that closed as not.
        }
      }
    } catch (failure) {
      // One trade whose candles could not be read is tried again next pass; the others go on.
      console.error(`The forecast trader could not settle its paper trade "${executor.name}":`, failure)
    }
  }
  return settled
}

export const forecastTraderBrowserDeps: ForecastTraderDeps = {
  getSettings: () => window.api.settings.get(),
  setExecutors: async (executors) => {
    await window.api.settings.set({ executors })
  },
  ranking: () => window.api.forecast.ranking(),
  predictions: () => window.api.forecast.list(),
  liveBook: (symbol) => window.api.market.liveBook(symbol),
  btcCorrelation: (symbol) =>
    readBtcCorrelation(
      async (from, pair, startSec, endSec) => (await window.api.market.fetchHistoricalRange(from, pair, '1h', startSec, endSec)).candles,
      'binance',
      symbol,
      Math.floor(Date.now() / 1000)
    ),
  fetchCandles: async (symbol, startSec, endSec) => (await window.api.market.fetchHistoricalRange('binance', symbol, '1m', startSec, endSec)).candles,
  // Not kept in Inventory (keepPosition is false), so nothing was handed over and the whole result is cash.
  settle: (executor, nowSec) => settleExecutorOnStop({ executor, handedOver: { held: null, realizedPnl: 0 }, now: nowSec }),
  notify: (title, body, extra) => void window.api.notify(title, body, extra?.severity, extra).catch(() => undefined),
  nowSec: () => Math.floor(Date.now() / 1000),
  newId: () => crypto.randomUUID(),
  queue: (work) => settingsWrites(work),
  i18n: noticeI18n
}
