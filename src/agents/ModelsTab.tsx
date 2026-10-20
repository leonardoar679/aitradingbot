import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { Toggle } from '../components/Toggle'
import { AI_PROVIDER_LABEL } from '../../shared/aiSignal'
import { formatUsd, type AiConfig, type AiConfigPatch, type AiModelCatalogue, type AiModelInfo } from '../../shared/aiCost'
import { AI_EFFORTS, aiEffortOf, aiModelSlugOf, effortIdFor, type AiEffort } from '../../shared/aiEffort'
import { AI_PANEL_CALLS, describeDecider, panelIdFor } from '../../shared/aiPanel'
import { AI_ESCALATE_WHEN, describeEscalation, isAiEscalateWhen } from '../../shared/aiRoute'
import { describeError } from '../utils/ipcError'
import { buttonStyle, cellStyle, headCellStyle, inputStyle, noteStyle } from './agentStyles'

/** The catalogue holds several hundred models; a search narrows it rather than a scroll. */
const MAX_SEARCH_ROWS = 60

/** Prices are published per token and read per million. */
function perMillion(pricePerToken: number | null): string {
  return pricePerToken === null ? '—' : formatUsd(pricePerToken * 1_000_000)
}

function matches(model: AiModelInfo, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return needle !== '' && (model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle))
}

/** Which models may be asked, and which one is asked when nothing else is said.
 *
 * Loading the catalogue is a free request, and nothing on this tab calls a model. Enabling one is
 * permission, not a purchase: it costs nothing until something asks it a question. */
