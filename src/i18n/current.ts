import { ENGLISH, type I18n } from '../../shared/i18n/translate'

// THE WINDOW'S LANGUAGE, FOR WHAT IS BUILT OUTSIDE A COMPONENT (V6 Stage 14): a notice a scheduler tells,
// a refusal a writer words for one. Set by the provider as the language changes (./I18nProvider.tsx);
// English until it is.

let current: I18n = ENGLISH

/** The language a notice built in the window is said in: the person's. */
export function noticeI18n(): I18n {
  return current
}

export function setNoticeI18n(i18n: I18n): void {
  current = i18n
}
