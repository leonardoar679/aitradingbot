import { HORIZONS, PAIR_CLASSES, type Horizon, type PairClass } from '../../shared/forecast/features'
import { LIVE_VARIANTS, type LabErrorKind, type LabEvent, type LabMetrics, type LeaderRow, type LiveLab, type TraderStats } from '../../shared/forecast/lab'
import type { LabFile } from '../../shared/forecast/labFile'
import type { DirectionView } from '../../shared/forecast/labView'
import { DIRECTION_MODELS } from '../../shared/forecast/models'
import { ROUND_TRIP_PCT } from '../../shared/forecast/edge'
import { CLASS_LINES, type ClassRecord } from '../../shared/forecast/opportunityClass'
import type { DirectionScore, PUpSource } from '../../shared/forecast/runCalibration'
import type { ShockRefusal, ShockRule } from '../../shared/forecast/shock'
import type { Interval } from '../../shared/forecast/uncertainty'
import type { RegistryRow } from '../../shared/forecast/preregistration'
import { WIDENED_STATES, type MarketShockRules, type MarketShockState, type ShockWidening } from '../../shared/forecast/marketShock'
import type { EventImpactFile } from '../../shared/calendar/eventImpact'
import { MACRO_KINDS, type MacroEvent, type MacroKind } from '../../shared/calendar/macro'

// THE FORECAST LAB'S TABLES (V6 Stage 11, 13 October 2026): each card's headers and rows, from the Lab's
// figures, the same for the page and its CSV. A share is said in percent, a move in percent with its
// sign; a cell with nothing to say reads "—".

export interface LabTableData {
  headers: string[]
  rows: (string | number)[][]
}

export const HORIZON_NAME: Record<Horizon, string> = { minutes5: '5m', minutes15: '15m', hour1: '1h', hours4: '4h', hours24: '24h' }
export const CLASS_NAME: Record<PairClass | 'pooled', string> = { pooled: 'Every coin', btc: 'Bitcoin', eth: 'Ether', large: 'Large', mid: 'Mid', 'high-vol': 'High volatility', other: 'Other' }
export const EVENT_NAME: Record<LabEvent, string> = { all: 'Every forecast', pump: 'After a pump', dump: 'After a dump', breakout: 'On a break of the day\'s range', news: 'With a story about the coin', listing: 'Listing', hack: 'Hack or exploit', etf: 'ETF', macro: 'Macro' }
export const ERROR_KINDS: LabErrorKind[] = ['CORRECT_DIRECTION', 'WRONG_DIRECTION', 'RIGHT_RANGE', 'TOO_NARROW', 'TOO_WIDE', 'EARLY', 'LATE', 'NEWS_MISREAD', 'MARKET_MISREAD']

export const share = (value: number | null | undefined, digits = 1): string => (value === null || value === undefined || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(digits)}%`)
export const pct = (value: number | null | undefined, digits = 2): string => (value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`)
export const plain = (value: number | null | undefined, digits = 3): string => (value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits))
/** A share or a skill with its 95% interval beside it, where one was read (V7.2 Stage 1). */
export const withInterval = (text: string, interval: Interval | null | undefined, digits = 1): string => (interval === null || interval === undefined ? text : `${text} (${(interval.low * 100).toFixed(digits)}–${(interval.high * 100).toFixed(digits)})`)
export const count = (value: number | null | undefined): string => (value === null || value === undefined || !Number.isFinite(value) ? '—' : Math.round(value).toLocaleString('en-US'))

const METRIC_HEADERS = ['Outcomes', 'Independent outcomes', 'Blocks resampled', 'Median\'s way right', 'Calls', 'Calls right', 'In the 50% range', 'In the 80% range', 'MAE', 'RMSE', 'Bias', 'Pinball', 'Skill over persistence', '80% width']

function metricCells(metrics: LabMetrics | undefined): (string | number)[] {
  if (metrics === undefined) return METRIC_HEADERS.map(() => '—')
  return [
    metrics.n,
    count(metrics.nEff),
    metrics.blocks ?? '—',
    share(metrics.direction),
    metrics.calls,
    withInterval(share(metrics.callsRight), metrics.ci?.callsRight),
    withInterval(share(metrics.coverage50), metrics.ci?.coverage50),
    withInterval(share(metrics.coverage80), metrics.ci?.coverage80),
    `${plain(metrics.mae, 2)}%`,
    `${plain(metrics.rmse, 2)}%`,
    pct(metrics.bias, 3),
    plain(metrics.pinball, 4),
    withInterval(share(metrics.skill, 2), metrics.ci?.skill, 2),
    `${plain(metrics.width80, 2)}%`
  ]
}

