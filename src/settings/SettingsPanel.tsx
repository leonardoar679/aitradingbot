import { Moon, Sun, Eye } from 'lucide-react'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/palette'
import { ModelsTab } from '../agents/ModelsTab'
import { UsageTab } from '../agents/UsageTab'

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

/** The settings that are not a key and not a risk limit: those are on Connections and on Risk &
 * Safety. Every value here is still validated by the process that stores it. */
export function SettingsPanel(): React.JSX.Element {
  const { theme, setTheme } = useTheme()

  return (
    <>
      <PageHeader title="Settings" subtitle="Appearance, and the AI models this app may ask. Keys are on Connections, limits on Risk & Safety." />

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

      <SectionHeading
        title="AI"
        note="Which models may be asked, the default and the route, the daily budget, the pace, and what asking has cost."
      />
      <ModelsTab />
      <UsageTab />
    </>
  )
}
