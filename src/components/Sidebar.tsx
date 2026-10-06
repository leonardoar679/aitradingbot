import { ChevronLeft, ChevronRight } from 'lucide-react'
import { NAV_GROUPS, type Page } from '../navigation/pages'
import appIcon from '../../build/icon.png'

interface SidebarProps {
  currentPage: Page
  onNavigate: (page: Page) => void
  collapsed: boolean
  onToggleCollapsed: () => void
  /** A count shown beside a page: alerts not yet seen, on Discovery. */
  badges?: Partial<Record<Page, number>>
}

export function Sidebar({
  currentPage,
  onNavigate,
  collapsed,
  onToggleCollapsed,
  badges = {}
}: SidebarProps): React.JSX.Element {
  return (
    <nav
      style={{
        // Wide enough for the longest label, "Backtest & Research", beside its icon.
        width: collapsed ? 64 : 200,
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
          flex: 1,
          overflowY: 'auto'
        }}
      >
        {NAV_GROUPS.map((group, index) => (
          <div key={group.title} style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
            {collapsed ? (
              // Collapsed, a group is a rule between icons: the four still read as four.
              index > 0 && <div style={{ borderTop: '1px solid var(--border)', margin: '0.35rem 0.4rem' }} />
            ) : (
              <div
                style={{
                  padding: index === 0 ? '0.15rem 0.6rem 0.2rem' : '0.6rem 0.6rem 0.2rem',
                  fontSize: '0.66rem',
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                  whiteSpace: 'nowrap'
                }}
              >
                {group.title}
              </div>
            )}
            {group.items.map(({ page, label, icon: Icon }) => {
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
                    // Tight enough for all fifteen to fit a 760-pixel-high window without scrolling.
                    padding: '0.38rem 0.6rem',
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
                  {(badges[page] ?? 0) > 0 && (
                    <span
                      aria-label={`${badges[page]} new`}
                      style={{
                        marginLeft: collapsed ? 0 : 'auto',
                        minWidth: collapsed ? 8 : 18,
                        height: collapsed ? 8 : 18,
                        padding: collapsed ? 0 : '0 5px',
                        borderRadius: 999,
                        background: 'var(--down)',
                        color: '#fff',
                        fontSize: '0.66rem',
                        fontWeight: 700,
                        lineHeight: '18px',
                        textAlign: 'center'
                      }}
                    >
                      {collapsed ? '' : badges[page]}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        ))}
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
