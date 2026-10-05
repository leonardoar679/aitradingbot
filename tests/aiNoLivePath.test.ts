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
//
// And once more on 2026-10-04: the user chose to let the watch open PAPER positions by itself
// ("Yes, paper only"). The watch used to be held to "no executor, no settings write". It is now
// held to this: exactly one of its files writes settings, what that file makes is paper by a
// literal it cannot be handed, and no watch file -- that one included -- mentions the bridge a
// real order travels over. A bot that trades real money by itself was offered and not chosen.
//
// And on 2026-10-05 the pages were rearranged around a trade (docs/INVENTORY.md). The Agents page
// was split up: its Opportunities tab became the Opportunities page, Analyze and Signals became AI
// Decisions, and Benchmark became AI Benchmark. Nothing about what a call can do changed. The
// lists below name the new pages where they named the old one, held to exactly the same rule.

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
      join(ROOT, 'src', 'agents', 'eventBenchmark.ts'),
      join(ROOT, 'src', 'agents', 'EventBenchmarkView.tsx'),
      join(ROOT, 'src', 'ai-benchmark', 'AiBenchmarkPage.tsx'),
      join(ROOT, 'shared', 'aiBenchmark.ts'),
      join(ROOT, 'shared', 'aiEventBenchmark.ts')
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
    const routing = [
      join(ROOT, 'shared', 'aiRoute.ts'),
      join(ROOT, 'shared', 'aiPanel.ts'),
      join(ROOT, 'src', 'agents', 'ModelsTab.tsx'),
      // The page the route is now set on.
      join(ROOT, 'src', 'settings', 'SettingsPanel.tsx')
    ]
    for (const path of routing) {
      const source = readFileSync(path, 'utf-8')
      expect(source, path).not.toMatch(/liveTrading|LiveTrading|liveOrders|placeLive/)
    }
  })

  it('a call that fills in an order form goes no further than the form', () => {
    // The proposal rules, the card that offers one and the pages that hand it on. None of them
    // may mention the bridge an order travels over: the form is on Strategies › Execution, and
    // the only thing these files can do is ask for it to be opened.
    const proposing = [
      join(ROOT, 'shared', 'aiProposal.ts'),
      join(ROOT, 'shared', 'aiOpportunity.ts'),
      join(ROOT, 'shared', 'aiOpportunityOutcome.ts'),
      join(ROOT, 'src', 'agents', 'SignalCard.tsx'),
      join(ROOT, 'src', 'agents', 'AnalyzeTab.tsx'),
      join(ROOT, 'src', 'agents', 'OpportunitiesTab.tsx'),
      join(ROOT, 'src', 'agents', 'OpportunityCard.tsx'),
      join(ROOT, 'src', 'agents', 'opportunities.ts'),
      join(ROOT, 'src', 'opportunities', 'OpportunitiesPage.tsx'),
      join(ROOT, 'src', 'ai-decisions', 'AiDecisionsPage.tsx'),
      // Overview leads with the strongest call still on offer and can hand it on too. What it
      // shows of the live session is read in files of its own (SafetySummary, HoldingsSummary),
      // which offer no call -- so the card that does, and the page, are held to this rule.
      join(ROOT, 'src', 'overview', 'OverviewPage.tsx'),
      join(ROOT, 'src', 'overview', 'TopOpportunityCard.tsx'),
      join(ROOT, 'src', 'agents', 'useEventFeed.ts')
    ]
    for (const path of proposing) {
      const source = readFileSync(path, 'utf-8')
      expect(source, path).not.toMatch(/liveTrading|LiveTrading|liveOrders|placeLive|window\.api\.executors/)
    }
    // And the rules themselves are arithmetic on a decision: they import types and a few helpers,
    // and nothing from the renderer or the main process. A recommendation on an event added two
    // of those imports on 2026-10-04: what a recommendation is, and the name of an event's type.
    const rules = readFileSync(join(ROOT, 'shared', 'aiProposal.ts'), 'utf-8')
    expect(importsOf(join(ROOT, 'shared', 'aiProposal.ts')).sort()).toEqual(['aiOpportunity', 'aiPanel', 'aiSignal', 'ipc', 'marketEvent'])
    expect(rules).not.toMatch(/window\.|ipcRenderer|electron/)
  })

  it('the market scanner reads the market and reaches nothing else', () => {
    // It is not an AI module, and it is the first thing in this app that decides, by itself and
    // with no window open, that something is worth acting on. What it singles out is later put to
    // a model. So it is held to the same rule from the start: it imports nothing that trades or
    // holds a key, nothing that asks a model, and its page mentions no bridge an order travels over.
    const main = [join(SERVICES, 'marketScannerService.ts'), join(SERVICES, 'jsonlStore.ts'), join(ROOT, 'electron', 'ipc', 'handlers', 'scannerHandlers.ts')]
    for (const path of main) {
      expect(importsOf(path).filter((name) => LIVE_MODULES.has(name)), path).toEqual([])
      expect(importsOf(path).filter((name) => aiModuleNames.has(name)), path).toEqual([])
    }
    const renderer = [
      join(ROOT, 'shared', 'marketEvent.ts'),
      join(ROOT, 'shared', 'marketScanner.ts'),
      join(ROOT, 'src', 'explorer', 'ExplorerPage.tsx'),
      join(ROOT, 'src', 'explorer', 'eventOutcomes.ts')
    ]
    for (const path of renderer) {
      const source = readFileSync(path, 'utf-8')
      expect(source, path).not.toMatch(/liveTrading|LiveTrading|liveOrders|placeLive|window\.api\.executors|window\.api\.ai\b/)
    }
    // The detector is arithmetic on candles: it imports types and nothing else.
    expect(importsOf(join(ROOT, 'shared', 'marketEvent.ts'))).toEqual(['ipc'])
  })

  it('the watch asks and notifies, and all but one of its files has nothing to write with', () => {
    // The watch is the one thing that asks a model with nobody pressing anything. What it may do
    // with the answer is show it, say so on the desktop and -- since 2026-10-04, when it is
    // switched on -- open a PAPER position. Everything that asks, schedules and shows is still
    // held to what it always was: no bridge an order travels over, no executor, no settings write
    // (which is where the paper account lives) and no order form. The writing is one file, below.
    const watching = [
      join(ROOT, 'shared', 'aiWatch.ts'),
      join(ROOT, 'src', 'agents', 'opportunityWatch.ts'),
      join(ROOT, 'src', 'agents', 'OpportunityScheduler.tsx'),
      join(ROOT, 'src', 'agents', 'WatchCard.tsx'),
      join(ROOT, 'src', 'agents', 'liveBoard.ts'),
      join(ROOT, 'src', 'agents', 'LiveBoardCard.tsx'),
      join(ROOT, 'src', 'agents', 'EventTables.tsx'),
      join(ROOT, 'src', 'agents', 'RightNowCard.tsx'),
      join(SERVICES, 'aiWatchService.ts')
    ]
    for (const path of watching) {
      const source = readFileSync(path, 'utf-8')
      expect(source, path).not.toMatch(/liveTrading|LiveTrading|liveOrders|placeLive|window\.api\.(executors|settings|trade|paper)/)
      expect(source, path).not.toMatch(/onPrepareOrder|buildOpportunityProposal|buildAiProposal/)
      expect(importsOf(path), path).not.toContain('aiProposal')
    }
    // The scheduler reaches the same six things through the bridge as before. The paper trader is
    // handed to it whole, from the one file that writes.
    const scheduler = readFileSync(join(ROOT, 'src', 'agents', 'OpportunityScheduler.tsx'), 'utf-8')
    expect([...scheduler.matchAll(/window\.api\.(\w+)/g)].map((match) => match[1]).sort()).toEqual(['ai', 'ai', 'ai', 'market', 'notify', 'scanner', 'scanner'])
    expect(importsOf(join(ROOT, 'src', 'agents', 'OpportunityScheduler.tsx')).sort()).toEqual(['marketEvent', 'opportunityWatch', 'react', 'watchPaperTrade'])
    // The main-process half reads the setting and the ledger, and nothing else.
    expect(importsOf(join(SERVICES, 'aiWatchService.ts')).sort()).toEqual(['aiConfigService', 'aiLedgerService', 'aiWatch'])
  })

  it('what the watch opens by itself is paper, by a literal it cannot be handed', () => {
    // The rules (shared) and the one file that writes (renderer).
    const rules = join(ROOT, 'shared', 'aiWatchPaper.ts')
    const writer = join(ROOT, 'src', 'agents', 'watchPaperTrade.ts')
    for (const path of [rules, writer]) {
      const source = readFileSync(path, 'utf-8')
      // No bridge a real order travels over, and no executor bridge either: a paper executor is a
      // row in settings, and a real one is made somewhere this file never mentions.
      expect(source, path).not.toMatch(/liveTrading|LiveTrading|liveOrders|placeLive|window\.api\.(executors|trade|paper|credentials)/)
      // The word for the other mode does not appear as a value anywhere in either file.
      expect(source, path).not.toMatch(/['"`]live['"`]/)
      expect(source, path).not.toMatch(/\bleverage\s*:/)
    }
    const source = readFileSync(writer, 'utf-8')
    // Paper is written where the executor is made, and where its funds are checked, and the
    // function that makes it takes no mode.
    expect(source.match(/mode: 'paper'/g)).toHaveLength(2)
    expect(source).not.toMatch(/mode:(?!\s*'paper')/)
    const signature = /export function watchPaperExecutor\(input: \{([^}]*)\}\)/.exec(source)?.[1] ?? ''
    expect(signature).toContain('plan: OkPlan')
    expect(signature).not.toMatch(/mode/)
    // The rules import the proposal's arithmetic, a few names and types, and nothing that acts.
    expect(importsOf(rules).sort()).toEqual(['aiOpportunity', 'aiPanel', 'aiProposal', 'aiSignal', 'ipc', 'marketEvent'])
    expect(readFileSync(rules, 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron/)
    // The writer reaches settings, the price, candles, a notice and the setting. Nothing else.
    expect([...new Set([...source.matchAll(/window\.api\.(\w+)/g)].map((match) => match[1]))].sort()).toEqual(['ai', 'market', 'notify', 'settings'])
    // And it is the only file of the watch's that reaches settings at all.
    const others = ['opportunityWatch.ts', 'OpportunityScheduler.tsx', 'WatchCard.tsx', 'liveBoard.ts', 'LiveBoardCard.tsx', 'RightNowCard.tsx']
    for (const file of others) expect(readFileSync(join(ROOT, 'src', 'agents', file), 'utf-8'), file).not.toMatch(/window\.api\.settings/)
  })

  it('a paper trade of the watch\'s is closed with paper bookkeeping and nothing else', () => {
    // Stopping one and booking its result is what pressing Stop on its card does. The two things
    // the writer calls to do it are the paper account's own, and each refuses a real executor
    // before it does anything.
    const writer = readFileSync(join(ROOT, 'src', 'agents', 'watchPaperTrade.ts'), 'utf-8')
    expect(importsOf(join(ROOT, 'src', 'agents', 'watchPaperTrade.ts')).sort()).toEqual([
      'aiCost',
      'aiSignal',
      'aiWatchPaper',
      'engine',
      'executorFunding',
      'ipc',
      'marketEvent',
      'settingsWrites',
      'settleExecutor'
    ])
    expect(readFileSync(join(ROOT, 'src', 'account', 'settleExecutor.ts'), 'utf-8')).toContain("if (executor.mode === 'live') return null")
    // It only ever looks at its own: a paper Position carrying the watch's mark.
    expect(writer).toContain('watchPaperExecutors(executors).filter((entry) => entry.status === \'active\')')
    expect(readFileSync(join(ROOT, 'shared', 'aiWatchPaper.ts'), 'utf-8')).toContain("executor.watch !== undefined && executor.mode === 'paper' && executor.type === 'position'")
  })

  it('the AI\'s part of the status bar reads two settings and offers nothing', () => {
    // It sits on the live-trading bar, beside the arm and kill controls, so it is held to the
    // narrowest rule of all: it reads whether a key is stored and what the AI setting is, and
    // nothing that carries a call -- no proposal, no feed, no answer -- is anywhere near it.
    const chip = join(ROOT, 'src', 'ai', 'AiStatusChip.tsx')
    const source = readFileSync(chip, 'utf-8')
    expect([...source.matchAll(/window\.api\.(\w+)\.(\w+)/g)].map((match) => `${match[1]}.${match[2]}`).sort()).toEqual(['ai.credentialsStatus', 'ai.getConfig'])
    expect(importsOf(chip).sort()).toEqual(['StatusChip', 'aiCost', 'react', 'statusModes'])
    const modes = readFileSync(join(ROOT, 'src', 'status', 'statusModes.ts'), 'utf-8')
    expect(modes).not.toMatch(/window\.|ipcRenderer|electron/)
    expect(importsOf(join(ROOT, 'src', 'status', 'statusModes.ts')).sort()).toEqual(['aiCost', 'ipc'])
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
