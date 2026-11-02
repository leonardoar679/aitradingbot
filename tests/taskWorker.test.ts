import { Worker } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TASKS, TASK_LINES, runTask } from '../shared/tasks'
import { runInWorker, taskWorkerSeam } from '../electron/services/taskWorkerService'

// THE TASKS RUN AWAY FROM THE MAIN THREAD (shared/tasks.ts; V8 Stage 1): each in a worker of its own, killed at
// its deadline or when it runs out of its memory, the caller told which; the worker runs only the tasks named.

const ROOT = join(__dirname, '..')
const real = taskWorkerSeam.make

/** A worker made from code: `body` handles each request as `request`, answering with `reply(value)`. */
function evalWorker(body: string): (limits: { maxOldGenerationSizeMb: number }) => Worker {
  return (limits) =>
    new Worker(
      `const { parentPort } = require('node:worker_threads');
       parentPort.on('message', (request) => { const reply = (result) => parentPort.postMessage({ id: request.id, ok: true, result }); ${body} });`,
      { eval: true, resourceLimits: { maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb } }
    )
}

afterEach(() => {
  taskWorkerSeam.make = real
})

describe('the tasks', () => {
  it('runs a named task on its input, and refuses a name that is not one', () => {
    expect(runTask({ id: 1, task: 'echo', payload: { a: 1 } })).toEqual({ id: 1, ok: true, result: { a: 1 } })
    expect(runTask({ id: 2, task: 'toString', payload: null })).toEqual({ id: 2, ok: false, message: 'No task is named toString' })
    expect(runTask({ id: 3, task: '__proto__', payload: null }).ok).toBe(false)
    // Since V8 Stage 4 a pasted article's page is read in the worker too, and since Stage 10 a pair's ninety days.
    expect(Object.keys(TASKS)).toEqual(['echo', 'extractArticle', 'traderTests', 'traderFile', 'pairRates'])
  })

  it('says what failed when a task throws', () => {
    const was = TASKS.echo
    try {
      TASKS.echo = () => {
        throw new Error('bad input')
      }
      expect(runTask({ id: 4, task: 'echo', payload: null })).toEqual({ id: 4, ok: false, message: 'bad input' })
    } finally {
      TASKS.echo = was
    }
  })
})

describe('a task in its worker', () => {
  it('answers, and its worker ends', async () => {
    taskWorkerSeam.make = evalWorker('reply(request.payload)')
    expect(await runInWorker('echo', [1, 2, 3])).toEqual({ ok: true, result: [1, 2, 3] })
  })

  it('is stopped at its deadline, and the caller told so', async () => {
    taskWorkerSeam.make = evalWorker('for (;;) {}')
    const started = Date.now()
    const outcome = await runInWorker('echo', null, { timeoutMs: 300 })
    expect(outcome).toEqual({ ok: false, reason: 'timeout', message: 'echo took longer than 300 ms and was stopped' })
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('dies when it runs out of its memory, and the caller is told that, not a timeout', async () => {
    taskWorkerSeam.make = evalWorker('const hold = []; for (;;) hold.push(new Array(100000).fill(Math.random()))')
    const outcome = await runInWorker('echo', null, { timeoutMs: 30_000, maxOldGenerationSizeMb: 16 })
    expect(outcome).toMatchObject({ ok: false, reason: 'memory' })
  }, 40_000)

  it("says a task's own failure, and that a worker which could not start did not", async () => {
    taskWorkerSeam.make = () =>
      new Worker(`const { parentPort } = require('node:worker_threads'); parentPort.on('message', (r) => parentPort.postMessage({ id: r.id, ok: false, message: 'no' }))`, { eval: true })
    expect(await runInWorker('echo', null)).toEqual({ ok: false, reason: 'error', message: 'no' })
    taskWorkerSeam.make = () => {
      throw new Error('cannot start')
    }
    expect(await runInWorker('echo', null)).toEqual({ ok: false, reason: 'error', message: 'cannot start' })
  })

  it('runs under the pinned limits unless given its own', () => {
    expect(TASK_LINES).toEqual({ version: 'tasks-v1', defaultTimeoutMs: 2000, defaultMaxOldGenerationSizeMb: 256 })
    const config = readFileSync(join(ROOT, 'electron.vite.config.ts'), 'utf-8')
    expect(config).toMatch(/taskWorker: resolve\(__dirname, 'electron\/tasks\/taskWorker\.ts'\)/)
  })
})

describe('the worker, as written', () => {
  it('runs the named tasks and imports nothing that reads a key, a file or the network', () => {
    const source = readFileSync(join(ROOT, 'electron', 'tasks', 'taskWorker.ts'), 'utf-8')
    expect([...source.matchAll(/from '([^']+)'/g)].map((match) => match[1])).toEqual(['worker_threads', '../../shared/tasks'])
    const tasks = readFileSync(join(ROOT, 'shared', 'tasks.ts'), 'utf-8')
    expect(tasks).not.toMatch(/\bfetch\(|node:fs|from 'fs'|credentials/)
  })
})
