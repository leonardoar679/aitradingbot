import { useEffect } from 'react'
import { NOTICE_REPEAT_SECONDS, btcHourMovePct, crashNotice, crashStep, noticeCoins, noticeSeverity, repeatsNotice, storyNotice, storySeverity, type NoticedStory } from '../../shared/alerts'
import { heldPlaces, type Holdings } from '../../shared/newsActions'
import type { NewsFeedState } from '../../shared/newsFeed'
import { addAlert, addToldAlert, seedAlerts } from './alertStore'

/** A story published longer ago than this when first read is not news to raise. */
const FRESH_SECONDS = 30 * 60
const CRASH_LOOK_MS = 60_000

/** What someone holds: the settings, and the real balances where a Binance key is stored. Balances
 * that cannot be read are left out, never guessed. */
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

/** Headless, mounted once in App.tsx: the alerts of the second V3 document (§28-29). Each story the
 * news feed reads in this session, published within the last half hour, is given a severity
 * (shared/alerts.ts) -- CRITICAL for a hack or delisting of a coin you hold -- and kept for the
 * badge and the banner; WATCH and above also raise a desktop notice, silent at WATCH, and a WATCH
 * notice that only tells again news a notice told in the last six hours is not raised. Once a minute
 * it also looks at Bitcoin's last hour on the live stream, and a fall of 5% is CRITICAL, told once.
 *
 * Binance's own announcements are kept here too, but their notice is the news reader's own
 * (src/news/NewsScheduler.tsx), so none is raised for them twice. It reads, and tells; it opens,
 * closes, sells and asks nothing. */
export function NewsAlertScheduler(): null {
  useEffect(() => {
    let cancelled = false
    const sessionStart = Math.floor(Date.now() / 1000) - 60
    const handled = new Set<string>()
    /** The stories a notice was raised or held back for in the last six hours. */
    let noticed: NoticedStory[] = []

    const look = async (state: NewsFeedState): Promise<void> => {
      const nowSec = Math.floor(Date.now() / 1000)
      const fresh = state.stories.filter((story) => !handled.has(story.id) && !story.stale && story.seenAt >= sessionStart && nowSec - story.publishedAt <= FRESH_SECONDS)
      for (const story of state.stories) handled.add(story.id)
      if (fresh.length === 0 || cancelled) return
      let holdings: Holdings | null = null
      try {
        holdings = await readHoldings()
      } catch {
        holdings = null
      }
      for (const story of fresh) {
        const held = new Set(
          story.assets.filter((asset) => asset.relationship === 'DIRECT' && holdings !== null && heldPlaces(asset.ticker, holdings).length > 0).map((asset) => asset.ticker)
        )
        const severity = storySeverity(story, held, state.reactions[story.id]?.verdict ?? null)
        const places = holdings === null ? [] : [...held].flatMap((ticker) => heldPlaces(ticker, holdings as Holdings))
        const notice = storyNotice(story, severity, places)
        addAlert({ id: story.id, severity, title: notice.title, body: notice.body, at: story.publishedAt, url: story.url, kind: 'NEWS_EVENT' })
        const level = noticeSeverity(severity)
        if (level === null || story.source === 'binance' || cancelled) continue
        noticed = noticed.filter((entry) => nowSec - entry.at < NOTICE_REPEAT_SECONDS)
        const repeat = repeatsNotice(story, severity, noticed, nowSec)
        // Held back or told, it is news told: a third telling is held back against either.
        noticed.push({ coins: noticeCoins(story), title: story.title, at: nowSec })
        if (repeat) continue
        // Told through the one handler, which records it under the story's id and tells the window.
        void window.api.notify(notice.title, notice.body, level, { kind: 'NEWS_EVENT', id: story.id, url: story.url }).catch(() => undefined)
      }
    }

    // The day's alerts, read back from the file: Overview's major alerts after a restart, as told.
    void window.api.records
      .alerts({ sinceSec: Math.floor(Date.now() / 1000) - 86_400 })
      .then((page) => {
        if (!cancelled) seedAlerts(page.rows)
      })
      .catch(() => undefined)
    // And each notice as it is told from now on, whatever raised it: a real position's exit, the
    // live loss limit, the exchange's health, a failure, a breaker.
    const stopTold = window.api.records.onTold((record) => {
      if (!cancelled) addToldAlert(record)
    })
    void window.api.feed
      .getState()
      .then((state) => look(state))
      .catch(() => undefined)
    const stop = window.api.feed.onUpdate((state) => void look(state).catch(() => undefined))

    let telling = false
    const lookAtBitcoin = (): void => {
      void window.api.market
        .liveState()
        .then((live) => {
          if (cancelled) return
          const nowSec = Math.floor(Date.now() / 1000)
          const move = btcHourMovePct(live.btcMinutes, nowSec)
          const step = crashStep(move, telling)
          telling = step.telling
          if (!step.tell || move === null) return
          const notice = crashNotice(move)
          addAlert({ id: `btc-crash:${nowSec}`, severity: 'critical', title: notice.title, body: notice.body, at: nowSec, kind: 'MARKET_EVENT' })
          void window.api.notify(notice.title, notice.body, 'critical', { kind: 'MARKET_EVENT', thread: 'BTCUSDT', id: `btc-crash:${nowSec}` }).catch(() => undefined)
        })
        .catch(() => undefined)
    }
    const timer = setInterval(lookAtBitcoin, CRASH_LOOK_MS)

    return (): void => {
      cancelled = true
      stopTold()
      stop()
      clearInterval(timer)
    }
  }, [])

  return null
}
