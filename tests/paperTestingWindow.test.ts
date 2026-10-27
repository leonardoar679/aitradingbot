import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutorConfig } from '../shared/ipc'

// STOP PAPER TESTING, IN THE WINDOW (src/trading/paperTesting.ts; V8 Stage 9): the books stopped and their switches put
// back first, by the main process; then each book's open trades closed by the writer that opened them, one writer's
// failure not the others'; and a Stop cut short finished when the app next runs. The writers are faked at the functions
// it calls.

const calls = vi.hoisted(() => ({ order: [] as string[], fail: new Set<string>() }))
const closer = (name: string, closed: string[]) => async (): Promise<string[]> => {
  calls.order.push(name)
  if (calls.fail.has(name)) throw new Error(`${name} could not be read`)
  return closed
}
vi.mock('../src/news/newsBookShort', () => ({ newsBookBrowserDeps: {}, closeNewsBookShorts: () => closer('news', ['Delisting short · ABC (news book)'])() }))
vi.mock('../src/traders/paperFollow', () => ({ followBrowserDeps: {}, closeFollows: () => closer('follows', ['Follow · ETH long'])() }))
vi.mock('../src/traders/paperClone', () => ({ cloneBrowserDeps: {}, closeClones: () => closer('clones', [])() }))
vi.mock('../src/baseline/baselineTrade', () => ({ baselineBrowserDeps: {}, closeBaselineTrades: () => closer('baseline', ['Trend Regime Ensemble · BTCUSDT (baseline book)'])() }))

const world = { running: false, executors: [] as ExecutorConfig[] }
vi.stubGlobal('window', {
  api: {
    books: {
      stop: async () => {
        calls.order.push('stop')
        world.running = false
      },
      testing: async () => ({ running: world.running }),
      state: async () => ({ running: world.running, startedAt: 1, standings: [] })
    },
    settings: { get: async () => ({ executors: world.executors }) }
  }
})

const { closeLeftoverBookTrades, openBookTrades, stopPaperTesting } = await import('../src/trading/paperTesting')

const trade = (over: Partial<ExecutorConfig>): ExecutorConfig => ({ id: 'x', type: 'position', mode: 'paper', status: 'active', book: { id: 'baseline', startedAt: 1, ledger: 'baseline' }, ...over }) as ExecutorConfig

beforeEach(() => {
  calls.order = []
  calls.fail = new Set()
  world.running = true
  world.executors = []
})

describe('Stop, in the window', () => {
  it("stops the books first, then closes each book's open trades by its own writer, one failing not the others", async () => {
    calls.fail.add('follows')
    const { state, closed } = await stopPaperTesting()
    expect(calls.order).toEqual(['stop', 'news', 'follows', 'clones', 'baseline'])
    expect(closed).toEqual(['Delisting short · ABC (news book)', 'Trend Regime Ensemble · BTCUSDT (baseline book)'])
    expect(state).toEqual({ running: false })
  })

  it('finishes a Stop cut short: a stopped book with a trade still open has it closed; nothing while they run or with none open', async () => {
    world.executors = [trade({}), trade({ id: 'y', book: undefined }), trade({ id: 'z', status: 'stopped' })]
    expect(openBookTrades(world.executors).map((executor) => executor.id)).toEqual(['x'])
    expect(await closeLeftoverBookTrades()).toEqual([])
    expect(calls.order).toEqual([])
    world.running = false
    expect(await closeLeftoverBookTrades()).toHaveLength(3)
    expect(calls.order).toEqual(['news', 'follows', 'clones', 'baseline'])
    calls.order = []
    world.executors = [trade({ status: 'stopped' }), trade({ id: 'live', mode: 'live' })]
    expect(await closeLeftoverBookTrades()).toEqual([])
    expect(calls.order).toEqual([])
  })
})
