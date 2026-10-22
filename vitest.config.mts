import { defineConfig } from 'vitest/config'

// At most half the machine's cores run test files at once. On 13 October 2026, with every core (27
// worker processes on a 28-core machine), a test file's worker now and then exited mid-run ("Worker
// exited unexpectedly", its tests never reported) and a disk-heavy test ran ten times its usual time;
// at half the cores neither happened, and the suite took as long.
// A test is allowed fifteen seconds, not vitest's five (22 October 2026): the heaviest -- a run calibration built and
// read back, a refit's walk forward -- take about two seconds alone and passed five under a machine also running a
// virtual machine and a check run of the app, failing a different one each time. A test that hangs still fails.
export default defineConfig({
  test: {
    maxWorkers: '50%',
    testTimeout: 15_000
  }
})
