import { useEffect, useState } from 'react'
import { bannerAlerts, dismissAlert, subscribeAlerts, type AlertRecord } from './alertStore'

/** CRITICAL alerts stay here, above every page, until dismissed (the second V3 document, §29): a
 * hack or delisting of a coin you hold, or Bitcoin down 5% within an hour. It shows; it acts on
 * nothing. */
export function AlertBanner(): React.JSX.Element | null {
  const [alerts, setAlerts] = useState<AlertRecord[]>([])
  useEffect(() => subscribeAlerts((list) => setAlerts(bannerAlerts(list))), [])
  if (alerts.length === 0) return null
  return (
    <div role="alert" style={{ background: 'color-mix(in srgb, var(--down) 18%, var(--bg-app))', borderBottom: '1px solid var(--down)' }}>
      {alerts.slice(0, 3).map((alert) => (
        <div key={alert.id} style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', padding: '0.45rem 1rem', fontSize: '0.8rem', color: 'var(--text-primary)' }}>
          <strong style={{ color: 'var(--down)', whiteSpace: 'nowrap' }}>{alert.title}</strong>
          <span style={{ color: 'var(--text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{alert.body}</span>
          {alert.url !== undefined && (
            <button
              onClick={() => void window.api.feed.openLink(alert.url as string).catch(() => undefined)}
              style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.2rem 0.6rem', fontSize: '0.74rem', color: 'var(--text-primary)', cursor: 'pointer' }}
            >
              Open
            </button>
          )}
          <button
            aria-label={`Dismiss: ${alert.title}`}
            onClick={() => dismissAlert(alert.id)}
            style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.2rem 0.6rem', fontSize: '0.74rem', color: 'var(--text-primary)', cursor: 'pointer' }}
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  )
}
