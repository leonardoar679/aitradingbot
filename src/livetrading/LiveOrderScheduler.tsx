import { useEffect } from 'react'
import type { ExecutorConfig, DcaExecutorParams, GridExecutorParams } from '../../shared/ipc'
import { describeError } from '../utils/ipcError'
import { settingsWrites } from '../utils/settingsWrites'
import { needsExitWatcherRetry, isFinished } from './liveExecutorState'

/** Headless — mounted once in App.tsx, same tier as RoutineScheduler/ControllerScheduler.
 * Reconciles main-process-resolved real-money state into settings.executors every 5s, the same
 * read-modify-write pattern RoutineScheduler already uses to update state a page mounted
 * elsewhere might be showing:
 *   1. Every open live limit order (liveOrdersService.ts) — for anything resolved, removes its id
 *      from the matching executor's pendingLiveOrderIds and patches liveOrder. A live Order limit
 *      always has exactly one id here; a live DCA ladder or Grid's bounded ladder (Phase 6) can
 *      have several (one per unfilled level/order), any of which can resolve independently in the
 *      same tick.
 *   2. A live DCA or Grid fill specifically also needs its exit watcher created (on the first
 *      fill) or refreshed (on every later fill, since the true weighted-average cost keeps moving
 *      until the ladder exits or runs out of levels — paper DCA always evaluates TP/SL/time-limit
 *      against the CURRENT average, never a stale snapshot, and the live watcher has to match
 *      that; live Grid shares this same "one shared exit across many fills" model rather than
 *      paper Grid's per-level independent exits — see the Phase 6 plan). Position never reaches
 *      this path — its one entry resolves synchronously in ExecutorsPage.handleCreate, not via
 *      this poll.
 *   3. Every live Position/DCA/Grid watcher's resolved exit (livePositionWatchersService.ts) —
 *      the actual triggering runs continuously in the main process independent of this poll (see
 *      startLivePositionWatcherLoop in electron/main.ts); this just picks up the result and
 *      patches the matching executor's status/liveExitResult.
 * An executor only goes 'stopped' once BOTH pendingLiveOrderIds is empty AND liveWatcherId is
 * null — a live DCA or Grid executor can have unfilled levels and an active watcher at the same
 * time, unlike Order (always exactly one resting order, never a watcher) or Position (never a
 * resting order, always exactly one watcher).
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
        if (cancelled) return

        const settings = await window.api.settings.get()
        if (cancelled) return

        // Arming a watcher can fail (a bad signature, a clock skew, a dropped connection) and the
        // fill that needed it is drained from orderResolutions after one tick -- so waiting for
        // another fill to retry would mean never retrying. Retry is driven by stored state
        // instead, which also covers the case where the fill arrived before its position did.
        const retryIds = new Set(settings.executors.filter(needsExitWatcherRetry).map((e) => e.id))
        if (
          orderResolutions.length === 0 &&
          watcherEvents.length === 0 &&
          twapEvents.length === 0 &&
          retryIds.size === 0
        )
          return
        const stoppedAt = Math.floor(Date.now() / 1000)

        // A live DCA fill this tick needs the position's current weighted-average cost to create
        // or refresh its exit watcher — fetched once and shared, rather than once per executor.
        const needsPositionLookup = orderResolutions.some((r) => r.status === 'filled') || retryIds.size > 0
        const livePositions = needsPositionLookup ? await window.api.liveTrading.listPositions() : []

        // Only the executors this tick actually touches are collected, and they're merged into a
        // FRESH read of settings just before writing (below). Writing the whole array built from
        // the snapshot taken above would clobber anything saved in between -- and "in between" is
        // seconds long here, spanning listPositions() and any createWatcher() calls. An executor
        // the user created during that window would vanish from settings while its real resting
        // order carried on existing, tracked by nothing.
        const changed = new Map<string, ExecutorConfig>()
        for (const executor of settings.executors) {
          const myResolutions = orderResolutions.filter((r) => r.executorId === executor.id)
          const watcherEvent = watcherEvents.find((e) => e.executorId === executor.id)
          const twapEvent = twapEvents.find((e) => e.executorId === executor.id)

          if (myResolutions.length === 0 && !watcherEvent && !twapEvent && !retryIds.has(executor.id)) continue

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
          // Live Grid shares this exact create-or-refresh-watcher mechanism with live DCA (see
          // the Phase 6 plan) -- both place several independent resting orders that fold into one
          // shared, ever-moving average cost. Grid has no native stop-loss/time-limit fields (and
          // its Stop Price isn't enforced live -- see the Phase 6 plan), so those stay null.
          const hadFill = myResolutions.some((r) => r.status === 'filled')
          if ((next.type === 'dca' || next.type === 'grid') && (hadFill || retryIds.has(next.id)) && !watcherEvent) {
            const position = livePositions.find((p) => p.exchange === next.exchange && p.symbol === next.symbol)
            if (position) {
              try {
                if (next.liveWatcherId) {
                  await window.api.liveTrading.updateWatcherEntryPrice(next.liveWatcherId, position.avgCost)
                  next = { ...next, liveWatcherError: null }
                } else if (next.type === 'dca') {
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
                  next = { ...next, liveWatcherId: watcher.id, liveWatcherError: null }
                } else {
                  const gridParams = next.params as GridExecutorParams
                  const watcher = await window.api.liveTrading.createWatcher(
                    next.id,
                    next.exchange,
                    next.symbol,
                    position.avgCost,
                    gridParams.takeProfitPct,
                    null,
                    null,
                    null
                  )
                  next = { ...next, liveWatcherId: watcher.id, liveWatcherError: null }
                }
              } catch (error) {
                console.error(`Failed to create/update live ${next.type} watcher for executor ${next.id}:`, error)
                next = { ...next, liveWatcherError: describeError(error) }
              }
            } else {
              // A fill with no position to arm against. Genuinely anomalous, and silent until now:
              // the executor fell straight through to the "nothing left, so we are done" rule.
              next = {
                ...next,
                liveWatcherError: `filled, but no open ${next.symbol} position was found to arm an exit watcher against`
              }
            }
          }

          if (watcherEvent) {
            // The watcher's own resolution already cancelled every sibling resting order for
            // this executor server-side (cancelSiblingLiveOrders, resolved directly via
            // cancelLiveOrderById -- not through this poll's own queryOrder path, so those ids
            // would never otherwise show up in orderResolutions this tick or any later one).
            // Clear them here rather than waiting for a poll response that will never come.
            next = { ...next, liveExitResult: watcherEvent.liveExitResult, liveWatcherId: null, pendingLiveOrderIds: [], liveWatcherError: null }
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

          if (isFinished(next)) {
            next = { ...next, status: 'stopped', stoppedAt }
          }

          changed.set(next.id, next)
        }

        if (changed.size === 0) return
        // Read and write together on the shared queue: ExecutorsPage writes the same array, and
        // a page write landing between this read and this write would drop these patches.
        await settingsWrites(async () => {
          const fresh = await window.api.settings.get()
          if (cancelled) return
          await window.api.settings.set({ executors: fresh.executors.map((e) => changed.get(e.id) ?? e) })
        })
      } catch (error) {
        console.error('Failed to poll live orders/watchers:', error)
      }
    }

    // Matches the re-entry guard both main-process loops carry. poll() awaits a credential
    // decrypt, endpoint resolution and a signed query per open order; an endpoint failover
    // alone has been measured at a 10s connect timeout against this 5s interval.
    let polling = false
    const tick = (): void => {
      if (polling) return
      polling = true
      void poll().finally(() => {
        polling = false
      })
    }

    tick()
    const timer = setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return null
}
