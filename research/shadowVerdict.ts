// A SHADOW WEEK'S VERDICT READ AGAIN (V7.2-R Stage 9; V72R-S8-SHADOW). For each challenger whose shadow week ended on a
// profile -- a shadow-adopted or shadow-dropped line on its training log -- the two records are read back from the
// profile's files and paired again with the app's own arithmetic (shared/forecast/shadow.ts shadowVerdictOf), on the
// outcomes that had been settled when the verdict was made (an outcome's close at or before the line's moment), and
// the verdict set beside the one logged: why, adopted, and each horizon's paired outcomes and worse or better.
//
//   PROFILE=<a scratch profile> npx esbuild research/shadowVerdict.ts --bundle --platform=node --format=esm --outfile=research/.shadowVerdict.mjs
//   PROFILE=... node research/.shadowVerdict.mjs
//
// Reads only.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HORIZONS } from '../shared/forecast/features'
import { isMissing, parseOutcomeLine, parsePredictionLine, type MissingOutcomeLine, type OutcomeLine, type PredictionLine } from '../shared/forecast/forecastRecord'
import { shadowVerdictOf, type ShadowVerdict } from '../shared/forecast/shadow'

const PROFILE = process.env.PROFILE ?? ''
if (PROFILE === '') throw new Error('PROFILE names the profile whose shadow weeks are read again')

const linesOf = (dir: string, pattern: RegExp): unknown[] => {
  const out: unknown[] = []
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((name) => pattern.test(name)).sort()
  } catch {
    return out
  }
  for (const name of names) {
    for (const line of readFileSync(join(dir, name), 'utf-8').split('\n')) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // A torn line.
      }
    }
  }
  return out
}

const forecasts = join(PROFILE, 'forecasts')
const parse = <T>(rows: unknown[], read: (raw: unknown) => T | null): T[] => rows.map(read).filter((line): line is T => line !== null)
const championPredictions = parse(linesOf(forecasts, /^predictions-\d{4}-\d{2}\.jsonl$/), parsePredictionLine)
const championOutcomes = parse(linesOf(forecasts, /^outcomes-\d{4}-\d{2}\.jsonl$/), parseOutcomeLine)
const shadowPredictions = parse(linesOf(forecasts, /^shadow-predictions-\d{4}-\d{2}\.jsonl$/), parsePredictionLine)
const shadowOutcomes = parse(linesOf(forecasts, /^shadow-outcomes-\d{4}-\d{2}\.jsonl$/), parseOutcomeLine)
const training = linesOf(join(PROFILE, 'forecastModels'), /^training-\d{4}-\d{2}\.jsonl$/) as Record<string, unknown>[]
const ended = training.filter((line) => line.kind === 'shadow-adopted' || (line.kind === 'shadow-dropped' && line.why !== 'unreadable' && line.why !== 'rollback'))

/** The outcomes that had been settled at the verdict's close: an outcome's own close, or its due where it has none. */
const settledBy = (outcomes: readonly (OutcomeLine | MissingOutcomeLine)[], at: number): (OutcomeLine | MissingOutcomeLine)[] =>
  outcomes.filter((line) => (isMissing(line) ? line.due : (line.at ?? line.due)) <= at)

console.log(`${PROFILE}: ${championPredictions.length} forecasts and ${championOutcomes.length} outcomes of the run in use; ${shadowPredictions.length} and ${shadowOutcomes.length} of shadows; ${ended.length} shadow week(s) ended`)
let differ = 0
for (const line of ended) {
  const runId = String(line.runId)
  const since = Number(line.since)
  const until = Number(line.until)
  const at = Number(line.at)
  const mine: PredictionLine[] = shadowPredictions.filter((prediction) => prediction.run === runId)
  const again: ShadowVerdict = shadowVerdictOf({ predictions: championPredictions, outcomes: settledBy(championOutcomes, at) }, { predictions: mine, outcomes: settledBy(shadowOutcomes, at) }, since, until)
  const logged = { adopted: line.kind === 'shadow-adopted', why: String(line.why), horizons: (line.horizons ?? {}) as ShadowVerdict['horizons'] }
  console.log(`\n${runId} beside ${String(line.championRunId)}, ${new Date(since * 1000).toISOString()} to ${new Date(until * 1000).toISOString()}, judged ${new Date(at * 1000).toISOString()}`)
  console.log(`  logged: ${logged.adopted ? 'adopted' : 'dropped'} (${logged.why}) -- ${String(line.summary)}`)
  console.log(`  again:  ${again.adopted ? 'adopted' : 'dropped'} (${again.why}) -- ${again.summary}`)
  let same = again.adopted === logged.adopted && again.why === logged.why
  for (const horizon of HORIZONS) {
    const a = again.horizons[horizon]
    const b = logged.horizons[horizon]
    const agrees = a !== undefined && b !== undefined && a.pairs === b.pairs && a.worse === b.worse && a.better === b.better
    if (!agrees) same = false
    const figure = a?.paired === null || a?.paired === undefined ? 'unread' : `pinball ${a.paired.pinball.difference.toFixed(5)} [${a.paired.pinball.low.toFixed(5)}, ${a.paired.pinball.high.toFixed(5)}], coverage distance ${a.paired.coverageDistance.difference.toFixed(4)}, skill ${a.paired.directionSkill === null ? '-' : a.paired.directionSkill.difference.toFixed(4)}`
    console.log(`  ${horizon.padEnd(10)} pairs ${a?.pairs ?? '-'} (logged ${b?.pairs ?? '-'}), worse ${a?.worse} (${b?.worse}), better ${a?.better} (${b?.better}); ${figure}${agrees ? '' : '  DIFFERS'}`)
  }
  if (!same) differ++
  console.log(`  ${same ? 'the same verdict' : 'NOT the verdict logged'}`)
}
console.log(`\n${ended.length - differ} of ${ended.length} verdicts read again as logged`)
process.exitCode = differ === 0 ? 0 : 1
