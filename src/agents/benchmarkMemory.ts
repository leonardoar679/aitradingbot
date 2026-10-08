import type { EventBenchmarkRow } from '../../shared/aiEventBenchmark'

// WHAT THE LAST BENCHMARK SAID OF EACH MODEL, KEPT FOR THE SESSION. The promotion checklist
// (shared/modelHealth.ts) has one line that sets the live board's sign against the benchmark's,
// and a benchmark is scored on the Benchmark tab, from candles, when a person asks for one. The
// view remembers its model rows here as it scores them, and the registry reads them. Nothing is
// written to disk: with no benchmark scored this session, the line says so.

export interface BenchmarkMemory {
  meanNetPct: number | null
  closed: number
  /** When it was scored, in seconds. */
  at: number
}

const remembered = new Map<string, BenchmarkMemory>()

export function rememberBenchmark(rows: readonly Pick<EventBenchmarkRow, 'name' | 'meanNetPct' | 'closed'>[], nowSec: number): void {
  for (const row of rows) remembered.set(row.name, { meanNetPct: row.meanNetPct, closed: row.closed, at: nowSec })
}

export function benchmarkRemembered(model: string): BenchmarkMemory | null {
  return remembered.get(model) ?? null
}

/** Test seam. */
export function forgetBenchmarks(): void {
  remembered.clear()
}
