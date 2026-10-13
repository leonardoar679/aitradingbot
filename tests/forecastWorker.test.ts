import { beforeEach, describe, expect, it, vi } from 'vitest'

// THE FORECAST'S WORKER, FROM THE MAIN PROCESS'S SIDE (electron/services/forecastWorkerService.ts): one
// request at a time, each answered by its id; a worker that dies fails what it was doing and is started
// again for the next. The worker is faked: it answers in its own time, or dies when told to.

const made = vi.hoisted(() => ({ workers: [] as { posted: { id: number; task: string; rows?: number }[]; emit: (event: string, value: unknown) => boolean }[], inFlight: 0, mostInFlight: 0 }))

vi.mock('worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWorker extends EventEmitter {
    posted: { id: number; task: string; rows?: number }[] = []
    constructor() {
      super()
      made.workers.push(this)
    }
    postMessage(message: { id: number; task: string; rows?: number }): void {
      this.posted.push(message)
      made.inFlight++
      made.mostInFlight = Math.max(made.mostInFlight, made.inFlight)
      const answered = (): void => void made.inFlight--
      // A row count of -1 kills the worker; otherwise it answers after a moment.
      if (message.rows === -1)
        setTimeout(() => {
          answered()
          this.emit('exit', 1)
        }, 5)
      else
        setTimeout(() => {
          answered()
          this.emit('message', { id: message.id, ok: true, result: { task: 'selftest', trees: message.rows, validLoss: 0, baselineLoss: 1, ms: 1 } })
        }, 5)
    }
    terminate(): Promise<number> {
      return Promise.resolve(0)
    }
  }
  return { Worker: FakeWorker }
})

beforeEach(() => {
  vi.resetModules()
  made.workers.length = 0
  made.inFlight = 0
  made.mostInFlight = 0
})

describe('the forecast worker', () => {
  it('answers each request by its id, one at a time, in the order asked', async () => {
    const { askWorker } = await import('../electron/services/forecastWorkerService')
    const answers = await Promise.all([1, 2, 3].map((rows) => askWorker({ task: 'selftest', rows, cols: 2, seed: 1 })))
    expect(answers.map((reply) => (reply.ok ? reply.result.trees : null))).toEqual([1, 2, 3])
    expect(made.workers).toHaveLength(1)
    expect(made.workers[0].posted.map((message) => message.id)).toEqual([1, 2, 3])
    // Each asked only once the one before it was answered.
    expect(made.mostInFlight).toBe(1)
  })

  it('fails what a dead worker was doing, and starts another for the next request', async () => {
    const { askWorker } = await import('../electron/services/forecastWorkerService')
    await expect(askWorker({ task: 'selftest', rows: -1, cols: 2, seed: 1 })).rejects.toThrow(/stopped/)
    const next = await askWorker({ task: 'selftest', rows: 7, cols: 2, seed: 1 })
    expect(next.ok && next.result.trees).toBe(7)
    expect(made.workers).toHaveLength(2)
  })
})
