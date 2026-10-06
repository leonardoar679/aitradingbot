import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { HIGH_IMPACT, WATCH_IMPACT } from '../../shared/alerts'
import { IMPACT_MIN_STORIES, describeEventType, type ReadStory, type StoryReaction } from '../../shared/newsFeed'
import { describeNewsReading } from '../../shared/aiAdditions'
import { markAlertsSeen } from '../news/alertStore'
import { useNewsFeed } from '../news/useNewsFeed'
import { useNewsReadings } from '../news/useNewsReadings'
import { WhyButton } from '../news/WhyItMovedHost'

type Filter = 'all' | 'btc' | 'eth' | 'alts' | 'market' | 'major'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'btc', label: 'Bitcoin' },
  { id: 'eth', label: 'Ethereum' },
  { id: 'alts', label: 'Altcoins' },
  { id: 'market', label: 'Market-wide' },
  { id: 'major', label: 'Major alerts' }
]

const SHOWN = 60

function utcStamp(sec: number): string {
  const iso = new Date(sec * 1000).toISOString()
  const today = new Date().toISOString().slice(0, 10)
  return iso.slice(0, 10) === today ? `${iso.slice(11, 16)}` : `${iso.slice(5, 10)} ${iso.slice(11, 16)}`
}

const pct = (value: number | null): string => (value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`)

function keep(story: ReadStory, filter: Filter, reaction: StoryReaction | undefined): boolean {
  const tickers = story.assets.map((asset) => asset.ticker)
  if (filter === 'btc') return tickers.includes('BTC')
  if (filter === 'eth') return tickers.includes('ETH')
  if (filter === 'alts') return tickers.some((ticker) => ticker !== 'BTC' && ticker !== 'ETH')
  if (filter === 'market') return story.marketWide
  if (filter === 'major') return story.impact >= HIGH_IMPACT || reaction?.verdict === 'CONFIRMED'
  return true
}

function Reaction({ reaction }: { reaction: StoryReaction | undefined }): React.JSX.Element {
  if (reaction === undefined) return <span style={{ color: 'var(--text-muted)' }}>—</span>
  const tone = reaction.verdict === 'CONFIRMED' ? 'var(--up)' : reaction.verdict === 'AGAINST' ? 'var(--down)' : 'var(--text-secondary)'
  return (
    <span title={`${reaction.symbol}: 5m ${pct(reaction.after.m5)}, 15m ${pct(reaction.after.m15)}, 1h ${pct(reaction.after.h1)}, 4h ${pct(reaction.after.h4)}`}>
      <strong style={{ color: tone }}>{reaction.verdict}</strong>
      <span style={{ color: 'var(--text-muted)' }}>
        {' '}
        15m {pct(reaction.after.m15)}
        {reaction.after.h1 !== null && `, 1h ${pct(reaction.after.h1)}`}
        {reaction.pricedIn && ' · already moved before'}
      </span>
    </span>
  )
}

const cell: React.CSSProperties = { padding: '0.45rem 0.5rem', fontSize: '0.8rem', borderBottom: '1px solid var(--border)', verticalAlign: 'top' }
const head: React.CSSProperties = { ...cell, fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textAlign: 'left' }

/** News & Market Events (the second V3 document, §53): the stories of four free feeds and Binance's
 * announcements, the coins each names, its kind and impact, and what the price did around it
 * (shared/newsFeed.ts) -- and, under a story of high impact, the news analyst's reading of it, where
 * it has read one (shared/aiAdditions.ts). Opening it marks the alerts seen. It reads; nothing here
 * asks a model, places or sells anything. */
export function NewsFeedCard(): React.JSX.Element {
  const feed = useNewsFeed()
  const readings = useNewsReadings(feed)
  const [filter, setFilter] = useState<Filter>('all')
  useEffect(() => markAlertsSeen(), [feed])

  const stories = feed === null ? [] : feed.stories.filter((story) => keep(story, filter, feed.reactions[story.id]))

  return (
    <Card
      title="News & Market Events"
      actions={
        <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setFilter(entry.id)}
              style={{
                background: filter === entry.id ? 'var(--accent-soft)' : 'none',
                border: `1px solid ${filter === entry.id ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-sm)',
                padding: '0.2rem 0.6rem',
                fontSize: '0.74rem',
                fontWeight: 600,
                color: filter === entry.id ? 'var(--accent)' : 'var(--text-primary)',
                cursor: 'pointer'
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      }
    >
      {feed === null ? (
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>Reading the news…</p>
      ) : (
        <>
          <p style={{ margin: '0 0 0.6rem', fontSize: '0.76rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {feed.sources.map((source, index) => (
              <span key={source.id} style={{ color: source.ok === false ? 'var(--down)' : undefined }} title={source.error ?? undefined}>
                {index > 0 && ' · '}
                {source.name} {source.ok === null ? 'not read yet' : source.ok ? `${source.items} items` : 'could not be read'}
              </span>
            ))}
            {feed.updatedAt !== null && <span style={{ color: 'var(--text-muted)' }}> · read at {utcStamp(feed.updatedAt)} UTC, every three minutes</span>}
          </p>
          {stories.length === 0 ? (
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>No story here yet.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={head}>UTC</th>
                    <th style={head}>Story</th>
                    <th style={head}>Coins</th>
                    <th style={head}>Kind</th>
                    <th style={head}>Impact</th>
                    <th style={head}>Price after</th>
                    <th style={head} />
                  </tr>
                </thead>
                <tbody>
                  {stories.slice(0, SHOWN).map((story) => {
                    const reaction = feed.reactions[story.id]
                    const direct = story.assets.find((asset) => asset.relationship === 'DIRECT')
                    return (
                      <tr key={story.id}>
                        <td style={{ ...cell, whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{utcStamp(story.publishedAt)}</td>
                        <td style={{ ...cell, minWidth: 260 }}>
                          <div style={{ fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.4 }}>{story.title}</div>
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                            {story.sourceName}
                            {story.alsoIn.length > 0 && ` · also ${story.alsoIn.join(', ')}`}
                            {story.stale && ' · old news'}
                          </div>
                          {readings[story.id] !== undefined && (
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.2rem', lineHeight: 1.45 }} title={readings[story.id].reasons}>
                              <strong style={{ color: 'var(--accent)' }}>AI reading:</strong> {describeNewsReading(readings[story.id])}
                            </div>
                          )}
                        </td>
                        <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                          {story.assets.length === 0 ? (
                            <span style={{ color: 'var(--text-muted)' }}>{story.marketWide ? 'Market' : '—'}</span>
                          ) : (
                            story.assets.slice(0, 4).map((asset) => (
                              <span
                                key={asset.ticker}
                                title={asset.relationship === 'DIRECT' ? 'Named in the title' : 'Mentioned in the summary'}
                                style={{ marginRight: '0.35rem', fontWeight: asset.relationship === 'DIRECT' ? 700 : 400, color: asset.relationship === 'DIRECT' ? 'var(--text-primary)' : 'var(--text-muted)' }}
                              >
                                {asset.ticker}
                              </span>
                            ))
                          )}
                        </td>
                        <td style={{ ...cell, whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{describeEventType(story.eventType)}</td>
                        <td style={{ ...cell, fontWeight: 700, color: story.impact >= HIGH_IMPACT ? 'var(--down)' : story.impact >= WATCH_IMPACT ? 'var(--gold)' : 'var(--text-muted)' }}>
                          {story.impact}
                        </td>
                        <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                          <Reaction reaction={reaction} />
                        </td>
                        <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                          <button
                            onClick={() => void window.api.feed.openLink(story.url).catch(() => undefined)}
                            style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.1rem 0.45rem', fontSize: '0.7rem', color: 'var(--text-primary)', cursor: 'pointer', marginRight: '0.3rem' }}
                          >
                            Open
                          </button>
                          {direct !== undefined && <WhyButton symbol={`${direct.ticker}USDT`} compact />}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ marginTop: '1rem', fontSize: '0.74rem', fontWeight: 700, color: 'var(--text-secondary)' }}>What each kind of news did, once measured to its end</div>
          {feed.impact.length === 0 ? (
            <p style={{ margin: '0.3rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              No story has been followed for four hours yet. Insufficient historical evidence.
            </p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '0.3rem' }}>
              <thead>
                <tr>
                  <th style={head}>Kind</th>
                  <th style={head}>Stories</th>
                  <th style={head}>Median 5m</th>
                  <th style={head}>15m</th>
                  <th style={head}>1h</th>
                  <th style={head}>4h</th>
                  <th style={head}>Up at 1h</th>
                </tr>
              </thead>
              <tbody>
                {feed.impact.map((row) => (
                  <tr key={row.eventType}>
                    <td style={cell}>{describeEventType(row.eventType)}</td>
                    <td style={cell}>{row.stories}</td>
                    {row.enough && row.medianPct !== null ? (
                      <>
                        <td style={cell}>{pct(row.medianPct.m5)}</td>
                        <td style={cell}>{pct(row.medianPct.m15)}</td>
                        <td style={cell}>{pct(row.medianPct.h1)}</td>
                        <td style={cell}>{pct(row.medianPct.h4)}</td>
                        <td style={cell}>{row.shareUp1h === null ? '—' : `${Math.round(row.shareUp1h * 100)}%`}</td>
                      </>
                    ) : (
                      <td style={{ ...cell, color: 'var(--text-muted)' }} colSpan={5}>
                        Insufficient historical evidence: {row.stories} of the {IMPACT_MIN_STORIES} needed.
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p style={{ margin: '0.8rem 0 0', fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Four free feeds — CoinDesk, The Block, Cointelegraph and Decrypt — and Binance&apos;s own announcements, read every three minutes; no key, no cost. A
            coin in bold is named in the title, in grey only mentioned; coins are matched by rules, never guessed. Impact is the kind of news, how directly it
            names a coin, the source and how fresh it is, 0 to 100. &quot;Price after&quot; is the coin&apos;s move from the minute the story was published:
            CONFIRMED when it went the way that kind of news would send it, by 1% within fifteen minutes. Nothing here is a reason the app trades.
          </p>
        </>
      )}
    </Card>
  )
}
