import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENGINE_CONSTANTS, flattenConfig } from '../shared/appConfig'
import { HASHED_FIELDS, checkRegistry, parseRegistry, registrationHash, registryRows, type Registration } from '../shared/forecast/preregistration'
import { registrationsTable } from '../src/forecastLab/labTables'

// PRE-REGISTRATION (shared/forecast/preregistration.ts; research/preregistered.jsonl; V7.2 Stage 3): the
// registry parsed and checked -- the lock on a registration whose result is written, a duplicate id, a
// result without a registration -- on the real file and on tampered copies; and every engine constant added
// since 16 October 2026 named by a registration or listed as infrastructure.

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const FILE = join(__dirname, '..', 'research', 'preregistered.jsonl')
const TEXT = readFileSync(FILE, 'utf-8')

/** The paths under ENGINE_CONSTANTS added since 16 October 2026 (V7.2): each must be named by a registration's
 * constants (the path or a prefix of it) or be infrastructure -- arithmetic every line rests on, not a line. */
const ADDED_SINCE_16_OCTOBER = [
  'forecast.challenger.shadow',
  'forecast.blocksV3',
  'forecast.hypotheses',
  'forecast.replay',
  'forecast.rangeStrategies',
  'venueCosts',
  'forecast.universe',
  'forecast.moveOdds',
  'forecast.moveRates',
  'forecast.opportunity',
  'forecast.uncertainty',
  'forecast.directionModels.promotion.minSkill',
  'forecast.directionModels.promotion.minCalls',
  'forecast.directionModels.promotion.precisionLowerBound',
  'forecast.directionModels.promotion.halvesAbove',
  'forecast.directionModels.promotion.classFloor',
  'forecast.directionModels.promotion.edgeAbovePct',
  'forecast.challenger.newerDays',
  'forecast.challenger.level',
  'forecast.byHour',
  'forecast.ablation',
  'forecast.pass',
  'forecast.tape',
  'forecast.fidelity',
  'aiRouting'
]
// The intervals' lines, the pass's version and the tape's: plumbing with no line to hold or fail.
// httpPacing (V8 Stage 1): the hosts' budgets, which keep every reader within the limits each host sets; tasks: the
// limits a worker's task runs under; paperRisk.equity: how the paper account's equity is read (a fix, not a line); paperBooks: how
// a book's money is read from its executors (arithmetic, its comparison rules registered as V8-S9-BOOKS).
// The article reading (V8 Stage 5): its daily limit and its prompt's and schema's versions, a reading of a link a person
// pastes -- their own sample, so nothing it says is registered as a claim; its size calls are recorded and scored as a
// source like every other, and reported for what they are.
const INFRASTRUCTURE = [
  'forecast.uncertainty',
  'forecast.pass',
  'forecast.tape',
  'forecast.moveRates',
  'forecast.universe',
  'httpPacing',
  'tasks',
  'paperRisk.equity',
  'paperBooks',
  'newsUrls',
  'aiAdditions.dailyLimits.article',
  'aiAdditions.prompts.article',
  'aiAdditions.schemas.article',
  // How a pasted trader is read, their fills become round trips, and an analysis fetches the minutes the delay test
  // reads (V8 Stage 6): reading, not a claim.
  'traders.ref',
  'traders.roundTrips',
  'traders.analysis',
  // How an OKX lead trader's record is read and its fees and funding estimated, and how a file of trades is read (V8
  // Stage 7): reading, its figures labelled REPORTED, ESTIMATED or UNVERIFIABLE, not a claim.
  'traders.okx',
  'traders.file',
  // How a follow reads its trader and mirrors them in the copy book -- its caps, the price it must agree with, how late it
  // may enter, how long it stays, when a trader is lost (V8 Stage 8): the book's mechanics, on paper, not a claim. What the
  // book makes is judged by V8-S9-BOOKS, registered before its first Start.
  'traders.follow'
]

