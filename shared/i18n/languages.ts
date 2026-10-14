// THE TEN LANGUAGES (the V6 document, §81-87; V6 Stage 14, 13 October 2026). English, the two Chineses,
// Japanese, Korean, Vietnamese, Thai, Indonesian, Hindi and Arabic, in the document's order and under the
// names it lists for the selector (§87). Arabic is written right to left (§85).
//
// WHAT IS TRANSLATED (the user's answer of 13 October: the normal-user pages): the sidebar, Home,
// Predictions, Opportunities, Positions and Performance's summary; Settings' Essentials, Notifications
// and Language; every notice and alert; the trade plan and the Position form, and their errors. The
// expert pages -- Research and All Features -- stay in English, set left to right inside a right-to-left
// window, and the selector says so.
//
// WHO TRANSLATED: the translations were made by the app's author against one terminology dictionary
// (shared/i18n/terms.ts), not by a native speaker. A review by one is something only a person can give;
// until a language has had one, the selector says so beside it.

export const LANGUAGES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'vi', 'th', 'id', 'hi', 'ar'] as const
export type Language = (typeof LANGUAGES)[number]

export const DEFAULT_LANGUAGE: Language = 'en'

export interface LanguageInfo {
  code: Language
  /** What the selector shows: the language's name for itself (§87). */
  native: string
  /** Its English name, under the native one. */
  english: string
  dir: 'ltr' | 'rtl'
  /** Whether a native speaker has reviewed its translation. */
  nativeReview: boolean
}

export const LANGUAGE_INFO: Record<Language, LanguageInfo> = {
  en: { code: 'en', native: 'English', english: 'English', dir: 'ltr', nativeReview: true },
  'zh-CN': { code: 'zh-CN', native: '中文简体', english: 'Simplified Chinese', dir: 'ltr', nativeReview: false },
  'zh-TW': { code: 'zh-TW', native: '繁體中文', english: 'Traditional Chinese', dir: 'ltr', nativeReview: false },
  ja: { code: 'ja', native: '日本語', english: 'Japanese', dir: 'ltr', nativeReview: false },
  ko: { code: 'ko', native: '한국어', english: 'Korean', dir: 'ltr', nativeReview: false },
  vi: { code: 'vi', native: 'Tiếng Việt', english: 'Vietnamese', dir: 'ltr', nativeReview: false },
  th: { code: 'th', native: 'ไทย', english: 'Thai', dir: 'ltr', nativeReview: false },
  id: { code: 'id', native: 'Bahasa Indonesia', english: 'Indonesian', dir: 'ltr', nativeReview: false },
  hi: { code: 'hi', native: 'हिन्दी', english: 'Hindi', dir: 'ltr', nativeReview: false },
  ar: { code: 'ar', native: 'العربية', english: 'Arabic', dir: 'rtl', nativeReview: false }
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)
}

/** A stored setting, read as one: settings.json is written by the renderer, so it is healed rather than
 * obeyed. Null where none was ever chosen: the first launch asks (§87). */
export function healLanguage(value: unknown): Language | null {
  return isLanguage(value) ? value : null
}

/** The language a locale tag of the computer's falls in, or null for one not among the ten. Chinese by
 * script, then by region: Hant, Taiwan, Hong Kong and Macau are Traditional, the rest Simplified. */
export function languageForLocale(tag: string): Language | null {
  const parts = tag.replace(/_/g, '-').split('-').map((part) => part.toLowerCase())
  const base = parts[0]
  if (base === 'zh') {
    if (parts.includes('hant')) return 'zh-TW'
    if (parts.includes('hans')) return 'zh-CN'
    return parts.some((part) => part === 'tw' || part === 'hk' || part === 'mo') ? 'zh-TW' : 'zh-CN'
  }
  // "in" is Indonesian's code before 1989, still sent by some systems.
  if (base === 'in') return 'id'
  return (['en', 'ja', 'ko', 'vi', 'th', 'id', 'hi', 'ar'] as const).find((code) => code === base) ?? null
}

/** The first of the computer's languages that is one of the ten, else English (§87's default). */
export function languageForLocales(tags: readonly string[]): Language {
  for (const tag of tags) {
    const language = languageForLocale(tag)
    if (language !== null) return language
  }
  return DEFAULT_LANGUAGE
}
