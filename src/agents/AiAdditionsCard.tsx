import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { AI_ADDITION_INFO, AI_ADDITION_KINDS, type AiAdditionKind, type AiAdditionsStatus } from '../../shared/aiAdditions'
import { formatUsd } from '../../shared/aiCost'
import { describeDecider } from '../../shared/aiPanel'
import { describeError } from '../utils/ipcError'
import { cellStyle, headCellStyle, noteStyle } from './agentStyles'

/** The AI additions under Settings › AI (shared/aiAdditions.ts): each one's switch, what it asks and
 * when, its daily limit, what it has asked today, and what a day of it can cost at that limit.
 * Switching one off only ever spends less, so it takes effect at once, with no confirmation. */
export function AiAdditionsCard(): React.JSX.Element {
  const [status, setStatus] = useState<AiAdditionsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const read = (): void => {
    void window.api.ai.additionsStatus().then(setStatus, (failure: unknown) => setProblem(describeError(failure)))
  }
  useEffect(read, [])

  async function toggle(kind: AiAdditionKind, on: boolean): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      await window.api.ai.setConfig({ additions: { [kind]: on } })
      read()
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="AI additions">
      <p style={{ ...noteStyle, marginBottom: '0.8rem' }}>
        Small questions put to a model beside the watch&apos;s, each inside the daily budget above and with a daily limit of its own, so that none can starve the
        watch.{' '}
        {status !== null && status.byRole
          ? `They ask by role: the news analyst, the conclusion and the daily summary ask ${describeDecider(status.models.news)}; the exit check, the reviewer and the article reading ask ${describeDecider(status.models.exit)}, the model that decides.`
          : `They ask ${status === null ? 'the model the watch follows' : describeDecider(status.model)}, the model the watch's paper trades follow, until "Who asks which model" above moves them to roles.`}{' '}
        One that asks
        by itself does so only while the watch is on{status !== null && !status.watchOn ? ', and the watch is off now' : ''}; the article reading never asks by itself,
        only on a click on News URLs. None of them places, sizes or arms
        anything; the exit check can only close one of the app&apos;s own paper trades sooner than its plan would, never a live one.
      </p>
      {status === null ? (
        <p style={noteStyle}>{problem ?? 'Loading…'}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['On', 'Addition', 'Today', 'A day at its limit'].map((column) => (
                  <th key={column} style={headCellStyle}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {AI_ADDITION_KINDS.map((kind) => {
                const info = AI_ADDITION_INFO[kind]
                const perCall = status.perCall[kind]
                const limit = status.limits[kind]
                return (
                  <tr key={kind}>
                    <td style={cellStyle}>
                      <input
                        type="checkbox"
                        aria-label={`${info.name} on`}
                        checked={status.additions[kind]}
                        disabled={busy}
                        onChange={(change) => void toggle(kind, change.target.checked)}
                      />
                    </td>
                    <td style={{ ...cellStyle, whiteSpace: 'normal' }}>
                      <strong>{info.name}</strong>
                      <div style={{ ...noteStyle, marginTop: '0.2rem' }}>{info.what}</div>
                    </td>
                    <td style={cellStyle}>
                      {status.today[kind]} of {limit}
                    </td>
                    <td style={{ ...cellStyle, whiteSpace: 'normal', minWidth: 170 }}>
                      {perCall.usd === null
                        ? 'not known yet'
                        : `about ${formatUsd(perCall.usd * limit)} (${formatUsd(perCall.usd)} a call, ${perCall.basis === 'history' ? 'from its own calls' : 'from the price list'})`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {problem !== null && status !== null && <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.5rem' }}>{problem}</p>}
    </Card>
  )
}
