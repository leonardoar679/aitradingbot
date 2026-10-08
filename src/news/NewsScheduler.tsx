import { useEffect } from 'react'
import { newsActionsFor, type NewsItem, type NewsState } from '../../shared/news'
import { DELISTING_SHORT_LATEST_SECONDS, NEWS_NOTICE_LATEST_SECONDS, isFreshNews, newsHolderNotice, tagShortWindow, type Holdings } from '../../shared/newsActions'
import { newsShortBrowserDeps, openNewsShorts, settleNewsShorts } from './newsPaperShort'
import { recordPaperRefusal } from '../agents/paperRefusals'

/** How often the rules' paper shorts are looked at for one that has closed. */
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

async function openShorts(item: NewsItem, config: NewsState['config']): Promise<void> {
  const actions = newsActionsFor(config, item.category)
  if (actions === null) return
  try {
    for (const line of await openNewsShorts(item, actions, newsShortBrowserDeps)) {
      console.info(`Announcement ${item.id}: ${line}`)
      // For the session report: a short refused, and why.
      if (!line.endsWith('was opened.')) {
        const nowMs = Date.now()
        const refusal = { id: `${item.id}:${line.split(':')[0]}:${nowMs}`, at: Math.floor(nowMs / 1000), source: 'news' as const, symbol: `${line.split(':')[0]}USDT`, text: line }
        recordPaperRefusal(refusal)
        // And on file (shared/records.ts), so a restart loses it not.
        void window.api.records.refusal(refusal).catch(() => undefined)
      }
    }
  } catch (failure) {
    console.error('The news reader could not open its paper short:', failure)
  }
}

/** What the user chose an announcement of its kind to do (shared/newsActions.ts): tell someone who
 * holds the coin, and open the kind's paper short. Each, when it is switched on for the kind. A
 * tag's short waits for its minute: `later` runs it then. Never throws. */
async function actOn(item: NewsItem, config: NewsState['config'], nowSec: number, later: (work: () => void, atSec: number) => void): Promise<void> {
  const actions = newsActionsFor(config, item.category)
  if (actions === null) return
  if (actions.notifyHeld) {
    try {
      const notice = newsHolderNotice(item, await readHoldings())
      if (notice !== null) void window.api.notify(notice.title, notice.body).catch(() => undefined)
    } catch (failure) {
      console.error('The news reader could not check what is held:', failure)
    }
  }
  if (!actions.paperShort.enabled) return
  if (item.category === 'DELISTING' && nowSec - item.releaseSec <= DELISTING_SHORT_LATEST_SECONDS) await openShorts(item, config)
  if (item.category === 'MONITORING_TAG') {
    // The rule enters at the second minute after the announcement's: the short is made once the
    // first has begun. One read later than that is too late, and the writer says so.
    const opens = tagShortWindow(item.releaseSec)
    if (nowSec <= opens.toSec) later(() => void openShorts(item, config), opens.fromSec)
  }
}

/** Headless -- mounted once in App.tsx, like OpportunityScheduler. When the news reader keeps a
 * delisting, or a coin added to the Monitoring Tag, read in this session, it does what the user
 * chose that kind to do; and once a minute it stops and settles each of the rules' paper shorts
 * that has closed.
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
    const waiting = new Set<ReturnType<typeof setTimeout>>()
    const later = (work: () => void, atSec: number): void => {
      const timer = setTimeout(
        () => {
          waiting.delete(timer)
          if (!cancelled) work()
        },
        Math.max(0, atSec * 1000 - Date.now())
      )
      waiting.add(timer)
    }
    const look = (state: NewsState): void => {
      if (cancelled || !state.config.enabled) return
      const nowSec = Math.floor(Date.now() / 1000)
      for (const item of state.recent) {
        if (handled.has(item.id) || !isFreshNews(item, { sessionStartSec, nowSec, latestSeconds: NEWS_NOTICE_LATEST_SECONDS })) continue
        handled.add(item.id)
        void actOn(item, state.config, nowSec, later)
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
      for (const waits of waiting) clearTimeout(waits)
    }
  }, [])

  return null
}
