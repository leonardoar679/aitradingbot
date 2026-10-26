// THE TASKS RUN AWAY FROM THE MAIN THREAD (V8 Stage 1, 26 October 2026).
//
// The main process carries the live-position watcher, the one piece of this app that has to fire a real exit
// on time, and from V8 it also reads text chosen by strangers: a pasted article's HTML, a trader's ten thousand
// fills. A pathological page or a heavy analysis on the main thread would delay that exit. So such work is a
// TASK: a pure function of its input, run in a worker thread of its own with a memory limit and a deadline
// (electron/tasks/taskWorker.ts, electron/services/taskWorkerService.ts), killed when it overruns either, the
// caller told why. Each task is named here; the worker runs only these.

export interface TaskTable {
  /** The host's own check: hands its input back. */
  echo: (payload: unknown) => unknown
}

export type TaskName = keyof TaskTable

export const TASKS: TaskTable = {
  echo: (payload) => payload
}

/** What a task's run came to. */
export type TaskOutcome = { ok: true; result: unknown } | { ok: false; reason: 'timeout' | 'memory' | 'error'; message: string }

/** A request to the worker, and its answer. */
export interface TaskRequest {
  id: number
  task: string
  payload: unknown
}
export interface TaskReply {
  id: number
  ok: boolean
  result?: unknown
  message?: string
}

/** Runs one named task on its input: what the worker does with each request. */
export function runTask(request: TaskRequest): TaskReply {
  if (!Object.prototype.hasOwnProperty.call(TASKS, request.task)) return { id: request.id, ok: false, message: `No task is named ${String(request.task).slice(0, 60)}` }
  try {
    return { id: request.id, ok: true, result: TASKS[request.task as TaskName](request.payload) }
  } catch (error) {
    return { id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** A task's limits: how long and how much memory it may take. */
export interface TaskLimits {
  timeoutMs: number
  maxOldGenerationSizeMb: number
}

/** The limits a task runs under unless it is given its own (pinned: ENGINE_CONSTANTS.tasks). */
export const TASK_LINES = {
  version: 'tasks-v1',
  defaultTimeoutMs: 2000,
  defaultMaxOldGenerationSizeMb: 256
} as const
