import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { TextLink } from '../components/TextLink'
import type { Page } from '../navigation/pages'
import { NEWS_FINDINGS, describeNewsCategory, type NewsCategory, type NewsItem, type NewsState } from '../../shared/news'
import { cellStyle, headCellStyle, noteStyle } from '../agents/agentStyles'
import { describeError } from '../utils/ipcError'

const SHOWN = 30
const KINDS: NewsCategory[] = ['DELISTING', 'FUTURES_LAUNCH', 'SPOT_LISTING']

function utcMinute(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 19)
}

/** How long after its release the reader first read an article. One read the first time the
 * reader was switched on was already on the list, and says so. */
function readAfter(item: NewsItem): string {
  const seconds = item.seenAt - item.releaseSec
  if (seconds < 0 || seconds >= 3600) return 'already listed'
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} after`
}

/** Binance's own announcements as the reader has read them (electron/services/newsService.ts),
 * sorted by their titles into the kinds research/NEWS.md measured, with what each kind did to
 * prices. Read and shown only: this card asks no model and opens nothing. */
export function NewsCard({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const [state, setState] = useState<NewsState | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [everything, setEverything] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.news.getState().then(
      (next) => {
        if (!cancelled) setState(next)
      },
      (failure: unknown) => {
        if (!cancelled) setProblem(describeError(failure))
      }
    )
    const stop = window.api.news.onUpdate((next) => {
      if (!cancelled) setState(next)
    })
    return (): void => {
      cancelled = true
      stop()
    }
  }, [])

  const enabled = state?.config.enabled === true
  const recent = state?.recent ?? []
  const sorted = recent.filter((item) => item.category !== null)
  const rows = (everything ? recent : sorted).slice(0, SHOWN)

  return (
    <Card title="Binance announcements">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', fontSize: '0.85rem' }}>
        <span style={{ color: enabled ? 'var(--up)' : 'var(--text-secondary)', fontWeight: 700 }}>{enabled ? 'On' : 'Off'}</span>
        <span style={{ color: 'var(--text-secondary)' }}>
          {enabled && state?.lastReadAt !== null && state?.lastReadAt !== undefined ? `Last read ${utcClock(state.lastReadAt)} UTC. ` : ''}
          It is switched on and off under <TextLink onClick={() => onNavigate('settings')}>Settings › Market</TextLink>.
        </span>
      </div>
      {(problem ?? state?.error) && <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.6rem' }}>{problem ?? state?.error}</p>}

      {recent.length === 0 ? (
        <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
          {enabled ? 'Nothing read yet.' : 'Switch the reader on under Settings › Market to see what Binance announces.'}
        </p>
      ) : (
        <>
          <div style={{ overflowX: 'auto', marginTop: '0.8rem' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={headCellStyle}>Released (UTC)</th>
                  <th style={headCellStyle}>Read</th>
                  <th style={headCellStyle}>Kind</th>
                  <th style={headCellStyle}>Coins</th>
                  <th style={headCellStyle}>Title</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr key={item.id}>
                    <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{utcMinute(item.releaseSec)}</td>
                    <td style={{ ...cellStyle, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{readAfter(item)}</td>
                    <td
                      style={{
                        ...cellStyle,
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        color: item.category === null ? 'var(--text-muted)' : item.category === 'DELISTING' ? 'var(--down)' : 'var(--up)'
                      }}
                    >
                      {item.category === null ? '—' : describeNewsCategory(item.category)}
                    </td>
                    <td style={{ ...cellStyle, fontWeight: 600 }}>{item.tickers.length === 0 ? '—' : item.tickers.join(', ')}</td>
                    <td style={{ ...cellStyle, color: 'var(--text-secondary)' }}>{item.title}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.6rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={everything} onChange={(event) => setEverything(event.target.checked)} />
            Every announcement read, not only the three kinds ({recent.length - sorted.length} others)
          </label>
        </>
      )}

      <div style={{ marginTop: '0.8rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {KINDS.map((kind) => (
          <p key={kind} style={{ ...noteStyle, margin: 0 }}>
            <strong style={{ color: 'var(--text-primary)' }}>{describeNewsCategory(kind)}.</strong> {NEWS_FINDINGS[kind]}
          </p>
        ))}
      </div>
      <p style={{ ...noteStyle, marginTop: '0.6rem' }}>
        What each kind did is from 2025 to September 2026, measured from the first minute an app reading the list once a minute could
        act (research/NEWS.md). It is what prices did, not advice. What a delisting does is set under Settings › Market: a notice if
        you hold the coin, and a paper short by the rule. Nothing real is placed or sold because of an announcement, and a short can
        never be placed for real here.
      </p>
    </Card>
  )
}
