import { useEffect, useRef, useState } from 'react'
import { Cpu, Plus } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { StatCard } from '../components/StatCard'
import { NewExecutorModal } from './NewExecutorModal'
import { ExecutorCard } from './ExecutorCard'
import { ExecutorDetailView } from './ExecutorDetailView'
import { SpreadExecutorDetailView } from './SpreadExecutorDetailView'
import { computeExecutorPosition } from './computeSnapshot'
import { dcaLevelPrice, twapNumOrders, buildGridLevels } from './engine'
import {
  EXCHANGES,
  type ExecutorConfig,
  type Exchange,
  type ExecutorType,
  type SymbolInfo,
  type GridExecutorParams,
  type DcaExecutorParams,
  type TwapExecutorParams,
  type PositionExecutorParams,
  type OrderExecutorParams,
  type XemmExecutorParams,
  type ArbitrageExecutorParams,
  type MarketMakingExecutorParams,
  type HeldPosition,
  type LiveOrderRecord,
  type LiveExitResult
} from '../../shared/ipc'
import type { Bot } from '../bots/types'

const EXECUTORS_POLL_MS = 10_000

export function ExecutorsPage(): React.JSX.Element {
  const [bots, setBots] = useState<Bot[]>([])
  const [executors, setExecutors] = useState<ExecutorConfig[]>([])
  const [showNew, setShowNew] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const loadedRef = useRef(false)
  const lastSerializedRef = useRef('')

  useEffect(() => {
    let cancelled = false
    window.api.settings.get().then((settings) => {
      if (cancelled) return
      setBots(settings.bots)
      setExecutors(settings.executors)
      lastSerializedRef.current = JSON.stringify(settings.executors)
      loadedRef.current = true
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!loadedRef.current) return
    lastSerializedRef.current = JSON.stringify(executors)
    void window.api.settings.set({ executors })
  }, [executors])

  // LiveOrderScheduler (mounted at the App level) can resolve a live limit order's fill/cancel
  // and patch settings.executors at any time, independent of whether this page is open — this
  // light poll-and-diff (same pattern RoutineScheduler already uses) is what makes that show up
  // here without requiring navigation away and back.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!loadedRef.current) return
      window.api.settings
        .get()
        .then((settings) => {
          const serialized = JSON.stringify(settings.executors)
          if (serialized !== lastSerializedRef.current) {
            lastSerializedRef.current = serialized
            setExecutors(settings.executors)
          }
        })
        .catch((error) => console.error('Failed to poll executors:', error))
    }, EXECUTORS_POLL_MS)
    return () => clearInterval(timer)
  }, [])

  async function handleCreate(input: {
    name: string
    type: ExecutorType
    exchange: Exchange
    pair: SymbolInfo
    keepPosition: boolean
    mode: 'paper' | 'live'
    params: GridExecutorParams | DcaExecutorParams | TwapExecutorParams | PositionExecutorParams | OrderExecutorParams | XemmExecutorParams | ArbitrageExecutorParams | MarketMakingExecutorParams
  }): Promise<void> {
    // Defense in depth — the UI only ever offers 'live' for type 'order', 'position', 'dca',
    // 'twap', or 'grid', but this is the last line of defense before anything real could happen.
    const mode =
      input.mode === 'live' &&
      (input.type === 'order' || input.type === 'position' || input.type === 'dca' || input.type === 'twap' || input.type === 'grid')
        ? 'live'
        : 'paper'

    const base: ExecutorConfig = {
      id: crypto.randomUUID(),
      name: input.name,
      type: input.type,
      exchange: input.exchange,
      symbol: input.pair.symbol,
      baseAsset: input.pair.baseAsset,
      quoteAsset: input.pair.quoteAsset,
      createdAt: Math.floor(Date.now() / 1000),
      status: 'active',
      stoppedAt: null,
      keepPosition: input.keepPosition,
      mode,
      liveOrder: null,
      pendingLiveOrderIds: [],
      liveWatcherId: null,
      liveExitResult: null,
      liveDcaBasePrice: null,
      liveTwapRunId: null,
      liveTwapResult: null,
      params: input.params
    }
    setShowNew(false)

    if (mode === 'paper') {
      setExecutors((prev) => [...prev, base])
      return
    }

    if (input.type === 'position') {
      // Live Position: entry is just a live BUY market order (the exact same path as the Order
      // executor), then — once it fills — a watcher starts monitoring for the automatic exit.
      // Buy-only and market-entry-only; NewExecutorModal's canGoLive already enforces both.
      const positionParams = input.params as PositionExecutorParams
      let entryResult: LiveOrderRecord | null = null
      try {
        const activeWatchers = await window.api.liveTrading.listActiveWatchers()
        if (activeWatchers.some((w) => w.exchange === input.exchange && w.symbol === input.pair.symbol)) {
          throw new Error(`Already watching a live position on ${input.pair.symbol} — only one at a time is supported`)
        }
        entryResult = await window.api.executors.placeLiveOrder(
          input.exchange,
          input.pair.symbol,
          input.pair.baseAsset,
          input.pair.quoteAsset,
          'buy',
          positionParams.amountQuote
        )
        const watcher = await window.api.liveTrading.createWatcher(
          base.id,
          input.exchange,
          input.pair.symbol,
          entryResult.avgFillPrice,
          positionParams.takeProfitPct,
          positionParams.stopLossPct,
          positionParams.timeLimitSec,
          positionParams.trailingStop
        )
        // Live entries are market-only, so params.entryPrice is always null going in (it means
        // "resting target" in paper mode, which doesn't apply here) -- patch in the *real* fill
        // price now so ExecutorCard/ExecutorDetailView have something real to draw against
        // instead of showing 0 or nothing.
        const filledEntryPrice = entryResult.avgFillPrice
        setExecutors((prev) => [
          ...prev,
          { ...base, params: { ...positionParams, entryPrice: filledEntryPrice }, liveWatcherId: watcher.id }
        ])
      } catch (error) {
        console.error('Live position entry failed:', error)
        const message = error instanceof Error ? error.message : String(error)
        const stoppedAt = Math.floor(Date.now() / 1000)
        if (entryResult) {
          // The real BUY already happened — only watcher creation failed (e.g. another watcher
          // is already active on this symbol). Never hide this: the position is real and
          // currently unmonitored until closed manually from the Positions page.
          const filledEntryPrice = entryResult.avgFillPrice
          setExecutors((prev) => [
            ...prev,
            {
              ...base,
              name: `${base.name} (filled but NOT being watched — close manually on Positions: ${message})`,
              status: 'stopped',
              stoppedAt,
              liveOrder: entryResult,
              params: { ...positionParams, entryPrice: filledEntryPrice }
            }
          ])
        } else {
          setExecutors((prev) => [...prev, { ...base, name: `${base.name} (failed: ${message})`, status: 'stopped', stoppedAt }])
        }
      }
      return
    }

    if (input.type === 'grid') {
      // Live Grid: a bounded ladder sharing ONE exit (take-profit from the shared average fill),
      // not full paper Grid's perpetual per-level cycling -- see the Phase 6 plan for why. Only
      // the maxOpenOrders levels nearest a real current price are placed as real resting orders,
      // since the full ladder (up to MAX_GRID_LEVELS) can be much larger than DCA's typically
      // hand-curated one -- this bounds how many real orders one click can place. Buy-only;
      // NewExecutorModal's canGoLive already enforces this.
      const gridParams = input.params as GridExecutorParams
      const allLevelPrices = buildGridLevels(gridParams)
      const amountPerLevel = gridParams.totalAmountQuote / allLevelPrices.length
      let placedLevelPrices: number[] = []
      const pendingIds: string[] = []
      let lastResolvedOrder: LiveOrderRecord | null = null
      let placedCount = 0
      try {
        const ticker = await window.api.market.fetchTicker24h(input.exchange, input.pair.symbol)
        placedLevelPrices = allLevelPrices
          .slice()
          .sort((a, b) => Math.abs(a - ticker.lastPrice) - Math.abs(b - ticker.lastPrice))
          .slice(0, Math.min(gridParams.maxOpenOrders, allLevelPrices.length))

        for (const levelPrice of placedLevelPrices) {
          const result = await window.api.executors.placeLiveLimitOrder(
            base.id,
            input.exchange,
            input.pair.symbol,
            input.pair.baseAsset,
            input.pair.quoteAsset,
            gridParams.side,
            amountPerLevel,
            levelPrice
          )
          placedCount++
          if (result.resolved) {
            lastResolvedOrder = result.liveOrder
          } else {
            pendingIds.push(result.pendingLiveOrderId)
          }
        }

        // Same "first fill creates the watcher" rule DCA/TWAP already follow -- if any selected
        // level was already marketable against the captured price, it filled synchronously.
        let watcherId: string | null = null
        if (lastResolvedOrder) {
          const positions = await window.api.liveTrading.listPositions()
          const position = positions.find((p) => p.exchange === input.exchange && p.symbol === input.pair.symbol)
          if (position) {
            // Grid has no native stop-loss/time-limit fields, and Stop Price (limitPrice) isn't
            // enforced live either -- see the Phase 6 plan. Take-profit only.
            const watcher = await window.api.liveTrading.createWatcher(
              base.id,
              input.exchange,
              input.pair.symbol,
              position.avgCost,
              gridParams.takeProfitPct,
              null,
              null,
              null
            )
            watcherId = watcher.id
          }
        }

        setExecutors((prev) => [
          ...prev,
          { ...base, pendingLiveOrderIds: pendingIds, liveWatcherId: watcherId, liveOrder: lastResolvedOrder }
        ])
      } catch (error) {
        console.error('Live Grid ladder placement failed:', error)
        const message = error instanceof Error ? error.message : String(error)
        const stoppedAt = Math.floor(Date.now() / 1000)
        if (placedCount > 0) {
          // Some levels already placed real resting orders (or filled) before a later one
          // failed -- never silently drop those. Keep the executor active with whatever
          // actually went through; the name flags the shortfall instead of hiding it.
          setExecutors((prev) => [
            ...prev,
            {
              ...base,
              name: `${base.name} (only ${placedCount}/${placedLevelPrices.length} levels placed — ${message})`,
              pendingLiveOrderIds: pendingIds,
              liveOrder: lastResolvedOrder
            }
          ])
        } else {
          setExecutors((prev) => [...prev, { ...base, name: `${base.name} (failed: ${message})`, status: 'stopped', stoppedAt }])
        }
      }
      return
    }

    if (input.type === 'dca') {
      // Live DCA: place every configured level as a real resting limit order against a real
      // reference price captured right now (there's no candle replay live the way paper mode
      // has to derive one from). Buy-only; NewExecutorModal's canGoLive already enforces this.
      const dcaParams = input.params as DcaExecutorParams
      let basePrice: number | null = null
      const pendingIds: string[] = []
      let lastResolvedOrder: LiveOrderRecord | null = null
      let placedCount = 0
      try {
        const ticker = await window.api.market.fetchTicker24h(input.exchange, input.pair.symbol)
        basePrice = ticker.lastPrice

        for (const level of dcaParams.levels) {
          const levelPrice = dcaLevelPrice(basePrice, level, dcaParams.side)
          const result = await window.api.executors.placeLiveLimitOrder(
            base.id,
            input.exchange,
            input.pair.symbol,
            input.pair.baseAsset,
            input.pair.quoteAsset,
            dcaParams.side,
            level.amountQuote,
            levelPrice
          )
          placedCount++
          if (result.resolved) {
            lastResolvedOrder = result.liveOrder
          } else {
            pendingIds.push(result.pendingLiveOrderId)
          }
        }

        // If any level was already marketable against the captured reference price, it filled
        // synchronously -- start the exit watcher right away, same "first fill creates the
        // watcher" rule LiveOrderScheduler applies for a level that fills later, asynchronously.
        let watcherId: string | null = null
        if (lastResolvedOrder) {
          const positions = await window.api.liveTrading.listPositions()
          const position = positions.find((p) => p.exchange === input.exchange && p.symbol === input.pair.symbol)
          if (position) {
            const watcher = await window.api.liveTrading.createWatcher(
              base.id,
              input.exchange,
              input.pair.symbol,
              position.avgCost,
              dcaParams.takeProfitPct,
              dcaParams.stopLossPct,
              dcaParams.timeLimitSec,
              null
            )
            watcherId = watcher.id
          }
        }

        setExecutors((prev) => [
          ...prev,
          { ...base, liveDcaBasePrice: basePrice, pendingLiveOrderIds: pendingIds, liveWatcherId: watcherId, liveOrder: lastResolvedOrder }
        ])
      } catch (error) {
        console.error('Live DCA ladder placement failed:', error)
        const message = error instanceof Error ? error.message : String(error)
        const stoppedAt = Math.floor(Date.now() / 1000)
        if (placedCount > 0) {
          // Some levels already placed real resting orders (or filled) before a later one
          // failed -- never silently drop those. Keep the executor active with whatever
          // actually went through; the name flags the shortfall instead of hiding it.
          setExecutors((prev) => [
            ...prev,
            {
              ...base,
              name: `${base.name} (only ${placedCount}/${dcaParams.levels.length} levels placed — ${message})`,
              liveDcaBasePrice: basePrice,
              pendingLiveOrderIds: pendingIds,
              liveOrder: lastResolvedOrder
            }
          ])
        } else {
          setExecutors((prev) => [...prev, { ...base, name: `${base.name} (failed: ${message})`, status: 'stopped', stoppedAt }])
        }
      }
      return
    }

    if (input.type === 'twap') {
      // Live TWAP: slice 0 fires immediately, placed synchronously the same way a live Order
      // market buy or Position entry is -- the exact same real order primitive. Buy-only;
      // NewExecutorModal's canGoLive already enforces this.
      const twapParams = input.params as TwapExecutorParams
      const numOrders = twapNumOrders(twapParams)
      const amountPerOrder = twapParams.totalAmountQuote / numOrders
      const stoppedAt = Math.floor(Date.now() / 1000)
      try {
        const firstFill = await window.api.executors.placeLiveOrder(
          input.exchange,
          input.pair.symbol,
          input.pair.baseAsset,
          input.pair.quoteAsset,
          twapParams.side,
          amountPerOrder
        )
        if (numOrders === 1) {
          // A degenerate 1-slice TWAP is just a live Order market buy -- no run needed, nothing
          // left to schedule.
          setExecutors((prev) => [...prev, { ...base, status: 'stopped', stoppedAt, liveOrder: firstFill }])
        } else {
          const run = await window.api.liveTrading.createTwapRun(
            base.id,
            input.exchange,
            input.pair.symbol,
            input.pair.baseAsset,
            input.pair.quoteAsset,
            twapParams.side,
            amountPerOrder,
            numOrders,
            twapParams.orderIntervalSec
          )
          setExecutors((prev) => [...prev, { ...base, liveOrder: firstFill, liveTwapRunId: run.id }])
        }
      } catch (error) {
        console.error('Live TWAP first slice failed:', error)
        const message = error instanceof Error ? error.message : String(error)
        setExecutors((prev) => [...prev, { ...base, name: `${base.name} (failed: ${message})`, status: 'stopped', stoppedAt }])
      }
      return
    }

    const orderParams = input.params as OrderExecutorParams
    const stoppedAt = Math.floor(Date.now() / 1000)

    if (orderParams.executionStrategy === 'limit') {
      // Live limit order: may resolve immediately (Binance can fill a marketable limit order
      // synchronously) or rest open — in which case the executor stays 'active' with
      // pendingLiveOrderId set, and LiveOrderScheduler picks up its resolution later.
      const limitPrice = orderParams.limitPrice as number
      try {
        const result = await window.api.executors.placeLiveLimitOrder(
          base.id,
          input.exchange,
          input.pair.symbol,
          input.pair.baseAsset,
          input.pair.quoteAsset,
          orderParams.side,
          orderParams.amountQuote,
          limitPrice
        )
        if (result.resolved) {
          setExecutors((prev) => [...prev, { ...base, status: 'stopped', stoppedAt, liveOrder: result.liveOrder }])
        } else {
          setExecutors((prev) => [...prev, { ...base, pendingLiveOrderIds: [result.pendingLiveOrderId] }])
        }
      } catch (error) {
        console.error('Live limit order failed:', error)
        const message = error instanceof Error ? error.message : String(error)
        setExecutors((prev) => [...prev, { ...base, name: `${base.name} (failed: ${message})`, status: 'stopped', stoppedAt }])
      }
      return
    }

    // Live market order: place the one real order now — resolves synchronously, so the
    // executor is created already 'stopped'.
    try {
      const result = await window.api.executors.placeLiveOrder(
        input.exchange,
        input.pair.symbol,
        input.pair.baseAsset,
        input.pair.quoteAsset,
        orderParams.side,
        orderParams.amountQuote
      )
      setExecutors((prev) => [...prev, { ...base, status: 'stopped', stoppedAt, liveOrder: result }])
    } catch (error) {
      console.error('Live order failed:', error)
      const message = error instanceof Error ? error.message : String(error)
      setExecutors((prev) => [...prev, { ...base, name: `${base.name} (failed: ${message})`, status: 'stopped', stoppedAt }])
    }
  }

  async function handleStop(id: string): Promise<void> {
    const executor = executors.find((e) => e.id === id)

    // A live TWAP run stops independently of the pendingLiveOrderIds/liveWatcherId machinery
    // below — every slice is a market order that resolves the instant it's placed, so there's
    // nothing to cancel, only the run's schedule to halt. stopTwapRun returns the resolution
    // synchronously (mirrors stopWatcher), so this never needs to wait for a later poll.
    if (executor && executor.mode === 'live' && executor.liveTwapRunId) {
      try {
        const resolution = await window.api.liveTrading.stopTwapRun(executor.liveTwapRunId)
        if (resolution) {
          setExecutors((prev) =>
            prev.map((e) =>
              e.id === id
                ? {
                    ...e,
                    status: 'stopped',
                    stoppedAt: Math.floor(Date.now() / 1000),
                    liveTwapRunId: null,
                    liveTwapResult: {
                      ordersPlaced: resolution.ordersPlaced,
                      numOrders: resolution.numOrders,
                      totalQuoteFilled: resolution.totalQuoteFilled,
                      totalBaseFilled: resolution.totalBaseFilled,
                      failedSlices: resolution.failedSlices,
                      stoppedEarly: true
                    }
                  }
                : e
            )
          )
        }
        // A null resolution means the run already finished naturally (LiveOrderScheduler's own
        // drainTwapEvents poll will pick that up) — nothing to do here.
      } catch (error) {
        // The run stays active server-side and liveTwapRunId stays set — genuinely still running,
        // never silently hidden, same honesty precedent as a failed watcher-stop.
        console.error('Failed to stop live TWAP run:', error)
      }
      return
    }

    // A live executor with real state to tear down: still-resting orders (a single entry for a
    // live Order limit, up to one per unfilled level for a live DCA ladder) and/or an active
    // watcher on an open position (Position, or a DCA ladder with at least one fill) — a DCA
    // executor can have BOTH at once, unlike Order/Position, so these aren't mutually exclusive.
    if (executor && executor.mode === 'live' && (executor.pendingLiveOrderIds.length > 0 || executor.liveWatcherId)) {
      const stoppedAt = Math.floor(Date.now() / 1000)

      // Cancelling is ungated (it only ever reduces risk) — always attempted first, regardless
      // of whether a watcher also needs stopping. Best-effort per order: one that already
      // resolved a moment ago isn't a real failure, but a genuine failure keeps that id tracked
      // rather than silently losing a real resting order.
      const stillPendingIds: string[] = []
      let lastCancelledOrder: LiveOrderRecord | null = null
      for (const orderId of executor.pendingLiveOrderIds) {
        try {
          lastCancelledOrder = await window.api.liveTrading.cancelOrder(orderId)
        } catch (error) {
          console.error(`Failed to cancel live order ${orderId}:`, error)
          stillPendingIds.push(orderId)
        }
      }

      // Force-close a watched open position — same gate as the manual Close button on the
      // Positions page (kill-switch/session-arm only, never size/cap/loss-limit, since exiting
      // only reduces risk). If this is blocked, the real watcher stays active server-side, so
      // liveWatcherId must stay set here too and the executor must NOT be marked stopped — it's
      // genuinely still being watched, and clearing the reference here would silently hide that
      // from the UI (and disable retrying, since Stop is only offered while status === 'active').
      let liveExitResult: LiveExitResult | null = null
      let watcherStillActive = false
      if (executor.liveWatcherId) {
        try {
          // The main process reads the real result back from the ledger after closing — never
          // fabricated client-side.
          liveExitResult = await window.api.liveTrading.stopWatcher(executor.liveWatcherId)
        } catch (error) {
          console.error('Failed to force-close watched live position:', error)
          watcherStillActive = true
        }
      }

      const stillActive = stillPendingIds.length > 0 || watcherStillActive
      setExecutors((prev) =>
        prev.map((e) =>
          e.id === id
            ? {
                ...e,
                status: stillActive ? 'active' : 'stopped',
                stoppedAt: stillActive ? null : stoppedAt,
                pendingLiveOrderIds: stillPendingIds,
                liveOrder: lastCancelledOrder ?? e.liveOrder,
                liveWatcherId: watcherStillActive ? e.liveWatcherId : null,
                liveExitResult: liveExitResult ?? e.liveExitResult
              }
            : e
        )
      )
      return
    }

    setExecutors((prev) =>
      prev.map((e) => (e.id === id ? { ...e, status: 'stopped', stoppedAt: Math.floor(Date.now() / 1000) } : e))
    )
    // Position Handover is paper-only bookkeeping — a live fill already has its own ledger
    // (LivePosition) regardless of keepPosition. Re-running paper candle replay on a live
    // executor and stuffing the result into paper Inventory would be wrong.
    if (!executor || executor.mode === 'live' || !executor.keepPosition) return

    // Position Handover: fire the check as a background job — the executor's status already
    // flipped above, this only decides whether an open position gets a row in Inventory.
    void (async () => {
      try {
        const position = await computeExecutorPosition(executor)
        if (!position) return
        const settings = await window.api.settings.get()
        const held: HeldPosition = {
          id: crypto.randomUUID(),
          sourceExecutorId: executor.id,
          sourceExecutorName: executor.name,
          exchange: executor.exchange,
          symbol: executor.symbol,
          baseAsset: executor.baseAsset,
          quoteAsset: executor.quoteAsset,
          side: position.side,
          entryPrice: position.entryPrice,
          amountQuote: position.amountQuote,
          openedAt: Math.floor(Date.now() / 1000)
        }
        await window.api.settings.set({ heldPositions: [...settings.heldPositions, held] })
      } catch (error) {
        console.error('Failed to hand over position on stop:', error)
      }
    })()
  }

  const activeBots = bots.filter((b) => b.enabled)
  const activeExecutors = executors.filter((e) => e.status === 'active')
  const stoppedExecutors = executors.filter((e) => e.status === 'stopped')
  const selected = executors.find((e) => e.id === selectedId) ?? null

  if (selected) {
    if (selected.type === 'xemm' || selected.type === 'arbitrage') {
      return <SpreadExecutorDetailView executor={selected} onBack={() => setSelectedId(null)} />
    }
    return <ExecutorDetailView executor={selected} onBack={() => setSelectedId(null)} />
  }

  return (
    <>
      <PageHeader title="Executors" subtitle="Where your bots and paper strategies actually run" />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
        {/* Was a hardcoded "1 / 1" that never reflected anything -- the Local Executor card below
            already states this device is running, so this now reports the real running/total count
            instead of restating that as a fake statistic. */}
        <StatCard
          icon={Cpu}
          label="Executors Running"
          value={`${activeExecutors.length} / ${executors.length}`}
          valueColor={executors.length > 0 && activeExecutors.length === executors.length ? 'var(--positive)' : undefined}
        />
        <StatCard icon={Cpu} label="Active Strategies" value={`${activeBots.length + activeExecutors.length}`} />
      </div>

      <Card title="Local Executor">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.9rem' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--positive)', flexShrink: 0 }} />
          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>This device</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Running</span>
        </div>
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          Bots and Grid/DCA/TWAP executors all run inside this desktop app as paper-trading simulations — real
          market data, simulated money, no remote workers. They only run while this app stays open. Cloud/remote
          executors aren't available yet.
        </p>
      </Card>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>
          Executors
        </h2>
        <button
          onClick={() => setShowNew(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            background: 'linear-gradient(135deg, #7c86ff, #6366f1)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            padding: '0.55rem 0.9rem',
            color: '#fff',
            fontSize: '0.8rem',
            fontWeight: 700,
            cursor: 'pointer'
          }}
        >
          <Plus size={14} /> New Executor
        </button>
      </div>

      {executors.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0 }}>
          No executors yet. Create a Grid, DCA, TWAP, Position, Order, XEMM, or Arbitrage executor to start a
          paper-trading strategy against live market data.
        </p>
      )}

      {activeExecutors.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '1rem' }}>
          {activeExecutors.map((executor) => (
            <ExecutorCard key={executor.id} executor={executor} onStop={handleStop} onViewDetail={setSelectedId} />
          ))}
        </div>
      )}

      {stoppedExecutors.length > 0 && (
        <>
          <h2 style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Stopped
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '1rem' }}>
            {stoppedExecutors.map((executor) => (
              <ExecutorCard key={executor.id} executor={executor} onStop={handleStop} onViewDetail={setSelectedId} />
            ))}
          </div>
        </>
      )}

      {activeBots.length > 0 && (
        <Card title="Bots on this executor">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {activeBots.map((bot) => {
              const exchangeName = EXCHANGES.find((e) => e.id === bot.exchange)?.name ?? bot.exchange
              return (
                <div
                  key={bot.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.6rem 0.8rem',
                    background: 'var(--bg-app)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)'
                  }}
                >
                  <div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>{bot.name}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                      {exchangeName} • {bot.symbol} • {bot.strategy}
                    </div>
                  </div>
                  <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--positive)' }}>Running</span>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {showNew && <NewExecutorModal onCreate={handleCreate} onClose={() => setShowNew(false)} />}
    </>
  )
}
