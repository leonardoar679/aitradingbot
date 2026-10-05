import type { PropsWithChildren } from 'react'

/** A button that reads as a link: for "it is on Risk & Safety" inside a sentence. */
export function TextLink({ onClick, children }: PropsWithChildren<{ onClick: () => void }>): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }}
    >
      {children}
    </button>
  )
}
