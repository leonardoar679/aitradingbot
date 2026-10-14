import { createContext, useContext, useEffect, type PropsWithChildren } from 'react'
import { ENGLISH, i18nFor, type I18n } from '../../shared/i18n/translate'
import type { Language } from '../../shared/i18n/languages'
import { setNoticeI18n } from './current'

// THE WINDOW'S LANGUAGE (the V6 document, §82-87; V6 Stage 14). The app holds the language chosen; every
// translated component reads it with useI18n(), which re-renders it when the language changes. What is
// built outside a component -- a notice told by a scheduler -- reads the same language from noticeI18n().
//
// WHAT STAYS ENGLISH: a page that is not translated, and a card on a translated page that is not, is
// wrapped in EnglishOnly -- its words, numbers and direction are English, left to right, whatever the
// window's language (§85). A translated part inside one -- the Position form on Strategies' Execution --
// is wrapped in Translated, which brings the window's language back.

/** The language shown here: the window's, or English inside EnglishOnly. Exported for a class component,
 * which reads it as its contextType (src/components/ErrorBoundary.tsx); a function component uses useI18n. */
export const ShownContext = createContext<I18n>(ENGLISH)
/** The window's language, wherever it is read. */
const WindowContext = createContext<I18n>(ENGLISH)

/** Sets the window's language for everything inside it, and the document's own: its lang, and its
 * direction -- right to left for Arabic. */
export function I18nProvider({ language, children }: PropsWithChildren<{ language: Language }>): React.JSX.Element {
  const i18n = i18nFor(language)
  setNoticeI18n(i18n)
  useEffect(() => {
    document.documentElement.lang = language
    document.documentElement.dir = i18n.dir
  }, [language, i18n.dir])
  return (
    <WindowContext.Provider value={i18n}>
      <ShownContext.Provider value={i18n}>{children}</ShownContext.Provider>
    </WindowContext.Provider>
  )
}

/** The language a component is shown in: the window's, or English inside EnglishOnly. */
export function useI18n(): I18n {
  return useContext(ShownContext)
}

/** The window's language, inside EnglishOnly too: for the one control there that says which it is. */
export function useWindowI18n(): I18n {
  return useContext(WindowContext)
}

/** The page's column: what main lays its cards out by, so a wrapper of several keeps their spacing. */
const COLUMN: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '1.25rem', minWidth: 0 }

/** What stays English, left to right, inside any window: a page that is not translated, and an
 * untranslated card on a translated page. Its cards are laid out as the page's are. */
export function EnglishOnly({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <div dir="ltr" lang="en" style={COLUMN}>
      <ShownContext.Provider value={ENGLISH}>{children}</ShownContext.Provider>
    </div>
  )
}

/** A translated part inside EnglishOnly: the window's language, and its direction, again. */
export function Translated({ children }: PropsWithChildren): React.JSX.Element {
  const i18n = useContext(WindowContext)
  return (
    <div dir={i18n.dir} lang={i18n.language}>
      <ShownContext.Provider value={i18n}>{children}</ShownContext.Provider>
    </div>
  )
}

/** A value or a code shown as written inside right-to-left words: a chart, a pair, a model's name. */
export function Ltr({ children }: PropsWithChildren): React.JSX.Element {
  return <bdi dir="ltr">{children}</bdi>
}
