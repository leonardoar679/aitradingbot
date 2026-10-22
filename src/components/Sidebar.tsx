import { useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { NAV_GROUPS, NORMAL_NAV_GROUPS, foldedCount, groupOf, isGroupOpen, navGroupsFor, type NavGroupId, type NavId, type NavItem, type Page } from '../navigation/pages'
import type { UiMode } from '../../shared/uiMode'
import appIcon from '../../build/icon.png'
import { useI18n } from '../i18n'

interface SidebarProps {
  activeId: NavId | null
  onChoose: (item: NavItem) => void
  collapsed: boolean
  onToggleCollapsed: () => void
  uiMode: UiMode
  /** A count shown beside a page's entries: alerts not yet seen, on Explorer. */
  badges?: Partial<Record<Page, number>>
}

/** Which folded groups were opened, remembered on this computer only. A browser store that cannot be
 * read is every group folded, not an error. */
const OPEN_GROUPS_KEY = 'nav.openGroups'

function readOpenGroups(): Set<NavGroupId> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(OPEN_GROUPS_KEY) ?? '[]')
    return new Set(Array.isArray(stored) ? (stored.filter((id) => [...NAV_GROUPS, ...NORMAL_NAV_GROUPS].some((group) => group.id === id)) as NavGroupId[]) : [])
  } catch {
    return new Set()
  }
}

function writeOpenGroups(open: ReadonlySet<NavGroupId>): void {
  try {
    window.localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify([...open]))
  } catch {
    // Not remembered; the groups open folded next time.
  }
}

export function Sidebar({ activeId, onChoose, collapsed, onToggleCollapsed, uiMode, badges = {} }: SidebarProps): React.JSX.Element {
  const { t, dir } = useI18n()
  // Right to left the sidebar is on the right: its arrows point the other way.
  const rtl = dir === 'rtl'
  const [opened, setOpened] = useState<Set<NavGroupId>>(readOpenGroups)
  const activeGroup = activeId === null ? null : groupOf(activeId, uiMode)

  function toggleGroup(id: NavGroupId): void {
    setOpened((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      writeOpenGroups(next)
      return next
    })
  }

  function openGroupAndExpand(id: NavGroupId): void {
    setOpened((current) => {
      const next = new Set(current).add(id)
      writeOpenGroups(next)
      return next
    })
    if (collapsed) onToggleCollapsed()
  }

  return (
    <nav
      style={{
        // Wide enough for the longest label, "Opportunities", beside its icon and a badge.
        width: collapsed ? 64 : 200,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-surface)',
        borderInlineEnd: '1px solid var(--border)',
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
            aria-label={t('Workspace')}
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
            <option value="local">{t('local@@the workspace')}</option>
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
        {navGroupsFor(uiMode).map((group, index) => {
          const open = isGroupOpen(group, uiMode, opened, activeGroup)
          const folds = group.foldable && uiMode !== 'expert'
          const GroupIcon = group.icon
          const hidden = foldedCount(group, open, badges)
          return (
            <div key={group.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
              {collapsed ? (
                // Narrow, a group is a rule between icons, and a folded group one icon that opens it.
                index > 0 && <div style={{ borderTop: '1px solid var(--border)', margin: '0.35rem 0.4rem' }} />
              ) : folds ? (
                <button
                  onClick={() => toggleGroup(group.id)}
                  aria-expanded={open}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: index === 0 ? '0.15rem 0.6rem 0.2rem' : '0.6rem 0.6rem 0.2rem',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    fontSize: '0.66rem',
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'var(--text-muted)',
                    whiteSpace: 'nowrap'
                  }}
                >
                  <span>{t(group.title)}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    {hidden > 0 && <Badge count={hidden} collapsed={false} />}
                    <ChevronDown size={12} style={{ transform: open ? 'none' : rtl ? 'rotate(90deg)' : 'rotate(-90deg)', transition: 'transform 0.15s ease' }} />
                  </span>
                </button>
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
                  {t(group.title)}
                </div>
              )}
              {collapsed && !open && (
                <button
                  onClick={() => openGroupAndExpand(group.id)}
                  title={t(group.title)}
                  aria-label={t('Open {group}', { group: t(group.title) })}
                  className="nav-item"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '0.38rem 0.6rem',
                    borderRadius: 'var(--radius-sm)',
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer'
                  }}
                >
                  <GroupIcon size={18} />
                  {hidden > 0 && <Badge count={hidden} collapsed />}
                </button>
              )}
              {open && group.items.map((item) => <NavButton key={item.id} item={item} active={activeId === item.id} collapsed={collapsed} badge={badges[item.target.page] ?? 0} onChoose={onChoose} />)}
            </div>
          )
        })}
      </div>

      <button
        onClick={onToggleCollapsed}
        aria-label={collapsed ? t('Expand sidebar') : t('Collapse sidebar')}
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
        {collapsed === rtl ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>
    </nav>
  )
}

function NavButton({ item, active, collapsed, badge, onChoose }: { item: NavItem; active: boolean; collapsed: boolean; badge: number; onChoose: (item: NavItem) => void }): React.JSX.Element {
  const { t } = useI18n()
  const Icon = item.icon
  return (
    <button
      onClick={() => onChoose(item)}
      title={t(item.label)}
      className={`nav-item${active ? ' nav-item-active' : ''}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'flex-start',
        gap: '0.55rem',
        // Tight enough for the open groups to fit a 760-pixel-high window.
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
      {!collapsed && <span>{t(item.label)}</span>}
      {badge > 0 && <Badge count={badge} collapsed={collapsed} pushRight />}
    </button>
  )
}

function Badge({ count, collapsed, pushRight = false }: { count: number; collapsed: boolean; pushRight?: boolean }): React.JSX.Element {
  const { t, num } = useI18n()
  return (
    <span
      aria-label={t('{count} new', { count })}
      style={{
        marginInlineStart: pushRight && !collapsed ? 'auto' : 0,
        minWidth: collapsed ? 8 : 18,
        height: collapsed ? 8 : 18,
        padding: collapsed ? 0 : '0 5px',
        borderRadius: 999,
        background: 'var(--down)',
        color: '#fff',
        fontSize: '0.66rem',
        fontWeight: 700,
        letterSpacing: 0,
        lineHeight: '18px',
        textAlign: 'center',
        textTransform: 'none'
      }}
    >
      {collapsed ? '' : num(count)}
    </span>
  )
}
