import { LANGUAGES, LANGUAGE_INFO, type Language } from '../../shared/i18n/languages'

/** The ten languages as the selector lists them (the V6 document, §87): each by its own name, the one
 * chosen marked. Each button is in its own language's direction and lang, so its name is drawn by the
 * right font and read the right way in any window. */
export function LanguageButtons({ value, onChoose, disabled = false }: { value: Language; onChoose: (language: Language) => void; disabled?: boolean }): React.JSX.Element {
  return (
    <div role="radiogroup" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      {LANGUAGES.map((code) => {
        const info = LANGUAGE_INFO[code]
        const active = code === value
        return (
          <button
            key={code}
            role="radio"
            aria-checked={active}
            lang={code}
            dir={info.dir}
            disabled={disabled}
            onClick={() => onChoose(code)}
            title={info.english}
            style={{
              padding: '0.5rem 0.85rem',
              border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-sm)',
              background: active ? 'var(--accent-soft)' : 'var(--bg-app)',
              color: active ? 'var(--accent)' : 'var(--text-primary)',
              fontSize: '0.88rem',
              fontWeight: active ? 700 : 500,
              cursor: disabled ? 'default' : 'pointer',
              whiteSpace: 'nowrap'
            }}
          >
            {info.native}
          </button>
        )
      })}
    </div>
  )
}
