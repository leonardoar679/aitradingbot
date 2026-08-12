import { ChevronLeft, ChevronRight } from 'lucide-react'
import { NAV_ITEMS, type Page } from '../navigation/pages'
import appIcon from '../../build/icon.png'

interface SidebarProps {
  currentPage: Page
  onNavigate: (page: Page) => void
  collapsed: boolean
  onToggleCollapsed: () => void
}

export function Sidebar({
  currentPage,
  onNavigate,
  collapsed,
  onToggleCollapsed
}: SidebarProps): React.JSX.Element {
  return (
    <nav
      style={{
        width: collapsed ? 64 : 176,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-surface)',
        borderRight: '1px solid var(--border)',
        transition: 'width 0.15s ease',
        overflow: 'hidden'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          padding: collapsed ? '1.1rem 0' : '1.1rem 1rem',
          justifyContent: collapsed ? 'center' : 'flex-start',
          borderBottom: '1px solid var(--border)'
        }}
      >
        <img src={appIcon} alt="" style={{ width: 22, height: 22, flexShrink: 0 }} />
        {!collapsed && (
          <span
            style={{
              fontWeight: 700,
              fontSize: '0.95rem',
              letterSpacing: '0.01em',
              whiteSpace: 'nowrap',
              color: 'var(--text-primary)'
            }}
          >
            TraderSpider
          </span>
        )}
      </div>

      {!collapsed && (
        <div style={{ padding: '0.75rem 0.75rem 0' }}>
          <select
            value="local"
            onChange={() => {}}
            aria-label="Workspace"
            style={{
              width: '100%',
              background: 'var(--bg-app)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '0.45rem 0.6rem',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            <option value="local">local</option>
          </select>
        </div>
      )}

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.2rem',
          padding: '0.6rem',
          flex: 1
        }}
      >
        {NAV_ITEMS.map(({ page, label, icon: Icon }) => {
          const active = currentPage === page
          return (
            <button
              key={page}
              onClick={() => onNavigate(page)}
              title={label}
              className={`nav-item${active ? ' nav-item-active' : ''}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: collapsed ? 'center' : 'flex-start',
                gap: '0.55rem',
                padding: '0.5rem 0.6rem',
                borderRadius: 'var(--radius-sm)',
                border: 'none',
                background: 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: '0.85rem',
                fontWeight: active ? 600 : 500,
                whiteSpace: 'nowrap'
              }}
            >
              <Icon size={18} />
              {!collapsed && <span>{label}</span>}
            </button>
          )
        })}
      </div>

      <button
        onClick={onToggleCollapsed}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="icon-button"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0.6rem',
          padding: '0.5rem',
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          background: 'transparent',
          color: 'var(--text-muted)',
          cursor: 'pointer'
        }}
      >
        {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
      </button>
    </nav>
  )
}