export function ModelsTab(): React.JSX.Element {
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [catalogue, setCatalogue] = useState<AiModelCatalogue | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (refresh: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setConfig(await window.api.ai.getConfig())
      setCatalogue(await window.api.ai.listModels(refresh))
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  async function save(patch: AiConfigPatch): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      setConfig(await window.api.ai.setConfig(patch))
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  const enabled = useMemo(() => new Set(config?.enabledModels ?? []), [config])
  const rows = useMemo(() => {
    const models = catalogue?.models ?? []
    const known = new Map(models.map((model) => [model.id, model]))
    // An enabled model is always listed, even one the catalogue no longer carries: it must stay
    // visible to be switched off, and a bot may still be pinned to it.
    const enabledRows = (config?.enabledModels ?? []).map((id): AiModelInfo => {
      // A model enabled at a lower reasoning effort is a row of its own, under its own id, read
      // off the one price-list entry the model has.
      const listed = known.get(aiModelSlugOf(id))
      return listed
        ? { ...listed, id }
        : {
            id,
            name: id,
            contextLength: null,
            promptPricePerToken: null,
            completionPricePerToken: null,
            structuredOutputs: false,
            reasoning: false
          }
    })
    const found = models.filter((model) => !enabled.has(model.id) && matches(model, query)).slice(0, MAX_SEARCH_ROWS)
    return [...enabledRows, ...found]
  }, [catalogue, config, enabled, query])

  function toggle(model: AiModelInfo, on: boolean): void {
    if (!config) return
    void save({ enabledModels: on ? [...config.enabledModels, model.id] : config.enabledModels.filter((id) => id !== model.id) })
  }

  /** Enables the same model a second time, asked to think less (shared/aiEffort.ts). */
  function enableAtEffort(model: AiModelInfo, effort: AiEffort): void {
    if (!config) return
    void save({ enabledModels: [...config.enabledModels, effortIdFor(model.id, effort)] })
  }

  // Any enabled model but the default can be the second: the default is the first by definition.
  // A panel of agents can be the second on any enabled model, the default's own included.
  const secondChoices = (config?.enabledModels ?? []).filter((id) => id !== config?.defaultModel)
  const panelChoices = (config?.enabledModels ?? []).map(panelIdFor)
  const route = config?.route ?? null

  return (
    <>
      <Card
        title="Models"
        actions={
          <button onClick={() => void load(true)} disabled={busy} style={buttonStyle('secondary', busy)}>
            {busy ? 'Loading…' : 'Refresh list'}
          </button>
        }
      >
        <p style={{ ...noteStyle, marginBottom: '0.9rem' }}>
          Every model {AI_PROVIDER_LABEL} offers is reachable with the one key. Enable the ones you want to compare; the
          default is what a backtest, the chart and a newly enabled bot ask. Only models that can be held to a strict JSON
          schema can be enabled, since an answer that is not in the agreed shape is refused. What asks by itself -- the
          watch, its paper trades, the AI additions and each running bot -- keeps the model it was switched on with: &quot;Who
          asks which model&quot; below shows each of them and moves them all to your choices at once.
        </p>
        <p style={{ ...noteStyle, marginBottom: '0.9rem' }}>
          A model that reasons before it answers can also be enabled at a lower reasoning effort. Most of what a call
          costs, and most of the wait, is that reasoning, so the same model told to think less is cheaper and faster. It
          is listed as a second model, with the effort after an @, and can be made the default, benchmarked and routed to
          like any other. It is asked only where something names it: a role below, a bot, a benchmark or a route. Whether
          it answers as well is not assumed: tick both on AI Benchmark and it puts the same questions to each.
        </p>
        {error !== null && <p style={{ ...noteStyle, color: 'var(--down)', marginBottom: '0.7rem' }}>{error}</p>}

        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the catalogue: claude, gemini, deepseek…"
          style={{ ...inputStyle(), width: '100%', maxWidth: 360, marginBottom: '0.8rem' }}
        />

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={headCellStyle}>Model</th>
                <th style={headCellStyle}>Context</th>
                <th style={headCellStyle}>Input / 1M</th>
                <th style={headCellStyle}>Output / 1M</th>
                <th style={headCellStyle}>Strict schema</th>
                <th style={headCellStyle}>Enabled</th>
                <th style={headCellStyle}>Default</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((model) => {
                const isEnabled = enabled.has(model.id)
                const isDefault = config?.defaultModel === model.id
                const effort = aiEffortOf(model.id)
                // Offered on an enabled model that takes an effort, for each effort not yet enabled.
                const offered =
                  isEnabled && effort === null && model.reasoning ? AI_EFFORTS.filter((entry) => !enabled.has(effortIdFor(model.id, entry))) : []
                return (
                  <tr key={model.id}>
                    <td style={cellStyle}>
                      <div style={{ fontWeight: 600 }}>{model.name}</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{model.id}</div>
                      {effort !== null && (
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>asked at {effort} reasoning effort</div>
                      )}
                      {offered.length > 0 && (
                        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.3rem' }}>
                          {offered.map((entry) => (
                            <button
                              key={entry}
                              onClick={() => enableAtEffort(model, entry)}
                              disabled={busy}
                              style={{ ...buttonStyle('secondary', busy), padding: '0.15rem 0.5rem', fontSize: '0.7rem' }}
                            >
                              Also enable at {entry} effort
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                    <td style={cellStyle}>{model.contextLength !== null ? model.contextLength.toLocaleString() : '—'}</td>
                    <td style={cellStyle}>{perMillion(model.promptPricePerToken)}</td>
                    <td style={cellStyle}>{perMillion(model.completionPricePerToken)}</td>
                    <td style={{ ...cellStyle, color: model.structuredOutputs ? 'var(--up)' : 'var(--text-muted)' }}>
                      {model.structuredOutputs ? 'yes' : 'no'}
                    </td>
                    <td style={cellStyle}>
                      {/* The default cannot be switched off from here: something must answer a run that names no model. */}
                      {isDefault ? (
                        <span style={{ color: 'var(--text-muted)' }}>always</span>
                      ) : model.structuredOutputs || isEnabled ? (
                        <Toggle on={isEnabled} onChange={(on) => !busy && toggle(model, on)} />
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>unavailable</span>
                      )}
                    </td>
                    <td style={cellStyle}>
                      {isDefault ? (
                        <span style={{ color: 'var(--accent)', fontWeight: 700 }}>default</span>
                      ) : isEnabled ? (
                        <button onClick={() => void save({ defaultModel: model.id })} disabled={busy} style={buttonStyle('secondary', busy)}>
                          Make default
                        </button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <p style={{ ...noteStyle, marginTop: '0.7rem' }}>
          {catalogue?.fetchedAt
            ? `${catalogue.models.length.toLocaleString()} models, price list read ${new Date(catalogue.fetchedAt * 1000).toLocaleString()}.`
            : 'The catalogue has not been loaded yet.'}{' '}
          Prices are {AI_PROVIDER_LABEL}&apos;s published rates; what a call actually cost is in the tables below.
        </p>
      </Card>

      <Card title="Routing: a second model for some decisions">
        <p style={{ ...noteStyle, marginBottom: '0.9rem' }}>
          With a route, GPT Intraday asks the default model at every decision and passes the decision on to a second model
          only when the rule below says so. The second model is asked the same question and its answer is the one that
          counts, so a decision costs one call, or two when it is passed on. A route applies to a GPT Intraday backtest and
          to a bot switched on from now on, and both state it and its price before anything is asked. A bot that is already
          running keeps what it was switched on with. The chart, AI Decisions › Analyze and entry confirmations always ask one
          model.
        </p>
        <p style={{ ...noteStyle, marginBottom: '0.9rem' }}>
          The second step can also be a panel of agents on a model: a trend analyst, a momentum analyst and a risk analyst
          each answer one narrow question about the same snapshot, and a fourth call makes the decision from the snapshot
          and their three reports. That is {AI_PANEL_CALLS} calls for each decision passed on instead of one. A panel cannot
          be the default model, so nothing starts costing {AI_PANEL_CALLS} calls a question because of a setting; it can be
          tried on one candle in Analyze and set beside its own model on AI Benchmark, which is where to find out
          whether it is worth four times the price.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '0.7rem' }}>
          <select
            value={route?.model ?? ''}
            disabled={busy || config === null}
            onChange={(event) =>
              void save({ route: event.target.value === '' ? null : { model: event.target.value, when: route?.when ?? AI_ESCALATE_WHEN[0] } })
            }
            style={inputStyle()}
            aria-label="Second model"
          >
            <option value="">Off: one model decides alone</option>
            {secondChoices.map((id) => (
              <option key={id} value={id}>
                Pass on to {id}
              </option>
            ))}
            {panelChoices.map((id) => (
              <option key={id} value={id}>
                Pass on to {describeDecider(id)} ({AI_PANEL_CALLS} calls)
              </option>
            ))}
          </select>
          <select
            value={route?.when ?? AI_ESCALATE_WHEN[0]}
            disabled={busy || route === null}
            onChange={(event) => {
              if (route !== null && isAiEscalateWhen(event.target.value)) void save({ route: { model: route.model, when: event.target.value } })
            }}
            style={inputStyle()}
            aria-label="When the second model is asked"
          >
            {AI_ESCALATE_WHEN.map((when) => (
              <option key={when} value={when}>
                when {config?.defaultModel ?? 'the default model'} {describeEscalation(when)}
              </option>
            ))}
          </select>
        </div>

        {config !== null && secondChoices.length === 0 && (
          <p style={{ ...noteStyle, marginBottom: '0.7rem' }}>
            Only one model is enabled, so the only second step on offer is its own panel. Enable another model above to route
            to it.
          </p>
        )}
        <p style={noteStyle}>
          {route !== null
            ? `On: ${config?.defaultModel} decides, and ${describeDecider(route.model)} is asked as well whenever it ${describeEscalation(route.when)}. `
            : 'Off. '}
          Passing on only the decisions that would trade keeps the second model for the answers that can cost money.
          Passing on the unsure ones leaves the first model&apos;s confident answers standing, a confident entry included.
          A second opinion is worth as much as its mistakes differ from the first model&apos;s: research/gptroute.ts measured
          that two models which nearly always agree are one opinion, and the second call then buys nothing. The Benchmark
          tab shows what a route between any two models would have done, and how often they made the same call, worked
          out from answers it already holds, so a route can be judged before it is switched on.
        </p>
      </Card>
    </>
  )
}
