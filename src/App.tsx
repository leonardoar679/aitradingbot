import { useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { Dashboard } from './dashboard/Dashboard'
import { BotsPage } from './bots/BotsPage'
import { ExplorerPage } from './explorer/ExplorerPage'
import { BacktestPage } from './backtest/BacktestPage'
import { SettingsPanel } from './settings/SettingsPanel'
import type { Page } from './navigation/pages'

function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>('dashboard')
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
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
        {page === 'dashboard' && <Dashboard />}
        {page === 'bots' && <BotsPage />}
        {page === 'backtest' && <BacktestPage />}
        {page === 'explorer' && <ExplorerPage />}
        {page === 'settings' && <SettingsPanel />}
      </main>
    </div>
  )
}

export default App
