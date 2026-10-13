import { join } from 'path'
import { Worker } from 'worker_threads'
import type { WorkerReply, WorkerRequest } from '../forecast/trainWorker'

// THE FORECAST'S WORKER, FROM THE MAIN PROCESS'S SIDE (V6 Stages 4-5, 13 October 2026): started when
// first asked for, one request at a time in the order asked, each answered by its id, with what it is
// doing told on the way. A worker that dies fails what it was doing and is started again for the next
// request; it is never left half working. The worker is electron/forecast/trainWorker.ts, built beside
// the main process's own file.

export type WorkerProgress = Extract<WorkerReply, { progress: unknown }>['progress']
export type WorkerAnswer = Exclude<WorkerReply, { progress: unknown }>

type Pending = { resolve: (reply: WorkerAnswer) => void; reject: (error: Error) => void; onProgress?: (progress: WorkerProgress) => void }

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()
let queue: Promise<unknown> = Promise.resolve()

function workerPath(): string {
  return join(__dirname, 'forecastWorker.js')
}

function ensureWorker(): Worker {
  if (worker !== null) return worker
  const started = new Worker(workerPath())
  started.on('message', (reply: WorkerReply) => {
    const waiting = pending.get(reply.id)
    if (waiting === undefined) return
    if ('progress' in reply) {
      waiting.onProgress?.(reply.progress)
      return
    }
    pending.delete(reply.id)
    waiting.resolve(reply)
  })
  const fail = (error: Error): void => {
    for (const waiting of pending.values()) waiting.reject(error)
    pending.clear()
    if (worker === started) worker = null
  }
  started.on('error', fail)
  started.on('exit', (code) => fail(new Error(`the forecast worker stopped (exit ${code})`)))
  worker = started
  return started
}

type RequestWithoutId = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

/** Asks the worker one thing, after whatever was asked before it has been answered. */
export function askWorker(request: RequestWithoutId, onProgress?: (progress: WorkerProgress) => void): Promise<WorkerAnswer> {
  const run = async (): Promise<WorkerAnswer> => {
    const id = nextId++
    const target = ensureWorker()
    return new Promise<WorkerAnswer>((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress })
      target.postMessage({ ...request, id } as WorkerRequest)
    })
  }
  const result = queue.then(run, run)
  queue = result.catch(() => undefined)
  return result
}

/** Stops the worker, failing what it was doing (the app quitting). */
export function stopForecastWorker(): void {
  const current = worker
  worker = null
  void current?.terminate()
}
