import { describeThesisReason, describeThesisStatus, type ThesisVerdict } from '../../shared/thesisStatus'
import { StatusChip } from '../status/StatusChip'
import { useI18n } from '../i18n'

const TONES = { up: 'safe', gold: 'warn', down: 'blocked' } as const

/** THESIS STATUS as a pill, with its reasons in words beside it. A reading, never a control. */
export function ThesisChip({ verdict }: { verdict: ThesisVerdict }): React.JSX.Element {
  const i18n = useI18n()
  const shown = describeThesisStatus(verdict.status, i18n)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
      <StatusChip mode={{ label: i18n.t('THESIS {status}', { status: shown.word }), detail: shown.detail, tone: TONES[shown.tone] }} />
      {verdict.reasons.length > 0 && <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{verdict.reasons.map((reason) => describeThesisReason(reason, i18n)).join(i18n.t('; '))}</span>}
    </span>
  )
}
