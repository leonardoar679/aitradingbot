// PRE-REGISTRATION (V7.2 Stage 3, 17 October 2026). Every line the engine judges by has been a pinned
// constant under the engine version since V4, and every stage has written its success line before
// measuring; but nothing bound a hypothesis to the record it would be judged on, or a result to the
// registration it answers, and a line could be moved after a figure was seen with nothing to say so.
// research/preregistered.jsonl is that binding: an append-only file of REGISTRATION lines -- an id, when
// it was registered and under which engine version, the hypothesis, the metric, the success line, the
// record it is judged on, whether it is confirmatory (one cell per horizon per cycle) or exploratory, and
// the engine constants it names -- and RESULT lines, each carrying the hash of its registration's
// pre-result fields, the figure with its interval, the verdict and the commit. The hash is the lock: a
// registration edited after its result was written no longer hashes to what the result holds, and the
// test refuses it (tests/preregistration.test.ts), as it refuses a duplicate id, a result without a
// registration, and an engine constant added since 16 October 2026 that no registration names and the
// infrastructure list does not hold. The Lab shows the registry; the report cites its ids. Arithmetic on
// text: no key, no model, no order.

export const PREREGISTRATION_VERSION = 'preregistration-v1'

export type RegistrationKind = 'confirmatory' | 'exploratory'
export type Verdict = 'held' | 'failed' | 'not measured'

export interface Registration {
  line: 'registration'
  id: string
  /** ISO 8601, UTC. */
  registeredAt: string
  engineVersion: string
  hypothesis: string
  metric: string
  successLine: string
  /** The record the line is judged on. */
  judgedOn: string
  kind: RegistrationKind
  /** The paths under ENGINE_CONSTANTS this registration names (e.g. forecast.challenger.newerDays). */
  constants?: string[]
}

export interface Result {
  line: 'result'
  id: string
  measuredAt: string
  figure: string
  ci?: string | null
  verdict: Verdict
  commit: string
  /** The hash of the registration's pre-result fields as they stood when the result was written. */
  registrationHash: string
}

export type RegistryLine = Registration | Result

export interface Registry {
  registrations: Registration[]
  results: Result[]
  /** Lines that are not a registration or a result, by line number. */
  problems: string[]
}

export type Hash = (text: string) => string

/** The fields a result locks: everything a registration says before any figure. */
export const HASHED_FIELDS = ['id', 'registeredAt', 'engineVersion', 'hypothesis', 'metric', 'successLine', 'judgedOn', 'kind'] as const

const KINDS: readonly string[] = ['confirmatory', 'exploratory']
const VERDICTS: readonly string[] = ['held', 'failed', 'not measured']
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** The first twelve hex characters of the hash of the registration's locked fields, in a fixed order. */
export function registrationHash(registration: Registration, sha256: Hash): string {
  return sha256(JSON.stringify(HASHED_FIELDS.map((field) => [field, registration[field]]))).slice(0, 12)
}

function readRegistration(raw: Record<string, unknown>, at: number, problems: string[]): Registration | null {
  for (const field of HASHED_FIELDS) {
    if (!isText(raw[field])) {
      problems.push(`line ${at}: a registration without ${field}`)
      return null
    }
  }
  if (!KINDS.includes(raw.kind as string)) {
    problems.push(`line ${at}: a registration of kind ${String(raw.kind)}`)
    return null
  }
  if (raw.constants !== undefined && !(Array.isArray(raw.constants) && raw.constants.every(isText))) {
    problems.push(`line ${at}: a registration whose constants are not names`)
    return null
  }
  return {
    line: 'registration',
    id: raw.id as string,
    registeredAt: raw.registeredAt as string,
    engineVersion: raw.engineVersion as string,
    hypothesis: raw.hypothesis as string,
    metric: raw.metric as string,
    successLine: raw.successLine as string,
    judgedOn: raw.judgedOn as string,
    kind: raw.kind as RegistrationKind,
    ...(raw.constants === undefined ? {} : { constants: raw.constants as string[] })
  }
}

