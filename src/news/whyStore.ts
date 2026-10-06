// Which pair "Why did it move?" is open on, if any: one panel over the whole app, opened from
// Discovery's events, Right Now and Markets. A tiny store rather than a prop threaded through every
// page that offers the button.

type Listener = (symbol: string | null) => void

let open: string | null = null
const listeners = new Set<Listener>()

export function openWhy(symbol: string): void {
  open = symbol
  for (const listener of listeners) listener(open)
}

export function closeWhy(): void {
  open = null
  for (const listener of listeners) listener(open)
}

export function subscribeWhy(listener: Listener): () => void {
  listeners.add(listener)
  listener(open)
  return () => void listeners.delete(listener)
}
