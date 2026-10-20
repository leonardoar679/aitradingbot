import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { formatUsd, type AiConfig } from '../../shared/aiCost'
import { aiEffortOf } from '../../shared/aiEffort'
import type { AiCallRecord } from '../../shared/aiLedger'
import { describeDecider } from '../../shared/aiPanel'
import { modelsInUse, routingTableOf, type RoleChoice, type RoutedBot, type RoutedCaller } from '../../shared/aiRouting'
import type { Bot } from '../../shared/ipc'
import { describeError } from '../utils/ipcError'
import { buttonStyle, cellStyle, headCellStyle, inputStyle, noteStyle } from './agentStyles'

// WHO ASKS WHICH MODEL (V7.2-R Stage 1, 20 October 2026; shared/aiRouting.ts). The default model reaches only
// what a person starts; everything that asks by itself keeps the model it was switched on with. This card shows
// each such caller with the model it asks now and what it has asked today, and makes one move that puts them
// all on the three models chosen here -- confirmed once, with what the move changes and costs. Reading it asks
// no model; the move changes what asks by itself and nothing else.

/** The ledger rows of today a caller made. */
function rowsOf(caller: RoutedCaller, rows: readonly AiCallRecord[], bots: readonly Bot[]): AiCallRecord[] {
  if (caller.kind === 'watch') return rows.filter((row) => row.source === 'watch')
  if (caller.kind === 'watch-paper') return []
  if (caller.kind === 'addition') return rows.filter((row) => row.source === 'addition' && `addition:${row.addition}` === caller.id)
  const bot = bots.find((entry) => `bot:${entry.id}` === caller.id)
  if (bot === undefined) return []
  return rows.filter((row) => row.source === 'bot' && (row.botId === bot.id || (row.botId === undefined && row.symbol === bot.symbol)))
}

/** A model a role could suggest: an enabled one asked at this effort. */
function suggestion(enabled: readonly string[], effort: 'low' | 'minimal', decide: string): string | null {
  return enabled.find((id) => aiEffortOf(id) === effort && id !== decide) ?? null
}

