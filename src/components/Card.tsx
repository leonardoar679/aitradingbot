import type { PropsWithChildren } from 'react'

export function Card({ title, children }: PropsWithChildren<{ title: string }>): React.JSX.Element {
  return (
    <section style={{ border: '1px solid #444', borderRadius: 8, padding: '1rem' }}>
      <h2 style={{ marginTop: 0, fontSize: '1rem' }}>{title}</h2>
      {children}
    </section>
  )
}
