import { Card } from '../components/Card'
import { describeMarketStatus, stepDetailText, STEP_LABELS, type ResearchStep } from '../../shared/marketResearch'
import { useMarketResearch } from '../hooks/useMarketResearch'
import { useI18n } from '../i18n'

const TONES: Record<'up' | 'down' | 'muted' | 'gold', string> = { up: 'var(--up)', down: 'var(--down)', muted: 'var(--text-secondary)', gold: 'var(--gold)' }

function stepMark(step: ResearchStep): string {
  return step.status === 'done' ? '✓' : step.status === 'failed' ? '✗' : step.status === 'running' ? '…' : '·'
}

/** The top of Overview: the market's status in four words -- Bitcoin, ether, the other pairs, and
 * the risk state -- from the research the app does as it opens (shared/marketResearch.ts), and,
 * while that is still reading, what it has done so far. Public data; it asks no model. */
export function MarketStatusStrip(): React.JSX.Element {
  const i18n = useI18n()
  const { t, utcTime } = i18n
  const { state, refresh } = useMarketResearch()
  const researching = state === null || state.running || state.finishedAt === null

  const actions =
    state?.finishedAt != null ? (
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
        {t('as of {time} UTC', { time: utcTime(state.finishedAt * 1000) })}
        <button
          onClick={refresh}
          disabled={state.running}
          style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.2rem 0.55rem', fontSize: '0.72rem', color: 'var(--text-primary)', cursor: 'pointer' }}
        >
          {t('Read again')}
        </button>
      </span>
    ) : undefined

  return (
    <Card title={t('Market status')} actions={actions}>
      {state?.market != null && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.9rem' }}>
          {describeMarketStatus(state.market, i18n).map((chip) => (
            <div key={chip.id} style={{ minWidth: 0 }}>
              <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-muted)' }}>{chip.label}</div>
              <div style={{ fontSize: '1.05rem', fontWeight: 800, color: TONES[chip.tone], marginTop: '0.15rem' }}>{chip.value}</div>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', lineHeight: 1.45, marginTop: '0.15rem' }}>{chip.detail}</div>
            </div>
          ))}
        </div>
      )}
      {researching && (
        <p style={{ margin: state?.market != null ? '0.8rem 0 0' : 0, fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text-primary)' }}>{t('Researching the market…')}</strong>{' '}
          {state === null
            ? ''
            : state.steps.map((step) => (
                <span key={step.id} style={{ marginInlineEnd: '0.9rem', whiteSpace: 'nowrap', color: step.status === 'failed' ? 'var(--down)' : undefined }} title={stepDetailText(step, i18n) ?? undefined}>
                  {stepMark(step)} {t(STEP_LABELS[step.id] ?? step.label)}
                  {step.status === 'done' && step.detail !== null && step.id === 'universe' ? ` (${step.detail.split(' ')[0]})` : ''}
                </span>
              ))}
        </p>
      )}
      {!researching && state !== null && state.steps.some((step) => step.status === 'failed') && (
        <p style={{ margin: '0.7rem 0 0', fontSize: '0.74rem', color: 'var(--text-muted)' }}>
          {state.steps
            .filter((step) => step.status === 'failed')
            .map((step) => stepDetailText(step, i18n))
            .join(' ')}
        </p>
      )}
    </Card>
  )
}
