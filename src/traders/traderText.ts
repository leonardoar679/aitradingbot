import type { I18n } from '../i18n'

// Words Copy Traders shares between its page and its paper panel (V8 Stage 8).

/** A span of time from minutes, in the language's numbers: seconds under a minute, minutes under an hour and a half,
 * hours under two days, then days. */
export function durationOf(i18n: I18n, minutes: number): string {
  const { t, num } = i18n
  if (minutes < 1) return t('{seconds} s', { seconds: num(Math.round(minutes * 60), 0, 0) })
  if (minutes < 90) return t('{minutes} min', { minutes: num(minutes, 0, 0) })
  if (minutes < 48 * 60) return t('{hours} h', { hours: num(minutes / 60, 1, 1) })
  return t('{days} days', { days: num(minutes / 1440, 1, 1) })
}

/** A moment on the records' clock: its UTC day and time. */
export const utcWhen = (i18n: I18n, ms: number): string => i18n.t('{time} UTC', { time: `${i18n.utcDay(ms)} ${i18n.utcTime(ms)}` })
