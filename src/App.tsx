import { useState } from 'react'
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
import { NewsScheduler } from './news/NewsScheduler'
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
  const [collapsed, setCollapsed] = useState(false)

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
    }
  }

  // The same hand-over from every place a call is shown: Overview, Opportunities, AI Decisions, a
  // running bot. The form is on Strategies › Execution.
  function prepareOrder(proposal: AiOrderProposal): void {
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
      {/* What a delisting does: a notice to someone holding the coin, and the rule's paper short.
          Off unless the news reader is on; nothing it does is real. */}
      <ErrorBoundary label="The news reader's actions">
        <NewsScheduler />
      </ErrorBoundary>
      <ErrorBoundary label="The live trading bar">
        <LiveTradingBar />
      </ErrorBoundary>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <ErrorBoundary label="The sidebar">
          <Sidebar currentPage={page} onNavigate={navigate} collapsed={collapsed} onToggleCollapsed={() => setCollapsed((c) => !c)} />
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
                onProposalTaken={() => setOrderProposal(null)}
              />
            )}
            {page === 'research' && <ResearchPage tab={tabs.research} onTab={(tab) => setTabs((current) => ({ ...current, research: tab }))} />}
            {page === 'ai-benchmark' && <AiBenchmarkPage />}
            {page === 'discovery' && <ExplorerPage onNavigate={navigate} />}
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
