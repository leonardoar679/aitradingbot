import { useEffect } from 'react'
import type { NewsItem, NewsState } from '../../shared/news'
import { DELISTING_NOTICE_LATEST_SECONDS, DELISTING_SHORT_LATEST_SECONDS, delistingHolderNotice, isFreshDelisting, type Holdings } from '../../shared/newsActions'
import { newsShortBrowserDeps, openDelistingShorts, settleNewsShorts } from './newsPaperShort'

/** How often the rule's paper shorts are looked at for one that has closed. */
const SETTLE_MS = 60_000

/** What someone holds: the settings, and the real balances where a Binance key is stored. Balances
 * that cannot be read are left out, never guessed; the notice then says only what is on paper. */
async function readHoldings(): Promise<Holdings> {
  const settings = await window.api.settings.get()
  const holdings: Holdings = { live: null, paperAccount: settings.paperAccount, heldPositions: settings.heldPositions, executors: settings.executors }
  try {
    const keys = await window.api.credentials.list()
    if (keys.some((key) => key.exchange === 'binance' && key.configured)) holdings.live = (await window.api.credentials.balances('binance')).rows
  } catch {
    holdings.live = null
  }
  return holdings
}

/** What the user chose a delisting to do (shared/newsActions.ts): tell someone who holds the coin,
 * and open the rule's paper short. Each, when it is switched on. Never throws. */
async function actOn(item: NewsItem, config: NewsState['config'], nowSec: number): Promise<void> {
  if (config.notifyHeld) {
    try {
      const notice = delistingHolderNotice(item, await readHoldings())
      if (notice !== null) void window.api.notify(notice.title, notice.body).catch(() => undefined)
    } catch (failure) {
      console.error('The news reader could not check what is held:', failure)
    }
  }
  if (config.paperShort.enabled && nowSec - item.releaseSec <= DELISTING_SHORT_LATEST_SECONDS) {
    try {
      for (const line of await openDelistingShorts(item, config, newsShortBrowserDeps)) console.info(`Delisting ${item.id}: ${line}`)
    } catch (failure) {
      console.error('The news reader could not open its paper short:', failure)
    }
  }
}

/** Headless -- mounted once in App.tsx, like OpportunityScheduler. When the news reader keeps a
 * delisting it read in this session, it does what the user chose a delisting to do; and once a
 * minute it stops and settles each of the rule's paper shorts that has closed.
 *
 * It acts only on an announcement read in this session. One read before -- kept the first time the
 * reader was switched on, or before a restart -- has been acted on already, or was too old to act
 * on when it was read. It places nothing real and sells nothing: a notice says so, and a short is
 * paper by a literal in the one file that makes it (./newsPaperShort.ts). */
export function NewsScheduler(): null {
  useEffect(() => {
    let cancelled = false
    const sessionStartSec = Math.floor(Date.now() / 1000) - 60
    const handled = new Set<number>()
    const look = (state: NewsState): void => {
      if (cancelled || !state.config.enabled) return
      const nowSec = Math.floor(Date.now() / 1000)
      for (const item of state.recent) {
        if (handled.has(item.id) || !isFreshDelisting(item, { sessionStartSec, nowSec, latestSeconds: DELISTING_NOTICE_LATEST_SECONDS })) continue
        handled.add(item.id)
        void actOn(item, state.config, nowSec)
      }
    }
    void window.api.news
      .getState()
      .then(look)
      .catch(() => undefined)
    const stop = window.api.news.onUpdate(look)
    // On its own clock: a short opened yesterday is still closed with the reader since switched off.
    const settle = (): void => {
      if (cancelled) return
      void settleNewsShorts(newsShortBrowserDeps).catch((failure: unknown) => console.error('The news reader could not look at its paper shorts:', failure))
    }
    settle()
    const timer = setInterval(settle, SETTLE_MS)
    return (): void => {
      cancelled = true
      stop()
      clearInterval(timer)
    }
  }, [])

  return null
}
