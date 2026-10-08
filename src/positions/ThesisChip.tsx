import { describeThesisReason, describeThesisStatus, type ThesisVerdict } from '../../shared/thesisStatus'
import { StatusChip } from '../status/StatusChip'

const TONES = { up: 'safe', gold: 'warn', down: 'blocked' } as const

/** THESIS STATUS as a pill, with its reasons in words beside it. A reading, never a control. */
export function ThesisChip({ verdict }: { verdict: ThesisVerdict }): React.JSX.Element {
  const shown = describeThesisStatus(verdict.status)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
      <StatusChip mode={{ label: `THESIS ${shown.word}`, detail: shown.detail, tone: TONES[shown.tone] }} />
      {verdict.reasons.length > 0 && <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{verdict.reasons.map(describeThesisReason).join('; ')}</span>}
    </span>
  )
}
