import { useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { TextLink } from '../components/TextLink'
import type { AiConfig } from '../../shared/aiCost'
import type { CredentialStatus, ExecutorConfig, LiveTradingStatus, PaperAccount } from '../../shared/ipc'
import { livePathSteps, livePathSummary, type LivePathReport, type LivePathStep } from '../../shared/livePath'
import { buttonStyle, noteStyle } from '../agents/agentStyles'
import type { Page } from '../navigation/pages'
import { buildSessionReport, sessionReportBrowserDeps, spanStart } from '../performance/sessionReport'
import { describeError } from '../utils/ipcError'

const POLL_MS = 15_000

function glyph(step: LivePathStep): { mark: string; color: string } {
  if (step.state === 'done') return { mark: '✓', color: 'var(--up)' }
  if (step.state === 'not yet') return { mark: '○', color: 'var(--text-secondary)' }
  return { mark: '?', color: 'var(--text-muted)' }
}

/** Where you stand on the path to live (the second V3 document, §56; shared/livePath.ts): the key,
 * its test, paper trading, the two test runs, a trade prepared from a call, and the session. It reads
 * what is on file; the two test runs are read on a click, since their report reads candles. It opens
 * nothing and arms nothing: arming stays on the bar. */
export function LivePathCard({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const [binance, setBinance] = useState<CredentialStatus | null | undefined>(undefined)
  const [paperAccount, setPaperAccount] = useState<PaperAccount | null | undefined>(undefined)
  const [executors, setExecutors] = useState<ExecutorConfig[] | undefined>(undefined)
  const [config, setConfig] = useState<AiConfig | undefined>(undefined)
  const [status, setStatus] = useState<LiveTradingStatus | undefined>(undefined)
  const [hour, setHour] = useState<LivePathReport | null | undefined>(undefined)
  const [twelve, setTwelve] = useState<LivePathReport | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const read = (): void => {
      window.api.credentials.list().then(
        (list) => {
          if (!cancelled) setBinance(list.find((entry) => entry.exchange === 'binance') ?? null)
        },
        () => undefined
      )
      window.api.settings.get().then(
        (settings) => {
          if (cancelled) return
          setPaperAccount(settings.paperAccount ?? null)
          setExecutors(settings.executors)
        },
        () => undefined
      )
      window.api.ai.getConfig().then(
        (next) => {
          if (!cancelled) setConfig(next)
        },
        () => undefined
      )
      window.api.liveTrading.getStatus().then(
        (next) => {
          if (!cancelled) setStatus(next)
        },
        () => undefined
      )
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return (): void => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  async function checkRuns(): Promise<void> {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      const nowSec = Math.floor(Date.now() / 1000)
      for (const [span, set] of [
        ['hour', setHour],
        ['twelve', setTwelve]
      ] as const) {
        try {
          const report = await buildSessionReport(span, spanStart(span, nowSec, null), sessionReportBrowserDeps)
          set({ passed: report.passed, fromSec: report.fromSec, toSec: report.toSec })
        } catch (failure) {
          set(null)
          setProblem(describeError(failure))
        }
      }
    } finally {
      setBusy(false)
    }
  }

  const steps = useMemo(
    () => livePathSteps({ binance, paperAccount, watchPaperOn: config === undefined ? undefined : config.watchPaper.enabled, executors, hour, twelve, status }),
    [binance, paperAccount, config, executors, hour, twelve, status]
  )

  return (
    <Card title="The path to live">
      <p style={{ ...noteStyle, marginTop: 0 }}>{livePathSummary(steps)}</p>
      <ol style={{ margin: '0.5rem 0 0', paddingLeft: '1.3rem', fontSize: '0.86rem', lineHeight: 1.6 }}>
        {steps.map((step) => {
          const { mark, color } = glyph(step)
          return (
            <li key={step.id} style={{ marginBottom: '0.3rem' }}>
              <strong style={{ color }}>{mark}</strong> <strong>{step.label}</strong>
              <span style={{ color: 'var(--text-secondary)' }}> — {step.detail}</span>
            </li>
          )
        })}
      </ol>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', marginTop: '0.8rem', flexWrap: 'wrap' }}>
        <button onClick={() => void checkRuns()} disabled={busy} style={buttonStyle('secondary')}>
          {busy ? 'Reading…' : 'Check the test runs'}
        </button>
        <span style={noteStyle}>Reads the last hour and the last twelve hours against the session report&apos;s gates, as Performance does. Nothing is asked or placed.</span>
      </div>
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p>}
      <p style={{ margin: '0.7rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
        This card only reads. The key is on <TextLink onClick={() => onNavigate('connections')}>Connections</TextLink>, the report on{' '}
        <TextLink onClick={() => onNavigate('performance')}>Performance</TextLink>, and arming on the bar at the top. No model sizes, places or arms an order.
      </p>
    </Card>
  )
}
