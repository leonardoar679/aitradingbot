import { useState } from 'react'
import { LANGUAGE_INFO, type Language } from '../../shared/i18n/languages'
import { i18nFor } from '../../shared/i18n/translate'
import { LanguageButtons } from './LanguageButtons'
import { scopeNote, reviewNote } from './languageNotes'

/** The first launch's question (the V6 document, §87): which language, the computer's offered. Its own
 * words are in the language highlighted, so a person who reads only theirs can choose it. Nothing else
 * is asked, and nothing waits on it: the app runs behind it. */
export function LanguageChooser({ offered, onChoose }: { offered: Language; onChoose: (language: Language) => Promise<void> }): React.JSX.Element {
  const [highlighted, setHighlighted] = useState<Language>(offered)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const i18n = i18nFor(highlighted)
  const { t } = i18n

  async function choose(): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      await onChoose(highlighted)
    } catch (error) {
      setProblem(t('The language could not be saved: {error}', { error: error instanceof Error ? error.message : String(error) }))
      setBusy(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="language-chooser-title"
      lang={highlighted}
      dir={LANGUAGE_INFO[highlighted].dir}
      style={{ position: 'fixed', inset: 0, zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0, 0, 0, 0.55)', padding: '1rem' }}
    >
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '1.5rem', maxWidth: '36rem', width: '100%', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
        <h1 id="language-chooser-title" style={{ margin: 0, fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)' }}>
          {t('Choose your language')}
        </h1>
        <LanguageButtons value={highlighted} onChoose={setHighlighted} disabled={busy} />
        <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>{scopeNote(i18n)}</p>
        {reviewNote(i18n) !== null && <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{reviewNote(i18n)}</p>}
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>{t('You can change it at any time under Settings › Language.')}</p>
        {problem !== null && <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--down)' }}>{problem}</p>}
        <div>
          <button
            onClick={() => void choose()}
            disabled={busy}
            style={{ padding: '0.55rem 1.2rem', border: 'none', borderRadius: 'var(--radius-sm)', background: 'var(--accent)', color: '#fff', fontSize: '0.9rem', fontWeight: 700, cursor: busy ? 'default' : 'pointer' }}
          >
            {t('Continue')}
          </button>
        </div>
      </div>
    </div>
  )
}
