// TWO WALK FORWARDS PAIRED ON THE HOURS BOTH TESTED (V7.2 Stage 3, 17 October 2026): what the challenger
// of shared/forecast/challenger.ts reads, printed for two runs of one profile -- the champion and a refit --
// so that a refit's verdict can be read beside the figures it rests on, and V7.1's verdict (the tolerances
// alone) beside the V7.2 one (beyond noise, or a week newer and no worse).
//
//   npx esbuild research/pairedChallenge.ts --bundle --platform=node --format=esm --outfile=research/.pairedChallenge.mjs
//   PROFILE=<a scratch profile> CHAMPION=<run> CHALLENGER=<run> node research/.pairedChallenge.mjs
//
// It reads the profile's forecastModels/<run>/{oos-*.bin,calibration.json}; it writes nothing and asks nothing.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseRunCalibration } from '../shared/forecast/calibrationFile'
import { CHALLENGER_LINES, challengeRefusals, challengeSummary, compareRuns, pairedChallengeOf, type PairedFigure } from '../shared/forecast/challenger'
import { HORIZONS, type Horizon } from '../shared/forecast/features'
import type { ForecastModelId } from '../shared/forecast/models'
import { decodeOos, type OosRecord } from '../shared/forecast/oosRecord'
import { buildRunCalibration, rowsOf, scoreOutOfSample, type RunCalibration, type ScoredRow } from '../shared/forecast/runCalibration'
import type { Promotion } from '../shared/forecast/training'

const PROFILE = process.env.PROFILE ?? ''
const CHAMPION = process.env.CHAMPION ?? ''
const CHALLENGER = process.env.CHALLENGER ?? ''
if (PROFILE === '' || CHAMPION === '' || CHALLENGER === '') throw new Error('PROFILE, CHAMPION and CHALLENGER name the profile and its two runs')
const MODELS = join(PROFILE, 'forecastModels')

/** A run's records, its shown forecast scored as the app scores it with the models its calibration file
 * weighs (read raw: a file of an older version still says which), and its calibration built again from the
 * record so that two runs of any version compare on the same arithmetic. */
function loadRun(runId: string): { calibration: RunCalibration; shown: Map<Horizon, ScoredRow[]>; last: number } {
  const text = readFileSync(join(MODELS, runId, 'calibration.json'), 'utf-8')
  const kept = parseRunCalibration(text)
  const raw = JSON.parse(text) as { horizons?: Partial<Record<Horizon, { variants?: { v2?: { weights?: { pooled?: { model: ForecastModelId; weight: number }[] } } } }>> }
  const shown = new Map<Horizon, ScoredRow[]>()
  const records = new Map<Horizon, OosRecord>()
  const promotions: Promotion[] = []
  let last = 0
  for (const horizon of HORIZONS as Horizon[]) {
    let bytes: Buffer
    try {
      bytes = readFileSync(join(MODELS, runId, `oos-${horizon}.bin`))
    } catch {
      continue
    }
    const record = decodeOos(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    if (record === null) continue
    records.set(horizon, record)
    // The models the calibration weighs, as the app scores the forecast shown; every model where none is weighed.
    const weighed = (raw.horizons?.[horizon]?.variants?.v2?.weights?.pooled ?? []).filter((entry) => entry.weight > 0).map((entry) => entry.model)
    const promoted = weighed.length > 0 ? weighed : [...record.models]
    for (const model of promoted) promotions.push({ horizon, model, promoted: true, lines: [] })
    shown.set(horizon, scoreOutOfSample(rowsOf(record), 'v2', new Set<ForecastModelId>(promoted)))
    for (let row = 0; row < record.rows; row++) if (record.time[row] > last) last = record.time[row]
  }
  const calibration = kept ?? buildRunCalibration(records, promotions, runId)
  if (kept === null) console.log(`${runId}: its calibration file is of another version; the figures are built again from its record`)
  return { calibration, shown, last }
}

const champion = loadRun(CHAMPION)
const challenger = loadRun(CHALLENGER)
const newerDays = (challenger.last - champion.last) / 86400
const paired = pairedChallengeOf(champion.shown, challenger.shown)
const figure = (made: PairedFigure, digits: number, scale: number): string => `${made.difference >= 0 ? '+' : ''}${(made.difference * scale).toFixed(digits)} [${made.low >= 0 ? '+' : ''}${(made.low * scale).toFixed(digits)}, ${made.high >= 0 ? '+' : ''}${(made.high * scale).toFixed(digits)}]${made.better ? ' BETTER' : made.worse ? ' WORSE' : ''}`

console.log(`${CHALLENGER} against ${CHAMPION} in ${PROFILE}: the challenger's rows reach ${newerDays.toFixed(2)} days past the champion's; ${Math.round(CHALLENGER_LINES.level * 100)}% intervals, the floors ${CHALLENGER_LINES.pinballTolerance * 100}% of the pinball loss, ${CHALLENGER_LINES.coverageTolerance * 100} points of coverage, ${CHALLENGER_LINES.directionTolerance * 100} point of skill`)
console.log('horizon    shared hours  blocks  pinball difference (x1)              80% range distance from 80% (points)  direction skill difference (points)')
for (const horizon of HORIZONS as Horizon[]) {
  const made = paired[horizon]
  if (made === undefined) {
    console.log(`${horizon.padEnd(10)} no shared record`)
    continue
  }
  console.log(`${horizon.padEnd(10)} ${String(made.hours).padStart(12)}  ${String(made.blocks).padStart(6)}  ${figure(made.pinball, 4, 1).padEnd(36)} ${figure(made.coverageDistance, 2, 100).padEnd(37)} ${made.directionSkill === null ? '-' : figure(made.directionSkill, 2, 100)}`)
}
const v72 = compareRuns(champion.calibration, challenger.calibration, paired, newerDays)
const v71 = compareRuns(champion.calibration, challenger.calibration)
console.log(`\nV7.2 (beyond noise): ${challengeSummary(v72)}`)
console.log(`V7.1 (the tolerances alone): ${v71.adopted ? 'adopted' : `refused: ${challengeRefusals(v71).join('; ')}`}`)
