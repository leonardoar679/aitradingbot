import { ENGLISH, msg, type I18n } from '../../shared/i18n/translate'
import { HORIZON_NAME } from '../../shared/forecast/words'
import { noticeI18n } from '../i18n/current'
import type { AppSettings, Candle, Exchange, ExecutorConfig, LiveOrderRecord, PositionExecutorParams } from '../../shared/ipc'
import { paperFillOf } from '../../shared/venueCosts'
import { riskModeOf, targetLevelOf } from '../../shared/appDefaults'
import { SLIPPAGE_RATE } from '../../shared/fees'
import { LAB_RISK, LAB_STRATEGIES, classOnly, labDailyNet, labDayOf, labPaperExecutors, labStopReached, labStrategiesOf, sensitivityCounts, type LabStrategy, type LabTradeMark } from '../../shared/forecast/labTrader'
import type { PricePrediction } from '../../shared/forecast/prediction'
import type { ForecastRanking } from '../../shared/forecast/ranking'
import { decideOnBook, heldBackByPrice } from '../../shared/forecast/tradeDecision'
import { planValid, tradePlanOf, type TradePlan } from '../../shared/forecast/tradePlan'
import { healForecastSettings } from '../../shared/forecast/training'
import { bookSpreadPct, livePaperBlock, type LiveBook } from '../../shared/liveMarket'
import { paperCloseNotice, type NoticeExtra } from '../../shared/notices'
import { correlatedExposureBlock, readBtcCorrelation } from '../../shared/paperExposure'
import { healPaperPause } from '../../shared/paperPause'
import { healPaperRisk, paperEquity, paperOutBlock, rMultiple, sizePaperTrade } from '../../shared/paperRisk'
import { emptyAccount, fund } from '../account/paperAccount'
import { settleExecutorOnStop } from '../account/settleExecutor'
import { QUANTS, quantSideAt, quantSpan } from '../agents/quantState'
import { runExecutorSimulation } from '../executors/engine'
import { settingsWrites } from '../utils/settingsWrites'

// THE ONE FILE OF THE PAPER LABORATORY'S THAT WRITES ANYTHING (V7.1 Stage 4, 16 October 2026; the rules
// are shared/forecast/labTrader.ts). After each of the forecast's passes, each strategy switched on takes
// up the ranked forecasts it qualifies for, in the ranking's order -- a call the pass held back by the live
// price alone decided again on the book it reads, as the forecast trader does -- and opens a PAPER Position
// from its trade plan under the laboratory's caps: a quarter of a percent of the paper account's equity
// risked at the stop, a tenth of the equity staked at most, three open at once, one a pair, the money-out
// and correlated-side caps of Risk & Safety, and the DAILY STOP once the day's closed trades have lost
// 1.5% of the equity, told once. A trade that has closed is stopped and settled into the paper account, as
// the forecast trader's are. FUND fills the paper account to 10,000 USDT on a click, never by itself.
//
// THE DEMO ACCOUNT (V7.1 Stage 8; the user's answer of 16 October 2026). Set to it on the Lab's card, the
// laboratory sends each BUY it would have opened on paper to Bitget's demo account instead, over the demo
// bridge alone (window.api.demoTrading: play money the exchange gives, in ledgers of its own, through the
// one module whose requests Bitget refuses with a real key) -- the entry filled at the demo book's price
// and watched there by the demo watcher, which closes it by the plan's stop, target or time; what it made
// is read back from the demo ledger and written on the trade's mark, as a paper trade's is from the
// candles. A SELL stays paper whatever the setting: spot has no short. The caps are the same.
//
// PAPER AND DEMO ARE WRITTEN HERE AS LITERALS, each once, and the live mode nowhere: labPaperExecutor can
// make nothing else. Nothing in this file mentions the bridge a real order travels over, nor hands anything
// to an order form; tests/aiNoLivePath.test.ts reads this file to make sure of all of it.
//
// EVERY WRITE GOES THROUGH THE ONE QUEUE (src/utils/settingsWrites.ts), on settings read inside it.

/** What the demo account's bridge gives the laboratory: an entry, a watcher, and whether a demo key is
 * stored at all. */
