import { Moon, Sun, Eye } from 'lucide-react'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { TextLink } from '../components/TextLink'
import { useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/palette'
import { ModelsTab } from '../agents/ModelsTab'
import { UsageTab } from '../agents/UsageTab'
import type { Page } from '../navigation/pages'
import { NewsSettingsCard } from './NewsSettingsCard'
import { ScannerSettingsCard } from './ScannerSettingsCard'

const THEME_OPTIONS: { id: Theme; label: string; icon: typeof Moon }[] = [
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'colorblind', label: 'Colorblind', icon: Eye }
]

function SectionHeading({ title, note }: { title: string; note: string }): React.JSX.Element {
  return (
    <div style={{ marginTop: '0.4rem' }}>
      <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>{title}</h2>
      <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{note}</p>
    </div>
  )
}

/** The Configuration Center: every setting that is not a key or a risk limit, in sections, and
 * only settings that exist -- no control with nothing behind it (docs/INVENTORY.md lists what the
 * V3 document asked for that does not). Keys are on Connections and limits on Risk & Safety, each
 * in the one place, linked from the foot of this page. Every value here is still validated by the
 * process that stores it. */
export function SettingsPanel({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const { theme, setTheme } = useTheme()

  return (
    <>
      <PageHeader title="Settings" subtitle="How the app looks, what the app reads of the market, and which AI models may be asked" />

      <SectionHeading title="General" note="How the app looks." />
      <Card title="Appearance">
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          {THEME_OPTIONS.map(({ id, label, icon: Icon }) => {
            const active = theme === id
            return (
              <button
                key={id}
                onClick={() => setTheme(id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.6rem 1rem',
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-sm)',
                  background: active ? 'var(--accent-soft)' : 'var(--bg-app)',
                  color: active ? 'var(--accent)' : 'var(--text-primary)',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                <Icon size={15} />
                {label}
              </button>
            )
          })}
        </div>
      </Card>

      <SectionHeading title="Market" note="What the scanner watches, and whether Binance's announcements are read. Both are shown on Discovery." />
      <ScannerSettingsCard />
      <NewsSettingsCard />

      <SectionHeading
        title="AI"
        note="Which models may be asked, the default and the route, the daily budget, the pace, and what asking has cost. The watch is switched on and off on Opportunities, beside what it has asked."
      />
      <ModelsTab />
      <UsageTab />

      <SectionHeading title="Elsewhere" note="Two kinds of setting each have a page of their own." />
      <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        Exchange keys and the OpenRouter key are on <TextLink onClick={() => onNavigate('connections')}>Connections</TextLink>. The limits
        every real order is checked against, and the controller groups, are on{' '}
        <TextLink onClick={() => onNavigate('risk')}>Risk &amp; Safety</TextLink>.
      </p>
    </>
  )
}
