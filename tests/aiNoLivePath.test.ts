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
//
// And the same day, news: the app reads Binance's announcements (research/NEWS.md), and the user
// chose what a delisting does -- a notice to someone holding the coin, a PAPER short by the rule
// the study measured, and the watch's models asked about it. That short is the second thing in this
// app that opens a paper position with nobody pressing anything, and it is held to what the
// watch's is: one file writes it, paper is a literal there, and nothing that reads the news
// mentions the bridge a real order travels over. The models are asked the way they are asked about
// any event -- the event raised by the main process, the question checked there against its own
// record of the article -- and what they say can do no more than any answer the watch gets.
//
// And on 2026-10-06 the exit check, one of the four AI additions the user switched on within the $5
// day: a model's EXIT on one of the app's own open PAPER trades closes it at the next minute. It is
// held to bringing that trade's time limit forward, through the two files that already write those
// trades, and to nothing else: no stop moves, nothing opens, and no live position can be found.

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
  'credentialsService',
  // Added 8 October 2026 (the V5 document, S101-102): the account's own stream books fills, and the
  // reconciliation resolves orders the exchange no longer rests. Neither reads a model.
  'liveUserStreamService',
  'liveReconcileService'
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
    // And, since 8 October 2026, the fee rate: the amount a real order from a call is suggested to
    // stake is what the person's risk share would lose at the call's stop after fees.
    expect(importsOf(join(ROOT, 'shared', 'aiProposal.ts')).sort()).toEqual(['aiOpportunity', 'aiPanel', 'aiSignal', 'fees', 'ipc', 'marketEvent'])
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
      join(ROOT, 'src', 'explorer', 'eventOutcomes.ts'),
      // Where it is switched on and its pairs chosen, since Settings became the one place for that.
      join(ROOT, 'src', 'settings', 'ScannerSettingsCard.tsx')
    ]
    for (const path of renderer) {
      const source = readFileSync(path, 'utf-8')
      expect(source, path).not.toMatch(/liveTrading|LiveTrading|liveOrders|placeLive|window\.api\.executors|window\.api\.ai\b/)
    }
    // The detector is arithmetic on candles: it imports types and nothing else.
    expect(importsOf(join(ROOT, 'shared', 'marketEvent.ts'))).toEqual(['ipc'])
  })

  it('the market research reads public data and reaches nothing else', () => {
    // Since 6 October 2026 the app studies the market as it opens (the second V3 document): the
    // liquid pairs, a day's and a week's moves, CoinGecko's free trending list, the market's state.
    // It is held to the scanner's rule: its main-process files import nothing that trades or holds
    // a key and nothing that asks a model, the rules are arithmetic, and what shows it calls the
    // research bridge alone.
    const main = [join(SERVICES, 'marketResearchService.ts'), join(ROOT, 'electron', 'ipc', 'handlers', 'researchHandlers.ts')]
    for (const path of main) {
      expect(importsOf(path).filter((name) => LIVE_MODULES.has(name)), path).toEqual([])
      expect(importsOf(path).filter((name) => aiModuleNames.has(name)), path).toEqual([])
    }
    // The data host's reads, through the scanner's own source; never the resolver that trades.
    expect(importsOf(join(SERVICES, 'marketResearchService.ts')).sort()).toEqual(['ipc', 'marketResearch', 'marketService', 'singleFlight'])
    expect(readFileSync(join(SERVICES, 'marketResearchService.ts'), 'utf-8')).not.toMatch(/resolveTradingEndpoint|credentials|apiKey/)
    const rules = join(ROOT, 'shared', 'marketResearch.ts')
    // Since 8 October 2026 (V5 Stage 3) the emerging movers are typed by the scanner's event words.
    expect(importsOf(rules).sort()).toEqual(['aiEventMarket', 'ipc', 'marketEvent', 'marketScanner'])
    expect(readFileSync(rules, 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron/)
    const views = [join(ROOT, 'src', 'hooks', 'useMarketResearch.ts'), join(ROOT, 'src', 'overview', 'MarketStatusStrip.tsx'), join(ROOT, 'src', 'dashboard', 'MoversCard.tsx')]
    for (const path of views) {
      const source = readFileSync(path, 'utf-8')
      expect([...new Set([...source.matchAll(/window\.api\.(\w+)/g)].map((match) => match[1]))], path).toEqual(path.endsWith('useMarketResearch.ts') ? ['research'] : [])
      expect(source, path).not.toMatch(/liveTrading|LiveTrading|placeLive|onPrepareOrder|aiProposal/)
    }
  })

  it("the forecast's bars are public data, kept, and reach nothing else (13 October 2026)", () => {
    // The V6 document's price forecast learns from ninety days of five-minute bars of the research's
    // pairs, kept in forecastData/ (V6 Stage 2). Its service reads the data host through the request
    // the scanner and the research read through, never the resolver that trades; it imports nothing
    // that trades, holds a key or asks a model; and everything under shared/forecast is arithmetic.
    const service = join(SERVICES, 'forecastDataService.ts')
    expect(importsOf(service).filter((name) => LIVE_MODULES.has(name))).toEqual([])
    expect(importsOf(service).filter((name) => aiModuleNames.has(name))).toEqual([])
    expect(importsOf(service).sort()).toEqual(['bars', 'binance', 'electron', 'jsonlStore', 'marketResearchService', 'path', 'promises'])
    const source = readFileSync(service, 'utf-8')
    expect(source).not.toMatch(/resolveTradingEndpoint|credentials|apiKey|signed|placeLive|liveTrading/)
    expect(source).toContain("import { fetchMarketData, servesBinanceComMarket } from './exchanges/binance'")
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : /\.ts$/.test(entry.name) ? [join(dir, entry.name)] : []))
    const shared = walk(join(ROOT, 'shared', 'forecast'))
    expect(shared.length).toBeGreaterThan(0)
    for (const path of shared) {
      expect(importsOf(path).filter((name) => LIVE_MODULES.has(name) || aiModuleNames.has(name)), path).toEqual([])
      expect(readFileSync(path, 'utf-8'), path).not.toMatch(/window\.|ipcRenderer|electron|placeLive|liveTrading/)
    }
    expect(importsOf(join(ROOT, 'shared', 'forecast', 'bars.ts')).sort()).toEqual(['aggregateCandles', 'ipc'])
    // The training runs in a worker thread (V6 Stage 4): it is handed what to fit and reaches no
    // network, no key, nothing that trades and nothing that asks a model.
    for (const path of [join(ROOT, 'electron', 'forecast', 'trainWorker.ts'), join(SERVICES, 'forecastWorkerService.ts')]) {
      expect(importsOf(path).filter((name) => LIVE_MODULES.has(name) || aiModuleNames.has(name)), path).toEqual([])
      expect(readFileSync(path, 'utf-8'), path).not.toMatch(/fetch\(|https?:\/\/|credentials|apiKey|liveTrading|placeLive|openRouter/)
    }
    expect(importsOf(join(SERVICES, 'forecastWorkerService.ts')).sort()).toEqual(['path', 'trainWorker', 'worker_threads'])
  })

  it('the live prices read the public stream and refuse, never place', () => {
    // Since 6 October 2026 one public socket streams the best bid and ask and the minute forming
    // for the pairs shown and the app's own paper trades (the second V3 document, §7). It is held to
    // the scanner's rule -- nothing that trades, holds a key or asks a model -- and resolves the data
    // host only. What uses it can say a recommendation is not enterable, and the watch's writer can
    // refuse a paper trade on it; nothing can place anything with it.
    const main = [join(SERVICES, 'liveMarketService.ts'), join(ROOT, 'electron', 'ipc', 'handlers', 'liveMarketHandlers.ts')]
    for (const path of main) {
      expect(importsOf(path).filter((name) => LIVE_MODULES.has(name)), path).toEqual([])
      expect(importsOf(path).filter((name) => aiModuleNames.has(name)), path).toEqual([])
    }
    const service = readFileSync(join(SERVICES, 'liveMarketService.ts'), 'utf-8')
    // noticeService and notices (since 8 October 2026): the stream dead for three minutes is told,
    // as a failure of something the app runs on; a notice places nothing.
    expect(importsOf(join(SERVICES, 'liveMarketService.ts')).sort()).toEqual(['binance', 'ipc', 'liveMarket', 'marketService', 'noticeService', 'notices', 'reconnectingSocket', 'settingsService', 'ws'])
    expect(service).toContain('const endpoint = await resolveEndpoint()')
    expect(service).not.toMatch(/resolveTradingEndpoint|credentials|apiKey|setSettings|settings\.set/)
    // The rules are arithmetic: the scanner's spread, the watch's Bitcoin rule, and types.
    const rules = join(ROOT, 'shared', 'liveMarket.ts')
    expect(importsOf(rules).sort()).toEqual(['aiWatchPaper', 'ipc', 'marketScanner'])
    expect(readFileSync(rules, 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron/)
    // What shows it reads the market bridge alone, and offers no call to an order.
    for (const path of [join(ROOT, 'src', 'hooks', 'useLiveMarket.ts'), join(ROOT, 'src', 'agents', 'liveVerdict.ts'), join(ROOT, 'src', 'agents', 'LiveVerdictView.tsx')]) {
      const source = readFileSync(path, 'utf-8')
      expect([...new Set([...source.matchAll(/window\.api\.(\w+)/g)].map((match) => match[1]))], path).toEqual(path.endsWith('useLiveMarket.ts') ? ['market'] : [])
      expect(source, path).not.toMatch(/liveTrading|LiveTrading|placeLive|onPrepareOrder|aiProposal|settings\.set/)
    }
    // The watch's writer refuses on it inside the queue, among its other refusals.
    expect(readFileSync(join(ROOT, 'src', 'agents', 'watchPaperTrade.ts'), 'utf-8')).toContain('livePaperBlock(book, deps.nowSec() * 1000) ??')
  })

  it('the news reader reads one public list and reaches nothing else', () => {
    // It reads Binance's announcements once a minute with no window open: the first news in this
    // app. It is held to the scanner's rule and to more. Its main-process files import nothing that
    // trades, holds a key or asks a model; its pages call the news bridge and nothing else; and the
    // files that read the news at all are exactly these. What a delisting does (shared/newsActions.ts)
    // is done by two files of src/news/, held below. Making anything else read the news is a
    // deliberate change, and it has to change this list to do it.
    const main = [join(SERVICES, 'newsService.ts'), join(SERVICES, 'newsRecordService.ts'), join(ROOT, 'electron', 'ipc', 'handlers', 'newsHandlers.ts')]
    for (const path of main) {
      expect(importsOf(path).filter((name) => LIVE_MODULES.has(name)), path).toEqual([])
      expect(importsOf(path).filter((name) => aiModuleNames.has(name)), path).toEqual([])
    }
    // It raises a delisting as an event through the scanner, which reads public candles; that is
    // the whole of what it reaches beyond its own files.
    // Since 8 October 2026 (V5 Stage 1) its settings file is read through the one reader that
    // stamps each file with its version (configFiles.ts, shared/configMigration.ts): no new reach.
    expect(importsOf(join(SERVICES, 'newsService.ts')).sort()).toEqual([
      'atomicWrite',
      'configFiles',
      'configMigration',
      'electron',
      'jsonlStore',
      'marketScannerService',
      'news',
      'newsActions',
      'path',
      'promises'
    ])
    // The record of the rules since the study reads the same lists, and Upbit's public list of
    // trading notices for the near miss it keeps beside them, when it is asked; and the coins'
    // candles through the market service that charts read: public data, kept in a file of its own.
    expect(importsOf(join(SERVICES, 'newsRecordService.ts')).sort()).toEqual(['atomicWrite', 'electron', 'marketEvent', 'marketService', 'news', 'newsRecord', 'newsRules', 'path', 'promises'])
    expect(importsOf(join(ROOT, 'shared', 'newsRecord.ts')).sort()).toEqual(['news', 'newsRules', 'newsTitles', 'upbitTitles'])
    // The rules' arithmetic is arithmetic: the fee, the candle type and the detector's reading.
    expect(importsOf(join(ROOT, 'shared', 'newsRules.ts')).sort()).toEqual(['fees', 'ipc', 'marketEvent'])
    expect(importsOf(join(ROOT, 'shared', 'news.ts'))).toEqual(['newsTitles'])
    expect(importsOf(join(ROOT, 'shared', 'newsTitles.ts'))).toEqual([])
    expect(importsOf(join(ROOT, 'shared', 'upbitTitles.ts'))).toEqual(['newsTitles'])
    for (const path of [join(ROOT, 'src', 'explorer', 'NewsCard.tsx'), join(ROOT, 'src', 'explorer', 'NewsRecordCard.tsx'), join(ROOT, 'src', 'settings', 'NewsSettingsCard.tsx')]) {
      const source = readFileSync(path, 'utf-8')
      expect([...new Set([...source.matchAll(/window\.api\.(\w+)/g)].map((match) => match[1]))], path).toEqual(['news'])
    }

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []
      )
    const readsNews = /window\.api\.news\b|from '[^']*\/(news|newsTitles|upbitTitles|newsActions|newsService|newsHandlers|newsPaperShort|NewsScheduler)'/
    const readers = ['src', 'electron', 'shared']
      .flatMap((dir) => walk(join(ROOT, dir)))
      .filter((path) => readsNews.test(readFileSync(path, 'utf-8')))
      .map((path) => path.slice(ROOT.length + 1).replace(/\\/g, '/'))
      .sort()
    expect(readers).toEqual([
      'electron/ipc/handlers/newsHandlers.ts',
      'electron/ipc/index.ts',
      'electron/main.ts',
      'electron/preload.ts',
      // The models (the user's third choice): a question about an announcement's event is checked
      // against the reader's own record of the article before anything is asked.
      'electron/services/aiSignalService.ts',
      // The effective configuration (the V4 document, §4-5): the news reader's switches as set, for
      // the configuration version. It reads no article and changes no switch.
      'electron/services/effectiveConfigService.ts',
      // ...and the event is raised through the scanner, from the coin's own candles.
      'electron/services/marketScannerService.ts',
      // The news feed (the second V3 document, 6 October 2026): Binance's announcements as stories,
      // beside four free media feeds.
      'electron/services/newsFeedService.ts',
      // The record of the two rules since the study, and of the two near misses: Binance's and
      // Upbit's lists and the coins' candles, scored.
      'electron/services/newsRecordService.ts',
      'electron/services/newsService.ts',
      // The same, composed: the switches among every other store's, read-only.
      'shared/appConfig.ts',
      // Since 8 October 2026 (V5 Stage 1) the defaults composed, DEFAULT_CONFIG: the reader's
      // defaults among every other store's, and nothing read.
      'shared/appDefaults.ts',
      'shared/news.ts',
      'shared/newsActions.ts',
      'shared/newsRecord.ts',
      // Upbit's patterns, for the near miss on record: they drop the pegged coins Binance's do.
      'shared/upbitTitles.ts',
      'src/App.tsx',
      // The exit check (6 October 2026) hands an EXIT for one of the rules' shorts to the file that
      // writes them; it reads no news itself (held below).
      'src/agents/exitCheck.ts',
      // Shows where one of the rule's shorts came from, from the mark on it.
      'src/executors/ExecutorCard.tsx',
      'src/explorer/NewsCard.tsx',
      'src/explorer/NewsRecordCard.tsx',
      // The feed's alerts: whether a coin a story names is held, by the holder notice's own rule.
      'src/news/NewsAlertScheduler.tsx',
      'src/news/NewsScheduler.tsx',
      'src/news/newsPaperShort.ts',
      'src/settings/NewsSettingsCard.tsx'
    ])
    // The news's own files offer no model a question and no form a call.
    for (const file of readers.filter((name) => /\/news|News/.test(name))) {
      // Since 8 October 2026 the alert scheduler reads the ledger (ai.listCalls) for a story's facts; nothing else of the AI's.
      expect(readFileSync(join(ROOT, file), 'utf-8'), file).not.toMatch(/window\.api\.ai\.(?!listCalls\b)|aiProposal|onPrepareOrder/)
    }
  })

  it('the news feed reads public feeds, opens links only on their hosts, and tells; it trades nothing', () => {
    // Since 6 October 2026 four free media feeds are read beside Binance's announcements (the second
    // V3 document, §11-14 and §28-30). The main-process half reads them and the coins' public candles
    // and writes its own two files; a link opens only on https and on a feed's host. The arithmetic is
    // arithmetic. What shows it, explains a move or raises an alert reads; none of it places, sells,
    // asks or offers a call.
    const main = [join(SERVICES, 'newsFeedService.ts'), join(ROOT, 'electron', 'ipc', 'handlers', 'newsFeedHandlers.ts')]
    for (const path of main) {
      expect(importsOf(path).filter((name) => LIVE_MODULES.has(name)), path).toEqual([])
      expect(importsOf(path).filter((name) => aiModuleNames.has(name)), path).toEqual([])
    }
    // noticeService and notices (since 8 October 2026): every feed unread for half an hour is told.
    expect(importsOf(join(SERVICES, 'newsFeedService.ts')).sort()).toEqual(['electron', 'jsonlStore', 'marketService', 'news', 'newsFeed', 'newsService', 'noticeService', 'notices', 'path', 'promises', 'singleFlight'])
    const service = readFileSync(join(SERVICES, 'newsFeedService.ts'), 'utf-8')
    expect(service).toContain("if (parsed.protocol !== 'https:' || !FEED_HOSTS.includes(parsed.hostname)) return false")
    expect(service).not.toMatch(/resolveTradingEndpoint|credentials|apiKey|setSettings/)
    expect(importsOf(join(ROOT, 'shared', 'newsFeed.ts'))).toEqual(['ipc'])
    expect(importsOf(join(ROOT, 'shared', 'moveExplanation.ts')).sort()).toEqual(['ipc', 'newsFeed'])
    expect(importsOf(join(ROOT, 'shared', 'alerts.ts')).sort()).toEqual(['ipc', 'newsFeed'])
    for (const file of ['newsFeed.ts', 'moveExplanation.ts', 'alerts.ts']) {
      expect(readFileSync(join(ROOT, 'shared', file), 'utf-8'), file).not.toMatch(/window\.|ipcRenderer|electron\//)
    }
    const calls = (path: string): string[] => {
      const source = readFileSync(path, 'utf-8')
      return [...new Set([...source.matchAll(/window\.api\.(\w+)(?:\s*\.\s*(\w+))?/g)].map((match) => (match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`)))].sort()
    }
    const views: [string, string[]][] = [
      [join(ROOT, 'src', 'news', 'useNewsFeed.ts'), ['feed.getState', 'feed.onUpdate']],
      [join(ROOT, 'src', 'explorer', 'NewsFeedCard.tsx'), ['feed.openLink']],
      [join(ROOT, 'src', 'news', 'WhyItMoved.tsx'), ['feed.openLink', 'market.fetchHistoricalRange']],
      [join(ROOT, 'src', 'news', 'WhyItMovedHost.tsx'), []],
      // The banner asks the main process for the minute's reminder while a CRITICAL alert is up (8 October 2026).
      [join(ROOT, 'src', 'news', 'AlertBanner.tsx'), ['feed.openLink', 'remind']],
      // The opportunities table opens a story on the coin, as the news tab does.
      [join(ROOT, 'src', 'agents', 'OpportunityTableCard.tsx'), ['feed.openLink']],
      // It reads what is held -- the settings and the balances a key can read -- the live stream
      // (Bitcoin, and since 8 October 2026 the story's pair for its price), and the ledger for the
      // analyst's reading and the watch's call on the coin; and tells.
      [
        join(ROOT, 'src', 'news', 'NewsAlertScheduler.tsx'),
        ['ai.listCalls', 'credentials.balances', 'credentials.list', 'feed.getState', 'feed.onUpdate', 'market.liveState', 'notify', 'records.alerts', 'records.onTold', 'settings.get']
      ]
    ]
    for (const [path, expected] of views) {
      expect(calls(path), path).toEqual(expected)
      expect(readFileSync(path, 'utf-8'), path).not.toMatch(/liveTrading|LiveTrading|placeLive|onPrepareOrder|aiProposal|settings\.set|window\.api\.ai\.(?!listCalls\b)/)
    }
  })

  it('what a delisting or a tag does is a notice and a paper short, by a literal it cannot be handed', () => {
    const rules = join(ROOT, 'shared', 'newsActions.ts')
    const writer = join(ROOT, 'src', 'news', 'newsPaperShort.ts')
    const scheduler = join(ROOT, 'src', 'news', 'NewsScheduler.tsx')
    for (const path of [rules, writer, scheduler]) {
      const source = readFileSync(path, 'utf-8')
      expect(source, path).not.toMatch(/liveTrading|LiveTrading|liveOrders|placeLive|window\.api\.(executors|trade|paper|ai)\b/)
      expect(source, path).not.toMatch(/['"`]live['"`]/)
      expect(source, path).not.toMatch(/\bleverage\s*:/)
    }
    expect(readFileSync(rules, 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron/)
    // The rules read a coin's usual move with the detector's arithmetic, which imports types alone,
    // and what its fills give up with the scorer's (aiOpportunityOutcome): arithmetic.
    expect(importsOf(rules).sort()).toEqual(['aiOpportunityOutcome', 'ipc', 'liveBalances', 'marketEvent', 'news', 'newsRules'])
    // Paper is written where the executor is made, and the function that makes it takes no mode.
    const source = readFileSync(writer, 'utf-8')
    expect(source.match(/mode: 'paper'/g)).toHaveLength(2)
    expect(source).not.toMatch(/mode:(?!\s*'paper')/)
    const signature = /export function newsShortExecutor\(input: \{([^}]*)\}\)/.exec(source)?.[1] ?? ''
    expect(signature).toContain('params: PositionExecutorParams')
    expect(signature).not.toMatch(/mode/)
    // The writer reaches settings, the market and a notice, and closes with paper bookkeeping.
    expect([...new Set([...source.matchAll(/window\.api\.(\w+)/g)].map((match) => match[1]))].sort()).toEqual(['market', 'notify', 'settings'])
    expect(source).not.toMatch(/window\.api\.credentials/)
    // paperRisk sizes a tag's short by its stop and holds the app's own paper trades to their cap,
    // paperExposure to their cap on one side on coins that move with Bitcoin, and paperPause refuses
    // one after a losing run: arithmetic, which only ever opens less (held below). aiExit is what the
    // exit check's EXIT writes: a time limit brought forward, and nothing else (held below).
    // notices (since 8 October 2026): the words of a notice, pure; the writer still tells through
    // the one dependency it is handed.
    expect(importsOf(writer).sort()).toEqual(['aiExit', 'engine', 'executorFunding', 'ipc', 'news', 'newsActions', 'notices', 'paperExposure', 'paperPause', 'paperRisk', 'settingsWrites', 'settleExecutor'])
    expect(readFileSync(rules, 'utf-8')).toContain("executor.newsRule !== undefined && executor.mode === 'paper' && executor.type === 'position'")
    // The scheduler reads -- the news, the settings, the balances a key can read -- and notifies.
    // Every write goes through the writer above.
    const watching = readFileSync(scheduler, 'utf-8')
    expect([...new Set([...watching.matchAll(/window\.api\.(\w+)(?:\s*\.\s*(\w+))?/g)].map((match) => (match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`)))].sort()).toEqual([
      'credentials.balances',
      'credentials.list',
      'news.getState',
      'news.onUpdate',
      'notify',
      'records.refusal',
      'settings.get'
    ])
    // paperRefusals keeps this session's refused shorts, for the session report, and since 8 October
    // 2026 each is written to the file as well: a record, read by nothing that decides anything
    // (held below).
    expect(importsOf(scheduler).sort()).toEqual(['news', 'newsActions', 'newsPaperShort', 'paperRefusals', 'react'])
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
      // The daily look at each model's health, its scheduler, and the last benchmark remembered for the
      // promotion checklist (8 October 2026): they read, mark and tell; nothing is unticked or rested by them.
      join(ROOT, 'src', 'agents', 'modelHealthWatch.ts'),
      join(ROOT, 'src', 'agents', 'ModelHealthScheduler.tsx'),
      join(ROOT, 'src', 'agents', 'benchmarkMemory.ts'),
      join(ROOT, 'shared', 'modelHealth.ts'),
      join(ROOT, 'shared', 'strategyHealth.ts'),
      // The opportunities table's rows: worked out from what the page holds, and nothing more.
      join(ROOT, 'src', 'agents', 'opportunityTable.ts'),
      join(SERVICES, 'aiWatchService.ts')
    ]
    for (const path of watching) {
      const source = readFileSync(path, 'utf-8')
      expect(source, path).not.toMatch(/liveTrading|LiveTrading|liveOrders|placeLive|window\.api\.(executors|settings|trade|paper)/)
      expect(source, path).not.toMatch(/onPrepareOrder|buildOpportunityProposal|buildAiProposal/)
      expect(importsOf(path), path).not.toContain('aiProposal')
    }
    // The scheduler reaches the same six things through the bridge as before, and since 8 October
    // 2026 the records on file, to write a refusal (a record, read by nothing that decides). The
    // paper trader is handed to it whole, from the one file that writes.
    const scheduler = readFileSync(join(ROOT, 'src', 'agents', 'OpportunityScheduler.tsx'), 'utf-8')
    // The third read of the scanner is the second look at an event whose candles could not be read.
    // The second read of the records (8 October 2026, the V5 document, §94): the refusals on file,
    // for the restart sweep that writes one for an answer the app was not running to act on.
    expect([...scheduler.matchAll(/window\.api\.(\w+)/g)].map((match) => match[1]).sort()).toEqual(['ai', 'ai', 'ai', 'market', 'notify', 'records', 'records', 'scanner', 'scanner', 'scanner'])
    expect(importsOf(join(ROOT, 'src', 'agents', 'OpportunityScheduler.tsx')).sort()).toEqual(['marketEvent', 'opportunityWatch', 'react', 'watchPaperTrade'])
    // The main-process half reads the setting and the ledger, and nothing else.
    expect(importsOf(join(SERVICES, 'aiWatchService.ts')).sort()).toEqual(['aiConfigService', 'aiLedgerService', 'aiWatch'])
  })

  it("the models' and the strategies' health are read, marked and told, and nothing is switched off by them (8 October 2026)", () => {
    // shared/modelHealth.ts and shared/strategyHealth.ts are arithmetic on a row's trades and a bot's;
    // the daily look (src/agents/modelHealthWatch.ts) reads the setting, the ledger, the events and
    // public candles, and raises a notice; its scheduler mounts it. None of them writes a setting,
    // unticks a model, stops a bot, or mentions the bridge an order travels over.
    for (const path of [join(ROOT, 'shared', 'modelHealth.ts'), join(ROOT, 'shared', 'strategyHealth.ts')]) {
      expect(readFileSync(path, 'utf-8'), path).not.toMatch(/window\.|ipcRenderer|electron\/|liveTrading|placeLive|setConfig|updateConfig|enabled:|mode: /)
    }
    expect(importsOf(join(ROOT, 'shared', 'strategyHealth.ts'))).toEqual([])
    expect(importsOf(join(ROOT, 'shared', 'modelHealth.ts')).sort()).toEqual(['aiEventBenchmark', 'aiOutcome', 'aiPanel', 'aiWatchPaper', 'ipc', 'strategyHealth'])
    const look = join(ROOT, 'src', 'agents', 'modelHealthWatch.ts')
    expect(importsOf(look).sort()).toEqual(['aiCost', 'aiEventBenchmark', 'liveBoard', 'modelHealth', 'notices'])
    expect(readFileSync(look, 'utf-8')).not.toMatch(/window\.|setConfig|updateConfig|enabled|disable|placeLive|liveTrading/)
    const scheduler = join(ROOT, 'src', 'agents', 'ModelHealthScheduler.tsx')
    expect([...readFileSync(scheduler, 'utf-8').matchAll(/window\.api\.(\w+)/g)].map((match) => match[1]).sort()).toEqual(['ai', 'ai', 'market', 'notify', 'scanner'])
    expect(importsOf(scheduler).sort()).toEqual(['modelHealthWatch', 'react'])
    // A strategy's health is told from the bot's card, which reaches the desktop and nothing else.
    const card = readFileSync(join(ROOT, 'src', 'bots', 'BotCard.tsx'), 'utf-8')
    expect([...new Set([...card.matchAll(/window\.api\.(\w+)/g)].map((match) => match[1]))]).toEqual(['notify'])
    // The bug of 8 October 2026: neither card passed Bitcoin's regime to the benchmark's cut, so its
    // slices by regime were always empty. Both pass the labels now, read from Bitcoin's own minutes.
    for (const file of ['LiveBoardCard.tsx', 'ModelRegistryCard.tsx']) {
      const source = readFileSync(join(ROOT, 'src', 'agents', file), 'utf-8')
      expect(source, file).toMatch(/summarizeEventBenchmark\(\{[^}]*\blabels\b/)
      expect(source, file).toContain('loadLiveLabels(')
    }
  })

  it('the daily report reads the records, and the paragraph about it is asked through the additions\' own path (8 October 2026)', () => {
    // The V4 plan's Stage 11. shared/dailyReport.ts is arithmetic on what is handed to it; the reader
    // (src/performance/dailyReport.ts) reads the records, public candles and the feed; the look
    // (src/performance/dailySummary.ts) builds the day before's report and asks for its paragraph
    // through the bridge the additions share, which the main process holds to one call a day, the
    // budget and the watch. The card builds, saves and asks. None of them writes a setting, opens,
    // closes or sizes anything, or mentions the bridge an order travels over.
    const rules = join(ROOT, 'shared', 'dailyReport.ts')
    expect(importsOf(rules).sort()).toEqual(['aiAdditions', 'aiEventBenchmark', 'aiLedger', 'alerts', 'ipc', 'marketResearch', 'newsFeed', 'paperDigest', 'shadowReport'])
    expect(readFileSync(rules, 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron|liveTrading|placeLive|setExecutors/)
    const calls = (path: string): string[] => {
      const text = readFileSync(path, 'utf-8')
      return [...new Set([...text.matchAll(/window\.api\.(\w+)(?:\s*\.\s*(\w+))?/g)].map((match) => (match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`)))].sort()
    }
    expect(calls(join(ROOT, 'src', 'performance', 'dailyReport.ts'))).toEqual(['ai.getConfig', 'ai.listCalls', 'feed.getState', 'market.fetchHistoricalRange', 'records.alerts', 'scanner.getState', 'scanner.listEvents', 'settings.get'])
    expect(calls(join(ROOT, 'src', 'performance', 'dailySummary.ts'))).toEqual(['ai.getConfig', 'ai.listCalls', 'ai.summarizeDay'])
    expect(calls(join(ROOT, 'src', 'performance', 'DailyReportCard.tsx'))).toEqual(['ai.listCalls', 'ai.summarizeDay', 'backtest.exportSave'])
    const scheduler = join(ROOT, 'src', 'performance', 'DailySummaryScheduler.tsx')
    expect(readFileSync(scheduler, 'utf-8')).not.toMatch(/window\.api/)
    expect(importsOf(scheduler).sort()).toEqual(['dailySummary', 'react'])
    for (const file of ['dailyReport.ts', 'dailySummary.ts', 'DailyReportCard.tsx', 'DailySummaryScheduler.tsx']) {
      expect(readFileSync(join(ROOT, 'src', 'performance', file), 'utf-8'), file).not.toMatch(/liveTrading|LiveTrading|placeLive|settings\.set|setExecutors|settingsWrites|onPrepareOrder|aiProposal|askOpportunity|exitCheck|reviewTrade/)
    }
    // The main process reads the request in its shape and asks through the one path every addition takes.
    const service = readFileSync(join(SERVICES, 'aiAdditionsService.ts'), 'utf-8')
    expect(service).toContain('const parsed = parseDailySummaryRequest(request)')
    expect(service).toContain("kind: 'daily',")
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
    // The rules import the proposal's arithmetic, the sizing's (paperRisk), the slippage the score
    // charges (aiOpportunityOutcome), the losing run's words for the confirmation (paperPause), a few
    // names and types, and nothing that acts.
    // dynamicRisk (8 October 2026): the conditions' factor on the risk, arithmetic on what was read.
    expect(importsOf(rules).sort()).toEqual(['aiOpportunity', 'aiOpportunityOutcome', 'aiPanel', 'aiProposal', 'aiSignal', 'dynamicRisk', 'ipc', 'marketEvent', 'paperPause', 'paperRisk'])
    expect(readFileSync(rules, 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron/)
    // The writer reaches settings, the price, candles, the stories on file, a notice and the setting;
    // and, since 8 October 2026, the research, to write the market's regime on the mark (a record).
    // Nothing else.
    expect([...new Set([...source.matchAll(/window\.api\.(\w+)/g)].map((match) => match[1]))].sort()).toEqual(['ai', 'feed', 'market', 'notify', 'research', 'settings'])
    // And it is the only file of the watch's that reaches settings at all.
    const others = ['opportunityWatch.ts', 'OpportunityScheduler.tsx', 'WatchCard.tsx', 'liveBoard.ts', 'LiveBoardCard.tsx', 'opportunityTable.ts', 'OpportunityTableCard.tsx', 'modelHealthWatch.ts', 'ModelHealthScheduler.tsx']
    for (const file of others) expect(readFileSync(join(ROOT, 'src', 'agents', file), 'utf-8'), file).not.toMatch(/window\.api\.settings/)
  })

  it('a paper trade of the watch\'s is closed with paper bookkeeping and nothing else', () => {
    // Stopping one and booking its result is what pressing Stop on its card does. The two things
    // the writer calls to do it are the paper account's own, and each refuses a real executor
    // before it does anything.
    const writer = readFileSync(join(ROOT, 'src', 'agents', 'watchPaperTrade.ts'), 'utf-8')
    // aiEventMarket names Bitcoin's pair, whose minutes the Bitcoin safeguard reads; it is arithmetic.
    // aiAdditions: the reviewer's REJECT, one more refusal before the trade is written. aiExit: what
    // the exit check's EXIT writes, a time limit brought forward and nothing else (held below).
    // aiLedger and expectedValue (8 October 2026): the calibrated win rate the expected value is read
    // at, from the ledger's rows and the closed trades on file; it only ever refuses.
    expect(importsOf(join(ROOT, 'src', 'agents', 'watchPaperTrade.ts')).sort()).toEqual([
      'aiAdditions',
      'aiCost',
      // aiCostPerTrade and dynamicRisk (8 October 2026): the model's cost a trade the expected value
      // is net of, and the conditions' factor on the risk; both arithmetic on what was read.
      'aiCostPerTrade',
      'aiEventMarket',
      'aiExit',
      'aiLedger',
      'aiSignal',
      'aiWatchPaper',
      'dynamicRisk',
      'engine',
      'excursions',
      'executorFunding',
      'expectedValue',
      'ipc',
      'liveMarket',
      'marketEvent',
      'notices',
      'paperExposure',
      'paperNewsBlock',
      'paperPause',
      'paperRisk',
      'settingsWrites',
      'settleExecutor'
    ])
    expect(readFileSync(join(ROOT, 'src', 'account', 'settleExecutor.ts'), 'utf-8')).toContain("if (executor.mode === 'live') return null")
    // It only ever looks at its own: a paper Position carrying the watch's mark.
    expect(writer).toContain('watchPaperExecutors(executors).filter((entry) => entry.status === \'active\')')
    expect(readFileSync(join(ROOT, 'shared', 'aiWatchPaper.ts'), 'utf-8')).toContain("executor.watch !== undefined && executor.mode === 'paper' && executor.type === 'position'")
  })

  it('the size of the paper trades the app opens by itself is arithmetic, set on a card that only saves it', () => {
    // shared/paperRisk.ts sizes the watch's and the news rules' paper trades by their stop and caps
    // what they have out together. Both only ever open less: a sized trade is at most its own stake,
    // and the cap only refuses. It is arithmetic on a setting and the executors on file.
    const rules = join(ROOT, 'shared', 'paperRisk.ts')
    expect(importsOf(rules).sort()).toEqual(['fees', 'ipc'])
    const source = readFileSync(rules, 'utf-8')
    expect(source).not.toMatch(/window\.|ipcRenderer|electron|liveTrading|placeLive/)
    // Since 8 October 2026 the conditions' factor is applied after the cap (shared/dynamicRisk.ts).
    expect(source).toContain('Math.min(stakeQuote, ')
    // The card on Risk & Safety reads and saves the setting, and reaches nothing else.
    const card = readFileSync(join(ROOT, 'src', 'risk', 'PaperRiskCard.tsx'), 'utf-8')
    expect([...new Set([...card.matchAll(/window\.api\.(\w+)(?:\s*\.\s*(\w+))?/g)].map((match) => `${match[1]}.${match[2]}`))].sort()).toEqual(['settings.get', 'settings.set'])
    expect(card).not.toMatch(/liveTrading|placeLive|window\.api\.(executors|ai|credentials)/)
  })

  it('the AI additions ask within their own limits and the budget, and place nothing', () => {
    // Since 6 October 2026 (the V3 plan's Stage 7, switched on by the user within the $5 day). The
    // main-process half asks through aiSignalService's own path -- the budget immediately before the
    // request, the pace, the retries -- and writes its cache and the ledger, and nothing else; what
    // shows the additions reads their switch, their status and the ledger.
    const service = join(SERVICES, 'aiAdditionsService.ts')
    expect(importsOf(service).sort()).toEqual([
      'aiAdditionPrompts',
      'aiAdditions',
      'aiConfigService',
      'aiCost',
      'aiCredentialsService',
      'aiLedgerService',
      // The reviewer reads the other models' calls on the event under the live prompts.
      'aiOpportunity',
      'aiSignalService',
      'alerts',
      'atomicWrite',
      'electron',
      // The conclusion to "Why did it move?" rebuilds its evidence from public candles (the
      // scanner's own source, the data host) and the fixed rules' explanation.
      'marketService',
      'moveExplanation',
      'newsFeed',
      'newsFeedService',
      'node:crypto',
      // The budget met is told once a day on the budget's thread (8 October 2026), through the notice service.
      'noticeService',
      'notices',
      'path',
      'promises',
      // The exit check reads the executors on file, to find the trade it is asked about among the
      // app's own open paper trades. It reads them, and writes nothing there (held below).
      'settingsService'
    ])
    const source = readFileSync(service, 'utf-8')
    expect(source).toContain('await assertAiBudget()')
    expect(source).toContain("import { getSettings } from './settingsService'")
    expect(source).not.toMatch(/liveTrading|placeLive|setExecutors|settings\.set|setSettings|credentialsService'/)
    expect(importsOf(join(SERVICES, 'aiAdditionPrompts.ts'))).toEqual(['aiAdditions'])
    expect(readFileSync(join(ROOT, 'shared', 'aiAdditions.ts'), 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron\//)
    const calls = (path: string): string[] => {
      const text = readFileSync(path, 'utf-8')
      return [...new Set([...text.matchAll(/window\.api\.(\w+)(?:\s*\.\s*(\w+))?/g)].map((match) => (match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`)))].sort()
    }
    expect(calls(join(ROOT, 'src', 'agents', 'AiAdditionsCard.tsx'))).toEqual(['ai.additionsStatus', 'ai.setConfig'])
    expect(calls(join(ROOT, 'src', 'news', 'useNewsReadings.ts'))).toEqual(['ai.listCalls'])
    // The conclusion is asked from a click at the price shown; the Why window itself asks nothing.
    expect(calls(join(ROOT, 'src', 'agents', 'WhyConclusion.tsx'))).toEqual(['ai.additionsStatus', 'ai.concludeMove', 'ai.listCalls'])
    expect(readFileSync(join(SERVICES, 'aiAdditionsService.ts'), 'utf-8')).toContain("scanSourceFor('binance')")
    for (const path of [join(ROOT, 'src', 'agents', 'AiAdditionsCard.tsx'), join(ROOT, 'src', 'news', 'useNewsReadings.ts'), join(ROOT, 'src', 'agents', 'WhyConclusion.tsx')]) {
      expect(readFileSync(path, 'utf-8'), path).not.toMatch(/liveTrading|LiveTrading|placeLive|onPrepareOrder|aiProposal|settings\.set/)
    }
  })

  it("the exit check closes the app's own paper trades early, and does nothing else", () => {
    // Since 6 October 2026 (the V3 plan's Stage 7, switched on by the user within the $5 day): the
    // first answer a model gives that changes a trade already open, held to the narrowest form that
    // can. The main process reads the trade from the executors on file and refuses all but the app's
    // own open paper positions. The look in the renderer reads, asks and notifies, and writes
    // nothing. An EXIT is handed to the two files that write those trades, which find it among their
    // own paper positions and bring its time limit forward: the one field changed, and only ever made
    // shorter. No stop moves, nothing is opened, and nothing live is within reach.
    const rules = readFileSync(join(ROOT, 'shared', 'aiAdditions.ts'), 'utf-8')
    expect(rules).toContain("if (executor.mode !== 'paper' || executor.type !== 'position') return { ok: false, reason: 'it is not a paper position.' }")
    expect(readFileSync(join(SERVICES, 'aiAdditionsService.ts'), 'utf-8')).toContain(': exitTradeOf(executor)')

    // What an EXIT writes is arithmetic on one field.
    const exit = join(ROOT, 'shared', 'aiExit.ts')
    const exitSource = readFileSync(exit, 'utf-8')
    expect(importsOf(exit).sort()).toEqual(['aiAdditions', 'ipc', 'paperRisk'])
    // It sets no executor's status or mode: it stops nothing and makes nothing.
    expect(exitSource).not.toMatch(/window\.|ipcRenderer|electron|liveTrading|placeLive|setExecutors|status: '(active|stopped)'|mode: '/)
    expect(exitSource).toContain('if (plan <= limit) return null')
    expect(exitSource).toContain('params: { ...params, timeLimitSec: limit },')
    // The time limit brought forward, and the plan as it was: nothing else is set.
    expect(exitSource.match(/timeLimitSec:/g)).toHaveLength(2)

    // The two writers find the trade among their own paper positions, inside the queue, and write
    // the parameters it gives them.
    for (const [file, finder, mark] of [
      [join(ROOT, 'src', 'agents', 'watchPaperTrade.ts'), 'watchPaperExecutors(fresh.executors).find((entry) => entry.id === order.executorId)', 'watch'],
      [join(ROOT, 'src', 'news', 'newsPaperShort.ts'), 'newsShortExecutors(fresh.executors).find((entry) => entry.id === order.executorId)', 'newsRule']
    ] as const) {
      const source = readFileSync(file, 'utf-8')
      expect(source, file).toContain(finder)
      expect(source, file).toContain(`params: written.params, ${mark}: { ...current.${mark}, aiExit: written.mark }`)
    }

    // The look reads, asks and notifies. It writes nothing itself and fills in no form.
    const look = join(ROOT, 'src', 'agents', 'exitCheck.ts')
    const lookSource = readFileSync(look, 'utf-8')
    expect([...new Set([...lookSource.matchAll(/window\.api\.(\w+)(?:\s*\.\s*(\w+))?/g)].map((match) => (match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`)))].sort()).toEqual([
      'ai.exitCheck',
      'ai.getConfig',
      'market.fetchHistoricalRange',
      'notify',
      'settings.get'
    ])
    expect(lookSource).not.toMatch(/liveTrading|LiveTrading|liveOrders|placeLive|settings\.set|setExecutors|onPrepareOrder|aiProposal|mode:/)
    // Since 8 October 2026 the reading of a trade's minutes is openTradeReading.ts, shared with the
    // thesis status on Positions; the look still reaches the engine only through it.
    expect(importsOf(look).sort()).toEqual(['aiAdditions', 'aiCost', 'aiEventMarket', 'aiExit', 'ipc', 'newsPaperShort', 'notices', 'openTradeReading', 'paperRisk', 'watchPaperTrade'])
    expect(lookSource).toContain('ownOpenPaperTrades(executors)')
    const scheduler = join(ROOT, 'src', 'agents', 'ExitCheckScheduler.tsx')
    expect(readFileSync(scheduler, 'utf-8')).not.toMatch(/window\.api/)
    expect(importsOf(scheduler).sort()).toEqual(['exitCheck', 'react'])
    // What Performance shows of it reads the ledger, and the executors the page hands it.
    const card = join(ROOT, 'src', 'performance', 'ExitCheckCard.tsx')
    expect([...readFileSync(card, 'utf-8').matchAll(/window\.api\.(\w+)\.(\w+)/g)].map((match) => `${match[1]}.${match[2]}`)).toEqual(['ai.listCalls'])
  })

  it('the thesis status on Positions is a reading of the records, and nothing acts on it', () => {
    // Since 8 October 2026 (the V4 plan's Stage 5). The rule is pure (shared/thesisStatus.ts); the
    // reading of a trade's minutes is shared with the exit check (src/agents/openTradeReading.ts);
    // the measuring and the page read candles, the feed and the ledger, and write nothing, ask no
    // model, and open, size or close nothing. The live rows' label reads the watcher's copy.
    const rules = join(ROOT, 'shared', 'thesisStatus.ts')
    expect(importsOf(rules).sort()).toEqual(['aiAdditions', 'marketResearch', 'notices', 'paperNewsBlock'])
    expect(readFileSync(rules, 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron|liveTrading|placeLive|setExecutors/)
    const reading = join(ROOT, 'src', 'agents', 'openTradeReading.ts')
    expect(importsOf(reading).sort()).toEqual(['aiAdditions', 'aiEventMarket', 'engine', 'ipc', 'marketResearch'])
    expect(readFileSync(reading, 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron|liveTrading|placeLive|setExecutors|settings/)
    const measure = join(ROOT, 'src', 'positions', 'thesisMeasure.ts')
    expect(importsOf(measure).sort()).toEqual(['aiAdditions', 'aiEventMarket', 'ipc', 'marketResearch', 'openTradeReading', 'paperNewsBlock', 'paperRisk', 'thesisStatus'])
    expect(readFileSync(measure, 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron|liveTrading|placeLive|setExecutors|settings|closePosition/)
    const calls = (path: string): string[] => {
      const text = readFileSync(path, 'utf-8')
      return [...new Set([...text.matchAll(/window\.api\.(\w+)(?:\s*\.\s*(\w+))?/g)].map((match) => (match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`)))].sort()
    }
    expect(calls(join(ROOT, 'src', 'positions', 'useThesisReadings.ts'))).toEqual(['ai.listCalls', 'feed.getState', 'market.fetchHistoricalRange'])
    expect(calls(join(ROOT, 'src', 'positions', 'OwnPaperTradesCard.tsx'))).toEqual(['ai.listCalls'])
    expect(calls(join(ROOT, 'src', 'positions', 'ThesisChip.tsx'))).toEqual([])
    for (const name of ['useThesisReadings.ts', 'OwnPaperTradesCard.tsx', 'ThesisChip.tsx']) {
      const path = join(ROOT, 'src', 'positions', name)
      expect(readFileSync(path, 'utf-8'), path).not.toMatch(/liveTrading|LiveTrading|placeLive|settings\.set|setExecutors|settingsWrites|onPrepareOrder|aiProposal|closePosition|exitCheck|askOpportunity/)
    }
    // The page hands the live row its watcher's copy; the row's one real action, Close, is the
    // person's two clicks it was before.
    const row = join(ROOT, 'src', 'positions', 'LivePositionRow.tsx')
    expect(calls(row)).toEqual(['liveTrading.closePosition'])
    expect(readFileSync(row, 'utf-8')).toContain('thesis?: { watcher: LiveWatcherSummary; reading: ThesisReading | null } | null')
  })

  it('the expected value and the cost per trade are read from the records, and only ever refuse (8 October 2026)', () => {
    // The V4 plan's Stage 7. Both rules are arithmetic on the records: the ledger's rows and the
    // executors on file. The value refuses a paper trade of the watch's at a calibrated rate under
    // the round trip, and nothing else acts on either.
    const value = join(ROOT, 'shared', 'expectedValue.ts')
    expect(importsOf(value).sort()).toEqual(['aiLedger', 'fees', 'ipc', 'marketEvent'])
    expect(readFileSync(value, 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron|liveTrading|placeLive|setExecutors/)
    const cost = join(ROOT, 'shared', 'aiCostPerTrade.ts')
    expect(importsOf(cost).sort()).toEqual(['aiLedger', 'ipc'])
    expect(readFileSync(cost, 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron|liveTrading|placeLive|setExecutors/)
    const card = join(ROOT, 'src', 'performance', 'AiCostPerTradeCard.tsx')
    expect([...readFileSync(card, 'utf-8').matchAll(/window\.api\.(\w+)\.(\w+)/g)].map((match) => `${match[1]}.${match[2]}`)).toEqual(['ai.listCalls'])
    expect(readFileSync(card, 'utf-8')).not.toMatch(/liveTrading|LiveTrading|placeLive|settings\.set|setExecutors|settingsWrites|onPrepareOrder|aiProposal/)
    // The writer reads the ledger through the one namespace it already reaches, and the gate is
    // the block's, read before the reviewer is asked.
    const writer = readFileSync(join(ROOT, 'src', 'agents', 'watchPaperTrade.ts'), 'utf-8')
    expect(writer).toContain("rows = (await deps.listCalls({ source: 'watch', sinceSec: deps.nowSec() - EV_LINES.days * 86_400, limit: EV_ROWS })).rows")
    expect(writer.indexOf('const evBlock = expectedValueBlock(ev)')).toBeLessThan(writer.indexOf('review = await deps.review(event, decision)'))
  })

  it('the research on the record is arithmetic on the records, and the tab that shows it asks no model and acts on nothing (8 October 2026)', () => {
    // The V4 plan's Stage 9. Each builder in shared/research/ imports shared modules only and never
    // the window, the bridge or the main process; the tab reads the ledger, the events, the
    // executors, public candles and a history scan, saves a CSV through the export dialog, and
    // nothing more.
    const research = join(ROOT, 'shared', 'research')
    for (const name of readdirSync(research)) {
      const path = join(research, name)
      const source = readFileSync(path, 'utf-8')
      expect(source, path).not.toMatch(/window\.|ipcRenderer|electron|liveTrading|placeLive|setExecutors|settings\.set|\.\.\/\.\.\/src/)
    }
    const tab = join(ROOT, 'src', 'agents', 'ResearchTab.tsx')
    const calls = [...new Set([...readFileSync(tab, 'utf-8').matchAll(/window\.api\.(\w+)\.(\w+)/g)].map((match) => `${match[1]}.${match[2]}`))].sort()
    expect(calls).toEqual(['ai.getConfig', 'ai.listCalls', 'backtest.exportSave', 'market.fetchHistoricalRange', 'scanner.getState', 'scanner.listEvents', 'scanner.onHistoryProgress', 'scanner.scanHistory', 'settings.get'])
    expect(readFileSync(tab, 'utf-8')).not.toMatch(/liveTrading|LiveTrading|placeLive|settings\.set|setExecutors|settingsWrites|onPrepareOrder|aiProposal|askOpportunity|concludeMove|reviewTrade|\bexitCheck\b/)
  })

  it('the session report reads what the app did and changes none of it', () => {
    // Since 6 October 2026 (the V3 plan's Stage 8). It reads the records on file, the stream's log,
    // the alerts and the refusals, and the minute candles; it asks no model, writes no setting and
    // opens or closes nothing. Saving it writes a file a person names, through the export dialog.
    const rules = join(ROOT, 'shared', 'shadowReport.ts')
    expect(importsOf(rules).sort()).toEqual(['aiLedger', 'aiSignal', 'alerts', 'fees', 'ipc', 'liveMarket', 'marketEvent', 'paperRisk'])
    expect(readFileSync(rules, 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron|liveTrading|placeLive|setExecutors/)
    const calls = (path: string): string[] => {
      const text = readFileSync(path, 'utf-8')
      return [...new Set([...text.matchAll(/window\.api\.(\w+)(?:\s*\.\s*(\w+))?/g)].map((match) => (match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`)))].sort()
    }
    const reader = join(ROOT, 'src', 'performance', 'sessionReport.ts')
    expect(calls(reader)).toEqual([
      'ai.getConfig',
      'ai.listCalls',
      'effectiveConfig',
      'feed.getState',
      'market.fetchHistoricalRange',
      'market.liveState',
      'records.alerts',
      'records.refusals',
      'scanner.listEvents',
      'settings.get'
    ])
    const card = join(ROOT, 'src', 'performance', 'SessionReportCard.tsx')
    expect(calls(card)).toEqual(['backtest.exportSave'])
    for (const path of [reader, card]) {
      expect(readFileSync(path, 'utf-8'), path).not.toMatch(/liveTrading|LiveTrading|placeLive|settings\.set|setExecutors|settingsWrites|onPrepareOrder|aiProposal|askOpportunity|exitCheck|reviewTrade/)
    }
    // The refusals are a record kept in memory, which nothing reads to decide anything.
    const refusals = join(ROOT, 'src', 'agents', 'paperRefusals.ts')
    expect(importsOf(refusals)).toEqual([])
    expect(readFileSync(refusals, 'utf-8')).not.toMatch(/window\./)
  })

  it('"Does AI help?" counts trades already scored, with the strategies read from their own exports', () => {
    // Since 6 October 2026 (the second V3 document, §21 and §61): the quant and hybrid rows and the
    // three verdicts are worked out from answers already held, public candles and the stories on
    // file. Nothing here asks a model, and nothing here trades.
    const help = join(ROOT, 'shared', 'aiHelp.ts')
    expect(importsOf(help).sort()).toEqual(['aiEventBenchmark', 'aiOutcome', 'liveMarket', 'marketEvent', 'newsFeed'])
    expect(readFileSync(help, 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron\//)
    // The strategies' state is read from their exports, as the live strategy monitor reads it; and the
    // file that reads it reaches nothing through the bridge.
    const quant = join(ROOT, 'src', 'agents', 'quantState.ts')
    expect(importsOf(quant).sort()).toEqual(['aiEventBenchmark', 'engine', 'ipc', 'marketEvent', 'shortTermChannel', 'trendRegimeEnsemble'])
    const quantSource = readFileSync(quant, 'utf-8')
    expect(quantSource).not.toMatch(/window\.api|liveTrading|placeLive|onPrepareOrder/)
    expect(quantSource).toContain('regimeAgreement(bars, QUANTS.trend4h.barSeconds) : channelPositionSeries(bars)')
    expect(readFileSync(join(ROOT, 'src', 'agents', 'AiHelpCard.tsx'), 'utf-8')).not.toMatch(/window\.api|onPrepareOrder|aiProposal/)
    // The stories on file are read for it by the two pages that score, and by nothing else.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []
      )
    const historyReaders = walk(join(ROOT, 'src'))
      .filter((path) => /window\.api\.feed\.history\(/.test(readFileSync(path, 'utf-8')))
      .map((path) => path.slice(ROOT.length + 1).replace(/\\/g, '/'))
      .sort()
    // And since 8 October 2026 an experiment's report, for the same verdict over the run's span (V5 Stage 9).
    // And the attribution card (V5 Stage 10), for the news each closed trade's event had.
    expect(historyReaders).toEqual(['src/agents/EventBenchmarkView.tsx', 'src/agents/LiveBoardCard.tsx', 'src/ai-benchmark/experimentReport.ts', 'src/performance/AttributionCard.tsx'])
  })

  it('the opportunity score ranks and the cap on one side refuses; both are arithmetic', () => {
    // Since 6 October 2026 (the second V3 document, §20-24): shared/opportunityScore.ts ranks what is
    // on offer by fixed weights, and nothing is opened or refused by it; shared/paperExposure.ts
    // refuses one more of the app's own paper trades on one side, on coins that move with Bitcoin,
    // past its cap, and so only ever opens less. Neither makes, stops or places anything.
    const score = join(ROOT, 'shared', 'opportunityScore.ts')
    const exposure = join(ROOT, 'shared', 'paperExposure.ts')
    // The news analyst's reading of a story is one more observation the news part takes (a type).
    expect(importsOf(score).sort()).toEqual(['aiAdditions', 'aiOpportunity', 'marketEvent', 'marketResearch', 'newsFeed'])
    expect(importsOf(exposure).sort()).toEqual(['aiEventMarket', 'ipc', 'paperRisk'])
    for (const path of [score, exposure]) {
      expect(readFileSync(path, 'utf-8'), path).not.toMatch(/window\.|ipcRenderer|electron\/|liveTrading|placeLive|setExecutors|status: '|mode: /)
    }
    // Both writers refuse by the cap inside the queue, after the cap on what they have out together.
    for (const writer of [join(ROOT, 'src', 'agents', 'watchPaperTrade.ts'), join(ROOT, 'src', 'news', 'newsPaperShort.ts')]) {
      const source = readFileSync(writer, 'utf-8')
      const at = source.indexOf('paperOutBlock({')
      const next = source.indexOf('correlatedExposureBlock({', at)
      expect(at, writer).toBeGreaterThan(-1)
      expect(next, writer).toBeGreaterThan(at)
      expect(source.slice(at, next), writer).toMatch(/\}\) \?\?\s+$/)
    }
    // The score is shown and ranks by: nothing that asks a model or writes reads it.
    for (const file of ['watchPaperTrade.ts', 'opportunityWatch.ts', 'OpportunityScheduler.tsx']) {
      expect(importsOf(join(ROOT, 'src', 'agents', file)), file).not.toContain('opportunityScore')
    }
    expect(importsOf(join(ROOT, 'src', 'news', 'newsPaperShort.ts'))).not.toContain('opportunityScore')
  })

  it('the daily paper digest reads settings and says so, and nothing else', () => {
    // Once a day a notice says what the app's own paper trades did the day before. It is a reading of
    // the executors on file: the rules are arithmetic, and the scheduler reaches settings -- to read
    // them and to mark the day told -- and the notice, and nothing that opens, closes or asks.
    const rules = join(ROOT, 'shared', 'paperDigest.ts')
    // R is paperRisk's arithmetic: what a trade made over what its stop would have lost.
    expect(importsOf(rules).sort()).toEqual(['ipc', 'paperRisk'])
    expect(readFileSync(rules, 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron|liveTrading|placeLive/)
    const scheduler = join(ROOT, 'src', 'risk', 'PaperDigestScheduler.tsx')
    const source = readFileSync(scheduler, 'utf-8')
    expect([...new Set([...source.matchAll(/window\.api\.(\w+)(?:\s*\.\s*(\w+))?/g)].map((match) => (match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`)))].sort()).toEqual([
      'notify',
      'settings.get',
      'settings.set'
    ])
    expect(importsOf(scheduler).sort()).toEqual(['paperDigest', 'react', 'settingsWrites'])
    // What it writes is the day it told, beside the switch, and nothing else: never the executors.
    expect(source.match(/window\.api\.settings\.set\(/g)).toHaveLength(1)
    expect(source).toContain('window.api.settings.set({ paperDigest: { ...setting, lastDay: plan.day } })')
  })

  it("a losing run pauses the app's own paper trades: arithmetic the two that open them refuse by, written down by a scheduler that writes nothing else", () => {
    // Since 5 October 2026 a losing run in R pauses the watch's paper trades, or the news rules',
    // until they are resumed on Risk & Safety. It only ever opens less. The rules are arithmetic on
    // the results on file; each writer refuses by them inside the queue, where the trade would be
    // written; and the scheduler writes the pause down and says so -- never the executors, and it
    // closes nothing.
    const rules = join(ROOT, 'shared', 'paperPause.ts')
    // R is paperRisk's arithmetic: what a trade made over what its stop would have lost.
    expect(importsOf(rules).sort()).toEqual(['ipc', 'paperRisk'])
    const source = readFileSync(rules, 'utf-8')
    expect(source).not.toMatch(/window\.|ipcRenderer|electron|liveTrading|placeLive/)
    // It makes no executor and stops none.
    expect(source).not.toMatch(/status: '|setExecutors|mode: /)
    const writers = [
      [join(ROOT, 'src', 'agents', 'watchPaperTrade.ts'), 'watch'],
      [join(ROOT, 'src', 'news', 'newsPaperShort.ts'), 'news']
    ] as const
    for (const [writer, side] of writers) {
      expect(readFileSync(writer, 'utf-8'), writer).toContain(`paperPauseBlock({ setting: healPaperPause(fresh.paperPause), executors: fresh.executors, source: '${side}' })`)
    }
    const scheduler = join(ROOT, 'src', 'risk', 'PaperPauseScheduler.tsx')
    const watching = readFileSync(scheduler, 'utf-8')
    expect([...new Set([...watching.matchAll(/window\.api\.(\w+)(?:\s*\.\s*(\w+))?/g)].map((match) => (match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`)))].sort()).toEqual([
      'notify',
      'settings.get',
      'settings.set'
    ])
    expect(importsOf(scheduler).sort()).toEqual(['paperPause', 'react', 'settingsWrites'])
    expect(watching.match(/window\.api\.settings\.set\(/g)).toHaveLength(1)
    expect(watching).toContain('window.api.settings.set({ paperPause: plan.setting })')
  })

  it('the running total in R of the app\'s own paper trades is drawn from what it is handed', () => {
    // Performance draws the watch's and the news rules' paper trades as a running total in R. The
    // arithmetic is a reading of results on file; the card is handed the executors by the page and
    // reaches nothing through the bridge itself.
    const rules = join(ROOT, 'shared', 'paperRCurve.ts')
    expect(importsOf(rules).sort()).toEqual(['ipc', 'paperRisk'])
    expect(readFileSync(rules, 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron|liveTrading|placeLive/)
    const card = readFileSync(join(ROOT, 'src', 'performance', 'PaperRCurveCard.tsx'), 'utf-8')
    expect(card).not.toMatch(/window\.api|liveTrading|placeLive|onPrepareOrder/)
  })

  it('the essentials on Settings read the gates and change only what is safe in one click', () => {
    // The six settings at the top of Settings (the second V3 document, 6 October 2026). The card
    // reads the live session's gates to say whether live trading is ready or active, and never
    // changes them: arming and the kill switch stay on the bar, the limits on Risk & Safety, and the
    // watch on Opportunities behind its priced confirmation. It writes three things: the scanner's
    // switch and pairs, the desktop notices, and the paper settings put back to Conservative, which
    // only ever open less.
    const card = join(ROOT, 'src', 'settings', 'EssentialsCard.tsx')
    const source = readFileSync(card, 'utf-8')
    expect([...new Set([...source.matchAll(/window\.api\.(\w+)\.(\w+)/g)].map((match) => `${match[1]}.${match[2]}`))].sort()).toEqual([
      'ai.credentialsStatus',
      'ai.getConfig',
      'credentials.list',
      'liveTrading.getStatus',
      'scanner.getState',
      'scanner.setConfig',
      'settings.get',
      'settings.set'
    ])
    expect(source).not.toMatch(/onPrepareOrder|aiProposal|placeLive|setSessionArmed|KillSwitch|liveTrading\.setConfig|ai\.setConfig|window\.api\.executors/)
    // Three since 8 October 2026 (V5 Stage 2): the third is the tray's switch, which only ever
    // changes what closing the window does (shared/keepRunning.ts). Four since 13 October 2026 (V6
    // Stage 1): the fourth is the sidebar's layout, which changes nothing the app does.
    expect(source.match(/window\.api\.settings\.set\(/g)).toHaveLength(4)
    expect(source).toContain('window.api.settings.set({ alerts: { ...healAlerts(fresh.alerts), ...patch } })')
    expect(source).toContain('window.api.settings.set({ keepRunningWhenClosed: next })')
    expect(source).toContain('window.api.settings.set({ uiMode: next })')
    expect(source).toContain('window.api.settings.set(conservativePaper(healPaperPause(fresh.paperPause)))')
    // The page it sits on still mentions no bridge an order travels over (held above, for routes).
    expect(readFileSync(join(ROOT, 'src', 'settings', 'SettingsPanel.tsx'), 'utf-8')).not.toMatch(/liveTrading|LiveTrading|placeLive/)
    // Every desktop notice obeys the notifications setting, read where the notice is raised.
    // Since 8 October 2026 one service tells every notice (noticeService.ts): it reads the setting,
    // keeps the threads and records what it told; the handler only hands it what the window sent.
    expect(importsOf(join(ROOT, 'electron', 'ipc', 'handlers', 'appHandlers.ts')).sort()).toEqual(['electron', 'ipc', 'noticeService', 'pingService'])
    expect(importsOf(join(SERVICES, 'noticeService.ts')).sort()).toEqual(['alerts', 'electron', 'ipc', 'recordStoreService', 'settingsService'])
    // Since 8 October 2026 (V5 Stage 1) it composes DEFAULT_CONFIG from every store's default
    // constant: each a module of constants and heals, none of them trading, holding a key or asking.
    expect(importsOf(join(ROOT, 'shared', 'appDefaults.ts')).sort()).toEqual([
      'aiAdditions',
      'aiPace',
      'aiSignal',
      'aiWatch',
      'aiWatchPaper',
      'alerts',
      'hardLimits',
      'ipc',
      'keepRunning',
      'liveLimits',
      'marketScanner',
      'news',
      'paperDigest',
      'paperPause',
      'paperRisk',
      'uiMode'
    ])
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

  it("a trade's timeline reads what is on file and writes nothing", () => {
    // It opens on a watch paper trade's card and on a journal row, and joins records that already
    // exist: the event, the answers about it, the paper executor and its candles. It offers no call
    // to an order form, writes no setting, and mentions no bridge a real order travels over.
    const component = join(ROOT, 'src', 'agents', 'TradeTimeline.tsx')
    const loader = join(ROOT, 'src', 'agents', 'watchTradeRecords.ts')
    const rules = join(ROOT, 'shared', 'tradeLifecycle.ts')
    for (const path of [component, loader, rules]) {
      const source = readFileSync(path, 'utf-8')
      expect(source, path).not.toMatch(/liveTrading|LiveTrading|liveOrders|placeLive|window\.api\.(executors|trade|paper|credentials)/)
      expect(source, path).not.toMatch(/onPrepareOrder|buildOpportunityProposal|buildAiProposal|settings\.set|settingsWrites/)
      expect(importsOf(path), path).not.toContain('aiProposal')
    }
    const source = readFileSync(component, 'utf-8')
    expect([...source.matchAll(/window\.api\.(\w+)\.(\w+)/g)].map((match) => `${match[1]}.${match[2]}`).sort()).toEqual([
      'ai.listCalls',
      'market.fetchHistoricalRange',
      // The refusals on file (since 8 October 2026): the reason a call got no paper position.
      'records.refusals',
      'scanner.listEvents',
      'settings.get'
    ])
    expect(readFileSync(loader, 'utf-8')).not.toMatch(/window\.|ipcRenderer/)
    // aiOpportunityOutcome, fees and opportunities: the recommendation's own score on minute bars,
    // set beside where the paper position filled (since 8 October 2026). All of it reads.
    expect(importsOf(loader).sort()).toEqual(['aiLedger', 'aiOpportunityOutcome', 'aiWatchPaper', 'engine', 'fees', 'ipc', 'marketScanner', 'opportunities', 'records', 'tradeLifecycle'])
    expect(readFileSync(rules, 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron/)
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