export interface LabDemoDeps {
  keyStored: () => Promise<boolean>
  place: (symbol: string, side: 'buy', quoteAmount: number) => Promise<LiveOrderRecord>
  watch: (executorId: string, symbol: string, entryPrice: number, takeProfitPct: number | null, stopLossPct: number | null, timeLimitSec: number | null) => Promise<{ id: string }>
}

export interface LabTraderDeps {
  getSettings: () => Promise<Pick<AppSettings, 'executors' | 'paperAccount' | 'paperRisk' | 'paperPause' | 'forecast'>>
  setSettings: (patch: Partial<Pick<AppSettings, 'executors' | 'paperAccount' | 'forecast'>>) => Promise<void>
  ranking: () => Promise<ForecastRanking>
  predictions: () => Promise<PricePrediction[]>
  /** The live book now (shared/liveMarket.ts), or null when none can be had: no trade is opened then. */
  liveBook: (symbol: string) => Promise<LiveBook | null>
  /** The pair's hourly moves over the last week against Bitcoin's (shared/paperExposure.ts), or null. */
  btcCorrelation: (symbol: string) => Promise<number | null>
  /** Trend Regime 4h's side on the pair at the moment (src/agents/quantState.ts), or null where it cannot
   * be read: the hybrid's reading. */
  quantSide: (symbol: string, nowSec: number) => Promise<'long' | 'short' | null>
  /** One-minute candles of [startSec, endSec], for settling. */
  /** A trade's minute candles on the venue it is traded on (V7.2-R Stage 4: Binance or Bitget). */
  fetchCandles: (exchange: Exchange, symbol: string, startSec: number, endSec: number) => Promise<Candle[]>
  settle: (executor: ExecutorConfig, nowSec: number) => Promise<unknown>
  notify: (title: string, body: string, extra?: NoticeExtra) => void
  nowSec: () => number
  newId: () => string
  queue: <T>(work: () => Promise<T>) => Promise<T>
  /** The language its notices are in (V6 Stage 14); English where absent. */
  i18n?: () => I18n
  /** The demo account's bridge (V7.1 Stage 8); absent where the laboratory can only trade on paper. */
  demo?: LabDemoDeps
}

export const LAB_STRATEGY_NAME: Record<LabStrategy, string> = { strict: msg('STRICT'), direction: msg('DIRECTION'), news: msg('NEWS EVENT'), hybrid: msg('HYBRID') }

export interface LabPassResult {
  opened: { pair: string; strategy: LabStrategy }[]
  /** Each forecast a strategy took up and did not open, and why: said in the laboratory's language. */
  refused: { pair: string; why: string }[]
  /** The predeclared sensitivity counts of the pass, by P(up) line (shared/forecast/labTrader.ts). */
  sensitivity: Record<string, number>
  /** Why the whole pass opened nothing, where one thing stopped it: the daily stop, or no account. */
  held: string | null
}

const mid = (book: LiveBook): number => (book.bid + book.ask) / 2
const QUOTE = 'USDT'

/** The executor a plan becomes under the laboratory. Paper, unlevered, entered at market inside the plan's
 * zone until its next close, with its stop, target and horizon, and its position not kept when it stops;
 * or, on the demo account (V7.1 Stage 8), the same trade with its mode and exchange the demo's. */
