import { useEffect } from 'react'
import { AI_ADDITION_PROMPT_VERSIONS, newsReadingsOf } from '../../shared/aiAdditions'
import { NOTICE_REPEAT_SECONDS, btcHourMovePct, crashNotice, crashStep, noticeCoins, noticeSeverity, repeatsNotice, storyNotice, storySeverity, type NoticedStory, type StoryFacts } from '../../shared/alerts'
import type { LiveState } from '../../shared/liveMarket'
import { heldPlaces, type Holdings } from '../../shared/newsActions'
import type { NewsFeedState, ReadStory } from '../../shared/newsFeed'
import { addAlert, addToldAlert, seedAlerts } from './alertStore'

/** A story published longer ago than this when first read is not news to raise. */
const FRESH_SECONDS = 30 * 60
const CRASH_LOOK_MS = 60_000
/** How far before a story the watch's call on its coin is looked for. */
const WATCH_CALL_SECONDS = 3 * 3600

/** What is known of a story when it is told (shared/alerts.ts StoryFacts; the V5 document, §50):
 * the pair's price now and its move since the story's minute -- from the reaction's first window
 * where the feed has one, else from the minutes the live stream holds for the pair -- the source's
 * class, what the price did, the analyst's reading where it answered already, and the watch's
 * latest call on the coin's events. Read from what is on file and on the stream; what cannot be
 * read is not said. */
async function storyFactsOf(story: ReadStory, ticker: string, state: NewsFeedState, live: LiveState | null, nowSec: number): Promise<StoryFacts> {
  const symbol = `${ticker}USDT`
  const reaction = state.reactions[story.id] ?? null
  let price: StoryFacts['price'] = null
  const book = live?.books[symbol]
  const minutes = live?.minutes[symbol] ?? []
  const last = book !== undefined ? (book.bid + book.ask) / 2 : minutes.length > 0 ? minutes[minutes.length - 1].close : null
  if (last !== null) {
    const after = reaction?.after ?? null
    const span = after?.m15 != null ? { movePct: after.m15, over: 'the fifteen minutes after' } : after?.m5 != null ? { movePct: after.m5, over: 'the five minutes after' } : null
    if (span !== null) price = { last, ...span }
    else {
      const since = minutes.find((minute) => minute.time >= Math.floor(story.publishedAt / 60) * 60)
      price = { last, movePct: since !== undefined && since.open > 0 ? ((last - since.open) / since.open) * 100 : null, over: 'the minutes since' }
    }
  }
  let reading: StoryFacts['reading'] = null
  let watchCall: StoryFacts['watchCall'] = null
  try {
    const [readings, calls] = await Promise.all([
      window.api.ai.listCalls({ source: 'addition', promptVersion: AI_ADDITION_PROMPT_VERSIONS.news, sinceSec: story.publishedAt - 3600, limit: 200 }),
      window.api.ai.listCalls({ source: 'watch', symbol, sinceSec: Math.min(nowSec, story.publishedAt) - WATCH_CALL_SECONDS, limit: 20 })
    ])
    const read = newsReadingsOf(readings.rows)[story.id]
    if (read !== undefined) reading = { relationship: read.relationship, direction: read.direction, impact: read.impact }
    const latest = calls.rows.filter((row) => row.status === 'ok' && row.recommendation !== null && row.eventId !== undefined).sort((a, b) => b.at - a.at)[0]
    if (latest !== undefined) {
      watchCall = { side: latest.recommendation === 'buy' ? 'BUY' : latest.recommendation === 'sell' ? 'SELL' : 'NO TRADE', confidence: latest.confidence ?? 0, model: latest.model }
    }
  } catch {
    // The ledger that could not be read is not said.
  }
  return { price, sourceClass: story.sourceClass, reaction: reaction === null ? null : { verdict: reaction.verdict, pricedIn: reaction.pricedIn }, reading, watchCall }
}

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
      let live: LiveState | null = null
      try {
        live = await window.api.market.liveState()
      } catch {
        live = null
      }
      for (const story of fresh) {
        const held = new Set(
          story.assets.filter((asset) => asset.relationship === 'DIRECT' && holdings !== null && heldPlaces(asset.ticker, holdings).length > 0).map((asset) => asset.ticker)
        )
        const severity = storySeverity(story, held, state.reactions[story.id]?.verdict ?? null)
        const places = holdings === null ? [] : [...held].flatMap((ticker) => heldPlaces(ticker, holdings as Holdings))
        const ticker = story.assets.find((asset) => asset.relationship === 'DIRECT')?.ticker ?? null
        const facts = ticker === null ? {} : await storyFactsOf(story, ticker, state, live, nowSec)
        const notice = storyNotice(story, severity, places, facts)
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
