import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Zap } from 'lucide-react'
import { Card } from '../components/Card'
import { MarketConditionsCard } from './MarketConditionsCard'
import { PageHeader } from '../components/PageHeader'
import { BacktestRunningView, type RunningState } from './BacktestRunningView'
import { BacktestResultsView, type ResultsGeneralInfo } from './BacktestResultsView'
import { BacktestChartsView } from './BacktestChartsView'
import { StrategyComparisonView } from './StrategyComparisonView'
import { LiveBacktestView } from './LiveBacktestView'
import { LiveStrategyComparison } from './LiveStrategyComparison'
import { useLiveBacktest } from './useLiveBacktest'
import { runBacktest, DEFAULT_STARTING_BALANCE, type BacktestResult } from './engine'
import { MAX_LEVERAGE, MIN_LEVERAGE, isUsableLeverage, liquidationDistancePct } from '../../shared/perp'
import { availableBalance } from '../account/paperAccount'
import { committedFor } from '../account/accountCommitments'
import { describeRangeProblem, describeEmptyRange } from './rangeProblem'
import { describeError } from '../utils/ipcError'
import { STRATEGIES, DEFAULT_STRATEGY_ID, getStrategy, type StrategySignals } from './strategies'
import { generateGptIntradaySignals } from './strategies/gptIntraday'
import {
  AI_PROVIDER_LABEL,
  GPT_DECISION_EVERY_BARS,
  GPT_INTRADAY_STRATEGY_ID,
  GPT_LOOKBACK_BARS,
  GPT_MAX_DECISIONS,
  describeGptCadence,
  gptMaxSpanDays,
  type AiSignalTapeRequest
} from '../../shared/aiSignal'
import type { AiEntryPeek } from '../../shared/aiConfirm'
import { describeAiConfirmCost, describeAiRunCost, formatUsd } from '../../shared/aiCost'
import { deciderCalls, describeDecider } from '../../shared/aiPanel'
import { describeEscalation, describeRouteKind, type AiRoute } from '../../shared/aiRoute'
import { canConfirmEntries, confirmationCounts, resolveConfirmedRun, reviewEntries } from './aiConfirmation'
import { AiConfirmationCard, type ConfirmationReport } from './AiConfirmationCard'
import { formatUtcDate, formatUtcTime } from './formatTradeTime'
import { replayExecutor, type ExecutorReplayResult } from './executorReplay'
import { ExecutorBacktestView } from './ExecutorBacktestView'
import { replayController, type ControllerReplayResult } from './controllerReplay'
import { ControllerBacktestView } from './ControllerBacktestView'
import {
  EXCHANGES,
  INTERVALS,
  INTERVAL_SECONDS,
  type Candle,
  type ControllerConfig,
  type Exchange,
  type ExecutorConfig,
  type Interval,
  type PaperAccount,
  type SymbolInfo
} from '../../shared/ipc'

type Tab = 'configuration' | 'progress' | 'charts' | 'compare' | 'live'

/** A saved executor selected in the strategy dropdown, encoded so one field can carry either
 * kind of run. Executors and signal strategies are genuinely different things -- see
 * executorReplay.ts -- so they produce different result shapes rather than being forced into one. */
const EXECUTOR_PREFIX = 'executor:'

export function executorIdFromStrategyId(strategyId: string): string | null {
  return strategyId.startsWith(EXECUTOR_PREFIX) ? strategyId.slice(EXECUTOR_PREFIX.length) : null
}

/** A saved controller, encoded the same way. A controller supervises executors that may trade
 * different markets, so its run takes its symbols from them and ignores the Symbol picker. */
const CONTROLLER_PREFIX = 'controller:'

export function controllerIdFromStrategyId(strategyId: string): string | null {
  return strategyId.startsWith(CONTROLLER_PREFIX) ? strategyId.slice(CONTROLLER_PREFIX.length) : null
}

type RunState =
  | RunningState
  | {
      status: 'executor-done'
      executor: ExecutorConfig
      replay: ExecutorReplayResult
      candles: Candle[]
      elapsedSec: number
    }
  | {
      status: 'controller-done'
      controller: ControllerConfig
      replay: ControllerReplayResult
      elapsedSec: number
    }
  | {
      status: 'done'
      result: BacktestResult
      candles: Candle[]
      elapsedSec: number
      generalInfo: ResultsGeneralInfo
      logLines: string[]
      /** Present when a model was asked to confirm the strategy's entries. `result` is then the
       * run with its vetoes applied, and this carries the unconfirmed run to set beside it. */
      confirmation?: ConfirmationReport
    }

