import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { formatUsd, type AiModelInfo } from '../../shared/aiCost'
import type { AiCallRecord } from '../../shared/aiLedger'
import { summarizeEventBenchmark, type EventBenchmarkRow } from '../../shared/aiEventBenchmark'
import { describeDecider } from '../../shared/aiPanel'
import { MIN_SCORED_CALLS } from '../../shared/aiOutcome'
import { REGISTRY_DAYS, modelRegistry, type ModelRegistryEntry, type RegistrySlice } from '../../shared/modelRegistry'
import { describeError } from '../utils/ipcError'
import { buttonStyle, cellStyle, headCellStyle, noteStyle } from './agentStyles'
import { loadLiveBars, readLiveAnswers, type LiveBoardDeps } from './liveBoard'

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

/** Each model the app may ask, in one view: the catalogue's entry, the ledger's last thirty days,
 * and its leaderboard row with its slices by event type and by Bitcoin's regime
 * (shared/modelRegistry.ts). Opening it reads the catalogue and the ledger, both free; scoring the
 * leaderboard reads public candles, one request an event, so it waits for a click. It asks no model,
 * recommends nothing and changes nothing: the watch's models are chosen on Opportunities. */
export function ModelRegistryCard(): React.JSX.Element {
  const [models, setModels] = useState<string[] | null>(null)
  const [catalogue, setCatalogue] = useState<AiModelInfo[]>([])
  const [calls, setCalls] = useState<AiCallRecord[]>([])
  const [rows, setRows] = useState<EventBenchmarkRow[] | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const stop = useRef(false)

  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const sinceSec = Math.floor(Date.now() / 1000) - REGISTRY_DAYS * 86_400
        const [config, listed, page] = await Promise.all([window.api.ai.getConfig(), window.api.ai.listModels(false), window.api.ai.listCalls({ sinceSec, limit: ROWS_READ })])
        if (cancelled) return
        setModels(config.enabledModels)
        setCatalogue(listed.models)
        setCalls(page.rows)
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
      setRows(summarizeEventBenchmark({ events: live.events, models, answers: live.answers, answeredAt: live.answeredAt, bars, nowSec }).models)
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
        Each model the app may ask, in one place: what the catalogue says of it, what the ledger says it did over the last {REGISTRY_DAYS} days, and its row
        of the live leaderboard with its results by event type and by Bitcoin&apos;s regime. A figure under {MIN_SCORED_CALLS} closed trades, or ten in a
        slice, is not printed. Nothing here is stored, and nothing is promoted: the watch&apos;s models are chosen on Opportunities.
      </p>
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p>}
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
              <span style={noteStyle}>Reads public candles for the events the watch asked these models about, one request an event. Nothing is asked.</span>
            </div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.82rem', lineHeight: 1.7 }}>
              {entries.map((entry) => (
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
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  )
}
