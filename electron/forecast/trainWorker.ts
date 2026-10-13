import { parentPort } from 'worker_threads'
import { binMatrix, fitCuts, rngOf, type Matrix } from '../../shared/forecast/ml/bins'
import { fitGbt, lossOf, predictGbt } from '../../shared/forecast/ml/gbt'

// THE FORECAST'S TRAINING, OFF THE MAIN THREAD (the V6 document, §13 and §51; V6 Stage 4, 13 October
// 2026). Fitting trees on hundreds of thousands of rows takes seconds to minutes of one core; done in
// the main process it would hold up every socket, timer and window message for as long. So it runs
// here, in a worker thread of its own, built as its own file beside the main process's
// (electron.vite.config.ts), and talks to it in messages: a request with an id, a reply with the same.
//
// IT TRAINS ON PUBLIC MARKET DATA AND NOTHING ELSE. No key, no model of anyone else's, no order, no
// network: it is handed what to fit, or the files to read, and hands back what it fitted.

export type WorkerRequest = { id: number; task: 'selftest'; rows: number; cols: number; seed: number }

export type WorkerReply =
  | { id: number; ok: true; result: { task: 'selftest'; trees: number; validLoss: number; baselineLoss: number; ms: number } }
  | { id: number; ok: false; error: string }

/** A fit on a made-up problem, to show that the worker runs, and how fast: y = sin(x0) + noise growing
 * with x1, the L2 boosting's loss on held-back rows against predicting the mean. */
function selftest(rows: number, cols: number, seed: number): { trees: number; validLoss: number; baselineLoss: number; ms: number } {
  const started = Date.now()
  const random = rngOf(seed)
  const make = (count: number): { matrix: Matrix; y: Float64Array } => {
    const data = new Float64Array(count * cols)
    const y = new Float64Array(count)
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < cols; col++) data[row * cols + col] = random() * 4 - 2
      y[row] = Math.sin(2 * data[row * cols]) + (random() - 0.5) * (0.2 + 0.5 * Math.abs(data[row * cols + 1]))
    }
    return { matrix: { rows: count, cols, data }, y }
  }
  const train = make(rows)
  const valid = make(Math.max(1, Math.floor(rows / 4)))
  const cuts = fitCuts(train.matrix)
  const model = fitGbt(binMatrix(train.matrix, cuts), train.y, binMatrix(valid.matrix, cuts), valid.y, { kind: 'l2' }, {
    trees: 100,
    learningRate: 0.1,
    maxDepth: 4,
    minLeafRows: 20,
    minLeafHessian: 1,
    lambda: 1,
    minGain: 0,
    featureFraction: 1,
    featureSampling: 'tree',
    subsample: 0.8,
    patience: 10,
    seed
  })
  const mean = train.y.reduce((sum, value) => sum + value, 0) / train.y.length
  let loss = 0
  let baseline = 0
  for (let row = 0; row < valid.matrix.rows; row++) {
    loss += lossOf({ kind: 'l2' }, valid.y[row], predictGbt(model, valid.matrix.data, row * valid.matrix.cols))
    baseline += lossOf({ kind: 'l2' }, valid.y[row], mean)
  }
  return { trees: model.trees.length, validLoss: loss / valid.matrix.rows, baselineLoss: baseline / valid.matrix.rows, ms: Date.now() - started }
}

parentPort?.on('message', (request: WorkerRequest) => {
  try {
    if (request.task === 'selftest') {
      parentPort?.postMessage({ id: request.id, ok: true, result: { task: 'selftest', ...selftest(request.rows, Math.max(2, request.cols), request.seed) } } satisfies WorkerReply)
      return
    }
    parentPort?.postMessage({ id: (request as { id: number }).id, ok: false, error: 'unknown task' } satisfies WorkerReply)
  } catch (error) {
    parentPort?.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies WorkerReply)
  }
})
