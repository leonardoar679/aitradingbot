import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'

// NO MODEL PLACES AN ORDER, AND THAT IS A PROPERTY OF THE IMPORT GRAPH.
//
// A model's answer becomes a decision on a tape, and a tape is replayed through the paper engine.
// No code reads it on the way to a real order. That is easy to say and easy to undo by accident:
// one import of the live-order service from an AI module, or one import of an AI module from a
// live-trading one, and a signal has a route to real money that no gate was designed around.
//
// So the rule is checked structurally rather than trusted. If AI-driven live trading is ever
// built it will be a deliberate change with its own gates -- and it will have to change this test
// to do it, which is the point.
//
// It was changed once, deliberately, on 2026-10-03: the user chose "AI proposes, you place" over
// leaving AI on paper and over a bot that trades by itself. A call to buy can now FILL IN an
// executor form (shared/aiProposal.ts). A person sets the amount, ticks live, types the phrase and
// submits it, through the same gates as any executor made by hand. So everything below still
// holds as written -- no AI module reaches an order path -- and one test was added for the new
// surface. tests/aiProposal.test.ts pins what a proposal may carry and who submits the form.

const ROOT = join(__dirname, '..')
const SERVICES = join(ROOT, 'electron', 'services')

/** Everything that places, cancels or sizes a real order, or holds an exchange credential. */
const LIVE_MODULES = new Set([
  'liveTradingService',
  'liveExecutionService',
  'liveOrdersService',
  'livePositionsService',
  'livePositionWatchersService',
  'liveTwapService',
  'watcherExit',
  'watcherEvaluation',
  'binanceTrading',
  'binanceFuturesTrading',
  'upbitTrading',
  'credentialsService'
])

function isAiService(file: string): boolean {
  return /^ai[A-Z]\w*\.ts$/.test(file) || file === 'openRouterClient.ts'
}

/** The modules a source file imports, by bare file name. */
function importsOf(path: string): string[] {
  const source = readFileSync(path, 'utf-8')
  return [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => basename(match[1]))
}

const aiServices = readdirSync(SERVICES).filter(isAiService)
const aiModuleNames = new Set(aiServices.map((file) => file.replace(/\.ts$/, '')))

