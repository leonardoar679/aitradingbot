import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// electron/services/experimentRunService.ts: a run's record and clock in the main process, with the
// file in a temporary folder and the app's state faked. It asks nothing and changes no setting.

const rig = vi.hoisted(() => ({
  config: { watch: { enabled: true, confirmLive: false, models: ['openai/gpt-5-mini'] }, watchPaper: { enabled: true } },
  effective: { configVersion: 'cfg-1', engineVersion: 'eng-1' },
  universe: 60,
  sent: [] as { channel: string; run: { id: string; status: string } }[],
  timers: [] as number[]
}))
vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))
vi.mock('../electron/services/aiConfigService', () => ({ getAiConfig: async () => rig.config }))
vi.mock('../electron/services/effectiveConfigService', () => ({ getEffectiveConfig: async () => rig.effective }))
vi.mock('../electron/services/marketScannerService', () => ({ getScannerState: async () => ({ config: { universeSize: rig.universe } }) }))

import { fileExperimentReport, listExperimentRuns, startExperimentRun, startExperimentRunService, stopExperimentRun, stopExperimentRunService, tickExperimentRuns } from '../electron/services/experimentRunService'

const window = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, run: { id: string; status: string }) => void rig.sent.push({ channel, run: { id: run.id, status: run.status } }) }
}

beforeEach(() => {
  process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'experiment-runs-'))
  rig.sent.length = 0
  // The clock alone is faked: the file is read and written for real.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-08T12:00:00Z'))
})

afterEach(() => {
  stopExperimentRunService()
  vi.useRealTimers()
})

describe('a run in the main process', () => {
  it('is written down with what the app is as it starts, one line on file, and told to the window', async () => {
    const run = await startExperimentRun({ kind: 'shadow-1h' })
    expect(run).toMatchObject({ id: 'run-2026-10-08-1200', kind: 'shadow-1h', minutes: 60, startedAt: 1791460800, endsAt: 1791460800 + 3600, mode: 'PAPER', models: ['openai/gpt-5-mini'], universe: 60, status: 'running' })
    expect(run.versions).toMatchObject({ config: 'cfg-1', engine: 'eng-1', detector: 'events-v2' })
    expect(run.versions.prompt).not.toBe('')
    const lines = readFileSync(join(process.env.AI_TEST_USER_DATA as string, 'aiExperiments', 'runs.jsonl'), 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect((await listExperimentRuns()).rows).toEqual([run])
  })

  it('refuses a second run while one is running, and a custom run takes its minutes within the bounds', async () => {
    await startExperimentRun({ kind: 'custom', minutes: 5 })
    await expect(startExperimentRun({ kind: 'shadow-1h' })).rejects.toThrow(/A run is still going: run-2026-10-08-1200, until 12:05 UTC/)
    const { rows } = await listExperimentRuns()
    expect(rows).toHaveLength(1)
    expect(rows[0].minutes).toBe(5)
  })

  it('reads as ended once its end has passed, and the tick writes that down once and tells the window', async () => {
    startExperimentRunService(window as never)
    await startExperimentRun({ kind: 'custom', minutes: 3 })
    rig.sent.length = 0
    // Before the end, the tick writes nothing.
    await tickExperimentRuns()
    expect(rig.sent).toEqual([])
    vi.setSystemTime(new Date('2026-10-08T12:03:00Z'))
    expect((await listExperimentRuns()).rows[0].status).toBe('ended')
    await tickExperimentRuns()
    await tickExperimentRuns()
    expect(rig.sent.map((entry) => entry.run.status)).toEqual(['ended'])
    const lines = readFileSync(join(process.env.AI_TEST_USER_DATA as string, 'aiExperiments', 'runs.jsonl'), 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    // A new run may start once the earlier has ended.
    const next = await startExperimentRun({ kind: 'paper-12h' })
    expect(next.id).toBe('run-2026-10-08-1203')
  })

  it('files a report on an ended run once, refuses one on a running run, and keeps the first filed', async () => {
    const run = await startExperimentRun({ kind: 'custom', minutes: 3 })
    await expect(fileExperimentReport(run.id, { version: 'x' })).rejects.toThrow(/still running/)
    vi.setSystemTime(new Date('2026-10-08T12:04:00Z'))
    const reported = await fileExperimentReport(run.id, { version: 'experiment-run-v1', verdict: 'NOT ENOUGH TRADES' })
    expect(reported?.status).toBe('reported')
    expect(reported?.report).toEqual({ version: 'experiment-run-v1', verdict: 'NOT ENOUGH TRADES' })
    expect(reported?.reportedAt).toBe(1791460800 + 240)
    const again = await fileExperimentReport(run.id, { version: 'other' })
    expect(again?.report).toEqual({ version: 'experiment-run-v1', verdict: 'NOT ENOUGH TRADES' })
    expect(await fileExperimentReport('no-such-run', {})).toBeNull()
    expect((await listExperimentRuns()).rows[0].status).toBe('reported')
  })

  it('is stopped early, and then reads as stopped with the moment on it', async () => {
    const run = await startExperimentRun({ kind: 'shadow-1h' })
    vi.setSystemTime(new Date('2026-10-08T12:10:00Z'))
    const stopped = await stopExperimentRun(run.id)
    expect(stopped).toMatchObject({ status: 'stopped', stoppedAt: 1791460800 + 600 })
    expect((await listExperimentRuns()).rows[0].status).toBe('stopped')
    expect(await stopExperimentRun('no-such-run')).toBeNull()
    // Stopping it again, later, changes nothing: the moment it was stopped stands.
    vi.setSystemTime(new Date('2026-10-08T12:20:00Z'))
    expect(await stopExperimentRun(run.id)).toMatchObject({ status: 'stopped', stoppedAt: 1791460800 + 600 })
    expect((await listExperimentRuns()).rows[0].stoppedAt).toBe(1791460800 + 600)
  })
})
