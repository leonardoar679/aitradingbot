import { defineConfig } from 'vitest/config'

// At most half the machine's cores run test files at once. On 13 October 2026, with every core (27
// worker processes on a 28-core machine), a test file's worker now and then exited mid-run ("Worker
// exited unexpectedly", its tests never reported) and a disk-heavy test ran ten times its usual time;
// at half the cores neither happened, and the suite took as long.
export default defineConfig({
  test: {
    maxWorkers: '50%'
  }
})
