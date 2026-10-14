import { useState } from 'react'
import { Card } from '../components/Card'
import type { Language } from '../../shared/i18n/languages'
import { useI18n } from '../i18n'
import { LanguageButtons } from '../i18n/LanguageButtons'
import { reviewNote, scopeNote } from '../i18n/languageNotes'

/** Settings › Language (the V6 document, §87): the ten, by their own names. Choosing one saves it and
 * shows the window in it at once; the main process words its notices in it from then on. It changes
 * nothing the app does. */
export function LanguageCard({ onLanguageChange }: { onLanguageChange: (language: Language) => void }): React.JSX.Element {
  const i18n = useI18n()
  const { t, language } = i18n
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function choose(next: Language): Promise<void> {
    if (next === language) return
    setBusy(true)
    setProblem(null)
    try {
      await window.api.settings.set({ language: next })
      onLanguageChange(next)
    } catch (error) {
      setProblem(t('The language could not be saved: {error}', { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  const review = reviewNote(i18n)
  return (
    <Card title={t('Language')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        <LanguageButtons value={language} onChoose={(next) => void choose(next)} disabled={busy} />
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>{scopeNote(i18n)}</p>
        {review !== null && <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{review}</p>}
        {problem !== null && <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--down)' }}>{problem}</p>}
      </div>
    </Card>
  )
}