export function labPaperExecutor(input: { id: string; plan: TradePlan; mark: LabTradeMark; amountQuote: number; nowSec: number }, demo = false): ExecutorConfig {
  const { plan } = input
  const fill = paperFillOf(plan.cost)
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
    // On the venue its decision was costed on, at its fee, each market fill a half spread and an impact worse
    // (V7.2-R Stage 4); on Binance at the flat lines where no venue's book was read.
    slippageRate: fill.slippageRate,
    feeRate: fill.feeRate
  }
  return {
    id: input.id,
    name: `Lab ${input.mark.strategy} ${plan.side} ${plan.pair}${demo ? ' (demo)' : fill.exchange === 'bitget' ? ' (Bitget)' : ''}`,
    type: 'position',
    symbol: plan.pair,
    baseAsset: plan.pair.replace(/USDT$/, ''),
    quoteAsset: QUOTE,
    createdAt: input.nowSec,
    status: 'active',
    stoppedAt: null,
    keepPosition: false,
    ...(demo ? { mode: 'demo' as const, exchange: 'bitget' as const } : { mode: 'paper' as const, exchange: fill.exchange }),
    lab: input.mark,
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

/** One pass: every forecast a strategy switched on qualifies for, opened under the caps; nothing while
 * every strategy is off. */
export async function openLabTrades(deps: LabTraderDeps): Promise<LabPassResult> {
  const say = deps.i18n?.() ?? ENGLISH
  const { t } = say
  const result: LabPassResult = { opened: [], refused: [], sensitivity: {}, held: null }
  const settings = await deps.getSettings()
  const forecast = healForecastSettings(settings.forecast)
  const on = LAB_STRATEGIES.filter((strategy) => forecast.lab.strategies[strategy])
  if (on.length === 0) return result
  const predictions = await deps.predictions()
  result.sensitivity = sensitivityCounts(predictions)
  const nowSec = deps.nowSec()
  const equity = paperEquity(settings.paperAccount, settings.executors, QUOTE)
  if (equity === null) {
    result.held = t('The laboratory has no paper account funded in USDT: fund it on the Forecast Lab.')
    return result
  }
  // The demo account (V7.1 Stage 8): wanted by the setting, had only with a demo key stored; set to it
  // without one, the laboratory opens nothing and says why, rather than trading paper unasked.
  const demoWanted = forecast.lab.execution === 'demo'
  const demo = demoWanted && deps.demo !== undefined && (await deps.demo.keyStored()) ? deps.demo : null
  if (demoWanted && demo === null) {
    result.held = t('The laboratory is set to the demo account, but no Bitget demo key is stored: add one on Connections, or set it back to paper.')
    return result
  }
  // The daily stop: written down once reached, and held to until the next UTC day.
  const today = labDayOf(nowSec)
  if (forecast.lab.stopped !== null && forecast.lab.stopped.day === today) {
    result.held = t('The laboratory stopped for the day.')
    return result
  }
  const day = labDailyNet(settings.executors, nowSec, QUOTE)
  if (labStopReached(day.netQuote, equity)) {
    const stopped = await deps.queue(async (): Promise<boolean> => {
      const fresh = await deps.getSettings()
      const whole = healForecastSettings(fresh.forecast)
      if (whole.lab.stopped !== null && whole.lab.stopped.day === today) return false
      await deps.setSettings({ forecast: { ...whole, lab: { ...whole.lab, stopped: { day: today, at: nowSec, lossQuote: -day.netQuote, equityQuote: equity } } } })
      return true
    })
    if (stopped) {
      try {
        deps.notify(
          t('The paper laboratory stopped for the day'),
          t('Its trades closed today lost {loss} USDT together, {share} of its {equity} USDT: it opens none until tomorrow (UTC). Nothing real was placed or closed.', {
            loss: say.num(-day.netQuote, 2, 2),
            share: say.pctPlain((-day.netQuote / equity) * 100, 2),
            equity: say.num(equity, 0, 2)
          }),
          { kind: 'CIRCUIT_BREAKER', severity: 'high', thread: `lab-stop:${today}` }
        )
      } catch {
        // A desktop that cannot show it is not a reason to go on trading.
      }
    }
    result.held = t('The laboratory stopped for the day.')
    return result
  }
  const ranking = await deps.ranking()
  const byPair = new Map(predictions.map((prediction) => [prediction.pair, prediction]))
  const targetLevel = targetLevelOf(riskModeOf({ paperRisk: healPaperRisk(settings.paperRisk), paperPause: healPaperPause(settings.paperPause), trader: forecast.trader }))
  for (const entry of ranking.ranked) {
    const prediction = byPair.get(entry.pair)
    if (prediction === undefined) continue
    const book = await deps.liveBook(entry.pair)
    // A call the pass held back for want of a live price, decided again on the book just read.
    const decision = book !== null && heldBackByPrice(entry.decision) ? decideOnBook(entry.decision, prediction, book, nowSec * 1000) : entry.decision
    if (decision.side === null) continue
    const quant = on.includes('hybrid') && classOnly(decision) ? await deps.quantSide(entry.pair, nowSec) : null
    const qualified = labStrategiesOf(decision, prediction, quant).filter((strategy) => on.includes(strategy))
    if (qualified.length === 0) continue
    const strategy = qualified[0]
    const refuse = (why: string): void => void result.refused.push({ pair: entry.pair, why })
    const blocked = livePaperBlock(book, nowSec * 1000, say)
    if (blocked !== null || book === null) {
      refuse(blocked ?? t('No live price.'))
      continue
    }
    const price = mid(book)
    // The plan is read as for a TRADE: the laboratory's candidates are held back by their class alone.
    const plan = tradePlanOf({ decision: { ...decision, decision: 'TRADE' }, prediction, livePrice: price, atr5mPct: prediction.market?.atr5mPct ?? null, targetLevel })
    if (plan === null || !planValid(plan, price, nowSec)) {
      refuse(t('Its plan does not hold at the live price: no target clears a round trip, or the next close has come.'))
      continue
    }
    const correlation = await deps.btcCorrelation(entry.pair)
    const opened = await deps.queue(async (): Promise<string | null> => {
      // Everything that counts what is open is read again here, inside the queue.
      const fresh = await deps.getSettings()
      const freshLab = healForecastSettings(fresh.forecast).lab
      if (!freshLab.strategies[strategy]) return t('The strategy was switched off.')
      const open = labPaperExecutors(fresh.executors).filter((executor) => executor.status === 'active')
      if (open.some((executor) => executor.symbol === entry.pair)) return t('The laboratory already has a paper trade open on the pair.')
      if (open.length >= LAB_RISK.maxOpen) return t('The laboratory has {count} paper trades open, the most it keeps.', { count: open.length })
      const freshEquity = paperEquity(fresh.paperAccount, fresh.executors, QUOTE)
      if (freshEquity === null) return t('The laboratory has no paper account funded in USDT: fund it on the Forecast Lab.')
      const stored = healPaperRisk(fresh.paperRisk)
      const risk = { ...stored, sizing: 'equity' as const, riskPct: LAB_RISK.riskPct }
      const stakeQuote = Math.floor(freshEquity * LAB_RISK.maxPositionPct) / 100
      const size = sizePaperTrade({ risk, stakeQuote, stopPct: plan.stopPct, quoteAsset: QUOTE, slippageRate: SLIPPAGE_RATE, equityQuote: freshEquity }, say)
      if (!size.ok) return size.reason
      const out = paperOutBlock({ risk: stored, executors: fresh.executors, quoteAsset: QUOTE, amountQuote: size.amountQuote }, say)
      if (out !== null) return out
      const side = plan.side === 'BUY' ? 'buy' : 'sell'
      const correlated = correlatedExposureBlock({ account: fresh.paperAccount, risk: stored, executors: fresh.executors, quoteAsset: QUOTE, side, amountQuote: size.amountQuote, correlation }, say)
      if (correlated !== null) return correlated
      const range = prediction.horizons[decision.horizon]!
      const spread = bookSpreadPct(book)
      const mark: LabTradeMark = {
        strategy,
        qualified,
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
      // A BUY goes to the demo account where the laboratory is set to it; a SELL stays paper: spot has
      // no short. The demo entry is placed here, inside the queue the caps were read in.
      const onDemo = demo !== null && plan.side === 'BUY'
      if (!onDemo) {
        const executor = labPaperExecutor({ id: deps.newId(), plan, mark, amountQuote: size.amountQuote, nowSec })
        await deps.setSettings({ executors: [...fresh.executors, executor] })
        return null
      }
      let fill: LiveOrderRecord
      try {
        fill = await demo.place(entry.pair, 'buy', size.amountQuote)
      } catch (failure) {
        return t('The demo order was refused: {reason}', { reason: failure instanceof Error ? failure.message : String(failure) })
      }
      const executor = labPaperExecutor({ id: deps.newId(), plan, mark, amountQuote: size.amountQuote, nowSec }, true)
      const params = executor.params as PositionExecutorParams
      let watcherId: string | null = null
      let watcherError: string | null = null
      try {
        watcherId = (await demo.watch(executor.id, entry.pair, fill.avgFillPrice, params.takeProfitPct, params.stopLossPct, params.timeLimitSec)).id
      } catch (failure) {
        // The demo buy filled and nothing watches it: said on the trade, never hidden; a person closes it.
        watcherError = failure instanceof Error ? failure.message : String(failure)
      }
      await deps.setSettings({
        executors: [
          ...fresh.executors,
          {
            ...executor,
            name: watcherError === null ? executor.name : `${executor.name} (filled, but unwatched: ${watcherError})`,
            params: { ...params, entryPrice: fill.avgFillPrice, entryExpiresAt: null, entryRange: null },
            liveOrder: fill,
            liveWatcherId: watcherId,
            liveWatcherError: watcherError
          }
        ]
      })
      return null
    })
    if (opened !== null) {
      refuse(opened)
      continue
    }
    result.opened.push({ pair: entry.pair, strategy })
    try {
      const values = {
        pair: entry.pair,
        strategy: t(LAB_STRATEGY_NAME[strategy]),
        horizon: t(HORIZON_NAME[decision.horizon]),
        price: say.language === 'en' ? price.toPrecision(6) : say.num(Number(price.toPrecision(6)), 0, 10),
        stop: say.pctPlain(plan.stopPct, 2),
        target: say.pctPlain(plan.targetPct, 2),
        minutes: Math.round(plan.holdSec / 60)
      }
      const onDemo = demo !== null && plan.side === 'BUY'
      deps.notify(
        onDemo ? t('Laboratory demo trade: BUY {pair}', values) : plan.side === 'BUY' ? t('Laboratory paper trade: BUY {pair}', values) : t('Laboratory paper trade: SELL {pair}', values),
        onDemo
          ? t("The {strategy} strategy traded the {horizon} forecast on Bitget's demo account, play money: in at about {price}, stop {stop} away, target {target}, held at most {minutes} minutes. A demo order was placed, not a real one.", values)
          : t('The {strategy} strategy traded the {horizon} forecast, on paper: in around {price}, stop {stop} away, target {target}, held at most {minutes} minutes. Nothing real was placed.', values),
        { kind: 'TRADE_EXECUTED', severity: 'watch', thread: `lab-trade:${entry.pair}` }
      )
    } catch {
      // A desktop that cannot show it is not a reason to report a trade that opened as not.
    }
  }
  return result
}

/** Every open trade of the laboratory's that has closed, stopped and settled; what it made on its mark. A
 * demo trade (V7.1 Stage 8) is closed by the demo watcher and stopped by the live scheduler, which writes
 * its exit on it: here that exit is read onto the laboratory's mark, once, and nothing is settled into
 * the paper account. */
export async function settleLabTrades(deps: LabTraderDeps): Promise<string[]> {
  const settled: string[] = []
  const { executors } = await deps.getSettings()
  for (const executor of labPaperExecutors(executors).filter((entry) => entry.mode === 'demo' && entry.liveExitResult !== null && entry.lab?.result === undefined)) {
    const exit = executor.liveExitResult!
    const ended = { exit: exit.exitReason, pnlQuote: exit.realizedPnl, closedAt: exit.closedAt }
    const written = await deps.queue(async (): Promise<boolean> => {
      const fresh = await deps.getSettings()
      const current = fresh.executors.find((entry) => entry.id === executor.id)
      if (current === undefined || current.lab === undefined || current.lab.result !== undefined) return false
      const done: ExecutorConfig = { ...current, status: 'stopped', stoppedAt: current.stoppedAt ?? exit.closedAt, lab: { ...current.lab, result: ended } }
      await deps.setSettings({ executors: fresh.executors.map((entry) => (entry.id === executor.id ? done : entry)) })
      return true
    })
    if (written) settled.push(executor.name)
  }
  for (const executor of labPaperExecutors(executors).filter((entry) => entry.mode === 'paper' && entry.status === 'active')) {
    try {
      const nowSec = deps.nowSec()
      const candles = (await deps.fetchCandles(executor.exchange, executor.symbol, executor.createdAt, nowSec)).filter((bar) => bar.time + 60 <= nowSec)
      if (candles.length === 0) continue
      const state = runExecutorSimulation(candles, executor, candles[0].close)
      if (state.kind !== 'position' || state.status !== 'closed' || state.exitReason === null) continue
      const ended = { exit: state.exitReason, pnlQuote: state.realizedPnl ?? 0, closedAt: state.closedAt ?? nowSec }
      const stopped = await deps.queue(async (): Promise<boolean> => {
        const fresh = await deps.getSettings()
        const current = fresh.executors.find((entry) => entry.id === executor.id)
        if (current?.status !== 'active' || current.lab === undefined) return false
        const done: ExecutorConfig = { ...current, status: 'stopped', stoppedAt: nowSec, lab: { ...current.lab, result: ended } }
        await deps.setSettings({ executors: fresh.executors.map((entry) => (entry.id === executor.id ? done : entry)) })
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
      console.error(`The paper laboratory could not settle its paper trade "${executor.name}":`, failure)
    }
  }
  return settled
}

/** FUND: the paper account filled to LAB_RISK.fundQuote USDT -- made where there is none, topped up where
 * it holds less, left as it is where it holds that or more. A click's work, never a pass's. */
export async function fundLab(deps: Pick<LabTraderDeps, 'getSettings' | 'setSettings' | 'nowSec' | 'newId' | 'queue'>): Promise<{ added: number; balance: number }> {
  return deps.queue(async (): Promise<{ added: number; balance: number }> => {
    const fresh = await deps.getSettings()
    const now = deps.nowSec()
    const account = fresh.paperAccount ?? emptyAccount(now)
    const held = Number.isFinite(account.balances[QUOTE]) ? Math.max(0, account.balances[QUOTE]) : 0
    const added = Math.max(0, Math.round((LAB_RISK.fundQuote - held) * 100) / 100)
    const next = added > 0 ? fund(account, { asset: QUOTE, amount: added, now, id: deps.newId(), note: 'The paper laboratory' }) : account
    if (added > 0 || fresh.paperAccount === null) await deps.setSettings({ paperAccount: next })
    return { added, balance: Number.isFinite(next.balances[QUOTE]) ? next.balances[QUOTE] : 0 }
  })
}

/** Trend Regime 4h's side on a pair at the moment, from its 4-hour candles over its warm-up (src/agents/
 * quantState.ts); null where the candles could not be read. */
async function quantSideOf(symbol: string, nowSec: number): Promise<'long' | 'short' | null> {
  try {
    const span = quantSpan('trend4h', { startSec: nowSec - 2 * 86_400, endSec: nowSec })
    const bars = (await window.api.market.fetchHistoricalRange('binance', symbol, QUANTS.trend4h.interval, span.startSec, span.endSec)).candles
    const side = quantSideAt('trend4h', bars, nowSec)
    return side === 'long' || side === 'short' ? side : null
  } catch {
    return null
  }
}

export const labTraderBrowserDeps: LabTraderDeps = {
  getSettings: () => window.api.settings.get(),
  setSettings: async (patch) => {
    await window.api.settings.set(patch)
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
  quantSide: quantSideOf,
  // The demo account's bridge, and nothing of the real one's (tests/aiNoLivePath.test.ts).
  demo: {
    keyStored: async () => (await window.api.credentials.list()).some((key) => key.exchange === 'bitget' && key.slot === 'demo' && key.configured),
    place: (symbol, side, quoteAmount) => window.api.demoTrading.placeOrder('bitget', symbol, symbol.replace(/USDT$/, ''), QUOTE, side, quoteAmount),
    watch: (executorId, symbol, entryPrice, takeProfitPct, stopLossPct, timeLimitSec) => window.api.demoTrading.createWatcher(executorId, 'bitget', symbol, entryPrice, takeProfitPct, stopLossPct, timeLimitSec, null)
  },
  fetchCandles: async (exchange, symbol, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, '1m', startSec, endSec)).candles,
  // Not kept in Inventory (keepPosition is false), so nothing was handed over and the whole result is cash.
  settle: (executor, nowSec) => settleExecutorOnStop({ executor, handedOver: { held: null, realizedPnl: 0 }, now: nowSec }),
  notify: (title, body, extra) => void window.api.notify(title, body, extra?.severity, extra).catch(() => undefined),
  nowSec: () => Math.floor(Date.now() / 1000),
  newId: () => crypto.randomUUID(),
  queue: (work) => settingsWrites(work),
  i18n: noticeI18n
}
