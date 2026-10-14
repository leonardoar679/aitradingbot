import { describeLiveState, type LiveReading } from './liveVerdict'
import { useI18n } from '../i18n'

/** One recommendation against the live price: ENTERABLE, WAITING or INVALIDATED with why, the price
 * a fill would take, and the execution score with what held it down. */
export function LiveVerdictView({ reading, compact = false }: { reading: LiveReading | null; compact?: boolean }): React.JSX.Element {
  const i18n = useI18n()
  const { t, num } = i18n
  if (reading === null) return <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{t('Live price: connecting…')}</span>
  const { verdict, quality } = reading
  const state = describeLiveState(verdict, i18n)
  const why = verdict.reasons.join(t('; '))
  const execution = t('Execution {score}/100', { score: quality.score })
  return (
    <span style={{ fontSize: compact ? '0.78rem' : '0.84rem', lineHeight: 1.5 }} title={quality.reasons.length > 0 ? t('{execution}: {reasons}', { execution, reasons: quality.reasons.join(t('; ')) }) : execution}>
      <strong style={{ color: `var(--${state.tone})` }}>{state.word}</strong>
      {verdict.price !== null && <span style={{ color: 'var(--text-secondary)' }}> {t('at {price}', { price: num(Number(verdict.price.toPrecision(7)), 0, 8) })}</span>}
      <span style={{ color: quality.score >= 70 ? 'var(--text-secondary)' : 'var(--gold)' }}> · {execution}</span>
      {why !== '' && <span style={{ display: compact ? 'block' : 'inline', color: 'var(--text-muted)' }}>{compact ? why : ` · ${why}`}</span>}
    </span>
  )
}
