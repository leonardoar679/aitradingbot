import { useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { buttonStyle, cellStyle, headCellStyle, inputStyle, noteStyle } from '../agents/agentStyles'
import { HORIZONS, type Horizon, type PairClass } from '../../shared/forecast/features'
import { FIRST_TOUCH } from '../../shared/forecast/firstTouch'
import { LAB_EVENTS, type LabEvent } from '../../shared/forecast/lab'
import { MARKET_SHOCK_LINES } from '../../shared/forecast/marketShock'
import { EVENT_IMPACT_LINES } from '../../shared/calendar/eventImpact'
import { CHALLENGER_LINES, challengeSummary } from '../../shared/forecast/challenger'
import { CLASS_LINES } from '../../shared/forecast/opportunityClass'
import type { ForecastLabView } from '../../shared/forecast/labView'
import { describeError } from '../utils/ipcError'
import { settingsWrites } from '../utils/settingsWrites'
import { healForecastSettings } from '../../shared/forecast/training'
import { parseRegistry, registryRows } from '../../shared/forecast/preregistration'
import registryText from '../../research/preregistered.jsonl?raw'
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
  impactTable,
  liveTable,
  marketShockTable,
  nextReleasesTable,
  performanceTable,
  pUpCurveTable,
  registrationsTable,
  releasesTable,
  ablationTable,
  byHourTable,
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
/** The registry as shipped with this build, read once. */
const REGISTRY = registryRows(parseRegistry(registryText))

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

  // Champion and challenger (V7.1 Stage 13): the run before the one in use put back, models and verdicts
  // and nothing else; the Lab read again after.
  const [rollingBack, setRollingBack] = useState(false)
  const rollBack = (): void => {
    setRollingBack(true)
    setNote(null)
    void window.api.forecast
      .rollback()
      .then(async (answer) => {
        if (!answer.ok) setNote(answer.error ?? 'The run could not be rolled back.')
        setView(await window.api.forecast.lab())
      })
      .catch((failure) => setNote(describeError(failure)))
      .finally(() => setRollingBack(false))
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
            <p style={noteStyle}>
              Champion and challenger: a refit's walk forward is paired with the run in use's on the hours both tested (since V7.2 Stage 3, with {Math.round(CHALLENGER_LINES.level * 100)}% intervals), and it replaces the run in use only where it is better beyond noise at some horizon and worse beyond noise at none, or where its rows reach at least {CHALLENGER_LINES.newerDays} days past the champion's and it is worse beyond noise at none; a difference under the floors -- {Math.round(CHALLENGER_LINES.pinballTolerance * 100)}% of the pinball loss, {Math.round(CHALLENGER_LINES.coverageTolerance * 100)} points of coverage, {Math.round(CHALLENGER_LINES.directionTolerance * 100)} point of skill -- is neither. A refit within noise, or worse, is logged and kept, the run in use stays.{' '}
              {view.refit.champion === null || view.refit.champion === undefined ? 'No run is in use yet.' : `In use: ${view.refit.champion.runId}${view.refit.champion.foldsRunId !== null && view.refit.champion.foldsRunId !== view.refit.champion.runId ? ` (verdicts of ${view.refit.champion.foldsRunId})` : ''}.`}{' '}
              {view.refit.challenge === null || view.refit.challenge === undefined ? 'No refit has challenged it yet.' : `Last challenge: ${view.refit.challenge.runId} against ${view.refit.challenge.championRunId} at ${day(view.refit.challenge.at)} UTC, ${challengeSummary(view.refit.challenge.verdict)}.`}
            </p>
            {view.refit.previousRunId !== null && view.refit.previousRunId !== undefined && (
              <button type="button" style={buttonStyle('secondary', rollingBack)} onClick={rollBack} disabled={rollingBack}>
                {rollingBack ? 'Rolling back…' : `Roll back to ${view.refit.previousRunId}`}
              </button>
            )}
          </>
        )}
      </Card>

      <Card title="Registered lines">
        <p style={{ ...noteStyle, marginTop: 0 }}>
          Since V7.2 Stage 3 every line the forecast is judged by is registered before it is measured -- what will be judged, on which record, by which line, under which engine version -- in research/preregistered.jsonl, and a result is locked to its registration by a hash the tests check: a line moved after its figure was seen no longer passes. Stages 1 and 2 were measured before the file existed and are entered with the engine version they were measured under. A confirmatory line is one cell a horizon a cycle; an exploratory pass is a null until it repeats.
        </p>
        <LabTable table={registrationsTable(REGISTRY)} name="registered" onNote={setNote} />
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
            Moves and errors in percent. A call is BULLISH or BEARISH by the forecast's own rule, its P(up)'s skill read from the weeks before. Skill over persistence: how much less its pinball loss was than the plain range's, in usual moves. Since V7.2 Stage 1 each share and skill carries its 95% interval in brackets, from resampling the hours the forecasts were made at -- every pair's row of an hour together, in blocks as long as the horizon, a thousand times, widened for the overlap of the outcomes and for few blocks; "Independent outcomes" is how many outcomes drawn one by one would spread as these did, and "Blocks resampled" how many blocks a draw took. An interval that holds zero is no skill, and a figure on few blocks is itself uncertain.
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

      {lab !== null && Object.values(lab.horizons).some((entry) => entry?.byHour !== undefined) && (
        <Card title="By hour">
          <p style={{ ...noteStyle, marginTop: 0 }}>
            The forecast shown by the UTC hour it was made at (V7.2 Stage 4): how the 80% and 50% ranges held, the pinball loss, the dispersion the coverage implies (the true spread over the forecast's: 1 where 80% held, more where the range ran too narrow), the share of the misses forecast in a shock state, and each band in four halves -- the pairs' two halves by the first weeks against the last. A band FAILS the registered line only under 70% or over 90% in all four halves with 500 outcomes each; three weeks seldom give a half 500, and the weekday is reported, never acted on. Rows forecast before a scheduled release are left out.
          </p>
          <LabTable table={byHourTable(lab)} name="by-hour" onNote={setNote} />
        </Card>
      )}

      {view !== null && (view.ablations ?? []).length > 0 && (
        <Card title="What a block of figures added">
          <p style={{ ...noteStyle, marginTop: 0 }}>
            The walk forward fitted twice on identical folds and seeds (research/ablation.ts, V7.2 Stage 4) -- once with every block of figures, once with one block's columns held at their training mean -- and the two forecasts paired on the tested hours: the pinball loss the block saved, the 80% range's distance from 80% it saved and the direction skill it added, each with its 90% interval, and a control with the block's columns permuted across the tested rows, which must read near zero. A positive figure means the block helped.
          </p>
          <LabTable table={ablationTable(view.ablations ?? [])} name="ablation" onNote={setNote} />
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

      {view !== null && Object.keys(view.marketShock).length > 0 && (
        <Card title="The market's shock states">
          <p style={{ ...noteStyle, marginTop: 0 }}>
            Since V7.1 Stage 11 every forecast carries the market's state at its moment, read from what was known then: after a sharp move of Bitcoin's (its last fifteen minutes at or past {MARKET_SHOCK_LINES.line} usual moves), in a trending move (the same sharp fifteen minutes with the forty-five before them already at or past {MARKET_SHOCK_LINES.trendLine} of their usual moves the same way), in a liquidation cascade (a sharp fall with the breadth of the last fifteen minutes at or under {Math.round(MARKET_SHOCK_LINES.liquidationBreadth * 100)}% and the market's volume at {MARKET_SHOCK_LINES.liquidationVolume} times its usual or more), recovering (within {MARKET_SHOCK_LINES.recoveryHours} hours after a shock, Bitcoin's hour at least {MARKET_SHOCK_LINES.recoveryLine} usual move against it), before a scheduled release (once the calendar is in), or normal. Each state's widening is fitted and judged as the sharp-move rule above is, on the walk forward's moments in the state; the horizon then widens by the states' rules or by the one rule past the line, whichever had the lower pinball loss on every moment either would touch -- or by neither where neither passed its own test, the models having been fitted on the same figures. Live: the forecasts made in each state, and how their 80% ranges held.
          </p>
          <LabTable table={marketShockTable(view.marketShock, view.live)} name="market-shock" onNote={setNote} />
        </Card>
      )}

      {view !== null && (
        <Card title="Scheduled events">
          <p style={{ ...noteStyle, marginTop: 0 }}>
            The macro calendar (read {view.calendar.readAt} from the Bureau of Labor Statistics' and the Federal Reserve's public schedules; ETF decisions and token unlocks have no free, dated source and are left out): within the hour before a release the market is in its PRE_EVENT state, whose widening each refit fits and judges as any state's. The calendar never moves a forecast's median: the surprise is the market's own reaction, read as Bitcoin's fifteen minutes after. Below, what Bitcoin did after each past release inside the bars on file, by kind -- a kind under {EVENT_IMPACT_LINES.minSamples} releases is shown and not used -- and the releases inside the walk forward's weeks replayed: the record's hour before each and the first hour at or after it, every pair together, as forecast (V6), widened by the sharp-move rule (V6.1) and by the states' rules, with the market's state there and the calls. On a run fitted before the market's figures joined the rows, "as forecast" is the models from before.
          </p>
          <LabTable table={nextReleasesTable(view.calendar.next)} name="next-releases" onNote={setNote} />
          <LabTable table={impactTable(view.calendar.impact)} name="event-impact" onNote={setNote} />
          {view.lab !== null && HORIZONS.some((horizon) => (view.lab!.horizons[horizon]?.releases ?? []).length > 0) && <LabTable table={releasesTable(view.lab)} name="releases" onNote={setNote} />}
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
            The forecast's P(up) was read off its range's distribution, and on the walk forward it never beat the base rate, so no way was ever called. Since V7.1 four classifiers forecast which way from the same row -- a line and boosted trees on every figure, trees on the price and technical figures, trees on the price figures alone -- each mapped by the readings of the weeks before its own and scored on the same weeks as the distribution's reading: its Brier skill over the better of an even chance and the weeks-before base rate, and its calls at the forecast's lines (P(up) at or past 58%, or at or under 42%). A model is promoted by its checklist alone, and a class reads its P(up) from the promoted source with the highest skill where any is skilled, from the base rate where none is. The call's lines are unchanged; a model that calls more and does worse is never promoted. Since V7.2 Stage 1 each skill and each share of calls right carries its 95% interval, and each model the smallest skill its sample could tell from zero: a skill under that line, however it reads, is not yet a finding. Since V7.2 Stage 2 the checklist asks for a skill of at least 1%, at least 200 calls whose precision's lower bound clears an even chance, a skill above zero in both halves of the weeks and both halves of the pairs, and no class under -1% on 2,000 outcomes; a line it cannot read holds the model back. "Breakeven precision" is what a call must get right to pay its round trip at the horizon, from the median's error; "the calls' edge" is what the calls would have made in the way called, less the round trip, with its interval -- a model is TRADEABLE where that is above zero beyond noise, and it is a P(up) source only where two walk forwards in a row found it so.
          </p>
          <LabTable table={directionTable(view.direction, lab)} name="direction" onNote={setNote} />
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
