import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, ExecutorConfig } from '../shared/ipc'
import type { ResearchStatus } from '../shared/research'

// THE RESEARCH FOLDER'S REPORTS, AS THE WINDOW BUILDS THEM (src/performance/researchReports.ts; V7.2-R Stage 2):
// the last completed hour once it has settled, the day before once 00:10 UTC has passed, each once, from the
// session report, the forecast's section and the paper side's standing. The three builders are the
// Performance page's own and are faked here: what is tested is when a report is due, what goes in it, and that
// a kept one is not built again.

vi.mock('../src/performance/sessionReport', () => ({
  buildSessionReport: vi.fn(async (kind: string, fromSec: number, _deps: unknown, toSec: number) => ({ kind, fromSec, toSec, passed: true, gates: [] })),
  sessionReportBrowserDeps: {}
}))
vi.mock('../src/ai-benchmark/experimentReport', () => ({
  forecastOver: vi.fn(async (span: { fromSec: number; toSec: number }) => ({ span })),
  experimentReportBrowserDeps: {}
}))
vi.mock('../src/performance/dailyReport', () => ({
  buildDailyReport: vi.fn(async (day: string) => ({ day })),
  dailyReportBrowserDeps: {}
}))

const at = (iso: string): number => Date.parse(iso) / 1000

function status(latestHour: string | null, latestDay: string | null): ResearchStatus {
  return { version: 'research-v1', dir: 'x', exportsDir: 'x/exports', exports: [], lastExport: null, nextExportAt: 0, latestHour, latestDay }
}

function trade(id: string, openedAt: number, result: { closedAt: number; pnlQuote: number } | null, overrides: Partial<ExecutorConfig> = {}): ExecutorConfig {
  return {
    id,
    name: id,
    type: 'position',
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    createdAt: openedAt,
    status: result === null ? 'active' : 'stopped',
    stoppedAt: result?.closedAt ?? null,
    keepPosition: false,
    mode: 'paper',
    params: { side: 'buy', amountQuote: 100 },
    forecast: { openedAt, ...(result === null ? {} : { result: { exit: 'take_profit', ...result } }) },
    ...overrides
  } as unknown as ExecutorConfig
}

async function module() {
  return import('../src/performance/researchReports')
}

beforeEach(() => vi.clearAllMocks())

describe('when a report is due', () => {
  it('builds the last hour once three minutes have passed, and the day before once ten minutes of the day have', async () => {
    const { dueHour, dueDay } = await module()
    expect(dueHour(at('2026-10-20T07:02:59Z'))).toEqual({ stamp: '2026-10-20-05', fromSec: at('2026-10-20T05:00:00Z'), toSec: at('2026-10-20T06:00:00Z') })
    expect(dueHour(at('2026-10-20T07:03:00Z'))).toEqual({ stamp: '2026-10-20-06', fromSec: at('2026-10-20T06:00:00Z'), toSec: at('2026-10-20T07:00:00Z') })
    expect(dueHour(at('2026-10-20T00:30:00Z')).stamp).toBe('2026-10-19-23')
    expect(dueDay(at('2026-10-20T00:09:59Z'))).toEqual({ stamp: '2026-10-18', fromSec: at('2026-10-18T00:00:00Z'), toSec: at('2026-10-19T00:00:00Z') })
    expect(dueDay(at('2026-10-20T00:10:00Z'))).toEqual({ stamp: '2026-10-19', fromSec: at('2026-10-19T00:00:00Z'), toSec: at('2026-10-20T00:00:00Z') })
  })
})

