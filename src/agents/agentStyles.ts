import { ENGLISH, msg, type I18n } from '../../shared/i18n/translate'
import { INTERVAL_SECONDS, type Interval } from '../../shared/ipc'
import { formatHoldingDuration } from '../backtest/formatTradeTime'

// Small shared pieces for the AI pages (Opportunities, AI Decisions, AI Benchmark and the AI part
// of Settings), so a table on one looks like a table on another.

export function tabButtonStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    background: 'transparent',
    border: 'none',
    padding: '0.7rem 1rem',
    fontSize: '0.85rem',
    fontWeight: active ? 700 : 500,
    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    cursor: 'pointer',
    borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
    whiteSpace: 'nowrap'
  }
}

export function buttonStyle(kind: 'primary' | 'secondary', disabled = false): React.CSSProperties {
  return {
    padding: '0.5rem 0.9rem',
    borderRadius: 'var(--radius-sm)',
    fontSize: '0.8rem',
    fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    whiteSpace: 'nowrap',
    ...(kind === 'primary'
      ? { background: 'var(--accent)', border: 'none', color: '#fff' }
      : { background: 'var(--bg-app)', border: '1px solid var(--border)', color: 'var(--text-primary)' })
  }
}

export function inputStyle(): React.CSSProperties {
  return {
    background: 'var(--bg-app)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    padding: '0.45rem 0.6rem',
    color: 'var(--text-primary)',
    fontSize: '0.8rem'
  }
}

export const noteStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '0.76rem',
  color: 'var(--text-muted)',
  lineHeight: 1.55
}

export const headCellStyle: React.CSSProperties = {
  padding: '0.45rem 0.7rem',
  fontSize: '0.66rem',
  fontWeight: 600,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  textAlign: 'left',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid var(--border)'
}

export const cellStyle: React.CSSProperties = {
  padding: '0.5rem 0.7rem',
  fontSize: '0.78rem',
  color: 'var(--text-primary)',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid var(--border)'
}

export function recommendationColor(recommendation: 'buy' | 'sell' | 'hold' | null): string {
  if (recommendation === 'buy') return 'var(--up)'
  if (recommendation === 'sell') return 'var(--down)'
  return 'var(--text-secondary)'
}

/** `+0.42%`, coloured by sign. A dash while the horizon has not closed yet. In English unless handed a
 * language (V6 Stage 14). */
export function signedPct(value: number | null, i18n: I18n = ENGLISH): { text: string; color: string } {
  if (value === null) return { text: '—', color: 'var(--text-muted)' }
  if (i18n.language !== 'en') return { text: i18n.pct(value, 2), color: value >= 0 ? 'var(--up)' : 'var(--down)' }
  return { text: `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`, color: value >= 0 ? 'var(--up)' : 'var(--down)' }
}

/** A horizon in bars, said as a duration: 16 bars of 15m is `4h`. */
export function horizonLabel(bars: number, interval: Interval): string {
  return formatHoldingDuration(bars * INTERVAL_SECONDS[interval])
}

/** A model's codes in words: its reasons, the regime and the risk it read (shared/aiSignal.ts). */
const CODE_WORDS: Record<string, string> = {
  trend_up: msg('trend up'),
  trend_down: msg('trend down'),
  momentum_up: msg('momentum up'),
  momentum_down: msg('momentum down'),
  breakout: msg('breakout@@a reason'),
  breakdown: msg('breakdown@@a reason'),
  overbought: msg('overbought'),
  oversold: msg('oversold'),
  range_bound: msg('range bound'),
  high_volatility: msg('high volatility'),
  low_volatility: msg('low volatility'),
  volume_confirms: msg('volume confirms'),
  volume_absent: msg('volume absent'),
  timeframes_agree: msg('timeframes agree'),
  timeframes_conflict: msg('timeframes conflict'),
  cost_exceeds_edge: msg('cost exceeds edge'),
  strong_bull: msg('strong bull'),
  bull: msg('bull@@a model reading'),
  neutral: msg('neutral@@a model reading'),
  bear: msg('bear@@a model reading'),
  strong_bear: msg('strong bear'),
  low: msg('low@@risk'),
  medium: msg('medium@@risk'),
  high: msg('high@@risk')
}

/** `trend_up` as `trend up`, in a language. The codes are a closed vocabulary, so this is all the
 * formatting they need. */
export function reasonLabel(code: string, { t }: I18n = ENGLISH): string {
  const words = CODE_WORDS[code]
  return words === undefined ? code.replace(/_/g, ' ') : t(words)
}