export function RoutingCard({ onMoved }: { onMoved?: () => void }): React.JSX.Element {
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [bots, setBots] = useState<Bot[]>([])
  const [today, setToday] = useState<AiCallRecord[]>([])
  const [choice, setChoice] = useState<RoleChoice | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [read, settings] = await Promise.all([window.api.ai.getConfig(), window.api.settings.get()])
      const midnight = Math.floor(Date.now() / 86_400_000) * 86_400
      const page = await window.api.ai.listCalls({ sinceSec: midnight, limit: 2000 })
      setConfig(read)
      setBots(settings.bots ?? [])
      setToday(page.rows)
      setChoice(
        (held) =>
          held ?? {
            decide: read.defaultModel,
            gate: read.roles?.gate ?? suggestion(read.enabledModels, 'low', read.defaultModel),
            summarize: read.roles?.summarize ?? suggestion(read.enabledModels, 'minimal', read.defaultModel)
          }
      )
    } catch (failure) {
      setError(describeError(failure))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const table = useMemo(() => (config === null ? [] : routingTableOf(config, bots as RoutedBot[])), [config, bots])
  const unused = useMemo(() => {
    if (config === null) return []
    const used = modelsInUse(config, bots as RoutedBot[])
    return config.enabledModels.filter((model) => model !== config.defaultModel && !used.has(model) && model !== config.roles?.gate && model !== config.roles?.summarize)
  }, [config, bots])

  async function move(): Promise<void> {
    if (choice === null) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const preview = await window.api.ai.routingPreview(choice)
      if (!window.confirm(preview.text)) return
      const done = await window.api.ai.routingApply({ choice, token: preview.token })
      setConfig(done.config)
      const moved = done.movedBots.length === 0 ? '' : ` ${done.movedBots.map((bot) => bot.name).join(', ')} moved to ${describeDecider(choice.decide)} from now on.`
      setMessage(`Every caller now asks your choices.${moved}`)
      await load()
      onMoved?.()
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  const selectFor = (role: 'decide' | 'gate' | 'summarize', label: string, optional: boolean): React.JSX.Element => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.78rem', color: 'var(--text-secondary)', minWidth: 0 }}>
      {label}
      <select
        id={`routing-${role}`}
        value={choice?.[role] ?? ''}
        onChange={(event) => setChoice((held) => (held === null ? held : { ...held, [role]: event.target.value === '' ? null : event.target.value }))}
        disabled={busy || config === null}
        style={{ ...inputStyle(), maxWidth: 320 }}
      >
        {optional && <option value="">The model that decides</option>}
        {(config?.enabledModels ?? []).map((model) => (
          <option key={model} value={model}>
            {describeDecider(model)}
          </option>
        ))}
      </select>
    </label>
  )

  return (
    <Card title="Who asks which model">
      <p style={{ ...noteStyle, marginBottom: '0.8rem' }}>
        The default model above is what you start yourself: a backtest, the chart, a bot you switch on. Everything that asks by itself keeps the model it was
        switched on with: the watch its own list, its paper trades one of those, the AI additions the model those trades follow, and each running bot the model it
        was pinned to. Here is each of them, what it asks now and what it has asked today, and one move that puts them all on the three models chosen below. A bot
        moved keeps its earlier decisions as the model that made them; only bars from the move on are asked of the new one.
      </p>
      {error !== null && <p style={{ ...noteStyle, color: 'var(--down)', marginBottom: '0.6rem' }}>{error}</p>}
      {message !== null && <p style={{ ...noteStyle, color: 'var(--up)', marginBottom: '0.6rem' }}>{message}</p>}
      <div style={{ overflowX: 'auto', marginBottom: '1rem' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={headCellStyle}>Caller</th>
              <th style={headCellStyle}>On</th>
              <th style={headCellStyle}>Asks now</th>
              <th style={headCellStyle}>Follows</th>
              <th style={headCellStyle}>Calls today</th>
              <th style={headCellStyle}>Answered by</th>
              <th style={headCellStyle}>Cost today</th>
            </tr>
          </thead>
          <tbody>
            {table.map((caller) => {
              const mine = rowsOf(caller, today, bots)
              const served = [...new Set(mine.filter((row) => row.status !== 'failed').map((row) => row.servedModel ?? row.model))]
              const cost = mine.reduce((sum, row) => sum + (row.usage.costUsd ?? 0), 0)
              return (
                <tr key={caller.id}>
                  <td style={cellStyle}>{caller.label}</td>
                  <td style={cellStyle}>{caller.on ? 'yes' : 'no'}</td>
                  <td style={cellStyle}>{caller.asks.length === 0 ? '—' : caller.asks.map((model) => describeDecider(model)).join(', then ')}</td>
                  <td style={{ ...cellStyle, color: 'var(--text-secondary)' }}>{caller.follows}</td>
                  <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{caller.kind === 'watch-paper' ? '—' : mine.length}</td>
                  <td style={cellStyle}>{served.length === 0 ? '—' : served.join(', ')}</td>
                  <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{caller.kind === 'watch-paper' ? '—' : formatUsd(cost)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.8rem', alignItems: 'flex-end', marginBottom: '0.6rem' }}>
        {selectFor('decide', 'Decides: the watch, its paper trades, bots, reviews, exits', false)}
        {selectFor('gate', "Takes the watch's first look", true)}
        {selectFor('summarize', 'Writes the summaries: news, why, the daily summary', true)}
        <button onClick={() => void move()} disabled={busy || choice === null} style={buttonStyle('primary', busy || choice === null)}>
          {busy ? 'Working…' : 'Move every caller to these'}
        </button>
      </div>
      <p style={noteStyle}>
        The move says what each caller will ask and what that costs before anything changes. The watch and its paper trades stay on or off as they are, with their
        limits, stake and caps; the daily AI budget still applies to everything.
        {unused.length > 0 && ` Nothing asks ${unused.map((model) => describeDecider(model)).join(', ')} by itself now: ${unused.length === 1 ? 'it' : 'they'} can be disabled above.`}
      </p>
    </Card>
  )
}
