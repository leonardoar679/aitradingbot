import type { LucideIcon } from 'lucide-react'

export interface PageTab<T extends string> {
  id: T
  label: string
  icon?: LucideIcon
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    background: 'transparent',
    border: 'none',
    padding: '0.7rem 1rem',
    fontSize: '0.85rem',
    fontWeight: active ? 700 : 500,
    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    cursor: 'pointer',
    borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
    whiteSpace: 'nowrap'
  }
}

/** The views of a page that holds more than one, under its header. The page owns which is shown,
 * so a hand-off from another page can open it on the right one. */
export function PageTabs<T extends string>({
  tabs,
  current,
  onChange
}: {
  tabs: PageTab<T>[]
  current: T
  onChange: (tab: T) => void
}): React.JSX.Element {
  return (
    <div role="tablist" style={{ display: 'flex', borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
      {tabs.map(({ id, label, icon: Icon }) => (
        <button key={id} role="tab" aria-selected={current === id} onClick={() => onChange(id)} style={tabStyle(current === id)}>
          {Icon && <Icon size={15} />}
          {label}
        </button>
      ))}
    </div>
  )
}
