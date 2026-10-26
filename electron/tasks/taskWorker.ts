import { parentPort } from 'worker_threads'
import { runTask, type TaskRequest } from '../../shared/tasks'

// The tasks' worker (shared/tasks.ts; V8 Stage 1): a thread of its own for each task, started by
// electron/services/taskWorkerService.ts with a memory limit and killed at its deadline. It runs the named
// tasks and nothing else, and holds no key, reads no file and asks nothing on the network.

parentPort?.on('message', (request: TaskRequest) => {
  parentPort?.postMessage(runTask(request))
})
