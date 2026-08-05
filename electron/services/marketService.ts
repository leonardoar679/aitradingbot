import type { PriceUpdate } from '../../shared/ipc'

// Simulated tick feed — replace with a real exchange/websocket connection later.
// Everything above this line is the only part that should need to change.

type Listener = (update: PriceUpdate) => void

const timers = new Map<string, ReturnType<typeof setInterval>>()
const lastPrice = new Map<string, number>()
const listeners = new Set<Listener>()

export function onPriceUpdate(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function subscribe(symbol: string): void {
  if (timers.has(symbol)) return

  const base = lastPrice.get(symbol) ?? 100 + Math.random() * 900
  lastPrice.set(symbol, base)

  const timer = setInterval(() => {
    const prev = lastPrice.get(symbol) ?? base
    const next = Math.max(0.01, prev * (1 + (Math.random() - 0.5) * 0.01))
    lastPrice.set(symbol, next)

    const update: PriceUpdate = { symbol, price: Number(next.toFixed(2)), timestamp: Date.now() }
    for (const listener of listeners) listener(update)
  }, 1000)

  timers.set(symbol, timer)
}

export function unsubscribe(symbol: string): void {
  const timer = timers.get(symbol)
  if (timer) {
    clearInterval(timer)
    timers.delete(symbol)
  }
}

export function unsubscribeAll(): void {
  for (const symbol of timers.keys()) unsubscribe(symbol)
}
