import { useEffect, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { ErrorBoundary } from './components/ErrorBoundary'
import { HomePage } from './home/HomePage'
import { PredictionsPage } from './forecast/PredictionsPage'
import { ForecastLabPage } from './forecastLab/ForecastLabPage'
import { OverviewPage } from './overview/OverviewPage'
import { OpportunitiesPage } from './opportunities/OpportunitiesPage'
import { Dashboard } from './dashboard/Dashboard'
import { AiDecisionsPage } from './ai-decisions/AiDecisionsPage'
import { PositionsPage } from './positions/PositionsPage'
import { PerformancePage } from './performance/PerformancePage'
import { PaperTradingPage } from './trading/PaperTradingPage'
import { LiveTradingPage } from './trading/LiveTradingPage'
import { StrategiesPage } from './strategies/StrategiesPage'
import { ResearchPage } from './research/ResearchPage'
import { AiBenchmarkPage } from './ai-benchmark/AiBenchmarkPage'
import { ExplorerPage } from './explorer/ExplorerPage'
import { RiskSafetyPage } from './risk/RiskSafetyPage'
import { ConnectionsPage } from './connections/ConnectionsPage'
import { SettingsPanel } from './settings/SettingsPanel'
import { ControllerScheduler } from './controllers/ControllerScheduler'
import { OpportunityScheduler } from './agents/OpportunityScheduler'
import { ForecastTraderScheduler } from './forecast/ForecastTraderScheduler'
import { LabTraderScheduler } from './forecast/LabTraderScheduler'
import { ExitCheckScheduler } from './agents/ExitCheckScheduler'
import { ModelHealthScheduler } from './agents/ModelHealthScheduler'
import { StrategyHealthScheduler } from './bots/StrategyHealthScheduler'
import { ExperimentScheduler } from './ai-benchmark/ExperimentScheduler'
import { NewsScheduler } from './news/NewsScheduler'
import { NewsAlertScheduler } from './news/NewsAlertScheduler'
import { AlertBanner } from './news/AlertBanner'
import { NoticeSounds } from './sound/NoticeSounds'
import { NoticeToasts } from './sound/NoticeToasts'
import { WhyItMovedHost } from './news/WhyItMovedHost'
import { subscribeAlerts, unseenCount } from './news/alertStore'
import { PaperDigestScheduler } from './risk/PaperDigestScheduler'
import { DailySummaryScheduler } from './performance/DailySummaryScheduler'
import { PaperPauseScheduler } from './risk/PaperPauseScheduler'
import { RoutineScheduler } from './routines/RoutineScheduler'
import { LiveTradingBar } from './livetrading/LiveTradingBar'
import { LiveOrderScheduler } from './livetrading/LiveOrderScheduler'
import { PortfolioScheduler } from './portfolio/PortfolioScheduler'
import { DEFAULT_PAGE, DEFAULT_TABS, activeNavId, anchorElementId, pageLabel, type NavAnchor, type NavId, type NavItem, type NavTarget, type Page, type PageTabs } from './navigation/pages'
import type { AiOrderProposal } from '../shared/aiProposal'
import { DEFAULT_UI_MODE, healUiMode, type UiMode } from '../shared/uiMode'
import { EnglishOnly, I18nProvider, healLanguage, languageForLocales, msg, type Language } from './i18n'
import { LanguageChooser } from './i18n/LanguageChooser'

/** The pages shown in the window's language (V6 Stage 14); every other stays English. */
const TRANSLATED_PAGES: ReadonlySet<Page> = new Set<Page>(['home', 'predictions', 'opportunities', 'positions', 'performance', 'settings'])

/** When an entry that opens at a part of a page scrolls to it, after the page is drawn. */
const ANCHOR_SCROLL_MS = [0, 250, 700, 1500]

function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>(DEFAULT_PAGE)
  // The view each page with more than one is showing. Held here rather than in the page, so a
  // hand-off from another page can open it on the view it needs.
  const [tabs, setTabs] = useState<PageTabs>(DEFAULT_TABS)
  // The sidebar entry last chosen: several entries open one page (Strategies, Bots, Executors), and
  // the one chosen is the one shown as current while it still describes where the app is.
  const [chosenNav, setChosenNav] = useState<NavId | null>(null)
  // A part of a page an entry opens at, scrolled to once the page has drawn.
  const [pendingAnchor, setPendingAnchor] = useState<NavAnchor | null>(null)
  const [uiMode, setUiMode] = useState<UiMode>(DEFAULT_UI_MODE)
  // The language of the normal-user pages and the notices (V6 Stage 14): English until settings are
  // read; none on file, and the first launch asks, offering the computer's (the V6 document, §87).
  const [language, setLanguage] = useState<Language>('en')
  const [askLanguage, setAskLanguage] = useState(false)
  useEffect(() => {
    window.api.settings.get().then(
      (settings) => {
        setUiMode(healUiMode(settings.uiMode))
        const chosen = healLanguage(settings.language)
        if (chosen === null) setAskLanguage(true)
        else setLanguage(chosen)
      },
      () => undefined
    )
  }, [])
  async function chooseLanguage(next: Language): Promise<void> {
    await window.api.settings.set({ language: next })
    setLanguage(next)
    setAskLanguage(false)
  }
  useEffect(() => {
    if (pendingAnchor === null) return
    // Scrolled to again as the page settles: the cards above a part load their data after the first
    // paint and grow, pushing it down. A person scrolling or typing in the meantime stops it.
    const id = anchorElementId(pendingAnchor)
    let stopped = false
    const stop = (): void => {
      stopped = true
    }
    window.addEventListener('wheel', stop, { passive: true })
    window.addEventListener('keydown', stop)
    window.addEventListener('pointerdown', stop)
    const timers = ANCHOR_SCROLL_MS.map((delay) =>
      setTimeout(() => {
        if (!stopped) document.getElementById(id)?.scrollIntoView({ block: 'start' })
      }, delay)
    )
    const done = setTimeout(() => setPendingAnchor(null), ANCHOR_SCROLL_MS[ANCHOR_SCROLL_MS.length - 1] + 100)
    return (): void => {
      for (const timer of timers) clearTimeout(timer)
      clearTimeout(done)
      window.removeEventListener('wheel', stop)
      window.removeEventListener('keydown', stop)
      window.removeEventListener('pointerdown', stop)
    }
  }, [page, pendingAnchor])
  // Set when Overview's first-run card is clicked, cleared as soon as Execution has acted on it.
  const [presetsRequested, setPresetsRequested] = useState(false)
  // Set when a model's call is turned into an order form on Overview, Opportunities, AI Decisions
  // or a running bot, cleared as soon as Execution has opened that form. What crosses between pages is
  // a filled-in form, never an order: see shared/aiProposal.ts.
  const [orderProposal, setOrderProposal] = useState<AiOrderProposal | null>(null)
  /** With the proposal: it was confirmed (CONFIRM), so the form opens as a real order where allowed. */
  const [orderLive, setOrderLive] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  // Alerts at WATCH or above not yet seen: the badge on Explorer, which opens on its news while any
  // is waiting.
  const [unseenAlerts, setUnseenAlerts] = useState(0)
  useEffect(() => subscribeAlerts((alerts) => setUnseenAlerts(unseenCount(alerts))), [])

  function navigate(target: NavTarget | Page): void {
    if (typeof target === 'string') {
      setPage(target)
      return
    }
    setPage(target.page)
    if (target.anchor !== undefined) setPendingAnchor(target.anchor)
    if (target.page === 'strategies' && target.tab !== undefined) {
      const tab = target.tab
      setTabs((current) => ({ ...current, strategies: tab }))
    } else if (target.page === 'research' && target.tab !== undefined) {
      const tab = target.tab
      setTabs((current) => ({ ...current, research: tab }))
    } else if (target.page === 'ai-decisions' && target.tab !== undefined) {
      const tab = target.tab
      setTabs((current) => ({ ...current, 'ai-decisions': tab }))
    } else if (target.page === 'discovery' && target.tab !== undefined) {
      const tab = target.tab
      setTabs((current) => ({ ...current, discovery: tab }))
    }
  }

  // The same hand-over from every place a call is shown: Overview, Opportunities, AI Decisions, a
  // running bot. The form is on Strategies › Execution.
  function prepareOrder(proposal: AiOrderProposal, live = false): void {
    setOrderLive(live)
    setOrderProposal(proposal)
    navigate({ page: 'strategies', tab: 'execution' })
  }

  function openPresets(): void {
    setPresetsRequested(true)
    navigate({ page: 'strategies', tab: 'execution' })
  }

  /** A sidebar entry chosen. Explorer opens on its news while an alert there is unseen. */
  function choose(item: NavItem): void {
    setChosenNav(item.id)
    navigate(item.target.page === 'discovery' && unseenAlerts > 0 ? { page: 'discovery', tab: 'news' } : item.target)
  }

  return (
    <I18nProvider language={language}>
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Each headless scheduler gets its own boundary: LiveOrderScheduler is the only thing that
          reconciles resolved real orders and watcher exits back into settings, so it must not be
          able to take the kill switch or the rest of the UI down with it -- and if it does die,
          its fallback panel is visible rather than silent, because a dead reconciler means real
          fills stop being recorded. */}
      <ErrorBoundary label={msg("The routine scheduler")}>
        <RoutineScheduler />
      </ErrorBoundary>
      <ErrorBoundary label={msg("The controller scheduler")}>
        <ControllerScheduler />
      </ErrorBoundary>
      <ErrorBoundary label={msg("The live order scheduler")}>
        <LiveOrderScheduler />
      </ErrorBoundary>
      <ErrorBoundary label={msg("The portfolio scheduler")}>
        <PortfolioScheduler />
      </ErrorBoundary>
      {/* The watch: off unless switched on from Opportunities. It asks models; it has no way to
          place anything, and what it opens by itself is paper. */}
      <ErrorBoundary label={msg("The opportunity watch")}>
        <OpportunityScheduler />
        <ForecastTraderScheduler />
        <LabTraderScheduler />
      </ErrorBoundary>
      {/* The exit check: only while the watch is on, and only the app's own paper trades. Its EXIT
          closes one at the next minute, on paper; it never moves a stop or touches a live one. */}
      <ErrorBoundary label={msg("The exit check")}>
        <ExitCheckScheduler />
      </ErrorBoundary>
      {/* The daily look at each model's health: a DEGRADED mark and one notice a day. It asks
          nothing and switches nothing off. */}
      <ErrorBoundary label={msg("The models' health")}>
        <ModelHealthScheduler />
      </ErrorBoundary>
      {/* The hourly look at each running bot's health, for the bots that ask no model: a DEGRADED
          one is told once a day, whether or not Strategies is open. It stops nothing. */}
      <ErrorBoundary label={msg("The strategies' health")}>
        <StrategyHealthScheduler />
      </ErrorBoundary>
      {/* The report of an experiment that has ended, built from the records and filed on its run
          (shared/experimentRun.ts). It asks nothing and opens nothing. */}
      <ErrorBoundary label={msg("The experiments' reports")}>
        <ExperimentScheduler />
      </ErrorBoundary>
      {/* What a delisting does: a notice to someone holding the coin, and the rule's paper short.
          Off unless the news reader is on; nothing it does is real. */}
      <ErrorBoundary label={msg("The news reader's actions")}>
        <NewsScheduler />
      </ErrorBoundary>
      {/* Once a day, a notice of what the watch's and the news rules' paper trades did the day
          before. It reads settings and says so; it opens and closes nothing. */}
      <ErrorBoundary label={msg("The daily paper digest")}>
        <PaperDigestScheduler />
      </ErrorBoundary>
      {/* Once a day after 00:05 UTC, while the watch is on: the day before's report put to a model
          for one paragraph, the fifth AI addition. It reads, builds and asks; it writes nothing. */}
      <ErrorBoundary label={msg("The daily summary")}>
        <DailySummaryScheduler />
      </ErrorBoundary>
      {/* After a losing run, the watch's or the news rules' paper trades are paused until resumed
          on Risk & Safety. It writes the pause and says so; it opens and closes nothing. */}
      <ErrorBoundary label={msg("The losing-run pause")}>
        <PaperPauseScheduler />
      </ErrorBoundary>
      {/* The news feed's alerts and Bitcoin's falls, by severity: a notice, a badge, and for the
          critical ones a banner. It reads and tells; it opens, closes and sells nothing. */}
      <ErrorBoundary label={msg("The news alerts")}>
        <NewsAlertScheduler />
      </ErrorBoundary>
      {/* The live trading bar is Live Trading's, an expert page's: English, left to right, in any window. */}
      <ErrorBoundary label={msg("The live trading bar")}>
        <EnglishOnly>
          <LiveTradingBar />
        </EnglishOnly>
      </ErrorBoundary>
      <ErrorBoundary label={msg("The alert banner")}>
        <AlertBanner />
        <NoticeSounds />
        <NoticeToasts />
      </ErrorBoundary>
      <ErrorBoundary label={msg("Why did it move")}>
        <WhyItMovedHost />
      </ErrorBoundary>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <ErrorBoundary label={msg("The sidebar")}>
          <Sidebar
            activeId={activeNavId(page, tabs, chosenNav)}
            onChoose={choose}
            collapsed={collapsed}
            onToggleCollapsed={() => setCollapsed((c) => !c)}
            uiMode={uiMode}
            badges={{ discovery: unseenAlerts }}
          />
        </ErrorBoundary>
        <main
          style={{
            flex: 1,
            overflow: 'auto',
            minWidth: 0,
            padding: '1.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.25rem'
          }}
        >
          {/* Keyed by page so navigating away from a broken page and back retries it, rather than
              the boundary latching its error for the rest of the session. */}
          <ErrorBoundary key={page} label={msg('The {page} page')} page={pageLabel(page)}>
            {page === 'home' && <HomePage onPrepareOrder={prepareOrder} onNavigate={navigate} />}
            {page === 'predictions' && <PredictionsPage onPrepareOrder={prepareOrder} />}
            {page === 'opportunities' && <OpportunitiesPage onPrepareOrder={prepareOrder} />}
            {page === 'positions' && <PositionsPage />}
            {page === 'performance' && <PerformancePage />}
            {page === 'settings' && <SettingsPanel onNavigate={navigate} onUiModeChange={setUiMode} onLanguageChange={setLanguage} />}
            {/* The pages not translated (the user's answer of 13 October 2026: the normal-user pages are)
                stay English, left to right, inside any window. A translated part of one -- the Position
                form -- brings the window's language back itself. */}
            {!TRANSLATED_PAGES.has(page) && (
            <EnglishOnly>
            {page === 'overview' && <OverviewPage onGetStarted={openPresets} onPrepareOrder={prepareOrder} onNavigate={navigate} />}
            {page === 'markets' && <Dashboard />}
            {page === 'ai-decisions' && (
              <AiDecisionsPage
                tab={tabs['ai-decisions']}
                onTab={(tab) => setTabs((current) => ({ ...current, 'ai-decisions': tab }))}
                onPrepareOrder={prepareOrder}
              />
            )}
            {page === 'paper-trading' && <PaperTradingPage />}
            {page === 'live-trading' && <LiveTradingPage onNavigate={navigate} />}
            {page === 'strategies' && (
              <StrategiesPage
                tab={tabs.strategies}
                onTab={(tab) => setTabs((current) => ({ ...current, strategies: tab }))}
                onPrepareOrder={prepareOrder}
                autoOpenPresets={presetsRequested}
                onPresetsOpened={() => setPresetsRequested(false)}
                proposal={orderProposal}
                proposalLive={orderLive}
                onProposalTaken={() => setOrderProposal(null)}
              />
            )}
            {page === 'research' && <ResearchPage tab={tabs.research} onTab={(tab) => setTabs((current) => ({ ...current, research: tab }))} />}
            {page === 'ai-benchmark' && <AiBenchmarkPage />}
            {page === 'forecast-lab' && <ForecastLabPage />}
            {page === 'discovery' && (
              <ExplorerPage tab={tabs.discovery} onTab={(tab) => setTabs((current) => ({ ...current, discovery: tab }))} onNavigate={navigate} />
            )}
            {page === 'risk' && <RiskSafetyPage />}
            {page === 'connections' && <ConnectionsPage />}
            </EnglishOnly>
            )}
          </ErrorBoundary>
        </main>
      </div>
    </div>
    {askLanguage && <LanguageChooser offered={languageForLocales(navigator.languages)} onChoose={chooseLanguage} />}
    </I18nProvider>
  )
}

export default App
