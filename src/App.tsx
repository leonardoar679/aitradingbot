import { useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Dashboard } from './dashboard/Dashboard'
import { PortfolioPage } from './portfolio/PortfolioPage'
import { AccountPage } from './account/AccountPage'
import { TradePage } from './trade/TradePage'
import { BotsPage } from './bots/BotsPage'
import { ExecutorsPage } from './executors/ExecutorsPage'
import { ControllersPage } from './controllers/ControllersPage'
import { ControllerScheduler } from './controllers/ControllerScheduler'
import { PositionsPage } from './positions/PositionsPage'
import { AgentsPage } from './agents/AgentsPage'
import { OpportunityScheduler } from './agents/OpportunityScheduler'
import { RoutinesPage } from './routines/RoutinesPage'
import { RoutineScheduler } from './routines/RoutineScheduler'
import { ExplorerPage } from './explorer/ExplorerPage'
import { BacktestPage } from './backtest/BacktestPage'
import { SettingsPanel } from './settings/SettingsPanel'
import { LiveTradingBar } from './livetrading/LiveTradingBar'
import { LiveOrderScheduler } from './livetrading/LiveOrderScheduler'
import { PortfolioScheduler } from './portfolio/PortfolioScheduler'
import type { Page } from './navigation/pages'
import type { AiOrderProposal } from '../shared/aiProposal'

const PAGE_LABEL: Record<Page, string> = {
  portfolio: 'Portfolio',
  account: 'Account',
  trade: 'Trade',
  bots: 'Bots',
  executors: 'Executors',
  controllers: 'Controllers',
  positions: 'Positions',
  agents: 'Agents',
  routines: 'Routines',
  market: 'Market',
  backtest: 'Backtest',
  explorer: 'Explorer',
  settings: 'Settings'
}

function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>('portfolio')
  // Set when Portfolio's first-run card is clicked, cleared as soon as Executors has acted on it.
  const [presetsRequested, setPresetsRequested] = useState(false)
  // Set when a model's call is turned into an order form on the Agents page, cleared as soon as
  // Executors has opened that form. What crosses between the two pages is a filled-in form, never
  // an order: see shared/aiProposal.ts.
  const [orderProposal, setOrderProposal] = useState<AiOrderProposal | null>(null)
  // The same hand-over from both places a call is shown: the Analyze tab, and a running bot.
  function prepareOrder(proposal: AiOrderProposal): void {
    setOrderProposal(proposal)
    setPage('executors')
  }
  const [collapsed, setCollapsed] = useState(false)

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
      {/* The watch: off unless switched on from Agents, Opportunities. It asks models; it has no
          way to place anything. */}
      <ErrorBoundary label="The opportunity watch">
        <OpportunityScheduler />
      </ErrorBoundary>
      <ErrorBoundary label="The live trading bar">
        <LiveTradingBar />
      </ErrorBoundary>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <ErrorBoundary label="The sidebar">
          <Sidebar
            currentPage={page}
            onNavigate={setPage}
            collapsed={collapsed}
            onToggleCollapsed={() => setCollapsed((c) => !c)}
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
          <ErrorBoundary key={page} label={`The ${PAGE_LABEL[page]} page`}>
            {page === 'portfolio' && (
              <PortfolioPage
                onGetStarted={() => {
                  setPresetsRequested(true)
                  setPage('executors')
                }}
              />
            )}
            {page === 'account' && <AccountPage />}
            {page === 'trade' && <TradePage />}
            {page === 'bots' && <BotsPage onPrepareOrder={prepareOrder} />}
            {page === 'executors' && (
              <ExecutorsPage
                autoOpenPresets={presetsRequested}
                onPresetsOpened={() => setPresetsRequested(false)}
                proposal={orderProposal}
                onProposalTaken={() => setOrderProposal(null)}
              />
            )}
            {page === 'controllers' && <ControllersPage />}
            {page === 'positions' && <PositionsPage />}
            {page === 'agents' && <AgentsPage onPrepareOrder={prepareOrder} />}
            {page === 'routines' && <RoutinesPage />}
            {page === 'market' && <Dashboard />}
            {page === 'backtest' && <BacktestPage />}
            {page === 'explorer' && <ExplorerPage />}
            {page === 'settings' && <SettingsPanel />}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}

export default App
