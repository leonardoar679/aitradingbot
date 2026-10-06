import { useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { AI_ADDITION_PROMPT_VERSIONS, exitVerdictsOf } from '../../shared/aiAdditions'
import { aiExitTally, describeAiExitTally } from '../../shared/aiExit'
import type { ExecutorConfig } from '../../shared/ipc'
import { noteStyle } from '../agents/agentStyles'

type Answers = { KEEP: number; REDUCE: number; EXIT: number }

function describeAnswers(answers: Answers): string {
  const total = answers.KEEP + answers.REDUCE + answers.EXIT
  if (total === 0) return 'It has not answered yet.'
  return `It has answered ${total} ${total === 1 ? 'time' : 'times'}: ${answers.KEEP} KEEP, ${answers.REDUCE} REDUCE (recorded only) and ${answers.EXIT} EXIT.`
}

/** Whether the exit check helps (shared/aiExit.ts): what it has answered, and what the trades it closed
 * made against what their plans would have, in R. Read only: the page hands it the executors, and it
 * reads the check's answers from the ledger. */
export function ExitCheckCard({ executors }: { executors: ExecutorConfig[] | null }): React.JSX.Element {
  const [answers, setAnswers] = useState<Answers | null>(null)
  const tally = useMemo(() => (executors === null ? null : aiExitTally(executors)), [executors])
  const closed = tally?.closed ?? 0

  // Read again when it has closed another trade, not on every read of the executors.
  useEffect(() => {
    let cancelled = false
    void window.api.ai.listCalls({ source: 'addition', promptVersion: AI_ADDITION_PROMPT_VERSIONS.exit, limit: 5000 }).then(
      (page) => {
        if (cancelled) return
        const counts: Answers = { KEEP: 0, REDUCE: 0, EXIT: 0 }
        for (const row of exitVerdictsOf(page.rows)) counts[row.verdict.verdict]++
        setAnswers(counts)
      },
      () => undefined
    )
    return (): void => {
      cancelled = true
    }
  }, [closed])

  return (
    <Card title="Does the exit check help?">
      <p style={{ ...noteStyle, marginTop: 0 }}>
        The exit check looks again at the app&apos;s own open paper trades when something changes, and its EXIT closes one at the next minute. Each trade it
        closed is set against what its plan would have made on the same minutes, once the plan&apos;s own time has passed. Better is more than the plan, in R
        where the trade had a stop. KEEP and REDUCE change nothing. Paper: nothing real was placed or closed.
      </p>
      {tally === null ? (
        <p style={noteStyle}>Reading the trades…</p>
      ) : (
        <>
          <p style={{ ...noteStyle, margin: '0.5rem 0 0', color: 'var(--text-primary)' }}>{describeAiExitTally(tally)}</p>
          {answers !== null && <p style={{ ...noteStyle, margin: '0.35rem 0 0' }}>{describeAnswers(answers)}</p>}
        </>
      )}
    </Card>
  )
}
