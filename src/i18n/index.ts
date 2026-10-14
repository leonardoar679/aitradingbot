// The window's translation (the V6 document, §82; V6 Stage 14). The catalogs and the translator live in
// shared/i18n, because the main process words its own notices in the person's language too; this is the
// window's side of them: the provider, the hook, and what stays English.
export { I18nProvider, ShownContext, useI18n, useWindowI18n, EnglishOnly, Translated, Ltr } from './I18nProvider'
export { noticeI18n } from './current'
export { Interpolate } from './Interpolate'
export { msg, ENGLISH, i18nFor, type I18n, type Params } from '../../shared/i18n/translate'
export { LANGUAGES, LANGUAGE_INFO, healLanguage, languageForLocales, type Language } from '../../shared/i18n/languages'