describe('the registry on file', () => {
  const registry = parseRegistry(TEXT)

  it('parses clean, every registration whole, every result answering one and locked to it', () => {
    expect(registry.problems).toEqual([])
    expect(checkRegistry(registry, sha256)).toEqual([])
    expect(registry.registrations.length).toBeGreaterThanOrEqual(20)
    const ids = registry.registrations.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ['V72-S1-INTERVALS', 'V72-S2-DIRECTIONBAR', 'V72-S3-LOCK', 'V72-S3-CHALLENGER', 'V72-S13-BUNDLE']) expect(ids).toContain(id)
    // Stages 1 and 2 are measured and held; every registration from Stage 3 on waits for its measurement.
    const rows = registryRows(registry)
    expect(rows.find((row) => row.id === 'V72-S1-INTERVALS')).toMatchObject({ verdict: 'held', commit: '078a1ab' })
    expect(rows.find((row) => row.id === 'V72-S2-DIRECTIONBAR')).toMatchObject({ verdict: 'held', commit: 'a6cb99b' })
    expect(rows.find((row) => row.id === 'V72-S13-BUNDLE')!.verdict).toBeNull()
    // One confirmatory registration names a horizon's cell at most once a cycle: the kinds are the two known.
    expect(registry.registrations.every((entry) => entry.kind === 'confirmatory' || entry.kind === 'exploratory')).toBe(true)
  })

  it("names every engine constant added since 16 October 2026, or lists it as infrastructure, and names none that does not exist", () => {
    const paths = flattenConfig(ENGINE_CONSTANTS).map((entry) => entry.path)
    const exists = (named: string): boolean => paths.some((path) => path === named || path.startsWith(`${named}.`))
    for (const added of ADDED_SINCE_16_OCTOBER) expect(exists(added), added).toBe(true)
    const named = registry.registrations.flatMap((entry) => entry.constants ?? [])
    for (const name of named) expect(exists(name), name).toBe(true)
    const covered = (added: string): boolean => [...named, ...INFRASTRUCTURE].some((name) => added === name || added.startsWith(`${name}.`))
    for (const added of ADDED_SINCE_16_OCTOBER) expect(covered(added), added).toBe(true)
  })

  it('names every engine line added since V8 began, by a registration or as infrastructure, with no list to keep by hand (V8 Stage 1)', () => {
    // The engine's every path as it stood when V8 began (26 October 2026, before Stage 1's lines).
    const snapshot = new Set(JSON.parse(readFileSync(join(__dirname, 'fixtures', 'engine-paths-v8.json'), 'utf-8')) as string[])
    const paths = flattenConfig(ENGINE_CONSTANTS).map((entry) => entry.path)
    const named = registry.registrations.flatMap((entry) => entry.constants ?? [])
    const covered = (path: string): boolean => [...named, ...INFRASTRUCTURE].some((name) => path === name || path.startsWith(`${name}.`))
    const unnamed = paths.filter((path) => !snapshot.has(path) && !covered(path))
    expect(unnamed).toEqual([])
    // The snapshot is of the engine as it was: no path in it has gone missing without a word.
    expect([...snapshot].filter((path) => !paths.includes(path))).toEqual([])
  })

  it('is shown as a table, each registration with its last result', () => {
    const table = registrationsTable(registryRows(registry))
    expect(table.headers).toEqual(['Id', 'Kind', 'Registered (UTC)', 'Engine', 'Hypothesis', 'Success line', 'Judged on', 'Measured (UTC)', 'Figure', 'Verdict', 'Commit'])
    const first = table.rows.find((row) => row[0] === 'V72-S1-INTERVALS')!
    expect(first[1]).toBe('confirmatory')
    expect(first[9]).toBe('held')
    expect(first[10]).toBe('078a1ab')
    const waiting = table.rows.find((row) => row[0] === 'V72-S13-BUNDLE')!
    expect(waiting.slice(7)).toEqual(['—', '—', 'not yet', '—'])
  })
})

