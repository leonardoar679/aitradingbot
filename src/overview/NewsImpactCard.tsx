import { useMemo } from 'react'
import { Card } from '../components/Card'
import { TextLink } from '../components/TextLink'
import { describeEventType } from '../../shared/newsFeed'
import { noteStyle } from '../agents/agentStyles'
import type { Page } from '../navigation/pages'
import { useNewsFeed } from '../news/useNewsFeed'
import { useNewsReadings } from '../news/useNewsReadings'
import { useNowSec } from '../utils/useNowSec'
import { describeReaction, newsImpact } from './overviewBlocks'

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 16)
}

/** The strongest stories of the last six hours that name a coin: their kind and impact, the news
 * analyst's reading where it read them, and what the price did after (the second V3 document,
 * §51). It reads the stories on file and the ledger; it asks nothing. */
export function NewsImpactCard({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const news = useNewsFeed()
  const readings = useNewsReadings(news)
  const nowSec = useNowSec(true, 60_000)
  const rows = useMemo(() => (news === null ? [] : newsImpact(news.stories, readings, news.reactions, nowSec)), [news, readings, nowSec])

  return (
    <Card title="News impact">
      {news === null ? (
        <p style={{ ...noteStyle, marginTop: 0 }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ ...noteStyle, marginTop: 0 }}>No story naming a coin in the last six hours.</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.86rem', lineHeight: 1.6, color: 'var(--text-primary)' }}>
          {rows.map(({ story, reading, reaction }) => (
            <li key={story.id}>
              {utcClock(story.publishedAt)} UTC · <strong>{story.assets.map((asset) => asset.ticker).join(', ')}</strong> · {describeEventType(story.eventType)} · impact{' '}
              {Math.round(story.impact)}
              {reading !== null && reading.ticker !== null && (
                <span style={{ color: 'var(--text-secondary)' }}>
                  {' '}
                  · read as {reading.ticker} {reading.direction === 'none' ? 'neither way' : reading.direction}, impact {reading.impact}
                </span>
              )}
              {reaction !== null && <span style={{ color: 'var(--text-secondary)' }}> · price after: {describeReaction(reaction)}</span>}
              <span style={{ color: 'var(--text-secondary)' }}> · {story.title}</span>
            </li>
          ))}
        </ul>
      )}
      <p style={{ margin: '0.7rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
        Every story, with its link, is on <TextLink onClick={() => onNavigate('discovery')}>Discovery</TextLink>.
      </p>
    </Card>
  )
}
