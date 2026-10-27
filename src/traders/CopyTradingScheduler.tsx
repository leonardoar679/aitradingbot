import { useEffect } from 'react'
import type { FollowStatus } from '../../shared/traders/follow'
import { cloneBrowserDeps, cloneSignal, settleClones } from './paperClone'
import { followBrowserDeps, followEvent, settleFollows } from './paperFollow'

// THE FOLLOWS' AND THE CLONES' WRITERS, RUNNING (V8 Stage 8, 27 October 2026). Mounted with the app's other
// schedulers: each leader event and clone signal the main process pushes is acted on once, one at a time and in the
// order it came (src/traders/paperFollow.ts, paperClone.ts); those kept in the last ten minutes are read at the start,
// so that none pushed before this mounted is lost; and once a minute the follows and clones due to close are closed
// and the copy book's trades settled a day ago moved to its archive. Nothing runs unless a person followed or cloned
// someone, and nothing it writes is anything but paper.

const CATCH_UP_MS = 10 * 60_000
const SETTLE_MS = 60_000

export function CopyTradingScheduler(): null {
  useEffect(() => {
    const done = new Set<string>()
    let statuses: FollowStatus[] = []
    let chain: Promise<unknown> = Promise.resolve()
    const enqueue = (key: string, run: () => Promise<unknown>): void => {
      if (done.has(key)) return
      done.add(key)
      chain = chain.then(run).catch((error) => console.error(`Copy trading could not act on ${key}:`, error))
    }
    const offEvent = window.api.traders.onLeaderEvent((event) => enqueue(event.key, () => followEvent(event, followBrowserDeps)))
    const offSignal = window.api.traders.onCloneSignal((signal) => enqueue(signal.key, () => cloneSignal(signal, cloneBrowserDeps)))
    const offStatus = window.api.traders.onFollowStatus((next) => {
      statuses = next
    })
    void window.api.traders
      .followStatus()
      .then((next) => {
        statuses = next
      })
      .catch(() => undefined)
    void window.api.traders
      .followRecords(Date.now() - CATCH_UP_MS)
      .then(({ events, signals }) => {
        for (const event of events) enqueue(event.key, () => followEvent(event, followBrowserDeps))
        for (const signal of signals) enqueue(signal.key, () => cloneSignal(signal, cloneBrowserDeps))
      })
      .catch((error) => console.error('Copy trading could not read what it was sent before it started:', error))
    const timer = setInterval(() => {
      chain = chain
        .then(() => settleFollows(statuses, followBrowserDeps))
        .then(() => settleClones(cloneBrowserDeps))
        .catch((error) => console.error('Copy trading could not settle its trades:', error))
    }, SETTLE_MS)
    return (): void => {
      offEvent()
      offSignal()
      offStatus()
      clearInterval(timer)
    }
  }, [])
  return null
}
