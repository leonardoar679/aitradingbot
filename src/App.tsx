import { useEffect, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { ErrorBoundary } from './components/ErrorBoundary'
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
import { ExitCheckScheduler } from './agents/ExitCheckScheduler'
import { ModelHealthScheduler } from './agents/ModelHealthScheduler'
import { StrategyHealthScheduler } from './bots/StrategyHealthScheduler'
import { NewsScheduler } from './news/NewsScheduler'
import { NewsAlertScheduler } from './news/NewsAlertScheduler'
import { AlertBanner } from './news/AlertBanner'
import { WhyItMovedHost } from './news/WhyItMovedHost'
import { subscribeAlerts, unseenCount } from './news/alertStore'
import { PaperDigestScheduler } from './risk/PaperDigestScheduler'
import { DailySummaryScheduler } from './performance/DailySummaryScheduler'
import { PaperPauseScheduler } from './risk/PaperPauseScheduler'
import { RoutineScheduler } from './routines/RoutineScheduler'
import { LiveTradingBar } from './livetrading/LiveTradingBar'
import { LiveOrderScheduler } from './livetrading/LiveOrderScheduler'
import { PortfolioScheduler } from './portfolio/PortfolioScheduler'
import { DEFAULT_TABS, pageLabel, type NavTarget, type Page, type PageTabs } from './navigation/pages'
import type { AiOrderProposal } from '../shared/aiProposal'

function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>('overview')
  // The view each page with more than one is showing. Held here rather than in the page, so a
  // hand-off from another page can open it on the view it needs.
  const [tabs, setTabs] = useState<PageTabs>(DEFAULT_TABS)
  // Set when Overview's first-run card is clicked, cleared as soon as Execution has acted on it.
  const [presetsRequested, setPresetsRequested] = useState(false)
  // Set when a model's call is turned into an order form on Overview, Opportunities, AI Decisions
  // or a running bot, cleared as soon as Execution has opened that form. What crosses between pages is
  // a filled-in form, never an order: see shared/aiProposal.ts.
  const [orderProposal, setOrderProposal] = useState<AiOrderProposal | null>(null)
  /** With the proposal: it was confirmed (CONFIRM), so the form opens as a real order where allowed. */
  const [orderLive, setOrderLive] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  // Alerts at WATCH or above not yet seen: the badge on Discovery, which opens on its news while any
  // is waiting.
  const [unseenAlerts, setUnseenAlerts] = useState(0)
  useEffect(() => subscribeAlerts((alerts) => setUnseenAlerts(unseenCount(alerts))), [])

  function navigate(target: NavTarget | Page): void {
    if (typeof target === 'string') {
      setPage(target)
      return
    }
    setPage(target.page)
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Each headless scheduler gets its own boundary: LiveOrderScheduler is the only thing that
          reconciles resolved real orders and watcher exits back into settings, so it must not be
          able to take the kill switch or the rest of the UI down with it -- and if it does die,
          its fallback panel is visible rather than silent, because a dead reconciler means real
          fills stop being recorded. */}
      <ErrorBoundary label="The routine scheduler">
        <RoutineScheduler />
      </ErrorBoundary>
      <ErrorBoundary label="The controller scheduler">
        <ControllerScheduler />
      </ErrorBoundary>
      <ErrorBoundary label="The live order scheduler">
        <LiveOrderScheduler />
      </ErrorBoundary>
      <ErrorBoundary label="The portfolio scheduler">
        <PortfolioScheduler />
      </ErrorBoundary>
      {/* The watch: off unless switched on from Opportunities. It asks models; it has no way to
          place anything, and what it opens by itself is paper. */}
      <ErrorBoundary label="The opportunity watch">
        <OpportunityScheduler />
      </ErrorBoundary>
      {/* The exit check: only while the watch is on, and only the app's own paper trades. Its EXIT
          closes one at the next minute, on paper; it never moves a stop or touches a live one. */}
      <ErrorBoundary label="The exit check">
        <ExitCheckScheduler />
      </ErrorBoundary>
      {/* The daily look at each model's health: a DEGRADED mark and one notice a day. It asks
          nothing and switches nothing off. */}
      <ErrorBoundary label="The models' health">
        <ModelHealthScheduler />
      </ErrorBoundary>
      {/* The hourly look at each running bot's health, for the bots that ask no model: a DEGRADED
          one is told once a day, whether or not Strategies is open. It stops nothing. */}
      <ErrorBoundary label="The strategies' health">
        <StrategyHealthScheduler />
      </ErrorBoundary>
      {/* What a delisting does: a notice to someone holding the coin, and the rule's paper short.
          Off unless the news reader is on; nothing it does is real. */}
      <ErrorBoundary label="The news reader's actions">
        <NewsScheduler />
      </ErrorBoundary>
      {/* Once a day, a notice of what the watch's and the news rules' paper trades did the day
          before. It reads settings and says so; it opens and closes nothing. */}
      <ErrorBoundary label="The daily paper digest">
        <PaperDigestScheduler />
      </ErrorBoundary>
      {/* Once a day after 00:05 UTC, while the watch is on: the day before's report put to a model
          for one paragraph, the fifth AI addition. It reads, builds and asks; it writes nothing. */}
      <ErrorBoundary label="The daily summary">
        <DailySummaryScheduler />
      </ErrorBoundary>
      {/* After a losing run, the watch's or the news rules' paper trades are paused until resumed
          on Risk & Safety. It writes the pause and says so; it opens and closes nothing. */}
      <ErrorBoundary label="The losing-run pause">
        <PaperPauseScheduler />
      </ErrorBoundary>
      {/* The news feed's alerts and Bitcoin's falls, by severity: a notice, a badge, and for the
          critical ones a banner. It reads and tells; it opens, closes and sells nothing. */}
      <ErrorBoundary label="The news alerts">
        <NewsAlertScheduler />
      </ErrorBoundary>
      <ErrorBoundary label="The live trading bar">
        <LiveTradingBar />
      </ErrorBoundary>
      <ErrorBoundary label="The alert banner">
        <AlertBanner />
      </ErrorBoundary>
      <ErrorBoundary label="Why did it move">
        <WhyItMovedHost />
      </ErrorBoundary>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <ErrorBoundary label="The sidebar">
          <Sidebar
            currentPage={page}
            onNavigate={(next) => navigate(next === 'discovery' && unseenAlerts > 0 ? { page: 'discovery', tab: 'news' } : next)}
            collapsed={collapsed}
            onToggleCollapsed={() => setCollapsed((c) => !c)}
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
          <ErrorBoundary key={page} label={`The ${pageLabel(page)} page`}>
            {page === 'overview' && <OverviewPage onGetStarted={openPresets} onPrepareOrder={prepareOrder} onNavigate={navigate} />}
            {page === 'opportunities' && <OpportunitiesPage onPrepareOrder={prepareOrder} />}
            {page === 'markets' && <Dashboard />}
            {page === 'ai-decisions' && (
              <AiDecisionsPage
                tab={tabs['ai-decisions']}
                onTab={(tab) => setTabs((current) => ({ ...current, 'ai-decisions': tab }))}
                onPrepareOrder={prepareOrder}
              />
            )}
            {page === 'positions' && <PositionsPage />}
            {page === 'performance' && <PerformancePage />}
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
            {page === 'discovery' && (
              <ExplorerPage tab={tabs.discovery} onTab={(tab) => setTabs((current) => ({ ...current, discovery: tab }))} onNavigate={navigate} />
            )}
            {page === 'risk' && <RiskSafetyPage />}
            {page === 'connections' && <ConnectionsPage />}
            {page === 'settings' && <SettingsPanel onNavigate={navigate} />}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}

export default App
