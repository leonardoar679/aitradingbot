import { formatUsd, type AiConfig } from '../../shared/aiCost'
import type { CredentialStatus, LiveTradingStatus } from '../../shared/ipc'

// What the status bar and Overview say about the state of things, read from the gates
// themselves rather than from a setting that claims to describe them.
//
// The V3 document asks for four modes -- paper, shadow, confirm, live -- shown at the top of every
// page. In this app they are not one switch, and are shown as what is real:
// - Whether a real order can be placed at all is the live session's gates: a Binance key, the
//   session armed, the kill switch. That is the trading mode below.
// - What the AI does by itself is the watch: off, shadow (it asks models about events and scores
//   their calls, and opens nothing), or paper trades. That is the watch mode below.
// - "Confirm" is how a model's call reaches a real order at all: it fills in a form a person
//   places. There is no mode in which a model places one, and none is shown.

export type Tone = 'safe' | 'live' | 'blocked' | 'muted' | 'info' | 'warn'

export interface ModeLabel {
  label: string
  detail: string
  tone: Tone
}

export type TradingMode = 'paper-only' | 'paper' | 'live-armed' | 'kill-switch'

export function tradingModeOf(input: {
  binanceKey: boolean
  status: Pick<LiveTradingStatus, 'sessionArmed' | 'killSwitchEngaged'> | null
}): TradingMode {
  // The kill switch first: it blocks everything, whatever else is true.
  if (input.status?.killSwitchEngaged === true) return 'kill-switch'
  if (!input.binanceKey || input.status === null) return 'paper-only'
  return input.status.sessionArmed ? 'live-armed' : 'paper'
}

export function describeTradingMode(mode: TradingMode): ModeLabel {
  switch (mode) {
    case 'paper-only':
      return { label: 'PAPER', detail: 'No Binance key is stored, so no real order can be placed.', tone: 'safe' }
    case 'paper':
      return { label: 'PAPER', detail: 'Live trading is disarmed: no real order can be placed until it is armed for this session.', tone: 'safe' }
    case 'live-armed':
      return {
        label: 'LIVE ARMED',
        detail: 'Real orders can be placed by the live executors you made, within the limits on Risk & Safety. No model can place one.',
        tone: 'live'
      }
    case 'kill-switch':
      return { label: 'KILL SWITCH', detail: 'Every new real order is blocked until the kill switch is released.', tone: 'blocked' }
  }
}

/** The V3 document's "LIVE TRADING: READY" is not "ACTIVE": ready is a stored Binance key whose
 * last test passed, with the session disarmed, so that nothing real can happen until it is armed;
 * active is the session armed. A key that failed its last test is not ready. */
export type LiveReadiness = 'paper-only' | 'not-verified' | 'ready' | 'active' | 'blocked'

export function liveReadinessOf(input: { mode: TradingMode; connection: ConnectionState }): LiveReadiness {
  // The kill switch first, as in tradingModeOf: it blocks everything, whatever else is true.
  if (input.mode === 'kill-switch') return 'blocked'
  if (input.mode === 'live-armed') return 'active'
  if (input.mode === 'paper-only' || input.connection === 'none') return 'paper-only'
  return input.connection === 'ok' ? 'ready' : 'not-verified'
}

export function describeLiveReadiness(readiness: LiveReadiness): ModeLabel {
  switch (readiness) {
    case 'paper-only':
      return { label: 'PAPER', detail: 'No Binance key is stored, so no real order can be placed. A verified key on Connections makes live trading ready.', tone: 'safe' }
    case 'not-verified':
      return { label: 'PAPER · KEY NOT VERIFIED', detail: 'A Binance key is stored but its last test failed, so live trading is not ready. Test it again on Connections.', tone: 'warn' }
    case 'ready':
      return {
        label: 'PAPER · LIVE READY',
        detail: 'A verified Binance key is stored and the live session is disarmed: no real order can be placed until it is armed on the bar, for this session only.',
        tone: 'safe'
      }
    case 'active':
      return {
        label: 'LIVE ACTIVE',
        detail: 'The live session is armed: the live executors you made can place real orders, within the limits on Risk & Safety. No model can place one.',
        tone: 'live'
      }
    case 'blocked':
      return { label: 'KILL SWITCH', detail: 'Every new real order is blocked until the kill switch is released.', tone: 'blocked' }
  }
}

export type WatchMode = 'no-key' | 'off' | 'shadow' | 'paper-trades' | 'confirm'

export function watchModeOf(input: { keyConfigured: boolean; config: Pick<AiConfig, 'watch' | 'watchPaper'> | null }): WatchMode {
  if (!input.keyConfigured) return 'no-key'
  // Paper trades switched on with the watch off open nothing: the watch is what opens them.
  if (input.config === null || !input.config.watch.enabled) return 'off'
  if (!input.config.watchPaper.enabled) return 'shadow'
  // CONFIRM (8 October 2026): paper trades, and a notice when one is ready to confirm for real.
  return input.config.watch.confirmLive ? 'confirm' : 'paper-trades'
}

export function describeWatchMode(mode: WatchMode): ModeLabel {
  switch (mode) {
    case 'no-key':
      return { label: 'AI: NO KEY', detail: 'No OpenRouter key is stored, so no model can be asked.', tone: 'muted' }
    case 'off':
      return { label: 'AI: WATCH OFF', detail: 'Models are asked only when you ask them.', tone: 'muted' }
    case 'shadow':
      return { label: 'AI: SHADOW', detail: 'The watch asks models about events and scores their calls, and opens nothing.', tone: 'info' }
    case 'paper-trades':
      return { label: 'AI: PAPER TRADES', detail: 'The watch opens paper positions on its calls by itself. Never a real one.', tone: 'warn' }
    case 'confirm':
      return {
        label: 'AI: CONFIRM',
        detail: 'The watch opens paper positions on its calls by itself and tells you when one is ready to confirm as a real order. You place it; it never does.',
        tone: 'warn'
      }
  }
}

/** What has been spent on AI calls today, against the day's budget. */
export function describeAiSpend(config: Pick<AiConfig, 'spentTodayUsd' | 'dailyCapUsd'>): string {
  return `${formatUsd(config.spentTodayUsd)} of ${formatUsd(config.dailyCapUsd)} today`
}

export type ConnectionState = 'none' | 'ok' | 'failed'

/** A stored key passed a test before it was stored, so it reads as connected until a later test
 * says otherwise. */
export function connectionStateOf(status: Pick<CredentialStatus, 'configured' | 'lastTestOk'> | undefined): ConnectionState {
  if (status === undefined || !status.configured) return 'none'
  return status.lastTestOk === false ? 'failed' : 'ok'
}

export function describeConnection(name: string, state: ConnectionState): ModeLabel {
  if (state === 'none') return { label: `${name.toUpperCase()}: NO KEY`, detail: `No ${name} key is stored. Add one on Connections.`, tone: 'muted' }
  if (state === 'failed') return { label: `${name.toUpperCase()}: TEST FAILED`, detail: `The last test of the ${name} key failed. Test it again on Connections.`, tone: 'warn' }
  return { label: `${name.toUpperCase()}`, detail: `A ${name} key is stored and its last test passed.`, tone: 'safe' }
}