/** The walk forward's forecasts by horizon and variant, for one class or every coin (§27-28, §49). */
export function performanceTable(lab: LabFile, cls: PairClass | 'pooled'): LabTableData {
  const rows: (string | number)[][] = []
  for (const horizon of HORIZONS) {
    const entry = lab.horizons[horizon]
    if (entry === undefined) continue
    for (const variant of ['v1', 'v2'] as const) {
      const metrics = cls === 'pooled' ? entry.variants[variant].pooled : entry.variants[variant].byClass[cls]
      rows.push([HORIZON_NAME[horizon], variant === 'v1' ? 'V1 price only' : 'V2 + technical (shown)', ...metricCells(metrics)])
    }
  }
  return { headers: ['Horizon', 'Variant', ...METRIC_HEADERS], rows }
}

/** The classes a Lab holds outcomes for, for its class picker. */
export function classesOf(lab: LabFile): (PairClass | 'pooled')[] {
  const held = new Set<PairClass>()
  for (const entry of Object.values(lab.horizons)) for (const cls of Object.keys(entry?.variants.v2.byClass ?? {})) held.add(cls as PairClass)
  return ['pooled', ...PAIR_CLASSES.filter((cls) => held.has(cls))]
}

/** The calibration curve (§26, §56): the share at or below each level against its nominal, and the tails. */
export function calibrationTable(lab: LabFile): LabTableData {
  const rows: (string | number)[][] = []
  for (const horizon of HORIZONS) {
    const metrics = lab.horizons[horizon]?.variants.v2.pooled
    if (metrics === undefined) continue
    rows.push([HORIZON_NAME[horizon], ...metrics.levels.map((level) => share(level)), share(metrics.tailLow), share(metrics.tailHigh)])
  }
  return { headers: ['Horizon', 'At or below P10 (10%)', 'P25 (25%)', 'P50 (50%)', 'P75 (75%)', 'P90 (90%)', 'Under P10', 'Over P90'], rows }
}

/** P(up) against what went up (§59), tenth by tenth, every horizon. */
export function pUpCurveTable(lab: LabFile): LabTableData {
  const rows: (string | number)[][] = []
  for (const horizon of HORIZONS) {
    for (const bin of lab.horizons[horizon]?.variants.v2.pUpCurve ?? []) rows.push([HORIZON_NAME[horizon], share(bin.predicted), share(bin.observed), bin.n])
  }
  return { headers: ['Horizon', 'P(up) forecast', 'Went up', 'Outcomes'], rows }
}

function errorCells(metrics: LabMetrics | undefined): (string | number)[] {
  return ERROR_KINDS.map((kind) => {
    const count = metrics?.errors[kind] ?? 0
    return metrics === undefined || metrics.n === 0 ? '—' : `${count} (${share(count / metrics.n)})`
  })
}

/** The kinds of error (§43) by horizon, on the walk forward and on the live record. */
export function errorsTable(lab: LabFile | null, live: LiveLab): LabTableData {
  const rows: (string | number)[][] = []
  for (const horizon of HORIZONS) {
    const walked = lab?.horizons[horizon]?.variants.v2.pooled
    if (walked !== undefined) rows.push(['Walk forward', HORIZON_NAME[horizon], walked.n, ...errorCells(walked)])
    const shown = live.horizons[horizon]?.variants.v4
    if (shown !== undefined) rows.push(['Live record', HORIZON_NAME[horizon], shown.n, ...errorCells(shown)])
  }
  return { headers: ['Record', 'Horizon', 'Outcomes', ...ERROR_KINDS.map((kind) => kind.replace(/_/g, ' '))], rows }
}

