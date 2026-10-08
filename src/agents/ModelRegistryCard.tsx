import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { formatUsd, type AiModelInfo } from '../../shared/aiCost'
import type { AiCallRecord } from '../../shared/aiLedger'
import { summarizeEventBenchmark, type EventBenchmarkRow, type EventLabels } from '../../shared/aiEventBenchmark'
import { describeDecider } from '../../shared/aiPanel'
import { MIN_SCORED_CALLS } from '../../shared/aiOutcome'
import type { ExecutorConfig } from '../../shared/ipc'
import { HEALTH_ROLLING_TRADES, describeModelHealth, modelHealth, paperRecordOf, promotionChecklist, type ChecklistItem, type ModelHealth } from '../../shared/modelHealth'
import { REGISTRY_DAYS, modelRegistry, type ModelRegistryEntry, type RegistrySlice } from '../../shared/modelRegistry'
import { describeError } from '../utils/ipcError'
import { buttonStyle, cellStyle, headCellStyle, noteStyle } from './agentStyles'
import { benchmarkRemembered } from './benchmarkMemory'
import { loadLiveBars, loadLiveLabels, readLiveAnswers, type LiveBoardDeps } from './liveBoard'
import { getModelHealthReport, subscribeModelHealth, type ModelHealthReport } from './modelHealthWatch'

const ROWS_READ = 5000