describe('a look', () => {
  function deps(kept: ResearchStatus, settings: Partial<AppSettings> = {}) {
    const written: { kind: 'hour' | 'day'; stamp: string; report: Record<string, unknown> }[] = []
    return {
      written,
      deps: {
        nowSec: () => at('2026-10-20T07:04:00Z'),
        status: async () => kept,
        write: async (request: { kind: 'hour' | 'day'; stamp: string; report: unknown }) => {
          written.push(request as (typeof written)[number])
          return { ok: true }
        },
        settings: async () => ({ executors: [], paperAccount: null, ...settings }) as AppSettings,
        session: {} as never,
        experiment: {} as never,
        daily: {} as never
      }
    }
  }

  it("writes the hour's and the day's where the folder holds neither, each over its own span", async () => {
    const { lookAtResearchReports } = await module()
    const { written, deps: d } = deps(status(null, null))
    expect(await lookAtResearchReports(d)).toEqual({ hour: '2026-10-20-06', day: '2026-10-19' })
    expect(written.map((entry) => [entry.kind, entry.stamp])).toEqual([
      ['hour', '2026-10-20-06'],
      ['day', '2026-10-19']
    ])
    const hour = written[0].report
    expect(hour).toMatchObject({ fromSec: at('2026-10-20T06:00:00Z'), toSec: at('2026-10-20T07:00:00Z'), session: { kind: 'hour', fromSec: at('2026-10-20T06:00:00Z'), toSec: at('2026-10-20T07:00:00Z') }, forecast: { span: { fromSec: at('2026-10-20T06:00:00Z'), toSec: at('2026-10-20T07:00:00Z') } } })
    expect(hour.paper).toMatchObject({ account: null, openPaper: 0 })
    expect(written[1].report).toMatchObject({ fromSec: at('2026-10-19T00:00:00Z'), toSec: at('2026-10-20T00:00:00Z'), daily: { day: '2026-10-19' }, forecast: { span: { fromSec: at('2026-10-19T00:00:00Z') } } })
  })

  it('writes nothing the folder holds already, and the newer of two where it holds an older one', async () => {
    const { lookAtResearchReports } = await module()
    const kept = deps(status('2026-10-20-06', '2026-10-19'))
    expect(await lookAtResearchReports(kept.deps)).toEqual({ hour: null, day: null })
    expect(kept.written).toEqual([])
    const older = deps(status('2026-10-20-05', '2026-10-18'))
    expect(await lookAtResearchReports(older.deps)).toEqual({ hour: '2026-10-20-06', day: '2026-10-19' })
  })

  it("keeps the day's report where the daily report could not be built, with the reason it is missing as null", async () => {
    const daily = await import('../src/performance/dailyReport')
    vi.mocked(daily.buildDailyReport).mockRejectedValueOnce(new Error('no records'))
    const { lookAtResearchReports } = await module()
    const { written, deps: d } = deps(status('2026-10-20-06', null))
    await lookAtResearchReports(d)
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ kind: 'day', report: { daily: null } })
  })
})

describe("the paper side's standing", () => {
  it("counts the forecast trader's trades opened and closed in the span, the start in and the end out, and its open ones", async () => {
    const { paperPerformanceOf } = await module()
    const from = at('2026-10-20T06:00:00Z')
    const to = at('2026-10-20T07:00:00Z')
    const executors = [
      trade('in', from, { closedAt: from + 600, pnlQuote: 0.5 }),
      trade('at start', from - 3600, { closedAt: from, pnlQuote: -0.2 }),
      trade('at end', from + 100, { closedAt: to, pnlQuote: 9 }),
      trade('open', to - 60, null),
      trade('mine', from, null, { forecast: undefined }),
      trade('live', from, null, { forecast: undefined, mode: 'live' })
    ]
    const standing = paperPerformanceOf({ executors, paperAccount: { balances: { USDT: 9_990 }, initialBalances: { USDT: 10_000 }, createdAt: 1, ledger: [] } as never }, from, to)
    expect(standing.forecastTrader).toMatchObject({ opened: 3, closed: 2, open: 1 })
    expect((standing.forecastTrader as { netQuote: number }).netQuote).toBeCloseTo(0.3, 10)
    expect(standing.account).toEqual({ balances: { USDT: 9_990 }, initialBalances: { USDT: 10_000 } })
    // The paper ones still open: the forecast trader's and a person's, not the live one.
    expect(standing.openPaper).toBe(2)
    expect(Array.isArray(standing.lab)).toBe(true)
  })
})