/** Drift (§42): how forecasts made after an hour's shock behaved. */
export function driftTable(lab: LabFile | null, live: LiveLab): LabTableData {
  const rows: (string | number)[][] = []
  for (const horizon of HORIZONS) {
    const drift = lab?.horizons[horizon]?.drift
    if (drift !== undefined) rows.push(['Walk forward', HORIZON_NAME[horizon], drift.shocks, `${drift.overReacting} (${share(drift.shocks > 0 ? drift.overReacting / drift.shocks : null)})`, `${drift.underReacting} (${share(drift.shocks > 0 ? drift.underReacting / drift.shocks : null)})`])
  }
  const drift = live.drift
  rows.push(['Live record', 'every horizon', drift.shocks, `${drift.overReacting} (${share(drift.shocks > 0 ? drift.overReacting / drift.shocks : null)})`, `${drift.underReacting} (${share(drift.shocks > 0 ? drift.underReacting / drift.shocks : null)})`])
  return { headers: ['Record', 'Horizon', 'After a shock', 'Over-reacting', 'Under-reacting'], rows }
}

/** One event's forecasts by horizon (§92-93), on the walk forward and the live record. */
export function eventsTable(lab: LabFile | null, live: LiveLab, event: LabEvent): LabTableData {
  const rows: (string | number)[][] = []
  for (const horizon of HORIZONS) {
    const walked = lab?.horizons[horizon]?.events[event]
    if (walked !== undefined) rows.push(['Walk forward', HORIZON_NAME[horizon], ...metricCells(walked)])
  }
  const shown = live.events[event]
  if (shown !== undefined) rows.push(['Live record', 'every horizon', ...metricCells(shown)])
  return { headers: ['Record', 'Horizon', ...METRIC_HEADERS], rows }
}

const LIVE_NAME = { v1: 'V1 price only', v2: 'V2 + technical', v3: 'V3 + news', v4: 'V4 + news + AI (shown)' } as const

/** The live record's four variants on the same moments (§49), and the shown forecast with and without a story. */
export function liveTable(live: LiveLab): LabTableData {
  const rows: (string | number)[][] = []
  for (const horizon of HORIZONS) {
    const entry = live.horizons[horizon]
    if (entry === undefined) continue
    for (const variant of LIVE_VARIANTS) rows.push([HORIZON_NAME[horizon], LIVE_NAME[variant], ...metricCells(entry.variants[variant])])
    rows.push([HORIZON_NAME[horizon], 'Shown, a story moving it', ...metricCells(entry.news.moved)])
    rows.push([HORIZON_NAME[horizon], 'Shown, no story', ...metricCells(entry.news.unmoved)])
  }
  return { headers: ['Horizon', 'Variant', ...METRIC_HEADERS], rows }
}

/** Every model at every horizon (§103-105). */
const SHOCK_REFUSAL: Record<ShockRefusal, string> = {
  no_record: 'no record of Bitcoin\'s moves: a walk forward from before the rule, until the next refit',
  too_few: 'too few moments past the line to fit from',
  coverage: 'widening did not bring the 80% range nearer 80%',
  pinball: 'widening made the pinball loss worse'
}

/** The rule on Bitcoin's sharp moves at each horizon (V6.1): what the walk forward found past the line,
 * cross-fitted, whether it is in use and why not; and the live record's forecasts it widened. */
export function shockTable(rules: Partial<Record<Horizon, ShockRule>>, live: LiveLab): LabTableData {
  return {
    headers: ['Horizon', 'Moments', 'Hours', 'In the 80% range, as forecast', 'Widened', 'Pinball, as forecast', 'Widened', 'Factors (80% / 50%)', 'In use', 'Live: widened', 'In the 80% range', 'Unwidened'],
    rows: HORIZONS.filter((horizon) => rules[horizon] !== undefined).map((horizon) => {
      const rule = rules[horizon]!
      const widened = live.horizons[horizon]?.shock
      return [
        HORIZON_NAME[horizon],
        rule.moments,
        rule.rows,
        share(rule.before?.in80),
        share(rule.after?.in80),
        plain(rule.before?.pinball, 4),
        plain(rule.after?.pinball, 4),
        rule.refusal === 'too_few' || rule.refusal === 'no_record' ? '—' : `x${rule.k80.toFixed(2)} / x${rule.k50.toFixed(2)}`,
        rule.adopted ? 'yes' : `no: ${SHOCK_REFUSAL[rule.refusal ?? 'too_few']}`,
        widened?.widened.n ?? 0,
        share(widened?.widened.coverage80),
        share(widened?.unwidened.coverage80)
      ]
    })
  }
}

