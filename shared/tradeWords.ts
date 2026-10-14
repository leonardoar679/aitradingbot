import { ENGLISH, msg, type I18n } from './i18n/translate'

// A TRADE'S WORDS IN ANY LANGUAGE (V6 Stage 14, 13 October 2026): a side, and how a position ended, as the
// translated pages and the notices say them. Each is a key (shared/i18n/translate.ts).

const SIDE_WORDS: Record<'BUY' | 'SELL', string> = { BUY: msg('BUY'), SELL: msg('SELL') }

/** A side in a word: BUY or SELL, in a language. */
export function sideWord(side: 'BUY' | 'SELL' | 'buy' | 'sell' | null | undefined, { t }: I18n = ENGLISH): string {
  if (side === null || side === undefined) return '—'
  return t(SIDE_WORDS[side.toUpperCase() as 'BUY' | 'SELL'])
}

const EXIT_WORDS: Record<string, string> = {
  take_profit: msg('target reached'),
  stop_loss: msg('stopped out'),
  trailing_stop: msg('trailing stop'),
  time_limit: msg('time limit'),
  manual: msg('closed by hand'),
  liquidation: msg('liquidated'),
  entry_expired: msg('entry expired'),
  exit_check: msg('closed by the exit check'),
  news: msg('closed on the news')
}

/** How a position ended, in a few words, in a language; an end with no words of its own as it is named. */
export function exitWord(exit: string | null | undefined, { t }: I18n = ENGLISH): string {
  if (exit === null || exit === undefined) return '—'
  const words = EXIT_WORDS[exit]
  return words === undefined ? exit.replace(/_/g, ' ') : t(words)
}