const deps: LiveBoardDeps = {
  listCalls: (filter) => window.api.ai.listCalls(filter),
  listEvents: (filter) => window.api.scanner.listEvents(filter),
  fetchCandles: async (exchange, symbol, interval, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles
}

function perMillion(pricePerToken: number | null): string {
  return pricePerToken === null ? '—' : formatUsd(pricePerToken * 1_000_000)
}

function seconds(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`
}

function utcStamp(sec: number | null): string {
  return sec === null ? 'never' : `${new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function describeSlices(slices: RegistrySlice[]): string {
  if (slices.length === 0) return 'none'
  return slices.map((slice) => `${slice.key} ${slice.trades} (${slice.meanNetPct === null ? 'not enough trades' : `${slice.meanNetPct >= 0 ? '+' : ''}${slice.meanNetPct.toFixed(2)}% a trade`})`).join(' · ')
}

function tick(item: ChecklistItem): string {
  return item.ok === true ? '✓' : item.ok === false ? '✗' : '–'
}

/** The daily look's mark for a model (./modelHealthWatch.ts), as the table's Health column. */
function HealthMark({ model, report }: { model: string; report: ModelHealthReport | null }): React.JSX.Element {
  const health: ModelHealth | undefined = report?.models[model]
  if (report === null) return <span style={{ color: 'var(--text-muted)' }} title="Read three minutes after the app opens, then once a day.">not read yet</span>
  if (health === undefined) return <span style={{ color: 'var(--text-muted)' }}>not one the watch asks</span>
  if (health.degraded) {
    return (
      <span style={{ color: 'var(--gold)', fontWeight: 600 }} title={describeModelHealth(model, health)}>
        DEGRADED
      </span>
    )
  }
  if (health.rolling.expectancyPct === null) return <span style={{ color: 'var(--text-muted)' }}>{health.rolling.trades} of {HEALTH_ROLLING_TRADES} closed trades</span>
  return <span style={{ color: 'var(--up)' }}>as expected</span>
}

/** Each model the app may ask, in one view: the catalogue's entry, the ledger's last thirty days,
 * its leaderboard row with its slices by event type and by Bitcoin's regime
 * (shared/modelRegistry.ts), the daily look's mark on its health and, once scored, its promotion
 * checklist (shared/modelHealth.ts). Opening it reads the catalogue, the ledger and the executors
 * on file, all free; scoring the leaderboard reads public candles, one request an event and one a
 * stretch of events for Bitcoin's regime, so it waits for a click. It asks no model, promotes
 * nothing and changes nothing: the watch's models are chosen on Opportunities. */
export function ModelRegistryCard(): React.JSX.Element {
  const [models, setModels] = useState<string[] | null>(null)
  const [catalogue, setCatalogue] = useState<AiModelInfo[]>([])
  const [calls, setCalls] = useState<AiCallRecord[]>([])
  const [executors, setExecutors] = useState<ExecutorConfig[]>([])
  const [rows, setRows] = useState<EventBenchmarkRow[] | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [catalogueNote, setCatalogueNote] = useState<string | null>(null)
  const [report, setReport] = useState<ModelHealthReport | null>(getModelHealthReport())
  const stop = useRef(false)

  useEffect(() => subscribeModelHealth(setReport), [])

  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const sinceSec = Math.floor(Date.now() / 1000) - REGISTRY_DAYS * 86_400
        // The catalogue needs a key; the rest does not, and a registry with no key still has the
        // ledger, the health and the leaderboard to show, with each entry marked as not in the catalogue.
        const [config, listed, page, settings] = await Promise.all([
          window.api.ai.getConfig(),
          window.api.ai.listModels(false).catch((failure: unknown) => {
            setCatalogueNote(`The catalogue could not be read: ${describeError(failure)}`)
            return { models: [] as AiModelInfo[] }
          }),
          window.api.ai.listCalls({ sinceSec, limit: ROWS_READ }),
          window.api.settings.get()
        ])
        if (cancelled) return
        setModels(config.enabledModels)
        setCatalogue(listed.models)
        setCalls(page.rows)
        setExecutors(settings.executors)
      } catch (failure) {
        if (!cancelled) setProblem(describeError(failure))
      }
    })()
    return (): void => {
      cancelled = true
      stop.current = true
    }
  }, [])

  const score = useCallback(async (): Promise<void> => {
    if (models === null || models.length === 0) return
    stop.current = false
    setProblem(null)
    setProgress('Reading the answers…')
    try {
      const nowSec = Math.floor(Date.now() / 1000)
      const live = await readLiveAnswers(models, nowSec, deps)
      const bars = await loadLiveBars(live.events, nowSec, deps.fetchCandles, {
        shouldStop: () => stop.current,
        onProgress: (done, total) => setProgress(`Reading candles: ${done} of ${total} events…`)
      })
      if (stop.current) return
      setProgress("Reading Bitcoin's minutes around the events…")
      const labels: Record<string, EventLabels> = await loadLiveLabels(live.events, deps.fetchCandles, { shouldStop: () => stop.current })
      if (stop.current) return
      setRows(summarizeEventBenchmark({ events: live.events, models, answers: live.answers, answeredAt: live.answeredAt, bars, labels, nowSec }).models)
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setProgress(null)
    }
  }, [models])

  const entries: ModelRegistryEntry[] = useMemo(() => (models === null ? [] : modelRegistry({ models, catalogue, calls, rows: rows ?? [] })), [models, catalogue, calls, rows])

  return (
    <Card title="Model registry">
      <p style={{ ...noteStyle, marginTop: 0 }}>
        Each model the app may ask, in one place: what the catalogue says of it, what the ledger says it did over the last {REGISTRY_DAYS} days, its health by
        the daily look at its last {HEALTH_ROLLING_TRADES} closed trades, and its row of the live leaderboard with its results by event type and by Bitcoin&apos;s
        regime, with the promotion checklist under it. A figure under {MIN_SCORED_CALLS} closed trades, or ten in a slice, is not printed. Nothing here is
        stored, and nothing is promoted or switched off: the watch&apos;s models are chosen on Opportunities.
      </p>
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p>}
      {catalogueNote !== null && <p style={noteStyle}>{catalogueNote}</p>}
      {models === null ? (
        <p style={noteStyle}>Loading…</p>
      ) : entries.length === 0 ? (
        <p style={noteStyle}>No model is enabled.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr>
                <th style={headCellStyle}>Model</th>
                <th style={headCellStyle}>Context</th>
                <th style={headCellStyle}>Price in / out, per M</th>
                <th style={headCellStyle}>Schema</th>
                <th style={headCellStyle}>Calls</th>
                <th style={headCellStyle}>Answered / refused / failed</th>
                <th style={headCellStyle}>Latency p50 / p95</th>
                <th style={headCellStyle}>Cost</th>
                <th style={headCellStyle}>Last asked</th>
                <th style={headCellStyle}>Answered as</th>
                <th style={headCellStyle}>Health</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td style={cellStyle}>
                    <strong>{describeDecider(entry.id)}</strong>
                    {entry.listed === null && <span style={{ color: 'var(--text-muted)' }}> (not in the catalogue now)</span>}
                  </td>
                  <td style={cellStyle}>{entry.listed?.contextLength?.toLocaleString('en-US') ?? '—'}</td>
                  <td style={cellStyle}>
                    {entry.listed === null ? '—' : `${perMillion(entry.listed.promptPricePerToken)} / ${perMillion(entry.listed.completionPricePerToken)}`}
                  </td>
                  <td style={cellStyle}>{entry.listed === null ? '—' : entry.listed.structuredOutputs ? 'held to one' : 'not held'}</td>
                  <td style={cellStyle}>{entry.calls}</td>
                  <td style={cellStyle}>
                    {entry.answered} / {entry.refused} / {entry.failed}
                  </td>
                  <td style={cellStyle}>
                    {seconds(entry.latencyP50Ms)} / {seconds(entry.latencyP95Ms)}
                  </td>
                  <td style={cellStyle}>{formatUsd(entry.costUsd)}</td>
                  <td style={cellStyle}>{utcStamp(entry.lastAskedAt)}</td>
                  <td style={cellStyle}>{entry.servedModels.length === 0 ? '—' : entry.servedModels.join(', ')}</td>
                  <td style={cellStyle}>
                    <HealthMark model={entry.id} report={report} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {models !== null && entries.length > 0 && (
        <div style={{ marginTop: '0.8rem' }}>
          {rows === null ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap' }}>
              <button onClick={() => void score()} disabled={progress !== null} style={buttonStyle('secondary')}>
                {progress ?? 'Score the leaderboard'}
              </button>
              <span style={noteStyle}>
                Reads public candles for the events the watch asked these models about, one request an event and one a stretch of events for Bitcoin&apos;s four
                hours. Nothing is asked.
              </span>
            </div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.82rem', lineHeight: 1.7 }}>
              {entries.map((entry) => {
                const row = rows.find((candidate) => candidate.name === entry.id)
                const health = row === undefined ? null : modelHealth(row)
                const checklist = row === undefined ? null : promotionChecklist({ live: row, benchmark: benchmarkRemembered(entry.id), paper: paperRecordOf(executors, entry.id) })
                return (
                  <li key={entry.id}>
                    <strong>{describeDecider(entry.id)}</strong>:{' '}
                    {entry.results === null || entry.results.closed === 0 ? (
                      'the watch has no closed trade on its answers in these days.'
                    ) : (
                      <>
                        {entry.results.closed} closed; profit factor {entry.results.profitFactor === null ? 'not enough trades' : entry.results.profitFactor.toFixed(2)}; R a trade{' '}
                        {entry.results.meanR === null ? 'not enough trades' : `${entry.results.meanR >= 0 ? '+' : ''}${entry.results.meanR.toFixed(2)}`}.
                        <br />
                        By event type: {describeSlices(entry.results.byType)}.
                        <br />
                        By Bitcoin&apos;s regime: {describeSlices(entry.results.byBtc)}.
                      </>
                    )}
                    {health !== null && (
                      <>
                        <br />
                        <span style={{ color: health.degraded ? 'var(--gold)' : 'var(--text-secondary)' }}>
                          {health.degraded && <strong>DEGRADED. </strong>}
                          {describeModelHealth(entry.id, health)}
                        </span>
                      </>
                    )}
                    {checklist !== null && (
                      <>
                        <br />
                        <span style={{ color: 'var(--text-secondary)' }}>
                          Promotion checklist, {checklist.ticked} of {checklist.items.length} ticked{checklist.ready ? ' (every line)' : ''}:{' '}
                          {checklist.items.map((item) => `${tick(item)} ${item.label} (${item.detail})`).join(' · ')}. Ticks only: nothing is promoted by a full
                          list.
                        </span>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </Card>
  )
}