export const STATE_NAME: Record<MarketShockState, string> = {
  NORMAL: 'Normal',
  PRE_EVENT: 'Before a scheduled release',
  POST_EVENT_SHOCK: "After a sharp move of Bitcoin's",
  TRENDING_SHOCK: "In a trending move of Bitcoin's",
  LIQUIDATION_SHOCK: 'In a liquidation cascade',
  RECOVERY: 'Recovering from a shock'
}

const WIDENING_NAME: Record<ShockWidening, string> = { none: 'none: the models alone', line: "V6.1's one rule past the line", states: "the states' rules" }

/** The rules by market shock state at each horizon (V7.1 Stage 11): each state's rule as the walk forward
 * found it, cross-fitted, whether it is in use, and the horizon's choice among the widenings; and the live
 * record's forecasts in each state. */
export function marketShockTable(rules: Partial<Record<Horizon, MarketShockRules>>, live: LiveLab): LabTableData {
  const rows: (string | number)[][] = []
  for (const horizon of HORIZONS) {
    const mine = rules[horizon]
    if (mine === undefined) continue
    const compared = mine.compared
    const choice = `${WIDENING_NAME[mine.chosen]}${compared === null ? '' : ` (on ${compared.rows} rows: as forecast ${share(compared.before.in80)} in 80%, pinball ${plain(compared.before.pinball, 4)}; by the line ${share(compared.line.in80)}, ${plain(compared.line.pinball, 4)}; by the states ${share(compared.states.in80)}, ${plain(compared.states.pinball, 4)})`}`
    for (const state of WIDENED_STATES) {
      const rule = mine.byState[state]
      const widened = live.horizons[horizon]?.byState?.[state]
      rows.push([
        HORIZON_NAME[horizon],
        STATE_NAME[state],
        rule?.moments ?? 0,
        rule?.rows ?? 0,
        share(rule?.before?.in80),
        share(rule?.after?.in80),
        plain(rule?.before?.pinball, 4),
        plain(rule?.after?.pinball, 4),
        rule === undefined || rule.refusal === 'too_few' || rule.refusal === 'no_record' ? '—' : `x${rule.k80.toFixed(2)} / x${rule.k50.toFixed(2)}`,
        rule === undefined ? 'no: no moment in this state' : rule.adopted ? (mine.chosen === 'states' ? 'yes' : 'fitted, the horizon widens otherwise') : `no: ${SHOCK_REFUSAL[rule.refusal ?? 'too_few']}`,
        choice,
        widened?.n ?? 0,
        share(widened?.coverage80)
      ])
    }
  }
  return { headers: ['Horizon', 'State', 'Moments', 'Hours', 'In the 80% range, as forecast', 'Widened', 'Pinball, as forecast', 'Widened', 'Factors (80% / 50%)', 'In use', 'The horizon widens by', 'Live: forecasts in the state', 'In the 80% range'], rows }
}

