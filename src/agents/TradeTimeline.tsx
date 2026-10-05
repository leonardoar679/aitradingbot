import { useEffect, useState } from 'react'
import type { ExecutorConfig } from '../../shared/ipc'
import { describeTracePrices, traceWatchTrade, type WatchTradeTrace } from '../../shared/tradeLifecycle'
import { describeError } from '../utils/ipcError'
import { noteStyle } from './agentStyles'
import { loadWatchTradeRecords, type TimelineDeps } from './watchTradeRecords'

const deps: TimelineDeps = {
  listEvents: (filter) => window.api.scanner.listEvents(filter),
  listCalls: (filter) => window.api.ai.listCalls(filter),
  listExecutors: async () => (await window.api.settings.get()).executors,
  fetchCandles: async (exchange, symbol, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, '1m', startSec, endSec)).candles,
  nowSec: () => Math.floor(Date.now() / 1000)
}

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 19)
}

const TONE: Record<string, string> = { up: 'var(--up)', down: 'var(--down)', muted: 'var(--text-muted)' }

/** One trade's whole story, read when it is opened: the event, each model's answer, the paper
 * position the watch made of it, where that filled and how it ended (shared/tradeLifecycle.ts).
 * It reads the records that already exist and stores nothing. */
export function TradeTimeline({ eventId, model, executor = null }: { eventId: string; model: string; executor?: ExecutorConfig | null }): React.JSX.Element {
  const [trace, setTrace] = useState<WatchTradeTrace | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setTrace(null)
    setProblem(null)
    loadWatchTradeRecords(eventId, model, executor, deps).then(
      (records) => {
        if (!cancelled) setTrace(traceWatchTrade(records))
      },
      (failure: unknown) => {
        if (!cancelled) setProblem(describeError(failure))
      }
    )
    return (): void => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per trade: the executor's identity changes on every poll
  }, [eventId, model, executor?.id])

  if (problem !== null) return <p style={{ ...noteStyle, color: 'var(--down)' }}>The timeline could not be read: {problem}</p>
  if (trace === null) return <p style={noteStyle}>Reading the records of this trade…</p>

  // Each step flows as one line of text, time first, so it reads in a narrow card as well as
  // under the journal's full-width table.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
        {trace.steps.map((step, index) => (
          <li key={index} style={{ fontSize: '0.74rem', lineHeight: 1.45 }}>
            <span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', marginRight: '0.2rem' }}>{step.at === null ? '—' : utcClock(step.at)}</span>{' '}
            <strong style={{ color: 'var(--text-primary)' }}>{step.label}</strong>{' '}
            <span style={{ color: step.tone !== undefined ? TONE[step.tone] : 'var(--text-secondary)' }}>{step.detail}</span>
          </li>
        ))}
      </ol>
      <p style={{ ...noteStyle, marginTop: '0.2rem' }}>{describeTracePrices(trace)} Times are UTC.</p>
    </div>
  )
}
