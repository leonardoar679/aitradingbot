import { useEffect } from 'react'
import type { ExecutorConfig, DcaExecutorParams } from '../../shared/ipc'

/** Headless — mounted once in App.tsx, same tier as RoutineScheduler/ControllerScheduler.
 * Reconciles main-process-resolved real-money state into settings.executors every 5s, the same
 * read-modify-write pattern RoutineScheduler already uses to update state a page mounted
 * elsewhere might be showing:
 *   1. Every open live limit order (liveOrdersService.ts) — for anything resolved, removes its id
 *      from the matching executor's pendingLiveOrderIds and patches liveOrder. A live Order limit
 *      always has exactly one id here; a live DCA ladder can have several (one per unfilled
 *      level), any of which can resolve independently in the same tick.
 *   2. A live DCA fill specifically also needs its exit watcher created (on the first fill) or
 *      refreshed (on every later fill, since the true weighted-average cost keeps moving until
 *      the ladder exits or runs out of levels — paper DCA always evaluates TP/SL/time-limit
 *      against the CURRENT average, never a stale snapshot, and the live watcher has to match
 *      that). Position never reaches this path — its one entry resolves synchronously in
 *      ExecutorsPage.handleCreate, not via this poll.
 *   3. Every live Position/DCA watcher's resolved exit (livePositionWatchersService.ts) — the
 *      actual triggering runs continuously in the main process independent of this poll (see
 *      startLivePositionWatcherLoop in electron/main.ts); this just picks up the result and
 *      patches the matching executor's status/liveExitResult.
 * An executor only goes 'stopped' once BOTH pendingLiveOrderIds is empty AND liveWatcherId is
 * null — a live DCA executor can have unfilled levels and an active watcher at the same time,
 * unlike Order (always exactly one resting order, never a watcher) or Position (never a resting
 * order, always exactly one watcher).
 * Deliberately polling rather than a websocket user-data-stream / continuous renderer-side
 * ticker subscription for either; see the Phase 2c/3 plans for why that's the right-sized choice
 * here. */
const POLL_MS = 5_000

export function LiveOrderScheduler(): null {
  useEffect(() => {
    let cancelled = false

    async function poll(): Promise<void> {
      try {
        const [orderResolutions, watcherEvents, twapEvents] = await Promise.all([
          window.api.liveTrading.pollOpenOrders(),
          window.api.liveTrading.drainWatcherEvents(),
          window.api.liveTrading.drainTwapEvents()
        ])
        if (cancelled || (orderResolutions.length === 0 && watcherEvents.length === 0 && twapEvents.length === 0)) return

        const settings = await window.api.settings.get()
        if (cancelled) return
        const stoppedAt = Math.floor(Date.now() / 1000)

        // A live DCA fill this tick needs the position's current weighted-average cost to create
        // or refresh its exit watcher — fetched once and shared, rather than once per executor.
        const needsPositionLookup = orderResolutions.some((r) => r.status === 'filled')
        const livePositions = needsPositionLookup ? await window.api.liveTrading.listPositions() : []

        const nextExecutors: ExecutorConfig[] = []
        for (const executor of settings.executors) {
          const myResolutions = orderResolutions.filter((r) => r.executorId === executor.id)
          const watcherEvent = watcherEvents.find((e) => e.executorId === executor.id)
          const twapEvent = twapEvents.find((e) => e.executorId === executor.id)

          if (myResolutions.length === 0 && !watcherEvent && !twapEvent) {
            nextExecutors.push(executor)
            continue
          }

          let next = executor
          if (myResolutions.length > 0) {
            const resolvedIds = new Set(myResolutions.map((r) => r.liveOrderId))
            const lastResolution = myResolutions[myResolutions.length - 1]
            next = {
              ...next,
              pendingLiveOrderIds: next.pendingLiveOrderIds.filter((id) => !resolvedIds.has(id)),
              liveOrder: lastResolution.liveOrder
            }
          }

          // Skipped if the watcher also resolved THIS tick (e.g. it hit take-profit and its own
          // cleanup cancelled the remaining levels around the same time this poll ran) — nothing
          // left to watch, so there's no point creating or refreshing one.
          const hadFill = myResolutions.some((r) => r.status === 'filled')
          if (next.type === 'dca' && hadFill && !watcherEvent) {
            const position = livePositions.find((p) => p.exchange === next.exchange && p.symbol === next.symbol)
            if (position) {
              try {
                if (next.liveWatcherId) {
                  await window.api.liveTrading.updateWatcherEntryPrice(next.liveWatcherId, position.avgCost)
                } else {
                  const dcaParams = next.params as DcaExecutorParams
                  const watcher = await window.api.liveTrading.createWatcher(
                    next.id,
                    next.exchange,
                    next.symbol,
                    position.avgCost,
                    dcaParams.takeProfitPct,
                    dcaParams.stopLossPct,
                    dcaParams.timeLimitSec,
                    null
                  )
                  next = { ...next, liveWatcherId: watcher.id }
                }
              } catch (error) {
                console.error(`Failed to create/update live DCA watcher for executor ${next.id}:`, error)
              }
            }
          }

          if (watcherEvent) {
            // The watcher's own resolution already cancelled every sibling resting order for
            // this executor server-side (cancelSiblingLiveOrders, resolved directly via
            // cancelLiveOrderById -- not through this poll's own queryOrder path, so those ids
            // would never otherwise show up in orderResolutions this tick or any later one).
            // Clear them here rather than waiting for a poll response that will never come.
            next = { ...next, liveExitResult: watcherEvent.liveExitResult, liveWatcherId: null, pendingLiveOrderIds: [] }
          }

          if (twapEvent) {
            // A run only ever reaches here via its own automatic "every slice attempted" done
            // transition -- a manual Stop already resolves synchronously in ExecutorsPage and
            // never reaches drainTwapEvents (see stopTwapRun's doc comment).
            next = {
              ...next,
              liveTwapRunId: null,
              liveTwapResult: {
                ordersPlaced: twapEvent.ordersPlaced,
                numOrders: twapEvent.numOrders,
                totalQuoteFilled: twapEvent.totalQuoteFilled,
                totalBaseFilled: twapEvent.totalBaseFilled,
                failedSlices: twapEvent.failedSlices,
                stoppedEarly: twapEvent.status === 'stopped'
              },
              status: 'stopped',
              stoppedAt
            }
          }

          if (next.pendingLiveOrderIds.length === 0 && next.liveWatcherId === null && next.liveTwapRunId === null) {
            next = { ...next, status: 'stopped', stoppedAt }
          }

          nextExecutors.push(next)
        }

        await window.api.settings.set({ executors: nextExecutors })
      } catch (error) {
        console.error('Failed to poll live orders/watchers:', error)
      }
    }

    void poll()
    const timer = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return null
}
