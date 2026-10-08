import { emptyHealthState, HEALTH_LINES, healthVerdict, type HealthState, type HealthVerdict } from '../../shared/exchangeHealth'
import { listCredentialStatus } from './credentialsService'
import { resolveEndpoint } from './exchanges/binance'
import { getLiveState } from './liveMarketService'

// THE EXCHANGE HEALTH MONITOR (shared/exchangeHealth.ts has the rule). Once a minute it asks the
// data host the time -- one small public request -- and keeps how long it took and how far this
// machine's clock is from Binance's; beside them it reads the live-price socket's state and the
// key's last test. The live order gate reads the verdict before it opens a real position
// (liveTradingService.ts); the bar and Live Trading show it. It holds no key, asks no model,
// places nothing and changes no setting.

/** Test seam: how often the host is measured, and how long one measurement may take. */
export const healthProbe = { everyMs: 60_000, timeoutMs: 10_000 }

let state: HealthState = emptyHealthState()
let started = false
const listeners = new Set<(state: HealthState) => void>()

export function onHealthUpdate(listener: (state: HealthState) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** The stream's and the key's parts of the state, read now, beside the last measurement. */
function current(): HealthState {
  const live = getLiveState().connection
  const nowMs = Date.now()
  return { ...state, streamOpen: live.open, dataAgeS: live.lastMessageAt === null ? null : Math.max(0, (nowMs - live.lastMessageAt) / 1000) }
}

export function getHealthState(): HealthState {
  return current()
}

/** The verdict as it stands this moment, for the gate and the bar. */
export function liveHealth(): HealthVerdict {
  return healthVerdict(current())
}

/** Why live entries are paused now, each in words; empty when they are not. */
export function liveHealthReasons(): string[] {
  return liveHealth().reasons
}

function publish(): void {
  const snapshot = current()
  for (const listener of listeners) {
    try {
      listener(snapshot)
    } catch (error) {
      console.error('An exchange health listener failed:', error)
    }
  }
}

/** One measurement: the data host's time, and the key's last test. Never throws. */
export async function probeOnce(): Promise<HealthState> {
  const measuredAt = Math.floor(Date.now() / 1000)
  let keyOk: boolean | null = null
  try {
    const binance = (await listCredentialStatus()).find((entry) => entry.exchange === 'binance')
    keyOk = binance === undefined || !binance.configured ? null : binance.lastTestOk === false ? false : true
  } catch {
    keyOk = state.keyOk
  }
  try {
    const endpoint = await resolveEndpoint()
    const sentAt = Date.now()
    const response = await fetch(`${endpoint.restRoot}/time`, { signal: AbortSignal.timeout(healthProbe.timeoutMs) })
    const receivedAt = Date.now()
    if (!response.ok) throw new Error(`${endpoint.name} answered ${response.status}`)
    const body = (await response.json()) as { serverTime?: unknown }
    const serverTime = typeof body.serverTime === 'number' ? body.serverTime : Number.NaN
    if (!Number.isFinite(serverTime)) throw new Error(`${endpoint.name} gave no time`)
    const latency = receivedAt - sentAt
    const slow = latency > HEALTH_LINES.slowReadMs
    state = {
      ...state,
      measuredAt,
      host: endpoint.name,
      restLatencyMs: latency,
      restFailures: 0,
      slowReads: slow ? state.slowReads + 1 : 0,
      // Binance's clock against the midpoint of the round trip.
      clockSkewMs: serverTime - (sentAt + latency / 2),
      keyOk
    }
  } catch (error) {
    state = { ...state, measuredAt, restLatencyMs: null, restFailures: state.restFailures + 1, keyOk }
    if (state.restFailures === HEALTH_LINES.restFailuresToPause) console.warn(`Exchange health: the data host has failed ${state.restFailures} reads running:`, error instanceof Error ? error.message : error)
  }
  publish()
  return current()
}

/** Measures once now and once a minute after. Called once, from electron/main.ts. */
export function startExchangeHealth(): void {
  if (started) return
  started = true
  void probeOnce()
  setInterval(() => void probeOnce(), healthProbe.everyMs)
}

/** Test seam: forgets every measurement. */
export function resetExchangeHealth(): void {
  state = emptyHealthState()
}
