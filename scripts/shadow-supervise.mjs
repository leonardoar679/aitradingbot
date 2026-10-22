// A SHADOW RUN SEEN THROUGH TO ITS END (22 October 2026). scripts/shadow-run.mjs runs the app for its minutes on a
// scratch profile, then writes its reports and the research export; a run whose app is gone before then -- closed by a
// person, the OS, or a crash -- ends without them, its segment left open in segments.json. This runs it, and while
// the last segment ended without the run's end and resumes are left, resumes it on its own profile (RESUME=1), which
// carries on with the minutes not yet run. Every attempt's environment is the same but RESUME, so a run copied from
// a profile keeps that profile's own setup.
//
//   RUN_NAME=day RUN_MINUTES=720 [MAX_RESUMES=6] [... shadow-run.mjs's own] node scripts/shadow-supervise.mjs
//   RUN_NAME=day RESUME=1 node scripts/shadow-supervise.mjs     # a run already begun: resumed from the first attempt
//
// It asks nothing and places nothing; what each attempt does is shadow-run.mjs's.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUN_NAME = process.env.RUN_NAME ?? 'shadow'
const SHADOW_ROOT = path.resolve(process.env.SHADOW_ROOT ?? path.join(os.tmpdir(), 'traderspider-shadow'))
const SEGMENTS = path.join(SHADOW_ROOT, `${RUN_NAME}-out`, 'segments.json')
const MAX_RESUMES = Number(process.env.MAX_RESUMES ?? 6)
if (!Number.isInteger(MAX_RESUMES) || MAX_RESUMES < 0) throw new Error(`MAX_RESUMES must be a whole number: ${process.env.MAX_RESUMES}`)

const say = (text) => console.log(`[supervise ${new Date().toISOString().slice(11, 19)}] ${text}`)

function attempt(resume) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...(resume ? { RESUME: '1' } : {}) }
    const child = spawn(process.execPath, [path.join(HERE, 'shadow-run.mjs')], { env, stdio: 'inherit' })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

/** The last segment, as the run wrote it; null where there is none. */
function lastSegment() {
  try {
    const segments = JSON.parse(fs.readFileSync(SEGMENTS, 'utf8'))
    return Array.isArray(segments) && segments.length > 0 ? segments[segments.length - 1] : null
  } catch {
    return null
  }
}

let resume = process.env.RESUME === '1'
for (let resumes = 0; ; resumes++) {
  const code = await attempt(resume)
  const last = lastSegment()
  if (last !== null && typeof last.endedAt === 'number') {
    say(`run ${RUN_NAME} reached its end in segment ${last.n} (exit ${code}${resumes > 0 ? `, after ${resumes} resume${resumes === 1 ? '' : 's'}` : ''})`)
    process.exit(code)
  }
  if (last === null) {
    say(`run ${RUN_NAME} wrote no segment (exit ${code}): nothing to resume`)
    process.exit(code === 0 ? 1 : code)
  }
  if (resumes >= MAX_RESUMES) {
    say(`run ${RUN_NAME}: segment ${last.n} ended without the run's end, and the ${MAX_RESUMES} resumes are spent`)
    process.exit(1)
  }
  say(`run ${RUN_NAME}: segment ${last.n} ended without the run's end (the app was gone; exit ${code}); resuming`)
  resume = true
}
