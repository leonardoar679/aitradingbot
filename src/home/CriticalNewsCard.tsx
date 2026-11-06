import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { noteStyle } from '../agents/agentStyles'
import { sumWords } from '../../shared/alerts'
import { loudFirstReports } from '../../shared/incidents'
import type { ReadStory } from '../../shared/newsFeed'
import { subscribeAlerts, type AlertRecord } from '../news/alertStore'
import { useNewsFeed } from '../news/useNewsFeed'
import { useNowSec } from '../utils/useNowSec'
import { useI18n } from '../i18n'

// CRITICAL NEWS, ON HOME (V9 Stage 2, 6 November 2026): the first reports of the last two days of a theft that a
// notice tells HIGH whatever is held -- from a victim whose own token trades, from a top exchange, or of $100 million
// or more (shared/incidents.ts) -- each with its victim, its token and its sum; and the last shock of the market told,
// which can come before any story. Which way prices go after a hack: none to rely on, as V9-HACK-2 measured, said
// once. It reads.

/** First reports shown at most. */
const SHOWN = 3
/** A market shock told within this long is shown. */
const SHOCK_SHOWN_SECONDS = 86_400

/** The card, reading the feed as it is read, and the session's alerts for the last shock told. */
export function CriticalNewsCard(): React.JSX.Element {
  const feed = useNewsFeed()
  const nowSec = useNowSec(true, 60_000)
  const [alerts, setAlerts] = useState<readonly AlertRecord[]>([])
  useEffect(() => subscribeAlerts(setAlerts), [])
  const shock = alerts.find((alert) => alert.kind === 'MARKET_EVENT' && alert.id.startsWith('market-shock:') && nowSec - alert.at <= SHOCK_SHOWN_SECONDS) ?? null
  return <CriticalNewsView reports={feed === null ? null : loudFirstReports(feed.stories, nowSec).slice(0, SHOWN)} shock={shock} />
}

/** What the card shows of the reports and the shock: pure. Null reports is the feed not yet read. */
export function CriticalNewsView({ reports, shock }: { reports: readonly ReadStory[] | null; shock: Pick<AlertRecord, 'at' | 'title'> | null }): React.JSX.Element {
  const i18n = useI18n()
  const { t } = i18n
  const clock = (sec: number): string => t('{time} UTC', { time: i18n.utcTime(sec * 1000) })
  return (
    <Card title={t('Critical news')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem', fontSize: '0.84rem' }}>
        {reports !== null && reports.length === 0 && <span>{t('No first report of a large theft in the last two days.')}</span>}
        {(reports ?? []).map((story) => {
          const incident = story.incident
          const victim = incident?.victim ?? t('Victim not named')
          const named = incident?.victimToken ? t('{victim} ({token})', { victim, token: incident.victimToken }) : victim
          return (
            <div key={story.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                <strong>{named}</strong>
                {incident?.amountUsd != null && <> · {sumWords(incident.amountUsd, i18n)}</>} · {clock(story.publishedAt)}
              </span>
              <button
                type="button"
                onClick={() => void window.api.feed.openLink(story.url).catch(() => undefined)}
                style={{ all: 'unset', cursor: 'pointer', color: 'var(--accent)', lineHeight: 1.35 }}
              >
                {story.title}
              </button>
            </div>
          )
        })}
        {shock !== null && <span>{t('Last market shock: {time}.', { time: clock(shock.at) })} {shock.title}</span>}
        <p style={noteStyle}>
          {t('First reports of a theft in the last two days: of a victim whose own token trades, of a top exchange, or of $100 million or more.')}{' '}
          {t("Which way: unknown. On 24 hacks of 2024 to 2026, a short of the victim's own token from the second day made money in 12 and lost in 12: no way to trade it.")}
        </p>
      </div>
    </Card>
  )
}