interface TradingRouteRow {
  symbol: string
  interval: Interval
  strategyId: string
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** `GPT Intraday (Paper Only, every 4 hours, two models)`: what a run was asked goes inside the
 * name's own brackets, because the label is dropped into sentences ("... strategy selected above")
 * where a trailing clause would read as part of the sentence instead of part of the name. */
function withRunNotes(name: string, everyBars: number, route: AiRoute | null): string {
  const notes = [...(everyBars > 1 ? [`every ${describeGptCadence(everyBars)}`] : []), ...(route ? [describeRouteKind(route)] : [])]
  if (notes.length === 0) return name
  return name.endsWith(')') ? `${name.slice(0, -1)}, ${notes.join(', ')})` : `${name} (${notes.join(', ')})`
}

function defaultTradingRoute(symbol: string): TradingRouteRow {
  return { symbol, interval: getStrategy(DEFAULT_STRATEGY_ID).preferredInterval, strategyId: DEFAULT_STRATEGY_ID }
}

function fieldStyle(): React.CSSProperties {
  return {
    background: 'var(--bg-app)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    padding: '0.6rem 0.75rem',
    color: 'var(--text-primary)',
    fontSize: '0.85rem'
  }
}

function tabButtonStyle(active: boolean): React.CSSProperties {
  return {
    background: 'transparent',
    border: 'none',
    padding: '0.7rem 1rem',
    fontSize: '0.85rem',
    fontWeight: active ? 700 : 500,
    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    cursor: 'pointer',
    borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`
  }
}

function SectionHeader({
  label,
  actions
}: {
  label: string
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '1.6rem 0 0.9rem' }}>
      <span style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <div style={{ flex: 1, borderBottom: '1px dashed var(--border)' }} />
      {actions}
    </div>
  )
}

/** `embedded` leaves the title to the page this sits on (Backtest & Research). */
export function BacktestPage({ embedded = false }: { embedded?: boolean } = {}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('configuration')
  const [runLabel, setRunLabel] = useState<string | null>(null)
  const [runState, setRunState] = useState<RunState | null>(null)
  const runIdRef = useRef(0)
  const activeFetchRequestIdRef = useRef<string | null>(null)
  const [exchange, setExchange] = useState<Exchange>(EXCHANGES[0].id)
  const [symbols, setSymbols] = useState<SymbolInfo[]>([])
  const [symbolsLoading, setSymbolsLoading] = useState(false)
  /** SymbolSearch already learned this lesson; this page loads its symbols separately and did
   * not. A failed list left the Route dropdown with zero options, no message anywhere on the
   * page, and Start still enabled -- because the symbol lives in state (defaulted to the
   * exchange's own default) even when nothing can be shown for it. Verified by forcing
   * market:listSymbols to throw: optionCount 0, value "", Start disabled:false, no error text. */
  const [symbolsError, setSymbolsError] = useState<string | null>(null)
  const [symbolsReloadKey, setSymbolsReloadKey] = useState(0)
  const [tradingRoute, setTradingRoute] = useState<TradingRouteRow>(() =>
    defaultTradingRoute(EXCHANGES[0].defaultSymbol.symbol)
  )
  // Polls only while the Live tab is the one on screen -- see useLiveBacktest for why a monitor
  // that keeps fetching behind a hidden tab is a background job nobody asked for.
  const live = useLiveBacktest(exchange, tradingRoute.symbol, tradingRoute.interval, tradingRoute.strategyId, tab === 'live')

  const [startDate, setStartDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 90)
    return isoDate(d)
  })
  const [endDate, setEndDate] = useState(() => isoDate(new Date()))
  const [splitDate, setSplitDate] = useState('')
  const [startingCapital, setStartingCapital] = useState(String(DEFAULT_STARTING_BALANCE))
  /** Off unless ticked: it is the one option on this page that can spend money. */
  const [aiConfirm, setAiConfirm] = useState(false)
  /** How often GPT Intraday is asked, in 15-minute bars. It sets how far back a run can reach:
   * the ceiling is on decisions, so a slower cadence spreads the same number over more days. */
  const [gptEveryBars, setGptEveryBars] = useState<number>(GPT_DECISION_EVERY_BARS[0])
  /** The route set under Settings › AI, and the default model it starts from. Read when this
   * page opens, which is every time it is navigated to: a GPT Intraday run here is one of the two
   * places a route applies, and the page says so before Start rather than only in the dialog. */
  const [aiRouting, setAiRouting] = useState<{ model: string; route: AiRoute | null } | null>(null)
  const [leverageInput, setLeverageInput] = useState('')
  /** Once the user types their own number, the account must stop overwriting it -- otherwise
   * switching to a different pair to compare silently replaces the amount they chose. State
   * rather than a ref because the caption has to stop claiming the number came from the account. */
  const [capitalTouched, setCapitalTouched] = useState(false)
  const [account, setAccount] = useState<PaperAccount | null>(null)
  const [accountExecutors, setAccountExecutors] = useState<ExecutorConfig[]>([])
  const [accountControllers, setAccountControllers] = useState<ControllerConfig[]>([])
  // Spread executors (XEMM, Arbitrage) price two markets at once and are simulated by a different
  // engine entirely, so they are not offered here rather than being offered and then failing.
  const replayableExecutors = accountExecutors.filter((e) => e.type !== 'xemm' && e.type !== 'arbitrage')
  const [compareCandles, setCompareCandles] = useState<Candle[] | null>(null)

  // Labels for an exported comparison. Derived at render from the SAME pickers the comparison
  // fetch reads, rather than from the last single-strategy run's metadata -- those can differ,
  // because Compare Strategies fetches its own candles and the user may have changed the symbol
  // since the last Start.
  const comparisonMeta = useMemo(() => {
    const info = symbols.find((sym) => sym.symbol === tradingRoute.symbol)
    return {
      exchange: EXCHANGES.find((e) => e.id === exchange)?.name ?? exchange,
      symbol: info ? `${info.baseAsset}-${info.quoteAsset}` : tradingRoute.symbol,
      interval: INTERVALS.find((iv) => iv.id === tradingRoute.interval)?.label ?? tradingRoute.interval,
      startDate,
      endDate
    }
  }, [symbols, tradingRoute.symbol, tradingRoute.interval, exchange, startDate, endDate])
  const [compareLoading, setCompareLoading] = useState(false)
  const [compareError, setCompareError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.settings
      .get()
      .then((settings) => {
        if (cancelled) return
        setAccount(settings.paperAccount ?? null)
        setAccountExecutors(settings.executors ?? [])
        setAccountControllers(settings.controllers ?? [])
      })
      .catch((error: unknown) => {
        // A backtest does not need the account -- it only defaults the capital field from it.
        // Falling back to DEFAULT_STARTING_BALANCE beats blocking the page over bookkeeping.
        console.error('Failed to read the paper account for the starting capital default:', error)
      })
    return (): void => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setSymbolsLoading(true)
    setSymbolsError(null)
    window.api.market
      .listSymbols(exchange)
      .then((list) => {
        if (!cancelled) setSymbols(list)
      })
      .catch((error) => {
        console.error('Failed to load symbols:', error)
        if (!cancelled) setSymbolsError(describeError(error))
      })
      .finally(() => {
        if (!cancelled) setSymbolsLoading(false)
      })
    return (): void => {
      cancelled = true
    }
  }, [exchange, symbolsReloadKey])

  function handleExchangeChange(next: Exchange): void {
    setExchange(next)
    const info = EXCHANGES.find((e) => e.id === next)
    setTradingRoute(defaultTradingRoute(info?.defaultSymbol.symbol ?? ''))
  }

  function updateTradingRoute(patch: Partial<TradingRouteRow>): void {
    setTradingRoute((prev) => {
      const next = { ...prev, ...patch }
      // Picking a strategy also moves the interval to the one that strategy was measured on --
      // unless this same change set the interval explicitly, in which case the user is the one
      // choosing and is not overridden.
      //
      // The two shipped trend strategies genuinely disagree about the right bar size (1h for
      // Trend Regime, 15m for Short-Term Channel; see StrategyDefinition.preferredInterval), so a
      // single page-wide default was always wrong for one of them. Executor and controller
      // replays are excluded because they are not strategies and getStrategy would fall through
      // to an unrelated default for them.
      const isStrategy = STRATEGIES.some((s) => s.id === next.strategyId)
      if (patch.strategyId !== undefined && patch.interval === undefined && isStrategy) {
        next.interval = getStrategy(next.strategyId).preferredInterval
      }
      return next
    })
  }

  // Empty until the symbol list arrives, which is why the default-capital effect below waits for
  // it: defaulting against '' would charge the run to an asset the account has never held.
  const quoteAsset = symbols.find((sym) => sym.symbol === tradingRoute.symbol)?.quoteAsset ?? ''
  // AVAILABLE, not total. Money a running paper strategy is already holding cannot also be the
  // money this backtest starts with -- the paper account on Paper Trading draws the same line.
  const accountAvailable =
    account !== null && quoteAsset !== ''
      ? availableBalance(account, quoteAsset, committedFor(accountExecutors, quoteAsset))
      : 0

  useEffect(() => {
    if (capitalTouched) return
    if (accountAvailable > 0) setStartingCapital(String(accountAvailable))
  }, [accountAvailable, capitalTouched])

  useEffect(() => {
    let cancelled = false
    window.api.ai
      .getConfig()
      .then((config) => {
        if (!cancelled) setAiRouting({ model: config.defaultModel, route: config.route })
      })
      // Nothing to say without it: the run itself reports a setting it cannot read.
      .catch(() => undefined)
    return (): void => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (tradingRoute.strategyId !== GPT_INTRADAY_STRATEGY_ID) return
    const end = new Date(`${endDate}T00:00:00Z`)
    const start = new Date(end)
    // The longest range this cadence allows, both dates included. It can be shortened by hand.
    start.setUTCDate(start.getUTCDate() - (gptMaxSpanDays(gptEveryBars) - 1))
    setStartDate(isoDate(start))
  }, [tradingRoute.strategyId, endDate, gptEveryBars])

  // Blank means spot, and blank is the default: someone who came here to test a strategy should
  // not have to opt out of leverage. Anything typed is validated rather than silently coerced --
  // resolveLeverage would quietly turn 500 into 1x and run a spot backtest under a 500x heading.
  const leverageValue = leverageInput.trim() === '' ? 1 : Number.parseFloat(leverageInput)
  const leverageProblem =
    !Number.isFinite(leverageValue) || !isUsableLeverage(leverageValue)
      ? `Leverage has to be a number between ${MIN_LEVERAGE} and ${MAX_LEVERAGE}. Leave it blank for no leverage.`
      : null
  const capitalValue = Number.parseFloat(startingCapital)
  const capitalProblem =
    !Number.isFinite(capitalValue) || capitalValue <= 0
      ? 'Starting capital has to be a number above 0 — every figure in the results is a share of it.'
      : null

  function handleStart(): void {
    const route = tradingRoute
    if (!route.symbol || capitalProblem !== null || leverageProblem !== null) return

    // Checked before anything is fetched: a blank or backwards range fetches zero candles
    // without erroring, and a zero-candle run still renders a complete results page.
    const rangeProblem = describeRangeProblem({ startDate, endDate })
    if (rangeProblem !== null) {
      setTab('progress')
      setRunState({ status: 'error', message: rangeProblem })
      return
    }
    // Read once, like `confirming` below: the range check, the label, the request and the log must
    // all be about the same cadence, whatever the picker is changed to while the run is going.
    const everyBars = route.strategyId === GPT_INTRADAY_STRATEGY_ID ? gptEveryBars : 1
    // The same rule for the route: one read, used by the label, the request and the log.
    const gptRoute = route.strategyId === GPT_INTRADAY_STRATEGY_ID ? (aiRouting?.route ?? null) : null
    if (route.strategyId === GPT_INTRADAY_STRATEGY_ID) {
      const spanMs = new Date(`${endDate}T23:59:59Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()
      const maxDays = gptMaxSpanDays(everyBars)
      if (spanMs > maxDays * 86_400_000) {
        setTab('progress')
        setRunState({
          status: 'error',
          message:
            `GPT Intraday is limited to ${GPT_MAX_DECISIONS} decisions per backtest, which is ${maxDays} days when the model is ` +
            `asked every ${describeGptCadence(everyBars)}. Shorten the range, or ask less often.`
        })
        return
      }
    }

    const strategy = getStrategy(route.strategyId)
    // getStrategy falls back to the default for an id it does not know, and an executor id is
    // one of those -- so taking the label from it would head the whole run "EMA Crossover + ATR
    // Stop" while a grid was actually being replayed.
    const chosenExecutor = accountExecutors.find((e) => e.id === executorIdFromStrategyId(route.strategyId))
    const chosenController = accountControllers.find((c) => c.id === controllerIdFromStrategyId(route.strategyId))
    // Read once, here, so the label, the fetch and the run cannot disagree about whether this is
    // a confirmed run. False for an executor or a controller, which are not strategies.
    const confirming = aiConfirm && canConfirmEntries(route.strategyId)
    const strategyLabel = chosenExecutor
      ? `${chosenExecutor.name} (${chosenExecutor.type})`
      : confirming
        ? `${strategy.name} + AI confirmation`
        : withRunNotes(strategy.name, everyBars, gptRoute)
    const symbolInfo = symbols.find((s) => s.symbol === route.symbol)
    const symbolLabel = symbolInfo ? `${symbolInfo.baseAsset}-${symbolInfo.quoteAsset}` : route.symbol
    const intervalLabel = INTERVALS.find((iv) => iv.id === route.interval)?.label ?? route.interval
    // A controller's markets come from its executors, so naming the Symbol picker in the label
    // would head the run with a market it may never have touched.
    setRunLabel(
      chosenController ? `${chosenController.name} (controller) • ${intervalLabel}` : `${strategyLabel} • ${symbolLabel} • ${intervalLabel}`
    )
    setTab('progress')
    setRunState({ status: 'running', done: 0, total: 1 })

    // Fetched from before the requested start by however much history the strategy needs to warm
    // up, so the range the user asked for is the range that gets MEASURED rather than the range
    // that gets partly spent warming indicators.
    //
    // Without this the default 90-day range was unusable for any slow strategy: Trend Regime
    // Ensemble warms up over 80 days, so it had ten days left to trade in and reported "0 trades"
    // -- indistinguishable, on screen, from a strategy whose rules never fire. A run whose result
    // is "this does not work" has to actually mean that.
    //
    // Only the fetch moves. `startSec` still bounds the reported window, because the engine
    // anchors both the trade list and the buy & hold benchmark at warmupBars.
    const requestedStartSec = Math.floor(new Date(`${startDate}T00:00:00Z`).getTime() / 1000)
    const strategyWarmupBars = strategy.warmupBarsFor(INTERVAL_SECONDS[route.interval])
    // A reviewed entry needs the review's own lookback behind it as well as the strategy's, so a
    // confirmed run reaches back by whichever is longer. Without it a fast strategy's first days
    // would be untradeable for a reason that has nothing to do with the strategy.
    const warmupBars = confirming ? Math.max(strategyWarmupBars, GPT_LOOKBACK_BARS) : strategyWarmupBars
    const warmupSec = warmupBars * INTERVAL_SECONDS[route.interval]
    const startSec = requestedStartSec - warmupSec
    const endSec = Math.floor(new Date(`${endDate}T23:59:59Z`).getTime() / 1000)
    const runId = ++runIdRef.current
    const requestId = crypto.randomUUID()
    activeFetchRequestIdRef.current = requestId
    const startedAt = performance.now()

    const logs: string[] = []
    const log = (msg: string): void => {
      logs.push(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
    }
    log(`Starting fetch: ${exchange} ${route.symbol} ${route.interval}, range ${startDate} → ${endDate}`)
    log(`Starting capital: ${capitalValue.toLocaleString()} ${quoteAsset}`)

    if (chosenController) {
      void runControllerReplay(chosenController, { runId, startSec, endSec, interval: route.interval, startedAt, log })
      return
    }

    let lastLoggedDecile = -1
    // requestId scopes this to *this* fetch -- an unrelated bot poll or routine run fetching
    // candles at the same time gets its own id and never shows up here or gets cancelled by us.
    const unsubscribe = window.api.market.onHistoricalRangeProgress((progress) => {
      if (runIdRef.current !== runId || progress.requestId !== requestId) return
      const { done, total } = progress
      setRunState({ status: 'running', done, total })
      const pct = (done / Math.max(1, total)) * 100
      const decile = Math.floor(pct / 10)
      if (decile > lastLoggedDecile) {
        lastLoggedDecile = decile
        log(`Fetched ${done.toLocaleString()} / ${total.toLocaleString()} candles (${pct.toFixed(1)}%)`)
      }
    })

    window.api.market
      .fetchHistoricalRange(exchange, route.symbol, route.interval, startSec, endSec, requestId)
      .then(async (fetchResult) => {
        if (runIdRef.current !== runId) return
        if (fetchResult.cancelled) {
          log(`Fetch cancelled after ${fetchResult.candles.length.toLocaleString()} candles`)
          setRunState({ status: 'cancelled' })
          return
        }
        log(`Fetch complete: ${fetchResult.candles.length.toLocaleString()} candles`)
        const empty = describeEmptyRange({ candleCount: fetchResult.candles.length, startDate, endDate })
        if (empty !== null) {
          log(empty)
          setRunState({ status: 'error', message: empty })
          return
        }
        const executorId = executorIdFromStrategyId(route.strategyId)
        if (executorId !== null) {
          const chosen = accountExecutors.find((e) => e.id === executorId)
          if (!chosen) {
            const message = 'That executor no longer exists — it may have been deleted since this page loaded.'
            log(message)
            setRunState({ status: 'error', message })
            return
          }
          log(`Replaying executor: ${chosen.name} (${chosen.type})`)
          const replay = replayExecutor(fetchResult.candles, chosen, capitalValue)
          if (replay === null) {
            const message = 'No candles in that range, so there was nothing to replay.'
            log(message)
            setRunState({ status: 'error', message })
            return
          }
          log(`Replay complete: net ${replay.netProfit.toFixed(2)} (${replay.netProfitPct.toFixed(2)}%)`)
          setRunState({
            status: 'executor-done',
            executor: chosen,
            replay,
            candles: fetchResult.candles,
            elapsedSec: (performance.now() - startedAt) / 1000
          })
          setCompareCandles(fetchResult.candles)
          return
        }

        log(`Running strategy: ${strategy.name} — ${strategy.description}`)
        let suppliedSignals: StrategySignals | undefined
        if (route.strategyId === GPT_INTRADAY_STRATEGY_ID) {
          const aiRequest: AiSignalTapeRequest = {
            requestId,
            exchange,
            symbol: route.symbol,
            interval: route.interval,
            candles: fetchResult.candles,
            startIndex: strategy.warmupBarsFor(INTERVAL_SECONDS[route.interval]),
            maxDecisions: GPT_MAX_DECISIONS,
            decideEveryBars: everyBars,
            ...(gptRoute ? { route: gptRoute } : {}),
            source: 'backtest'
          }
          const estimate = await window.api.ai.estimateSignalTape(aiRequest)
          // The count was always stated; the price never was, and the count alone does not say
          // whether "672 calls" is thirty cents or thirty dollars -- that depends entirely on
          // which model is selected, which is now a choice.
          const confirmed = window.confirm(describeAiRunCost(estimate))
          if (!confirmed) {
            setRunState({ status: 'cancelled' })
            return
          }
          log(
            `Generating ${estimate.total} decisions from ${estimate.model}` +
              `${everyBars > 1 ? `, one every ${describeGptCadence(everyBars)}` : ''}` +
              `${estimate.route ? `, passed on to ${describeDecider(estimate.route.model)} when it ${describeEscalation(estimate.route.when)}` : ''}` +
              ` (${estimate.cached} confirmed cached)`
          )
          const stopProgress = window.api.ai.onSignalProgress((progress) => {
            if (runIdRef.current !== runId || progress.requestId !== requestId) return
            setRunState({ status: 'running', done: progress.completed, total: progress.total })
          })
          try {
            const tape = await window.api.ai.generateSignalTape(aiRequest)
            if (runIdRef.current !== runId) return
            // A tape that is entirely safety-holds is not a result, and downstream it is
            // indistinguishable from one: no entries, 0 trades, 0.00%, and a health check that
            // blames the strategy for never opening a position. An account with no credits
            // produced exactly that -- 96 failed calls rendered as a clean backtest with nothing
            // on the page mentioning OpenAI. Refuse rather than draw the placeholder.
            if (tape.errorCount > 0) {
              const sample = tape.decisions.find((d) => d.error)?.error ?? 'unknown error'
              log(`GPT tape FAILED: ${tape.errorCount} of ${tape.decisions.length} decisions never reached the model`)
              setTab('progress')
              setRunState({
                status: 'error',
                message:
                  `${tape.errorCount} of ${tape.decisions.length} GPT decisions failed, so this would not be a backtest of the ` +
                  `strategy — every failed candle falls back to a safety hold and can never open a trade. First error: ${sample}`
              })
              return
            }
            suppliedSignals = generateGptIntradaySignals(fetchResult.candles, tape)
            log(
              `GPT tape ready: ${tape.cachedCount} cached, ${tape.generatedCount} generated with ${tape.callCount} model ` +
                `call${tape.callCount === 1 ? '' : 's'}, ${formatUsd(tape.costUsd)} spent`
            )
            if (tape.route) {
              const passedOn = tape.decisions.filter((d) => d.first != null)
              // Counted on what each model SAID, not on what the account then did: it is a line
              // about the two models, and a hold answered twice is the same call.
              const same = passedOn.filter((d) => !d.rejected && !d.first?.rejected && d.first?.recommendation === d.recommendation)
              log(
                `${tape.route.escalated} of ${tape.decisions.length} decisions were passed on to ${describeDecider(tape.route.model)}; ` +
                  `it made the same call as ${tape.model} on ${same.length}`
              )
            }
            // Not a reason to refuse the run: the model was reached and answered, and an unusable
            // answer acting as a hold is what the strategy does with it live too. It is logged
            // because a run where most answers were refused is a result about the model.
            if (tape.rejectedCount > 0) {
              log(`${tape.rejectedCount} of ${tape.decisions.length} answers were refused by the validator and treated as hold`)
            }
          } finally {
            stopProgress()
          }
        }
        let result: BacktestResult
        let confirmation: ConfirmationReport | undefined
        if (confirming) {
          const engine = { startingBalance: capitalValue, leverage: leverageValue }
          const reviewed = {
            candles: fetchResult.candles,
            strategyId: route.strategyId,
            exchange,
            symbol: route.symbol,
            interval: route.interval,
            engine,
            confirmFromSec: 0,
            nowSec: Math.floor(Date.now() / 1000),
            source: 'backtest' as const
          }
          // FREE FIRST. This pass only reads the cache, and stops at the first entry that would
          // cost something -- which is the earliest point at which what the run needs is known
          // well enough to put a figure on it. A rerun of something already paid for never
          // reaches the confirmation at all.
          const quote: { last: AiEntryPeek | null } = { last: null }
          let run = await resolveConfirmedRun({
            ...reviewed,
            ask: async (request) => {
              quote.last = await window.api.ai.peekEntryConfirmation(request)
              return quote.last.decision
            }
          })
          if (runIdRef.current !== runId) return
          if (run.unsettled?.reason === 'uncached' && quote.last !== null) {
            const confirmed = window.confirm(
              describeAiConfirmCost({
                strategyName: strategy.name,
                model: quote.last.model,
                cached: run.decisions.size,
                openQuestions: run.openQuestions,
                perCallCostUsd: quote.last.perCallCostUsd,
                costBasis: quote.last.costBasis,
                budgetRemainingUsd: quote.last.budgetRemainingUsd
              })
            )
            if (!confirmed) {
              setRunState({ status: 'cancelled' })
              return
            }
            log(`Asking ${quote.last.model} to review entries (${run.decisions.size} already cached, about ${run.openQuestions} to ask)`)
            run = await resolveConfirmedRun({
              ...reviewed,
              known: run.decisions,
              ask: (request) => window.api.ai.confirmEntry(request),
              shouldStop: () => runIdRef.current !== runId,
              onProgress: (decided, expected) => {
                if (runIdRef.current === runId) setRunState({ status: 'running', done: decided, total: expected })
              }
            })
            if (runIdRef.current !== runId) return
          }
          // An entry nobody ruled on is not taken, and nothing after it can be decided either, so
          // what is left is the first part of a run rather than a run. Refused for the same reason
          // a GPT tape with failed decisions is: it would draw as a result and is not one.
          if (run.unsettled?.reason === 'unanswered') {
            const when = `${formatUtcDate(run.unsettled.time)} ${formatUtcTime(run.unsettled.time)} UTC`
            const answered = run.decisions.size
            const kept =
              answered === 0
                ? 'No review had been answered before it.'
                : answered === 1
                  ? 'The one review answered before it is cached.'
                  : `The ${answered} reviews answered before it are cached.`
            log(`AI confirmation FAILED at the entry signalled ${when}: ${run.unsettled.detail}`)
            setTab('progress')
            setRunState({
              status: 'error',
              message:
                `The model could not be reached to review the entry signalled at ${when}, so nothing after it can be decided and ` +
                `this would not be a result. ${kept} Error: ${run.unsettled.detail}`
            })
            return
          }
          const counts = confirmationCounts(run.decisions.values())
          const reviews = reviewEntries(fetchResult.candles, run)
          log(
            `AI confirmation: ${counts.reviewed} entries reviewed, ${counts.confirmed} confirmed, ${counts.vetoed} vetoed; ` +
              `${counts.generated} new calls, ${formatUsd(counts.costUsd)} spent, ${counts.cached} cached`
          )
          if (counts.refused > 0) log(`${counts.refused} answers were refused by the validator and counted as vetoes`)
          const forming = run.unsettled?.reason === 'forming' ? run.unsettled.time : null
          if (forming !== null) log('The last candle is still forming, so the entry signalled on it was neither reviewed nor taken')
          result = run.result
          confirmation = {
            strategyName: strategy.name,
            model: reviews[0]?.decision.model ?? null,
            quantOnly: run.quantOnly.stats,
            confirmed: run.result.stats,
            reviews,
            counts,
            formingEntryTime: forming
          }
        } else {
          result = runBacktest(fetchResult.candles, route.strategyId, {
            startingBalance: capitalValue,
            leverage: leverageValue,
            signals: suppliedSignals
          })
        }
        log(
          `Simulation complete: ${result.trades.length} trades, net P&L ${result.stats.totalNetProfit.toFixed(2)} (${result.stats.totalNetProfitPct.toFixed(2)}%)`
        )
        const elapsedSec = (performance.now() - startedAt) / 1000
        log(`Total elapsed: ${elapsedSec.toFixed(2)}s`)
        const generalInfo: ResultsGeneralInfo = {
          // The span the user asked to MEASURE, not the span fetched. The fetch reaches further
          // back so the strategy can warm up before the requested window opens, and reporting
          // that lead-in here would contradict the Starting Date shown three rows below it.
          periodDays: Math.round((endSec - requestedStartSec) / 86400),
          startDate,
          endDate,
          exchangeName: EXCHANGES.find((e) => e.id === exchange)?.name ?? exchange,
          symbolLabel,
          intervalLabel,
          strategyLabel,
          splitDate: splitDate && splitDate > startDate && splitDate < endDate ? splitDate : null,
          leverage: leverageValue
        }
        setRunState({ status: 'done', result, candles: fetchResult.candles, elapsedSec, generalInfo, logLines: logs, confirmation })
        setCompareCandles(fetchResult.candles)
      })
      .catch((error: unknown) => {
        if (runIdRef.current !== runId) return
        // describeError, not error.message: a run the main process stops on purpose -- the AI
        // budget reached, a key refused -- arrives wrapped as "Error invoking remote method
        // 'ai:generateSignalTape': Error: ...", and the reason someone needs is the part after it.
        log(`Error: ${describeError(error)}`)
        setRunState({ status: 'error', message: describeError(error) })
      })
      .finally(() => {
        unsubscribe()
        if (activeFetchRequestIdRef.current === requestId) activeFetchRequestIdRef.current = null
      })
  }

  /** A controller run fetches one candle set per market its executors trade, rather than the one
   * market the Symbol picker names: a controller can supervise executors on different pairs, and
   * replaying them all against a single symbol's candles would silently price them wrong. */
  async function runControllerReplay(
    controller: ControllerConfig,
    ctx: { runId: number; startSec: number; endSec: number; interval: Interval; startedAt: number; log: (message: string) => void }
  ): Promise<void> {
    const attached = accountExecutors.filter((e) => controller.executorIds.includes(e.id))
    const marketSymbols = [...new Set(attached.filter((e) => e.type !== 'xemm' && e.type !== 'arbitrage').map((e) => e.symbol))]
    if (marketSymbols.length === 0) {
      const message =
        attached.length === 0
          ? 'That controller has no executors attached, so there is nothing to replay.'
          : 'Every executor attached to that controller prices two markets at once (XEMM or Arbitrage), which cannot be replayed here.'
      ctx.log(message)
      setRunState({ status: 'error', message })
      return
    }

    ctx.log(`Controller "${controller.name}": ${marketSymbols.length} market${marketSymbols.length === 1 ? '' : 's'} to fetch (${marketSymbols.join(', ')})`)

    let fetchedSymbols = 0
    let activeRequestId = ''
    const unsubscribe = window.api.market.onHistoricalRangeProgress((progress) => {
      if (runIdRef.current !== ctx.runId || progress.requestId !== activeRequestId) return
      setRunState({
        status: 'running',
        done: fetchedSymbols * progress.total + progress.done,
        total: progress.total * marketSymbols.length
      })
    })

    try {
      const candlesBySymbol: Record<string, Candle[]> = {}
      for (const symbol of marketSymbols) {
        activeRequestId = crypto.randomUUID()
        activeFetchRequestIdRef.current = activeRequestId
        const fetched = await window.api.market.fetchHistoricalRange(exchange, symbol, ctx.interval, ctx.startSec, ctx.endSec, activeRequestId)
        if (runIdRef.current !== ctx.runId) return
        if (fetched.cancelled) {
          ctx.log(`Fetch cancelled after ${fetched.candles.length.toLocaleString()} ${symbol} candles`)
          setRunState({ status: 'cancelled' })
          return
        }
        candlesBySymbol[symbol] = fetched.candles
        fetchedSymbols++
        ctx.log(`${symbol}: ${fetched.candles.length.toLocaleString()} candles`)
      }

      const replay = replayController(controller, accountExecutors, candlesBySymbol)
      if (replay === null) {
        const message = 'None of that controller’s executors could be replayed over this range — no candles came back for their markets.'
        ctx.log(message)
        setRunState({ status: 'error', message })
        return
      }
      ctx.log(
        replay.breach === null
          ? `Replay complete: no limit crossed, net ${replay.finalPnlQuote.toFixed(2)} (${replay.finalPnlPct.toFixed(2)}%)`
          : `Replay complete: ${replay.breach.breach.kind} at ${new Date(replay.breach.atTime * 1000).toISOString()}, net ${replay.finalPnlQuote.toFixed(2)} (${replay.finalPnlPct.toFixed(2)}%)`
      )
      setRunState({ status: 'controller-done', controller, replay, elapsedSec: (performance.now() - ctx.startedAt) / 1000 })
    } catch (error: unknown) {
      if (runIdRef.current !== ctx.runId) return
      const message = error instanceof Error ? error.message : String(error)
      ctx.log(`Error: ${message}`)
      setRunState({ status: 'error', message })
    } finally {
      unsubscribe()
      if (activeFetchRequestIdRef.current === activeRequestId) activeFetchRequestIdRef.current = null
    }
  }

  function handleCancel(): void {
    runIdRef.current++
    if (runState?.status === 'running' && activeFetchRequestIdRef.current) {
      void window.api.market.cancelHistoricalRange(activeFetchRequestIdRef.current)
      void window.api.ai.cancelSignalTape(activeFetchRequestIdRef.current)
    }
    setTab('configuration')
    setRunLabel(null)
    setRunState(null)
  }

  // Reuses candles already fetched by the last single-strategy run when available — only
  // fetches fresh if the user hasn't run anything yet this session.
  async function handleCompare(): Promise<void> {
    const route = tradingRoute
    if (!route.symbol) return
    setTab('compare')
    if (compareCandles) return

    setCompareLoading(true)
    setCompareError(null)
    const startSec = Math.floor(new Date(`${startDate}T00:00:00Z`).getTime() / 1000)
    const endSec = Math.floor(new Date(`${endDate}T23:59:59Z`).getTime() / 1000)
    try {
      const fetchResult = await window.api.market.fetchHistoricalRange(exchange, route.symbol, route.interval, startSec, endSec)
      if (!fetchResult.cancelled) setCompareCandles(fetchResult.candles)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('Failed to fetch candles for strategy comparison:', error)
      setCompareError(message)
    } finally {
      setCompareLoading(false)
    }
  }

  return (
    <>
      {!embedded && <PageHeader title="Backtest" subtitle="Configure a strategy backtest against historical exchange data" />}

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
        <button style={tabButtonStyle(tab === 'configuration')} onClick={() => setTab('configuration')}>
          Configuration
        </button>
        <button style={tabButtonStyle(tab === 'live')} onClick={() => setTab('live')}>
          Live
        </button>
        {runLabel !== null && (
          <button style={tabButtonStyle(tab === 'progress')} onClick={() => setTab('progress')}>
            {runLabel}
          </button>
        )}
        {runState?.status === 'done' && (
          <button style={tabButtonStyle(tab === 'charts')} onClick={() => setTab('charts')}>
            Charts
          </button>
        )}
        {compareCandles !== null && (
          <button style={tabButtonStyle(tab === 'compare')} onClick={() => setTab('compare')}>
            Compare Strategies
          </button>
        )}
      </div>

      {tab === 'progress' && runState && runState.status === 'controller-done' && (
        <Card title="Controller Replay">
          <ControllerBacktestView controller={runState.controller} result={runState.replay} />
        </Card>
      )}

      {tab === 'progress' && runState && runState.status === 'executor-done' && (
        <Card title="Executor replay">
          <ExecutorBacktestView executor={runState.executor} result={runState.replay} />
        </Card>
      )}

      {tab === 'progress' && runState && runState.status === 'done' && runState.confirmation && (
        <Card title="AI confirmation">
          <AiConfirmationCard report={runState.confirmation} />
        </Card>
      )}

      {tab === 'progress' && runState && runState.status === 'done' && (
        <Card title="Backtest results">
          <BacktestResultsView
            result={runState.result}
            candles={runState.candles}
            elapsedSec={runState.elapsedSec}
            generalInfo={runState.generalInfo}
            logLines={runState.logLines}
            onRerun={handleStart}
            onNewSession={handleCancel}
            onViewCharts={() => setTab('charts')}
          />
        </Card>
      )}

      {tab === 'live' && (
        <Card title="Live strategy monitor">
          {tradingRoute.symbol !== '' && (
            <LiveStrategyComparison
              exchange={exchange}
              symbol={tradingRoute.symbol}
              active={tab === 'live'}
              selectedStrategyId={tradingRoute.strategyId}
            />
          )}
          <LiveBacktestView
            state={live}
            strategyId={tradingRoute.strategyId}
            symbol={tradingRoute.symbol}
            interval={tradingRoute.interval}
          />
        </Card>
      )}

      {tab === 'charts' && runState?.status === 'done' && (
        <Card title="Trade charts">
          <BacktestChartsView candles={runState.candles} trades={runState.result.trades} />
        </Card>
      )}

      {tab === 'compare' && (
        <Card title="Strategy comparison">
          {compareLoading && <p style={{ color: 'var(--text-secondary)', margin: 0 }}>Fetching candles…</p>}
          {!compareLoading && compareError && <p style={{ color: 'var(--down)', margin: 0 }}>Error: {compareError}</p>}
          {!compareLoading && !compareError && compareCandles && (
            <StrategyComparisonView
              candles={compareCandles}
              startingBalance={capitalValue}
              meta={comparisonMeta}
            />
          )}
          {!compareLoading && !compareError && !compareCandles && (
            <p style={{ color: 'var(--text-secondary)', margin: 0 }}>No candle data loaded yet.</p>
          )}
        </Card>
      )}

      {tab === 'progress' && runState && runState.status !== 'done' && runState.status !== 'executor-done' && runState.status !== 'controller-done' && (
        <Card title="Backtest progress">
          <BacktestRunningView runState={runState} onCancel={handleCancel} />
        </Card>
      )}

      {tab === 'configuration' && (
        <Card title="Backtest configuration">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: '2rem', alignItems: 'start' }}>
            <div>
              <SectionHeader label="Exchange" />
              <select
                value={exchange}
                onChange={(e) => handleExchangeChange(e.target.value as Exchange)}
                style={{ ...fieldStyle(), width: '100%' }}
              >
                {EXCHANGES.map((ex) => (
                  <option key={ex.id} value={ex.id}>
                    {ex.name}
                  </option>
                ))}
              </select>

              {symbolsError !== null && (
                <p style={{ color: 'var(--down)', fontSize: '0.76rem', margin: '0 0 0.6rem', lineHeight: 1.45 }}>
                  Could not load the symbol list for this exchange ({symbolsError}). Only the
                  default symbol below is available until it loads.{' '}
                  <button
                    onClick={() => setSymbolsReloadKey((k) => k + 1)}
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--down)',
                      borderRadius: 'var(--radius-sm)',
                      color: 'var(--down)',
                      cursor: 'pointer',
                      fontSize: '0.72rem',
                      padding: '0.1rem 0.45rem'
                    }}
                  >
                    Retry
                  </button>
                </p>
              )}

              <SectionHeader label="Route" />
              <div style={{ display: 'flex', gap: '0.6rem', marginBottom: '0.6rem' }}>
                <select
                  value={tradingRoute.symbol}
                  onChange={(e) => updateTradingRoute({ symbol: e.target.value })}
                  style={{ ...fieldStyle(), flex: 1 }}
                >
                  {symbolsLoading && <option>Loading symbols...</option>}
                  {/* Without this the dropdown renders empty on a failed list while state still
                      holds a symbol -- the control showing blank for a backtest that would in
                      fact run against that symbol. */}
                  {!symbolsLoading && symbols.length === 0 && tradingRoute.symbol !== '' && (
                    <option value={tradingRoute.symbol}>{tradingRoute.symbol}</option>
                  )}
                  {!symbolsLoading &&
                    symbols.map((s) => (
                      <option key={s.symbol} value={s.symbol}>
                        {s.symbol}
                      </option>
                    ))}
                </select>
                <select
                  value={tradingRoute.interval}
                  onChange={(e) => updateTradingRoute({ interval: e.target.value as Interval })}
                  disabled={tradingRoute.strategyId === GPT_INTRADAY_STRATEGY_ID}
                  style={{ ...fieldStyle(), width: 90 }}
                >
                  {INTERVALS.map((iv) => (
                    <option key={iv.id} value={iv.id}>
                      {iv.label}
                    </option>
                  ))}
                </select>
                <select
                  value={tradingRoute.strategyId}
                  onChange={(e) => updateTradingRoute({ strategyId: e.target.value })}
                  style={{ ...fieldStyle(), flex: 1 }}
                >
                  {STRATEGIES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                  {replayableExecutors.length > 0 && (
                    <optgroup label="Your executors">
                      {replayableExecutors.map((e) => (
                        <option key={e.id} value={`${EXECUTOR_PREFIX}${e.id}`}>
                          {e.name} ({e.type})
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {accountControllers.length > 0 && (
                    <optgroup label="Your controllers">
                      {accountControllers.map((c) => (
                        <option key={c.id} value={`${CONTROLLER_PREFIX}${c.id}`}>
                          {c.name} ({c.executorIds.length} executor{c.executorIds.length === 1 ? '' : 's'})
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>

              {tradingRoute.strategyId === GPT_INTRADAY_STRATEGY_ID && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Ask the model</span>
                    <select
                      value={gptEveryBars}
                      onChange={(e) => setGptEveryBars(Number(e.target.value))}
                      style={{ ...fieldStyle(), flex: 1 }}
                      aria-label="How often the model is asked"
                    >
                      {GPT_DECISION_EVERY_BARS.map((bars) => (
                        <option key={bars} value={bars}>
                          every {describeGptCadence(bars)} · up to {gptMaxSpanDays(bars)} days
                        </option>
                      ))}
                    </select>
                  </div>
                  <p style={{ margin: '0.4rem 0 0', fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    The model is asked on the clock: every candle, or the ones that open on the hour, or on every fourth hour
                    UTC. Between two questions the position is held and its stop is still checked on every candle. The
                    question itself is the same at every cadence, so answers are shared between them through the cache.
                  </p>
                </>
              )}

              {canConfirmEntries(tradingRoute.strategyId) && (
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.55rem',
                    fontSize: '0.76rem',
                    color: 'var(--text-muted)',
                    lineHeight: 1.5,
                    cursor: 'pointer'
                  }}
                >
                  <input
                    type="checkbox"
                    checked={aiConfirm}
                    onChange={(e) => setAiConfirm(e.target.checked)}
                    style={{ marginTop: '0.2rem', flexShrink: 0 }}
                  />
                  <span>
                    <strong style={{ color: 'var(--text-primary)' }}>Ask an AI model to confirm each entry.</strong> Paper only. The
                    strategy decides as it always does; at each entry it signals, a model is shown the market and the strategy&apos;s own
                    readings and can veto that trade. One call per trade through {AI_PROVIDER_LABEL}, priced before anything is spent,
                    and the results set the strategy beside itself with the vetoed trades removed.
                  </span>
                </label>
              )}

              {controllerIdFromStrategyId(tradingRoute.strategyId) !== null && (
                <p style={{ margin: '0.4rem 0 0', fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  A controller takes its markets from the executors attached to it, so the Symbol above is ignored and
                  the Starting Capital is not used — its limits are measured against the capital those executors
                  allocate, exactly as they are in the running app.
                </p>
              )}

              <SectionHeader label="Duration" />
              <div style={{ display: 'flex', gap: '0.6rem' }}>
                <input
                  type="date"
                  value={startDate}
                  max={endDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  style={{ ...fieldStyle(), flex: 1, colorScheme: 'dark' }}
                />
                <input
                  type="date"
                  value={endDate}
                  min={startDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  style={{ ...fieldStyle(), flex: 1, colorScheme: 'dark' }}
                />
              </div>
              {tradingRoute.strategyId === GPT_INTRADAY_STRATEGY_ID && (
                <p style={{ color: 'var(--text-muted)', fontSize: '0.76rem', lineHeight: 1.5, marginBottom: 0 }}>
                  Paper only. Limited to {GPT_MAX_DECISIONS} decisions, which is {gptMaxSpanDays(gptEveryBars)} days when the
                  model is asked every {describeGptCadence(gptEveryBars)}. Each uncached decision can use one model call
                  through {AI_PROVIDER_LABEL}
                  {aiRouting?.route
                    ? `, or ${deciderCalls(aiRouting.route.model) > 1 ? `up to ${1 + deciderCalls(aiRouting.route.model)}` : 'two'}: the route set under Settings › AI passes a decision on to ${describeDecider(aiRouting.route.model)} when ${aiRouting.model} ${describeEscalation(aiRouting.route.when)}`
                    : ''}
                  ; reruns reuse the deterministic signal tape. Short samples do not establish profitability.
                </p>
              )}

              <SectionHeader label="Out-of-Sample Split (optional)" />
              <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: '0 0 0.6rem' }}>
                Splits the results into a period before this date and a period after it, so you can check whether
                performance held up on data the strategy wasn't looked at first.
              </p>
              <input
                type="date"
                value={splitDate}
                min={startDate}
                max={endDate}
                onChange={(e) => setSplitDate(e.target.value)}
                style={{ ...fieldStyle(), width: '100%', colorScheme: 'dark' }}
              />

              <SectionHeader label="Starting Capital" />
              <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: '0 0 0.6rem' }}>
                {accountAvailable <= 0
                  ? 'What the simulation starts with. Every result is a share of this number, so the same percentage return is a different amount of money on a different starting balance.'
                  : capitalTouched
                    ? `Testing a size of your own. Your paper account has ${accountAvailable.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${quoteAsset} available; clear this field and reopen the page to go back to that.`
                    : `Filled in from your paper account: ${accountAvailable.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${quoteAsset} is available after what your running strategies are already holding. Change it to test a different size.`}
              </p>
              <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={startingCapital}
                  onChange={(e) => {
                    setCapitalTouched(true)
                    setStartingCapital(e.target.value)
                  }}
                  style={{ ...fieldStyle(), flex: 1 }}
                />
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', minWidth: 48 }}>
                  {quoteAsset || '—'}
                </span>
              </div>
              {capitalProblem !== null && (
                <p style={{ color: 'var(--down)', fontSize: '0.78rem', margin: '0.5rem 0 0' }}>{capitalProblem}</p>
              )}

              <SectionHeader label="Leverage" />
              <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: '0 0 0.6rem' }}>
                Leave this blank to test the strategy on spot, which is what it has always been. Above 1x the run can
                be liquidated — and when it is, it ends with nothing and takes no further trades, exactly as the account
                would.
              </p>
              <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                <input
                  type="number"
                  min={MIN_LEVERAGE}
                  max={MAX_LEVERAGE}
                  step="1"
                  placeholder="1"
                  value={leverageInput}
                  onChange={(e) => setLeverageInput(e.target.value)}
                  style={{ ...fieldStyle(), flex: 1 }}
                />
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', minWidth: 48 }}>×</span>
              </div>
              {leverageProblem !== null ? (
                <p style={{ color: 'var(--down)', fontSize: '0.78rem', margin: '0.5rem 0 0' }}>{leverageProblem}</p>
              ) : (
                leverageValue > 1 && (
                  <p style={{ color: 'var(--down)', fontSize: '0.78rem', margin: '0.5rem 0 0', fontWeight: 600 }}>
                    At {leverageValue}x a fall of{' '}
                    {liquidationDistancePct(leverageValue)?.toFixed(2) ?? '—'}% below an entry ends that trade and the
                    whole run with it. Funding is charged every 8 hours a position stays open, and every fee is{' '}
                    {leverageValue} times what it was.
                  </p>
                )
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              <button
                onClick={handleStart}
                disabled={symbolsLoading || !tradingRoute.symbol || capitalProblem !== null || leverageProblem !== null}
                title={symbolsLoading ? 'Symbols are still loading' : (capitalProblem ?? leverageProblem ?? undefined)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
                  background: 'linear-gradient(135deg, #7c86ff, #6366f1)',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.9rem',
                  color: '#fff',
                  fontSize: '0.95rem',
                  fontWeight: 700,
                  cursor: symbolsLoading || !tradingRoute.symbol || capitalProblem !== null || leverageProblem !== null ? 'not-allowed' : 'pointer',
                  opacity: symbolsLoading || !tradingRoute.symbol || capitalProblem !== null || leverageProblem !== null ? 0.6 : 1
                }}
              >
                <Zap size={16} /> Start
              </button>
              <button
                onClick={() => void handleCompare()}
                disabled={symbolsLoading || !tradingRoute.symbol || compareLoading || tradingRoute.strategyId === GPT_INTRADAY_STRATEGY_ID}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
                  background: 'var(--bg-app)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.9rem',
                  color: 'var(--text-primary)',
                  fontSize: '0.9rem',
                  fontWeight: 600,
                  cursor: symbolsLoading || !tradingRoute.symbol || compareLoading || tradingRoute.strategyId === GPT_INTRADAY_STRATEGY_ID ? 'not-allowed' : 'pointer',
                  opacity: symbolsLoading || !tradingRoute.symbol || compareLoading || tradingRoute.strategyId === GPT_INTRADAY_STRATEGY_ID ? 0.6 : 1
                }}
              >
                <Plus size={16} /> Compare Strategies
              </button>
            </div>
          </div>
        </Card>
      )}

      {/* Sits below the form rather than inside it: it describes the MARKET, not the run
          being configured, and it renders nothing at all for strategies whose expectation
          under this rule was never measured. */}
      {tab === 'configuration' && tradingRoute.symbol !== '' && (
        <MarketConditionsCard exchange={exchange} symbol={tradingRoute.symbol} strategyId={tradingRoute.strategyId} />
      )}
    </>
  )
}
