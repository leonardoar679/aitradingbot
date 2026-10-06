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
    expect(importsOf(rules).sort()).toEqual(['aiEventMarket', 'ipc', 'marketScanner'])
    expect(readFileSync(rules, 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron/)
    const views = [join(ROOT, 'src', 'hooks', 'useMarketResearch.ts'), join(ROOT, 'src', 'overview', 'MarketStatusStrip.tsx'), join(ROOT, 'src', 'dashboard', 'MoversCard.tsx')]
    for (const path of views) {
      const source = readFileSync(path, 'utf-8')
      expect([...new Set([...source.matchAll(/window\.api\.(\w+)/g)].map((match) => match[1]))], path).toEqual(path.endsWith('useMarketResearch.ts') ? ['research'] : [])
      expect(source, path).not.toMatch(/liveTrading|LiveTrading|placeLive|onPrepareOrder|aiProposal/)
    }
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
    expect(importsOf(join(SERVICES, 'liveMarketService.ts')).sort()).toEqual(['binance', 'ipc', 'liveMarket', 'marketService', 'reconnectingSocket', 'settingsService', 'ws'])
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
    expect(importsOf(join(SERVICES, 'newsService.ts')).sort()).toEqual(['atomicWrite', 'electron', 'jsonlStore', 'marketScannerService', 'news', 'newsActions', 'path', 'promises'])
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
      // ...and the event is raised through the scanner, from the coin's own candles.
      'electron/services/marketScannerService.ts',
      // The news feed (the second V3 document, 6 October 2026): Binance's announcements as stories,
      // beside four free media feeds.
      'electron/services/newsFeedService.ts',
      // The record of the two rules since the study, and of the two near misses: Binance's and
      // Upbit's lists and the coins' candles, scored.
      'electron/services/newsRecordService.ts',
      'electron/services/newsService.ts',
      'shared/news.ts',
      'shared/newsActions.ts',
      'shared/newsRecord.ts',
      // Upbit's patterns, for the near miss on record: they drop the pegged coins Binance's do.
      'shared/upbitTitles.ts',
      'src/App.tsx',
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
      expect(readFileSync(join(ROOT, file), 'utf-8'), file).not.toMatch(/window\.api\.ai\b|aiProposal|onPrepareOrder/)
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
    expect(importsOf(join(SERVICES, 'newsFeedService.ts')).sort()).toEqual(['electron', 'jsonlStore', 'marketService', 'news', 'newsFeed', 'newsService', 'path', 'promises', 'singleFlight'])
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
      [join(ROOT, 'src', 'news', 'AlertBanner.tsx'), ['feed.openLink']],
      // The opportunities table opens a story on the coin, as the news tab does.
      [join(ROOT, 'src', 'agents', 'OpportunityTableCard.tsx'), ['feed.openLink']],
      // It reads what is held -- the settings and the balances a key can read -- and the live
      // stream's Bitcoin, and tells.
      [
        join(ROOT, 'src', 'news', 'NewsAlertScheduler.tsx'),
        ['credentials.balances', 'credentials.list', 'feed.getState', 'feed.onUpdate', 'market.liveState', 'notify', 'settings.get']
      ]
    ]
    for (const [path, expected] of views) {
      expect(calls(path), path).toEqual(expected)
      expect(readFileSync(path, 'utf-8'), path).not.toMatch(/liveTrading|LiveTrading|placeLive|onPrepareOrder|aiProposal|settings\.set|window\.api\.ai\b/)
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
    // The rules read a coin's usual move with the detector's arithmetic, which imports types alone.
    expect(importsOf(rules).sort()).toEqual(['ipc', 'liveBalances', 'marketEvent', 'news', 'newsRules'])
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
    // one after a losing run: arithmetic, which only ever opens less (held below).
    expect(importsOf(writer).sort()).toEqual(['engine', 'executorFunding', 'ipc', 'news', 'newsActions', 'paperExposure', 'paperPause', 'paperRisk', 'settingsWrites', 'settleExecutor'])
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
      'settings.get'
    ])
    expect(importsOf(scheduler).sort()).toEqual(['news', 'newsActions', 'newsPaperShort', 'react'])
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
    // The scheduler reaches the same six things through the bridge as before. The paper trader is
    // handed to it whole, from the one file that writes.
    const scheduler = readFileSync(join(ROOT, 'src', 'agents', 'OpportunityScheduler.tsx'), 'utf-8')
    // The third read of the scanner is the second look at an event whose candles could not be read.
    expect([...scheduler.matchAll(/window\.api\.(\w+)/g)].map((match) => match[1]).sort()).toEqual(['ai', 'ai', 'ai', 'market', 'notify', 'scanner', 'scanner', 'scanner'])
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
    // The rules import the proposal's arithmetic, the sizing's (paperRisk), the losing run's words
    // for the confirmation (paperPause), a few names and types, and nothing that acts.
    expect(importsOf(rules).sort()).toEqual(['aiOpportunity', 'aiPanel', 'aiProposal', 'aiSignal', 'ipc', 'marketEvent', 'paperPause', 'paperRisk'])
    expect(readFileSync(rules, 'utf-8')).not.toMatch(/window\.|ipcRenderer|electron/)
    // The writer reaches settings, the price, candles, a notice and the setting. Nothing else.
    expect([...new Set([...source.matchAll(/window\.api\.(\w+)/g)].map((match) => match[1]))].sort()).toEqual(['ai', 'market', 'notify', 'settings'])
    // And it is the only file of the watch's that reaches settings at all.
    const others = ['opportunityWatch.ts', 'OpportunityScheduler.tsx', 'WatchCard.tsx', 'liveBoard.ts', 'LiveBoardCard.tsx', 'opportunityTable.ts', 'OpportunityTableCard.tsx']
    for (const file of others) expect(readFileSync(join(ROOT, 'src', 'agents', file), 'utf-8'), file).not.toMatch(/window\.api\.settings/)
  })

  it('a paper trade of the watch\'s is closed with paper bookkeeping and nothing else', () => {
    // Stopping one and booking its result is what pressing Stop on its card does. The two things
    // the writer calls to do it are the paper account's own, and each refuses a real executor
    // before it does anything.
    const writer = readFileSync(join(ROOT, 'src', 'agents', 'watchPaperTrade.ts'), 'utf-8')
    // aiEventMarket names Bitcoin's pair, whose minutes the Bitcoin safeguard reads; it is arithmetic.
    expect(importsOf(join(ROOT, 'src', 'agents', 'watchPaperTrade.ts')).sort()).toEqual([
      'aiCost',
      'aiEventMarket',
      'aiSignal',
      'aiWatchPaper',
      'engine',
      'executorFunding',
      'ipc',
      'liveMarket',
      'marketEvent',
      'paperExposure',
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
    expect(source).toContain('return Math.min(stakeQuote, ')
    // The card on Risk & Safety reads and saves the setting, and reaches nothing else.
    const card = readFileSync(join(ROOT, 'src', 'risk', 'PaperRiskCard.tsx'), 'utf-8')
    expect([...new Set([...card.matchAll(/window\.api\.(\w+)(?:\s*\.\s*(\w+))?/g)].map((match) => `${match[1]}.${match[2]}`))].sort()).toEqual(['settings.get', 'settings.set'])
    expect(card).not.toMatch(/liveTrading|placeLive|window\.api\.(executors|ai|credentials)/)
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
    expect(historyReaders).toEqual(['src/agents/EventBenchmarkView.tsx', 'src/agents/LiveBoardCard.tsx'])
  })

  it('the opportunity score ranks and the cap on one side refuses; both are arithmetic', () => {
    // Since 6 October 2026 (the second V3 document, §20-24): shared/opportunityScore.ts ranks what is
    // on offer by fixed weights, and nothing is opened or refused by it; shared/paperExposure.ts
    // refuses one more of the app's own paper trades on one side, on coins that move with Bitcoin,
    // past its cap, and so only ever opens less. Neither makes, stops or places anything.
    const score = join(ROOT, 'shared', 'opportunityScore.ts')
    const exposure = join(ROOT, 'shared', 'paperExposure.ts')
    expect(importsOf(score).sort()).toEqual(['aiOpportunity', 'marketEvent', 'marketResearch', 'newsFeed'])
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
    expect(source.match(/window\.api\.settings\.set\(/g)).toHaveLength(2)
    expect(source).toContain('window.api.settings.set({ alerts: { ...healAlerts(fresh.alerts), ...patch } })')
    expect(source).toContain('window.api.settings.set(conservativePaper(healPaperPause(fresh.paperPause)))')
    // The page it sits on still mentions no bridge an order travels over (held above, for routes).
    expect(readFileSync(join(ROOT, 'src', 'settings', 'SettingsPanel.tsx'), 'utf-8')).not.toMatch(/liveTrading|LiveTrading|placeLive/)
    // Every desktop notice obeys the notifications setting, read where the notice is raised.
    expect(importsOf(join(ROOT, 'electron', 'ipc', 'handlers', 'appHandlers.ts')).sort()).toEqual(['alerts', 'electron', 'ipc', 'pingService', 'settingsService'])
    expect(importsOf(join(ROOT, 'shared', 'appDefaults.ts')).sort()).toEqual(['ipc', 'paperPause', 'paperRisk'])
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
      'scanner.listEvents',
      'settings.get'
    ])
    expect(readFileSync(loader, 'utf-8')).not.toMatch(/window\.|ipcRenderer/)
    expect(importsOf(loader).sort()).toEqual(['aiLedger', 'aiWatchPaper', 'engine', 'ipc', 'marketScanner', 'tradeLifecycle'])
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
