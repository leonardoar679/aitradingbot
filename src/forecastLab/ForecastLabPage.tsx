import { useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { buttonStyle, cellStyle, headCellStyle, inputStyle, noteStyle } from '../agents/agentStyles'
import { HORIZONS, type Horizon, type PairClass } from '../../shared/forecast/features'
import { FIRST_TOUCH } from '../../shared/forecast/firstTouch'
import { LAB_EVENTS, type LabEvent } from '../../shared/forecast/lab'
import { CLASS_LINES } from '../../shared/forecast/opportunityClass'
import type { ForecastLabView } from '../../shared/forecast/labView'
import { describeError } from '../utils/ipcError'
import { settingsWrites } from '../utils/settingsWrites'
import { healForecastSettings } from '../../shared/forecast/training'
import {
  CLASS_NAME,
  COMPARISON_HEADERS,
  EVENT_NAME,
  HORIZON_NAME,
  calibrationTable,
  classesOf,
  classesTable,
  directionTable,
  driftTable,
  errorsTable,
  eventsTable,
  leaderTable,
  liveTable,
  performanceTable,
  pUpCurveTable,
  shockTable,
  tableCsv,
  timingTable,
  traderCells,
  traderTable,
  type LabTableData
} from './labTables'
import { ReplayCard } from './ReplayCard'
import { runComparison, type ComparisonResult } from './strategyComparison'
import { PaperLabCard } from '../forecast/PaperLabCard'

const day = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')

function LabTable({ table, name, onNote }: { table: LabTableData; name: string; onNote: (note: string | null) => void }): React.JSX.Element {
  const exportCsv = async (): Promise<void> => {
    onNote(null)
    try {
      const outcome = await window.api.backtest.exportSave({ defaultFileName: `forecast-lab-${name}-${new Date().toISOString().slice(0, 10)}.csv`, content: tableCsv(table), format: 'csv' })
      if (outcome.status === 'saved') onNote(`Saved to ${outcome.filePath}`)
      else if (outcome.status === 'error') onNote(`Could not save the file: ${outcome.message}`)
    } catch (failure) {
      onNote(describeError(failure))
    }
  }
  if (table.rows.length === 0) return <p style={noteStyle}>Nothing on record for this yet.</p>
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {table.headers.map((header) => (
                <th key={header} style={headCellStyle}>
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, column) => (
                  <td key={column} style={cellStyle}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={() => void exportCsv()} style={{ ...buttonStyle('secondary'), marginTop: '0.5rem' }}>
        Export CSV
      </button>
    </>
  )
}

/** How the price forecast did (the V6 document, §27-28, §42-43, §49-50, §90-105): on the walk forward's
 * weeks, which it had not seen, and on the live record; its models side by side; a tested hour replayed;
 * and its trades against the app's strategies. Every figure is out of sample, and each says which record
 * it is from. Reading it asks no model and places nothing. */
export function ForecastLabPage(): React.JSX.Element {
  const [view, setView] = useState<ForecastLabView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [cls, setCls] = useState<PairClass | 'pooled'>('pooled')
  const [event, setEvent] = useState<LabEvent>('pump')
  const [compareHorizon, setCompareHorizon] = useState<Horizon>('hour1')
  const [comparison, setComparison] = useState<{ result: ComparisonResult | null; done: number; total: number; running: boolean }>({ result: null, done: 0, total: 0, running: false })
  const stopped = useRef(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = (): void => {
      void window.api.forecast.lab().then(
        (next) => {
          if (cancelled) return
          setView(next)
          setProblem(null)
          // While the Lab is being made, read it again.
          if (next.status.state === 'making' || next.status.state === 'waiting') timer = setTimeout(load, 5_000)
        },
        (failure) => {
          if (!cancelled) setProblem(describeError(failure))
        }
      )
    }
    load()
    return (): void => {
      cancelled = true
      stopped.current = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [])

  const lab = view?.lab ?? null
  const classes = useMemo(() => (lab === null ? (['pooled'] as const) : classesOf(lab)), [lab])

  // The forecast's settings are written whole (a patch replaces them): the trader's are kept as they are.
  const setRefit = (on: boolean): void => {
    void settingsWrites(async () => {
      const fresh = await window.api.settings.get()
      await window.api.settings.set({ forecast: { ...healForecastSettings(fresh.forecast), refitNightly: on } })
    }).then(
      () => setView((current) => (current === null ? current : { ...current, refit: { ...current.refit, on } })),
      (failure) => setNote(describeError(failure))
    )
  }

  const compare = (): void => {
    if (lab === null || lab.span === null) return
    const trades = lab.horizons[compareHorizon]?.trades ?? { rules: [], medians: [] }
    setComparison({ result: null, done: 0, total: lab.pairs.length, running: true })
    void runComparison(lab.pairs, lab.span, trades, (pair, width, fromSec, toSec) => window.api.forecast.bars(pair, width, fromSec, toSec), {
      onProgress: (done, total) => setComparison((current) => ({ ...current, done, total })),
      shouldStop: () => stopped.current
    }).then(
      (result) => setComparison({ result, done: lab.pairs.length, total: lab.pairs.length, running: false }),
      (failure) => {
        setComparison({ result: null, done: 0, total: 0, running: false })
        setNote(describeError(failure))
      }
    )
  }

  const status = view?.status
  return (
    <>
      <PageHeader title="Forecast Lab" subtitle="How the price forecast did, on weeks it had not seen and on the live record" />
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p>}
      {note !== null && <p style={noteStyle}>{note}</p>}

      <Card title="Where these figures come from">
        {view === null ? (
          <p style={noteStyle}>Reading the Lab…</p>
        ) : (
          <>
            <p style={{ ...noteStyle, color: 'var(--text-primary)' }}>
              {lab === null || lab.span === null
                ? status?.state === 'making'
                  ? `The Lab of run ${status.runId} is being made${status.progress === null ? '' : `: ${status.progress.step}, ${status.progress.done} of ${status.progress.total}`}.`
                  : status?.state === 'failed'
                    ? `The Lab could not be made: ${status.lastError ?? 'unknown'}. It is tried again with the next walk forward.`
                    : 'No walk forward is in use yet: the Lab is made once the first one is.'
                : `The walk forward of run ${lab.runId}: ${lab.pairs.length} pairs, every whole hour of the weeks tested, ${day(lab.span.from)} to ${day(lab.span.to)} UTC, each hour forecast with models and a calibration made only from the weeks before it.`}
            </p>
            <p style={noteStyle}>
              The live record: what the app forecast and recorded over the last {view.liveDays} days ({view.live.from === null ? 'nothing yet' : `${day(view.live.from)} to ${day(view.live.to ?? view.live.from)} UTC`}), where the news and the analyst's readings moved it.
              The walk forward holds price and technical figures only: the free news feeds keep no archive. Its pairs are today's research universe, so it carries survivorship bias: coins that fell out of the top are not in it.
            </p>
            <label style={{ ...noteStyle, display: 'inline-flex', gap: '0.4rem', alignItems: 'center', marginTop: '0.5rem', color: 'var(--text-primary)' }}>
              <input type="checkbox" checked={view.refit.on} onChange={(change) => setRefit(change.target.checked)} />
              Refit every night at 00:30 UTC, from public data (no spend)
            </label>
            <p style={noteStyle}>
              Training: {view.refit.trainingStatus}
              {view.refit.lastFitAt === null ? '' : `; last fit ${day(view.refit.lastFitAt)} UTC`}
              {view.refit.on && view.refit.nextAt !== null ? `; next refit ${day(view.refit.nextAt)} UTC` : ''}. A refit's models are put in use only where they pass the promotion checklist.
            </p>
          </>
        )}
      </Card>

      {lab !== null && (
        <Card
          title="Performance on the walk forward"
          actions={
            <select value={cls} onChange={(change) => setCls(change.target.value as PairClass | 'pooled')} style={inputStyle()} aria-label="Kind of coin">
              {classes.map((one) => (
                <option key={one} value={one}>
                  {CLASS_NAME[one]}
                </option>
              ))}
            </select>
          }
        >
          <p style={{ ...noteStyle, marginTop: 0 }}>
            Moves and errors in percent. A call is BULLISH or BEARISH by the forecast's own rule, its P(up)'s skill read from the weeks before. Skill over persistence: how much less its pinball loss was than the plain range's, in usual moves.
          </p>
          <LabTable table={performanceTable(lab, cls)} name="performance" onNote={setNote} />
        </Card>
      )}

      {lab !== null && (
        <Card title="Calibration">
          <p style={{ ...noteStyle, marginTop: 0 }}>The share of outcomes at or below each level of the forecast shown, against what the level says: a calibrated forecast reads 10, 25, 50, 75 and 90%.</p>
          <LabTable table={calibrationTable(lab)} name="calibration" onNote={setNote} />
          <p style={{ ...noteStyle, marginTop: '0.8rem' }}>P(up) against the share that went up, where a map from the weeks before could be read:</p>
          <LabTable table={pUpCurveTable(lab)} name="p-up" onNote={setNote} />
        </Card>
      )}

      {view !== null && (
        <Card title="Kinds of error and drift">
          <p style={{ ...noteStyle, marginTop: 0 }}>
            §43's kinds: a call's way right or wrong; the close inside the 80% range or not; a range twice its usual width that held the close in its likely range (too wide); a call whose move came after the horizon (early) or came and went on the way (late); a story read the wrong way, or a call gone wrong with no story behind it.
          </p>
          <LabTable table={errorsTable(lab, view.live)} name="errors" onNote={setNote} />
          <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
            After an hour's shock of two usual moves or more: over-reacting is a median that followed the shock where the move then turned; under-reacting, one that did not follow where the move went on past its likely range. The live record also made {view.live.drift.refreshes} forecasts again between closes
            {view.live.drift.meanChangePct === null ? '' : `, moving the hour's median ${view.live.drift.meanChangePct.toFixed(3)} points on average`}
            {Object.keys(view.live.drift.byReason).length === 0 ? '' : ` (${Object.entries(view.live.drift.byReason).map(([reason, count]) => `${reason.toLowerCase().replace(/_/g, ' ')} ${count}`).join(', ')})`}.
          </p>
          <LabTable table={driftTable(lab, view.live)} name="drift" onNote={setNote} />
        </Card>
      )}

      {view !== null && (
        <Card
          title="By event"
          actions={
            <select value={event} onChange={(change) => setEvent(change.target.value as LabEvent)} style={inputStyle()} aria-label="Event">
              {LAB_EVENTS.map((one) => (
                <option key={one} value={one}>
                  {EVENT_NAME[one]}
                </option>
              ))}
            </select>
          }
        >
          <p style={{ ...noteStyle, marginTop: 0 }}>A pump or a dump is an hour of two usual moves or more before the forecast; a break, a close beyond the day before's range; a story, one published in the four hours before that named the coin.</p>
          <LabTable table={eventsTable(lab, view.live, event)} name={`event-${event}`} onNote={setNote} />
        </Card>
      )}

      {view !== null && (
        <Card title="The live record: V1 to V4 on the same moments">
          <p style={{ ...noteStyle, marginTop: 0 }}>Every recorded forecast whose horizon has come, read four ways: price only, every market model, with the news's rules, and with the analyst's readings (the forecast shown). Where no story moved a forecast, V3 and V4 are V2.</p>
          <LabTable table={liveTable(view.live)} name="live" onNote={setNote} />
        </Card>
      )}

      {view !== null && Object.keys(view.shock).length > 0 && (
        <Card title="After Bitcoin's sharp moves">
          <p style={{ ...noteStyle, marginTop: 0 }}>
            Where Bitcoin's last fifteen minutes reach {view.shock.hour1?.line ?? 2.5} of its usual moves, a horizon's ranges are widened about their median -- the 80% range by one factor, the 50% by another -- fitted on the walk forward's moments past the line, and only at a horizon where, each week widened by factors from the other weeks alone, the 80% range came nearer 80% and the pinball loss was no worse. Calm moments are never touched. Live: the forecasts it widened, and how their 80% ranges held widened and by V2's own levels.
          </p>
          <LabTable table={shockTable(view.shock, view.live)} name="shock" onNote={setNote} />
        </Card>
      )}

      {view !== null && HORIZONS.some((horizon) => view.live.horizons[horizon]?.timing !== undefined) && (
        <Card title="Price and time: the path's figures on the live record">
          <p style={{ ...noteStyle, marginTop: 0 }}>
            Since V7.1 each forecast also says how far the path may go on the way -- the levels its highest high stays under and its lowest low above, half the time, eight times in ten and nine, read by the excursion models and scaled by what the walk forward's paths did -- and when its expected price, the median, is reached: the chance within five minutes, fifteen, an hour and four from the first-touch table of the walk forward's bars, UNLIKELY under {Math.round(FIRST_TOUCH.unlikely * 100)}% within the horizon, and the typical minutes when it is. Judged here on the live record: the chance said against the share reached within the horizon's window (four hours at most), whether UNLIKELY was right, the minutes said against the minutes seen, and whether the 80% levels held.
          </p>
          <LabTable table={timingTable(view.live)} name="timing" onNote={setNote} />
        </Card>
      )}

      {view !== null && Object.keys(view.direction).length > 0 && (
        <Card title="Which way: the direction models">
          <p style={{ ...noteStyle, marginTop: 0 }}>
            The forecast's P(up) was read off its range's distribution, and on the walk forward it never beat the base rate, so no way was ever called. Since V7.1 four classifiers forecast which way from the same row -- a line and boosted trees on every figure, trees on the price and technical figures, trees on the price figures alone -- each mapped by the readings of the weeks before its own and scored on the same weeks as the distribution's reading: its Brier skill over the better of an even chance and the weeks-before base rate, and its calls at the forecast's lines (P(up) at or past 58%, or at or under 42%). A model is promoted by its checklist alone, and a class reads its P(up) from the promoted source with the highest skill where any is skilled, from the base rate where none is. The call's lines are unchanged; a model that calls more and does worse is never promoted.
          </p>
          <LabTable table={directionTable(view.direction)} name="direction" onNote={setNote} />
        </Card>
      )}

      {view !== null && (
        <Card title="Leaderboard">
          <p style={{ ...noteStyle, marginTop: 0 }}>Every model at every horizon on the walk forward's outcomes, its weight in the forecast shown, whether it was promoted, and whether its last week found it degraded. A model is never switched off: its weight falls with its score.</p>
          <LabTable table={leaderTable(view.leaderboard)} name="leaderboard" onNote={setNote} />
        </Card>
      )}

      {view !== null && (
        <Card title="Opportunity classes">
          <p style={{ ...noteStyle, marginTop: 0 }}>
            Each kind of coin, horizon and setup -- a story about the coin, a break of the day's range, a call against an hour's shock, the market's way, or none -- judged on the forecast trader's replay of the walk forward, as the rules stand, and on its own live paper trades: APPROVED where both have made money, PROBATION where the replay has and the live paper has not yet {CLASS_LINES.minLiveTrades} trades, DISABLED where either lost, NOT ENOUGH DATA under {CLASS_LINES.minHistoryTrades} replayed trades. The forecast trader trades only an approved class or one on probation.
          </p>
          <LabTable table={classesTable(view.classes)} name="classes" onNote={setNote} />
        </Card>
      )}

      {lab !== null && lab.span !== null && <ReplayCard pairs={lab.pairs} span={lab.span} />}

      <PaperLabCard />

      {lab !== null && (
        <Card title="The forecast trader">
          <p style={{ ...noteStyle, marginTop: 0 }}>
            Each forecast the rules would trade -- a called way, an edge after a round trip, a profit likelier than 55 in a hundred, a range not too wide -- entered at its close, stopped at its P10 level (P90 for a sell), taken at P75 (P25), else out at the horizon's close; one open trade a pair; where the path touched both, the stop. On the median alone: the same where the median clears the round trip, with no direction gate, for research. Net of 0.24% a round trip; a sell is a paper short.
          </p>
          <LabTable table={traderTable(lab)} name="trader" onNote={setNote} />
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.9rem' }}>
            <select value={compareHorizon} onChange={(change) => setCompareHorizon(change.target.value as Horizon)} style={inputStyle()} aria-label="The trader's horizon">
              {HORIZONS.filter((horizon) => lab.horizons[horizon] !== undefined).map((horizon) => (
                <option key={horizon} value={horizon}>
                  {HORIZON_NAME[horizon]} forecasts
                </option>
              ))}
            </select>
            <button type="button" style={buttonStyle('primary', comparison.running || lab.span === null)} disabled={comparison.running || lab.span === null} onClick={compare}>
              {comparison.running ? `Running ${comparison.done} of ${comparison.total} pairs…` : 'Run the comparison'}
            </button>
            <span style={noteStyle}>Trend Regime 4h and Short-Term Channel 15m, each its own backtest on the same pairs and weeks; buy and hold; and the hybrid. On the bars on file; nothing is asked.</span>
          </div>
          {comparison.result !== null && (
            <>
              <p style={{ ...noteStyle, marginTop: '0.6rem' }}>
                {comparison.result.window === null
                  ? 'No window on the bars on file lets both strategies trade: Trend Regime 4h reads 80 days before its first trade.'
                  : `Every row over ${day(comparison.result.window.from)} to ${day(comparison.result.window.to)} UTC on ${comparison.result.pairs.length} pairs: from where both strategies' warm-ups had passed on the bars on file (Trend Regime 4h reads 80 days; the files keep 90).${comparison.result.left.length === 0 ? '' : ` Left out, too young for it: ${comparison.result.left.join(', ')}.`}`}
              </p>
              {comparison.result.rows.length > 0 && <LabTable table={{ headers: COMPARISON_HEADERS, rows: comparison.result.rows.map((row) => [row.name, ...traderCells(row.stats)]) }} name={`comparison-${compareHorizon}`} onNote={setNote} />}
            </>
          )}
        </Card>
      )}
    </>
  )
}