describe('AI code has no route to a real order', () => {
  it('finds the AI services it is supposed to be guarding', () => {
    // A guard that silently matched nothing would pass forever.
    expect(aiServices).toEqual(
      expect.arrayContaining([
        'aiSignalService.ts',
        'aiCredentialsService.ts',
        'aiConfigService.ts',
        'aiLedgerService.ts',
        'aiPrompt.ts',
        'openRouterClient.ts'
      ])
    )
  })

  it.each([...aiServices.map((file) => join(SERVICES, file)), join(ROOT, 'electron', 'ipc', 'handlers', 'aiHandlers.ts')])(
    '%s imports nothing that trades',
    (path) => {
      expect(importsOf(path).filter((name) => LIVE_MODULES.has(name))).toEqual([])
    }
  )

  it('no shared AI module imports from the main process at all', () => {
    for (const file of readdirSync(join(ROOT, 'shared')).filter((name) => /^ai[A-Z]\w*\.ts$/.test(name))) {
      const source = readFileSync(join(ROOT, 'shared', file), 'utf-8')
      expect(source, file).not.toMatch(/from\s+'[^']*electron/)
    }
  })

  it('no live-trading module reads an AI one', () => {
    // The other direction. An order path that consulted a signal would not need the AI code to
    // import anything.
    const liveFiles = [
      ...readdirSync(SERVICES).filter((file) => LIVE_MODULES.has(file.replace(/\.ts$/, ''))),
      ...readdirSync(join(SERVICES, 'exchanges')).map((file) => join('exchanges', file))
    ].filter((file) => file.endsWith('.ts'))
    expect(liveFiles.length).toBeGreaterThan(5)
    for (const file of [...liveFiles.map((name) => join(SERVICES, name)), join(ROOT, 'electron', 'ipc', 'handlers', 'liveTradingHandlers.ts')]) {
      expect(importsOf(file).filter((name) => aiModuleNames.has(name)), file).toEqual([])
    }
  })

  it('a model reviewing a strategy\'s entries is still nowhere near the live-trading bridge', () => {
    // An entry review changes what a PAPER replay does: it removes entries from the signals the
    // backtest engine is handed. The renderer cannot import the main process's order code, but it
    // can call it through the bridge -- so the files that turn a model's answer into a paper
    // position are checked for any mention of that bridge at all.
    const reviewed = [
      join(ROOT, 'src', 'backtest', 'aiConfirmation.ts'),
      join(ROOT, 'src', 'backtest', 'AiConfirmationCard.tsx'),
      join(ROOT, 'src', 'bots', 'useDryRun.ts'),
      join(ROOT, 'src', 'bots', 'types.ts'),
      join(ROOT, 'src', 'bots', 'BotsPage.tsx'),
      join(ROOT, 'shared', 'aiConfirm.ts')
    ]
    for (const path of reviewed) {
      const source = readFileSync(path, 'utf-8')
      expect(source, path).not.toMatch(/liveTrading|LiveTrading|liveOrders|placeLive/)
    }
  })

  it('a benchmark asks, scores and shows, and does nothing else', () => {
    // It is the one place that turns many models' answers into a table of who would have made
    // what -- the natural place for a "trade the winner" button to appear one day. Until that is
    // built deliberately, nothing in it may mention the bridge an order would travel over.
    const benchmark = [
      join(ROOT, 'src', 'agents', 'benchmark.ts'),
      join(ROOT, 'src', 'agents', 'BenchmarkTab.tsx'),
      join(ROOT, 'shared', 'aiBenchmark.ts')
    ]
    for (const path of benchmark) {
      const source = readFileSync(path, 'utf-8')
      expect(source, path).not.toMatch(/liveTrading|LiveTrading|liveOrders|placeLive/)
    }
  })

  it('a route or a panel decides which answer a paper position follows, and reaches nothing else', () => {
    // Routing is the first place where a setting chooses WHOSE answer the account acts on, and a
    // panel is the first decider that is more than one call. The rules and the page they are set
    // on are checked like the rest: no mention of the bridge an order would travel over.
    const routing = [join(ROOT, 'shared', 'aiRoute.ts'), join(ROOT, 'shared', 'aiPanel.ts'), join(ROOT, 'src', 'agents', 'ModelsTab.tsx')]
    for (const path of routing) {
      const source = readFileSync(path, 'utf-8')
      expect(source, path).not.toMatch(/liveTrading|LiveTrading|liveOrders|placeLive/)
    }
  })

  it('a call that fills in an order form goes no further than the form', () => {
    // The proposal rules, the card that offers one and the pages that hand it on. None of them
    // may mention the bridge an order travels over: the form is on the Executors page, and the
    // only thing these files can do is ask for it to be opened.
    const proposing = [
      join(ROOT, 'shared', 'aiProposal.ts'),
      join(ROOT, 'src', 'agents', 'SignalCard.tsx'),
      join(ROOT, 'src', 'agents', 'AnalyzeTab.tsx'),
      join(ROOT, 'src', 'agents', 'AgentsPage.tsx')
    ]
    for (const path of proposing) {
      const source = readFileSync(path, 'utf-8')
      expect(source, path).not.toMatch(/liveTrading|LiveTrading|liveOrders|placeLive|window\.api\.executors/)
    }
    // And the rules themselves are arithmetic on a decision: they import types and two helpers,
    // and nothing from the renderer or the main process.
    const rules = readFileSync(join(ROOT, 'shared', 'aiProposal.ts'), 'utf-8')
    expect(importsOf(join(ROOT, 'shared', 'aiProposal.ts')).sort()).toEqual(['aiPanel', 'aiSignal', 'ipc'])
    expect(rules).not.toMatch(/window\.|ipcRenderer|electron/)
  })

  it('the model is offered no tools', () => {
    // It is handed a snapshot and returns one JSON object. A request that carried tool or function
    // definitions would be the first step toward a model that can ask this app to act.
    const client = readFileSync(join(SERVICES, 'openRouterClient.ts'), 'utf-8')
    expect(client).not.toMatch(/\btools\s*:/)
    expect(client).not.toMatch(/\btool_choice\b/)
    expect(client).not.toMatch(/\bfunctions\s*:/)
  })
})
