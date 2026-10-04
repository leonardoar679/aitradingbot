// Re-exported, not defined here. The implementation lives in shared/aggregateCandles.ts so that
// shared/aiContext.ts can build the 1h and 4h views a model is shown from the same aggregation the
// exchange adapters use -- shared/ cannot import from electron/. Every existing importer of this
// module keeps working.
export { aggregateCandles, bucketTimeFor } from '../../../shared/aggregateCandles'