describe('the lock', () => {
  const registration: Registration = { line: 'registration', id: 'T-1', registeredAt: '2026-10-17T00:00:00Z', engineVersion: 'abc', hypothesis: 'h', metric: 'm', successLine: 's', judgedOn: 'j', kind: 'confirmatory' }
  const line = (value: unknown): string => JSON.stringify(value)
  const result = (patch: Record<string, unknown> = {}): string => line({ line: 'result', id: 'T-1', measuredAt: '2026-10-18T00:00:00Z', figure: '1', verdict: 'held', commit: 'deadbee', registrationHash: registrationHash(registration, sha256), ...patch })

  it('hashes the fields a registration says before any figure, in a fixed order, and no other', () => {
    expect(HASHED_FIELDS).toEqual(['id', 'registeredAt', 'engineVersion', 'hypothesis', 'metric', 'successLine', 'judgedOn', 'kind'])
    const hash = registrationHash(registration, sha256)
    expect(hash).toMatch(/^[0-9a-f]{12}$/)
    expect(registrationHash({ ...registration, constants: ['x'] }, sha256)).toBe(hash)
    expect(registrationHash({ ...registration, successLine: 's!' }, sha256)).not.toBe(hash)
    expect(registrationHash({ ...registration, kind: 'exploratory' }, sha256)).not.toBe(hash)
  })

  it('refuses an edited registration, a duplicate id, a result without a registration and a malformed line', () => {
    const clean = parseRegistry(`# a comment\n${line(registration)}\n\n${result()}\n`)
    expect(clean.problems).toEqual([])
    expect(checkRegistry(clean, sha256)).toEqual([])
    expect(registryRows(clean)).toEqual([expect.objectContaining({ id: 'T-1', verdict: 'held', figure: '1', commit: 'deadbee', measuredAt: '2026-10-18T00:00:00Z' })])
    // The success line moved after the result: the hash no longer matches.
    const edited = parseRegistry(`${line({ ...registration, successLine: 'a kinder line' })}\n${result()}`)
    expect(checkRegistry(edited, sha256)).toEqual([expect.stringMatching(/^T-1: the registration was changed after its result/)])
    expect(checkRegistry(parseRegistry(`${line(registration)}\n${line(registration)}`), sha256)).toEqual(['T-1: registered twice'])
    expect(checkRegistry(parseRegistry(result()), sha256)).toEqual(['T-1: a result without a registration'])
    expect(parseRegistry('{not json').problems).toEqual(['line 1: not JSON'])
    expect(parseRegistry('[1]').problems).toEqual(['line 1: not an object'])
    expect(parseRegistry(line({ line: 'note' })).problems).toEqual(['line 1: neither a registration nor a result'])
    expect(parseRegistry(line({ ...registration, kind: 'hopeful' })).problems).toEqual(['line 1: a registration of kind hopeful'])
    expect(parseRegistry(line({ ...registration, hypothesis: '' })).problems).toEqual(['line 1: a registration without hypothesis'])
    expect(parseRegistry(line({ ...registration, constants: [1] })).problems).toEqual(['line 1: a registration whose constants are not names'])
    expect(parseRegistry(result({ verdict: 'maybe' })).problems).toEqual(['line 1: a result with the verdict maybe'])
    expect(parseRegistry(result({ commit: undefined })).problems).toEqual(['line 1: a result without commit'])
    expect(parseRegistry(result({ ci: 7 })).problems).toEqual(['line 1: a result whose interval is not text'])
    // The last result stands where there are several.
    const twice = parseRegistry(`${line(registration)}\n${result({ verdict: 'failed', figure: '0' })}\n${result({ measuredAt: '2026-10-19T00:00:00Z' })}`)
    expect(registryRows(twice)[0]).toMatchObject({ verdict: 'held', figure: '1', measuredAt: '2026-10-19T00:00:00Z' })
  })
})
