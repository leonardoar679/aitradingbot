import { LANGUAGE_INFO } from '../../shared/i18n/languages'
import type { I18n } from '../../shared/i18n/translate'

/** What the language covers, said where it is chosen (the user's answer of 13 October 2026: the
 * normal-user pages). */
export function scopeNote({ t }: I18n): string {
  return t(
    'It is used on Home, Predictions, Opportunities and Positions, in the summary of Performance, in the essential settings, in every notice and in the order form. The research pages and the other expert pages stay in English.'
  )
}

/** Null for a language a native speaker has reviewed; otherwise that none has. */
export function reviewNote({ t, language }: I18n): string | null {
  return LANGUAGE_INFO[language].nativeReview ? null : t('This translation was made against one dictionary of trading terms and has not yet been reviewed by a native speaker.')
}
