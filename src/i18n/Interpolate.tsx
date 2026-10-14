import { Fragment, type ReactNode } from 'react'

/** A translated sentence with parts that are not text -- a link, a bold word -- in its {placeholders}, so
 * each language puts them where its own order of words does: t() gives the sentence with them left in
 * braces, and this fills them in. A placeholder with no part given is shown as written. */
export function Interpolate({ text, values }: { text: string; values: Readonly<Record<string, ReactNode>> }): React.JSX.Element {
  const parts = text.split(/\{(\w+)\}/)
  return (
    <>
      {parts.map((part, index) => (index % 2 === 0 ? <Fragment key={index}>{part}</Fragment> : <Fragment key={index}>{part in values ? values[part] : `{${part}}`}</Fragment>))}
    </>
  )
}
