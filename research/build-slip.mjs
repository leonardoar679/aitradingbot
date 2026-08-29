// Builds a research bundle with SLIPPAGE_RATE overridden from the SLIP env var, WITHOUT editing
// shared/fees.ts.
//
// Why this exists: the interval question below 15m turns on what the extra fills cost, and
// SLIPPAGE_RATE is flat and interval-blind -- 2bps per side at 1d and at 3m alike. fees.ts says so
// against itself: "a strategy whose edge is thinner than a few tenths of a percent per trade should
// not be trusted on the strength of a backtest that used this constant." Testing that means
// re-running at several slippage levels, and a build-time rewrite does it while leaving the shipped
// constant untouched. Patching the real file and forgetting to revert is exactly the silent
// contamination this directory exists to avoid.
//
// VALIDATION: SLIP=0.0002 must reproduce the committed numbers exactly, and a raised SLIP must
// actually move them. Both are checked before anything built here is believed -- an override that
// silently misses its target reports the baseline forever and looks like "slippage does not matter".
import { build } from 'esbuild'
import { readFileSync } from 'fs'

const SLIP = process.env.SLIP || '0.0002'
const ENTRY = process.env.ENTRY || 'research/ivfair.ts'
const OUT = process.env.OUT || 'research/.ivfair-slip.mjs'
const NEEDLE = 'export const SLIPPAGE_RATE = 0.0002'

let hits = 0
const override = {
  name: 'slippage-override',
  setup(b) {
    b.onLoad({ filter: /fees\.ts$/ }, (args) => {
      const src = readFileSync(args.path, 'utf-8')
      if (!src.includes(NEEDLE)) return null
      hits++
      return { contents: src.replace(NEEDLE, 'export const SLIPPAGE_RATE = ' + SLIP), loader: 'ts' }
    })
  }
}

await build({
  entryPoints: [ENTRY], bundle: true, platform: 'node', format: 'esm',
  outfile: OUT, plugins: [override], logLevel: 'error'
})
if (hits !== 1) {
  console.error('FATAL: slippage override rewrote ' + hits + ' files, expected exactly 1')
  process.exit(1)
}
console.error('built ' + OUT + ' with SLIPPAGE_RATE=' + SLIP)