function readResult(raw: Record<string, unknown>, at: number, problems: string[]): Result | null {
  for (const field of ['id', 'measuredAt', 'figure', 'commit', 'registrationHash'] as const) {
    if (!isText(raw[field])) {
      problems.push(`line ${at}: a result without ${field}`)
      return null
    }
  }
  if (!VERDICTS.includes(raw.verdict as string)) {
    problems.push(`line ${at}: a result with the verdict ${String(raw.verdict)}`)
    return null
  }
  if (raw.ci !== undefined && raw.ci !== null && typeof raw.ci !== 'string') {
    problems.push(`line ${at}: a result whose interval is not text`)
    return null
  }
  return { line: 'result', id: raw.id as string, measuredAt: raw.measuredAt as string, figure: raw.figure as string, ...(raw.ci === undefined ? {} : { ci: raw.ci as string | null }), verdict: raw.verdict as Verdict, commit: raw.commit as string, registrationHash: raw.registrationHash as string }
}

/** The registry from its file's text: one JSON object a line, blank lines and lines starting with # left out. */
export function parseRegistry(text: string): Registry {
  const registry: Registry = { registrations: [], results: [], problems: [] }
  const lines = text.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    const at = index + 1
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      registry.problems.push(`line ${at}: not JSON`)
      continue
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      registry.problems.push(`line ${at}: not an object`)
      continue
    }
    const entry = raw as Record<string, unknown>
    if (entry.line === 'registration') {
      const made = readRegistration(entry, at, registry.problems)
      if (made !== null) registry.registrations.push(made)
    } else if (entry.line === 'result') {
      const made = readResult(entry, at, registry.problems)
      if (made !== null) registry.results.push(made)
    } else {
      registry.problems.push(`line ${at}: neither a registration nor a result`)
    }
  }
  return registry
}

/** What is wrong with a registry: its parse problems, a duplicate id, a result without a registration, and
 * a result whose registration no longer hashes to what it holds -- the lock. Empty where nothing is. */
export function checkRegistry(registry: Registry, sha256: Hash): string[] {
  const problems = [...registry.problems]
  const seen = new Map<string, Registration>()
  for (const registration of registry.registrations) {
    if (seen.has(registration.id)) problems.push(`${registration.id}: registered twice`)
    seen.set(registration.id, registration)
  }
  for (const result of registry.results) {
    const registration = seen.get(result.id)
    if (registration === undefined) {
      problems.push(`${result.id}: a result without a registration`)
      continue
    }
    const hash = registrationHash(registration, sha256)
    if (hash !== result.registrationHash) problems.push(`${result.id}: the registration was changed after its result (hash ${hash}, the result holds ${result.registrationHash})`)
  }
  return problems
}

export interface RegistryRow {
  id: string
  kind: RegistrationKind
  registeredAt: string
  engineVersion: string
  hypothesis: string
  successLine: string
  judgedOn: string
  /** The last result on file, or nothing yet. */
  measuredAt: string | null
  figure: string | null
  ci: string | null
  verdict: Verdict | null
  commit: string | null
}

/** Each registration in the file's order with its last result. */
export function registryRows(registry: Registry): RegistryRow[] {
  return registry.registrations.map((registration) => {
    const results = registry.results.filter((result) => result.id === registration.id)
    const last = results.length === 0 ? null : results[results.length - 1]
    return {
      id: registration.id,
      kind: registration.kind,
      registeredAt: registration.registeredAt,
      engineVersion: registration.engineVersion,
      hypothesis: registration.hypothesis,
      successLine: registration.successLine,
      judgedOn: registration.judgedOn,
      measuredAt: last?.measuredAt ?? null,
      figure: last?.figure ?? null,
      ci: last?.ci ?? null,
      verdict: last?.verdict ?? null,
      commit: last?.commit ?? null
    }
  })
}
