// HOW FAST THE FORECAST'S TRAINING IS (V6 Stage 4, 13 October 2026), outside the test gate, which must
// stay quick. Runs the BUILT worker file -- the one the app starts (electron/forecast/trainWorker.ts,
// built beside the main process's index.js as forecastWorker.js) -- in a worker thread, and asks it for
// its self-test fit: boosting on a made-up problem of the rows and figures given.
//
//   npx electron-vite build --outDir dist/verify        # never out/, which the user's app runs from
//   node scripts/forecast-bench.mjs [dist/verify/main/forecastWorker.js] [rows] [figures]
//
// It reads and writes nothing, and reaches no network.

import path from 'node:path'
import { Worker } from 'node:worker_threads'

const file = path.resolve(process.argv[2] ?? 'dist/verify/main/forecastWorker.js')
const rows = Number(process.argv[3] ?? 200_000)
const cols = Number(process.argv[4] ?? 63)
const worker = new Worker(file)
const started = Date.now()
worker.once('message', (reply) => {
  if (!reply.ok) {
    console.error(`the worker failed: ${reply.error}`)
    process.exitCode = 1
  } else {
    const { trees, validLoss, baselineLoss, ms } = reply.result
    console.log(`${rows} rows x ${cols} figures: ${trees} trees in ${ms} ms in the worker (${Date.now() - started} ms round trip); held-back loss ${validLoss.toFixed(4)} against ${baselineLoss.toFixed(4)} for the mean`)
  }
  void worker.terminate()
})
worker.once('error', (error) => {
  console.error(`the worker could not start: ${error.message}`)
  process.exitCode = 1
})
worker.postMessage({ id: 1, task: 'selftest', rows, cols, seed: 7 })
