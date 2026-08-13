import { useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { Dashboard } from './dashboard/Dashboard'
import { PortfolioPage } from './portfolio/PortfolioPage'
import { TradePage } from './trade/TradePage'
import { BotsPage } from './bots/BotsPage'
import { ExecutorsPage } from './executors/ExecutorsPage'
import { ControllersPage } from './controllers/ControllersPage'
import { ControllerScheduler } from './controllers/ControllerScheduler'
import { PositionsPage } from './positions/PositionsPage'
import { AgentsPage } from './agents/AgentsPage'
import { RoutinesPage } from './routines/RoutinesPage'
import { RoutineScheduler } from './routines/RoutineScheduler'
import { ExplorerPage } from './explorer/ExplorerPage'
import { BacktestPage } from './backtest/BacktestPage'
import { SettingsPanel } from './settings/SettingsPanel'
import { LiveTradingBar } from './livetrading/LiveTradingBar'
import type { Page } from './navigation/pages'

function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>('portfolio')
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <RoutineScheduler />
      <ControllerScheduler />
      <LiveTradingBar />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Sidebar
          currentPage={page}
          onNavigate={setPage}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((c) => !c)}
        />
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
          {page === 'portfolio' && <PortfolioPage />}
          {page === 'trade' && <TradePage />}
          {page === 'bots' && <BotsPage />}
          {page === 'executors' && <ExecutorsPage />}
          {page === 'controllers' && <ControllersPage />}
          {page === 'positions' && <PositionsPage />}
          {page === 'agents' && <AgentsPage />}
          {page === 'routines' && <RoutinesPage />}
          {page === 'market' && <Dashboard />}
          {page === 'backtest' && <BacktestPage />}
          {page === 'explorer' && <ExplorerPage />}
          {page === 'settings' && <SettingsPanel />}
        </main>
      </div>
    </div>
  )
}

export default App
