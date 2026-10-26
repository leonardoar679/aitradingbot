import { join } from 'path'
import { Worker } from 'worker_threads'
import { TASK_LINES, type TaskLimits, type TaskName, type TaskOutcome, type TaskReply } from '../../shared/tasks'

// THE TASKS' WORKERS, FROM THE MAIN PROCESS'S SIDE (shared/tasks.ts; V8 Stage 1). Each task runs in a worker
// thread started for it alone, under a memory limit (resourceLimits) and a deadline: a task that overruns its
// time is killed and the caller told "timeout"; one that runs out of memory dies and the caller is told
// "memory". The worker is ended once it has answered. One task's worker is never another's, so a page that
// broke one extraction cannot slow the next.

/** How a worker is made: the built file beside the main process's own, or, in a test, one made from code. */
export const taskWorkerSeam = {
  make: (limits: TaskLimits): Worker => new Worker(join(__dirname, 'taskWorker.js'), { resourceLimits: { maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb } })
}

let nextId = 1

/** Runs one task in a worker of its own, within its limits. Never throws: the outcome says what happened. */
export function runInWorker(task: TaskName, payload: unknown, limits: Partial<TaskLimits> = {}): Promise<TaskOutcome> {
  const resolved: TaskLimits = {
    timeoutMs: limits.timeoutMs ?? TASK_LINES.defaultTimeoutMs,
    maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb ?? TASK_LINES.defaultMaxOldGenerationSizeMb
  }
  return new Promise<TaskOutcome>((resolve) => {
    let settled = false
    let worker: Worker
    try {
      worker = taskWorkerSeam.make(resolved)
    } catch (error) {
      resolve({ ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) })
      return
    }
    const id = nextId++
    const finish = (outcome: TaskOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(outcome)
    }
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', message: `${task} took longer than ${resolved.timeoutMs} ms and was stopped` }), resolved.timeoutMs)
    worker.on('message', (reply: TaskReply) => {
      if (reply.id !== id) return
      finish(reply.ok ? { ok: true, result: reply.result } : { ok: false, reason: 'error', message: reply.message ?? 'the task failed' })
    })
    worker.on('error', (error: Error & { code?: string }) => {
      const memory = error.code === 'ERR_WORKER_OUT_OF_MEMORY'
      finish({ ok: false, reason: memory ? 'memory' : 'error', message: memory ? `${task} ran out of its ${resolved.maxOldGenerationSizeMb} MB and was stopped` : error.message })
    })
    worker.on('exit', (code) => finish({ ok: false, reason: 'error', message: `the task's worker stopped (exit ${code}) before it answered` }))
    worker.postMessage({ id, task, payload })
  })
}
