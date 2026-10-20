import { useState } from 'react'
import { Moon, Sun, Eye } from 'lucide-react'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { TextLink } from '../components/TextLink'
import { useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/palette'
import { ModelsTab } from '../agents/ModelsTab'
import { ModelRegistryCard } from '../agents/ModelRegistryCard'
import { UsageTab } from '../agents/UsageTab'
import { AiAdditionsCard } from '../agents/AiAdditionsCard'
import { RoutingCard } from '../agents/RoutingCard'
import { ResearchFolderCard } from './ResearchFolderCard'
import { EffectiveConfigCard } from './EffectiveConfigCard'
import type { Page } from '../navigation/pages'
import type { UiMode } from '../../shared/uiMode'
import { EssentialsCard } from './EssentialsCard'
import { NotificationsCard } from './NotificationsCard'
import { NewsSettingsCard } from './NewsSettingsCard'
import { ScannerSettingsCard } from './ScannerSettingsCard'
import { LanguageCard } from './LanguageCard'
import { EnglishOnly, useI18n, type Language } from '../i18n'

/** Whether Advanced was left open, remembered on this computer only. A browser store that cannot be
 * read is a closed Advanced, not an error. */
const ADVANCED_KEY = 'settings.advancedOpen'

function readAdvancedOpen(): boolean {
  try {
    return window.localStorage.getItem(ADVANCED_KEY) === 'true'
  } catch {
    return false
  }
}

function writeAdvancedOpen(open: boolean): void {
  try {
    window.localStorage.setItem(ADVANCED_KEY, String(open))
  } catch {
    // Not remembered; it opens closed next time.
  }
}

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
 * process that stores it.
 *
 * SMART DEFAULTS FIRST, ADVANCED SECOND (the second V3 document, 6 October 2026). The six settings
 * that decide what the app does by itself are at the top (EssentialsCard); everything else is under
 * Advanced, closed until opened. A fresh install needs nothing from it. */
export function SettingsPanel({
  onNavigate,
  onUiModeChange,
  onLanguageChange
}: {
  onNavigate: (page: Page) => void
  onUiModeChange: (mode: UiMode) => void
  onLanguageChange: (language: Language) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { theme, setTheme } = useTheme()
  const [advanced, setAdvanced] = useState(readAdvancedOpen)

  function toggleAdvanced(): void {
    setAdvanced((open) => {
      writeAdvancedOpen(!open)
      return !open
    })
  }

  return (
    <>
      <PageHeader title={t('Settings')} subtitle={t('What the app does by itself, in six settings, with the rest under Advanced')} />

      <EssentialsCard onNavigate={onNavigate} onUiModeChange={onUiModeChange} />
      <LanguageCard onLanguageChange={onLanguageChange} />

      <button
        aria-expanded={advanced}
        onClick={toggleAdvanced}
        style={{
          alignSelf: 'flex-start',
          background: 'none',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          padding: '0.5rem 0.9rem',
          color: 'var(--text-primary)',
          fontSize: '0.85rem',
          fontWeight: 700,
          cursor: 'pointer'
        }}
      >
        {advanced ? `▾ ${t('Advanced')}` : `▸ ${t('Advanced')}`}
      </button>
      {!advanced && (
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {t('Notifications, appearance, the scanner and the news reader in full, the AI models, their route, the daily budget and what asking has cost.')}
        </p>
      )}
      {advanced && <AdvancedSettings theme={theme} setTheme={setTheme} onNavigate={onNavigate} />}
    </>
  )
}

/** Every setting that is not one of the six: as the page held them before, section by section. The
 * notifications are in the window's language (V6 Stage 14); the rest is for an expert, in English. */
function AdvancedSettings({ theme, setTheme, onNavigate }: { theme: Theme; setTheme: (theme: Theme) => void; onNavigate: (page: Page) => void }): React.JSX.Element {
  const { t } = useI18n()
  // A move to roles changes what the models and additions cards show: they are read again after one.
  const [routingVersion, setRoutingVersion] = useState(0)
  return (
    <>
      <SectionHeading title={t('Notifications')} note={t('What each notice sounds like, how loud, and when it is quiet. The switch for notices themselves is on Essentials.')} />
      <NotificationsCard />

      <EnglishOnly>
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

      <SectionHeading title="Market" note="What the scanner watches, and whether Binance's announcements are read. Both are shown on Explorer." />
      <ScannerSettingsCard />
      <NewsSettingsCard />

      <SectionHeading
        title="AI"
        note="Which models may be asked, the default and the route, what each model is and has done, the daily budget, the pace, the AI additions, and what asking has cost. The watch is switched on and off on Opportunities, beside what it has asked."
      />
      <ModelsTab key={`models-${routingVersion}`} />
      <RoutingCard onMoved={() => setRoutingVersion((version) => version + 1)} />
      <ModelRegistryCard />
      <UsageTab />
      <AiAdditionsCard key={`additions-${routingVersion}`} />

      <SectionHeading
        title="Research record"
        note="What the app keeps for analysis on another machine, and the daily ZIP of it, with no key in it."
      />
      <ResearchFolderCard />

      <SectionHeading
        title="Effective configuration"
        note="Every setting as the app reads it, every constant the engine runs on, and the versions a report and an experiment are stamped with. Read-only."
      />
      <EffectiveConfigCard />

      <SectionHeading title="Elsewhere" note="Two kinds of setting each have a page of their own." />
      <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        Exchange keys and the OpenRouter key are on <TextLink onClick={() => onNavigate('connections')}>Connections</TextLink>. The limits
        every real order is checked against, and the controller groups, are on{' '}
        <TextLink onClick={() => onNavigate('risk')}>Risk &amp; Safety</TextLink>.
      </p>
      </EnglishOnly>
    </>
  )
}