const KIND_NAME: Record<MacroKind, string> = { CPI: 'Consumer Price Index', PPI: 'Producer Price Index', JOBS: 'Employment Situation', FOMC: 'FOMC statement' }
const utc = (sec: number): string => `${new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** The calendar's coming releases (V7.1 Stage 12). */
export function nextReleasesTable(next: readonly MacroEvent[]): LabTableData {
  return { headers: ['Release', 'Reports on', 'When (UTC)', 'Eastern'], rows: next.map((event) => [KIND_NAME[event.kind], event.reference ?? '—', utc(event.at), `${event.date} ${event.timeEt}`]) }
}

/** What Bitcoin did after past releases, by kind (V7.1 Stage 12; research/eventImpact.ts): the median move
 * from the close before at each window, in percent and in its usual moves, the typical high and low within
 * four hours, how often the fifteen minutes after were a shock, and how soon a usual hour's move was touched;
 * a kind with fewer than thirty releases said so. */
export function impactTable(impact: EventImpactFile | null): LabTableData {
  const headers = ['Release', 'Releases', 'Median |move| 5m', '15m', '1h', '4h', 'In usual moves, 15m', '1h', 'Typical high', 'Typical low', 'A shock after', 'A usual hour touched within 4h', 'Typically at', 'Regimes seen', 'Enough to use']
  if (impact === null) return { headers, rows: [] }
  const rows = MACRO_KINDS.map((kind) => {
    const entry = impact.kinds[kind]
    const minutes = (value: number | null): string => (value === null ? '—' : `${Math.round(value)} min`)
    return [
      KIND_NAME[kind],
      entry.n,
      `${plain(entry.medianAbsPct.m5, 2)}%`,
      `${plain(entry.medianAbsPct.m15, 2)}%`,
      `${plain(entry.medianAbsPct.h1, 2)}%`,
      `${plain(entry.medianAbsPct.h4, 2)}%`,
      plain(entry.medianAbsZ.m15, 1),
      plain(entry.medianAbsZ.h1, 1),
      pct(entry.medianMaxUpPct),
      pct(entry.medianMaxDownPct),
      share(entry.shockAfterShare, 0),
      share(entry.touchedWithin4hShare, 0),
      minutes(entry.medianTouchMin),
      Object.entries(entry.byRegime)
        .map(([regime, count]) => `${regime} ${count}`)
        .join(', ') || '—',
      entry.enough ? 'yes' : `no: ${entry.n} of ${impact.minSamples} needed`
    ]
  })
  return { headers, rows }
}

/** The calendar's releases inside the walk forward's weeks, replayed (V7.1 Stage 12; shared/forecast/
 * eventReplay.ts): at each horizon, the hour before each release and the first hour at or after it, every
 * pair together -- how the 80% range held and the pinball loss as forecast, widened by the line's rule and
 * by the states' rules, the market's state there, Bitcoin's fifteen minutes, and the calls. */
export function releasesTable(lab: LabFile): LabTableData {
  const headers = ['Release', 'When (UTC)', 'Horizon', 'Hour', 'Pairs', 'State', "Bitcoin's 15 min", 'In the 80% range, as forecast', 'By the line', 'By the states', 'Pinball, as forecast', 'By the line', 'By the states', 'Calls', 'Right']
  const rows: (string | number)[][] = []
  for (const horizon of HORIZONS) {
    for (const row of lab.horizons[horizon]?.releases ?? []) {
      rows.push([
        KIND_NAME[row.kind],
        utc(row.at),
        HORIZON_NAME[horizon],
        row.hour === 'before' ? `before (${utc(row.t).slice(11)})` : `after (${utc(row.t).slice(11)})`,
        row.n,
        row.state === null ? '—' : STATE_NAME[row.state],
        row.btc15 === null ? '—' : plain(row.btc15, 1),
        share(row.asForecast.in80),
        share(row.byLine?.in80),
        share(row.byStates?.in80),
        plain(row.asForecast.pinball, 4),
        plain(row.byLine?.pinball, 4),
        plain(row.byStates?.pinball, 4),
        row.calls,
        row.calls === 0 ? '—' : `${row.callsRight} (${share(row.callsRight / row.calls, 0)})`
      ])
    }
  }
  return { headers, rows }
}

const DIRECTION_MODEL_NAME: Record<(typeof DIRECTION_MODELS)[number], string> = {
  'dir-logistic': 'dir-logistic (every figure, a line)',
  'dir-gbt': 'dir-gbt (every figure, trees)',
  'dir-gbt-tech': 'dir-gbt-tech (price and technical figures)',
  'dir-gbt-price': 'dir-gbt-price (price figures alone)'
}

/** The precision a call must reach to pay its round trip at a horizon (V7.2 Stage 2): half plus the round
 * trip's cost over twice the median's error -- 0.90 at five minutes, 0.77 at fifteen, 0.64 at an hour, 0.565
 * at four and 0.525 at a day on the walk forward of 16 October 2026. Null without the Lab's error. */
export function breakevenPrecision(mae: number | null | undefined): number | null {
  return mae === null || mae === undefined || !(mae > 0) ? null : 0.5 + ROUND_TRIP_PCT / (2 * mae)
}

const edgeCell = (edge: DirectionScore['edge']): string => {
  if (edge === undefined) return '—'
  const text = pct(edge.meanPct, 3)
  return edge.ci === null ? text : `${text} (${pct(edge.ci.low, 3)}–${pct(edge.ci.high, 3)})`
}

/** The direction experiments (V7.1 Stage 2): at each horizon, the distribution's P(up) and every direction
 * model, scored on the same weeks of the walk forward -- outcomes, Brier skill over the base rate with its
 * interval and the skill its sample could tell from zero, calls at the forecast's lines and the share right,
 * the precision a call must reach to pay at the horizon, the calls' edge after the round trip (V7.2 Stage
 * 2) -- each model's verdict, whether it held on the run before too, its last week, and which pair classes
 * read their P(up) from it now. `lab` gives the median's error the breakeven is read from. */
export function directionTable(views: Partial<Record<Horizon, DirectionView>>, lab: LabFile | null = null): LabTableData {
  const rows: (string | number)[][] = []
  const cells = (score: DirectionScore | null | undefined, horizon: Horizon): (string | number)[] =>
    score === null || score === undefined
      ? ['—', '—', '—', '—', '—', '—', '—']
      : [
          score.n,
          withInterval(share(score.directionSkill, 2), score.ci?.directionSkill, 2),
          share(score.detectable, 2),
          score.calls,
          withInterval(share(score.precision), score.ci?.precision),
          share(breakevenPrecision(lab?.horizons[horizon]?.variants.v2.pooled.mae)),
          edgeCell(score.edge)
        ]
  const classesOf = (view: DirectionView, source: PUpSource): string => {
    const classes = view.inUse[source]
    return classes === undefined || classes.length === 0 ? '—' : classes.length === PAIR_CLASSES.length ? 'every class' : classes.join(', ')
  }
  for (const horizon of HORIZONS) {
    const view = views[horizon]
    if (view === undefined) continue
    rows.push([HORIZON_NAME[horizon], "the distribution's P(up)", ...cells(view.report.baseline.pooled, horizon), 'the floor', '—', '—', classesOf(view, 'distribution')])
    for (const model of DIRECTION_MODELS) {
      const made = view.report.models[model]
      if (made === undefined) continue
      const failed = made.lines.filter((line) => line.ok === false).map((line) => line.id)
      const unread = made.lines.filter((line) => line.ok === null).map((line) => line.id)
      const verdict = made.tradeable ? 'promoted, tradeable' : made.promoted ? `promoted, not tradeable: ${failed.concat(unread).join(', ')}` : `not promoted: ${failed.join(', ')}${unread.length === 0 ? '' : `${failed.length === 0 ? '' : '; '}not read: ${unread.join(', ')}`}`
      rows.push([
        HORIZON_NAME[horizon],
        DIRECTION_MODEL_NAME[model],
        ...cells(made.honest.pooled, horizon),
        verdict,
        made.tradeableBefore === null ? 'no run before' : made.tradeable && made.tradeableBefore ? 'yes: a P(up) source' : made.tradeableBefore ? 'the run before only' : made.tradeable ? 'this run only' : 'no',
        made.lastWeekSkill === null ? '—' : made.degraded ? `DEGRADED (${share(made.lastWeekSkill, 2)})` : share(made.lastWeekSkill, 2),
        classesOf(view, model)
      ])
    }
    rows.push([HORIZON_NAME[horizon], 'the base rate', '—', '—', '—', '—', '—', '—', '—', '—', '—', '—', classesOf(view, 'base')])
  }
  return { headers: ['Horizon', 'Source of P(up)', 'Outcomes', 'Brier skill over the base rate', 'Detectable skill', 'Calls at the lines', 'Calls right', 'Breakeven precision', "The calls' edge after costs", 'Verdict', 'Tradeable twice', 'Last week', 'P(up) of'], rows }
}

/** The path's figures on the live record (V7.1 Stage 3), by horizon: when the median was said to be reached
 * against when it was, whether UNLIKELY was right, the typical minutes said and seen, and whether the
 * likely high and low held. */
export function timingTable(live: LiveLab): LabTableData {
  const minutes = (value: number | null): string => (value === null ? '—' : `${Math.round(value)} min`)
  return {
    headers: ['Horizon', 'Forecasts', 'Said: median reached within the window', 'Seen: reached', 'Said UNLIKELY', 'Of those, reached', 'Typical minutes said', 'Minutes seen', 'With likely levels', 'High stayed under the 80% level', 'Low stayed above'],
    rows: HORIZONS.filter((horizon) => live.horizons[horizon]?.timing !== undefined).map((horizon) => {
      const timing = live.horizons[horizon]!.timing!
      return [HORIZON_NAME[horizon], timing.n, share(timing.predicted), share(timing.reached), timing.unlikely, share(timing.unlikelyReached), minutes(timing.saidMinutes), minutes(timing.seenMinutes), timing.excursion.n, share(timing.excursion.high80), share(timing.excursion.low80)]
    })
  }
}

export function leaderTable(rows: readonly LeaderRow[]): LabTableData {
  return {
    headers: ['Horizon', 'Model', 'Outcomes', 'Pinball', 'Skill over persistence', 'In the 80% range', 'Median\'s way right', 'Weight', 'Promoted', 'Last week'],
    rows: rows.map((row) => [
      HORIZON_NAME[row.horizon],
      row.model,
      row.n,
      plain(row.pinball, 4),
      row.model === 'persistence' ? 'the floor' : share(row.skill, 2),
      share(row.coverage80),
      share(row.direction),
      share(row.weight, 0),
      row.promoted === null ? '—' : row.promoted ? 'yes' : 'no',
      row.degraded ? 'DEGRADED' : 'within its lines'
    ])
  }
}

const TRADER_HEADERS = ['Trades', 'Win rate', 'Profit factor', 'Expectancy a trade', 'Net, a stake a trade', 'Max drawdown', 'Round trips\' cost']

export function traderCells(stats: TraderStats): (string | number)[] {
  return [stats.trades, share(stats.winRate), plain(stats.profitFactor, 2), pct(stats.expectancyPct, 3), pct(stats.netPct), `${plain(stats.maxDrawdownPct, 2)}%`, `${plain(stats.costPct, 2)}%`]
}

/** The forecast trader (§97) by horizon: as the rules stand, and on the median alone (research). */
export function traderTable(lab: LabFile): LabTableData {
  const rows: (string | number)[][] = []
  for (const horizon of HORIZONS) {
    const entry = lab.horizons[horizon]
    if (entry === undefined) continue
    rows.push([HORIZON_NAME[horizon], 'As the rules stand', ...traderCells(entry.trader.rules)])
    rows.push([HORIZON_NAME[horizon], 'On the median alone (research)', ...traderCells(entry.trader.medians)])
  }
  return { headers: ['Horizon', 'Rule', ...TRADER_HEADERS], rows }
}

export const COMPARISON_HEADERS = ['What', ...TRADER_HEADERS]

const VERDICT_NAME: Record<ClassRecord['verdict'], string> = { APPROVED: 'APPROVED', PROBATION: 'PROBATION', DISABLED: 'DISABLED', NOT_ENOUGH: 'NOT ENOUGH DATA' }

/** Every opportunity class (§99) with its two records and its verdict, approved first. */
export function classesTable(classes: readonly ClassRecord[]): LabTableData {
  const order: ClassRecord['verdict'][] = ['APPROVED', 'PROBATION', 'DISABLED', 'NOT_ENOUGH']
  const sorted = [...classes].sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict) || b.history.trades - a.history.trades || a.key.localeCompare(b.key))
  return {
    headers: ['Class (coin / horizon / setup)', 'Replayed trades', 'Replayed net', 'Live paper trades', 'Live paper net', 'Verdict'],
    rows: sorted.map((record) => [record.key, `${record.history.trades} of ${CLASS_LINES.minHistoryTrades}`, pct(record.history.netPct), record.live.trades, pct(record.live.netPct), VERDICT_NAME[record.verdict]])
  }
}

const utcText = (iso: string): string => iso.replace('T', ' ').replace(/Z$/, '')

/** The pre-registered lines (V7.2 Stage 3): each registration with its last result. */
export function registrationsTable(rows: readonly RegistryRow[]): LabTableData {
  return {
    headers: ['Id', 'Kind', 'Registered (UTC)', 'Engine', 'Hypothesis', 'Success line', 'Judged on', 'Measured (UTC)', 'Figure', 'Verdict', 'Commit'],
    rows: rows.map((row) => [
      row.id,
      row.kind,
      utcText(row.registeredAt),
      row.engineVersion,
      row.hypothesis,
      row.successLine,
      row.judgedOn,
      row.measuredAt === null ? '—' : utcText(row.measuredAt),
      row.figure === null ? '—' : row.ci === null || row.ci === undefined ? row.figure : `${row.figure} (${row.ci})`,
      row.verdict ?? 'not yet',
      row.commit ?? '—'
    ])
  }
}

export function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function tableCsv(table: LabTableData): string {
  return [table.headers, ...table.rows].map((row) => row.map(csvCell).join(',')).join('\n')
}
