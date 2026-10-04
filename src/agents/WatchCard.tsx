import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import type { AiConfig } from '../../shared/aiCost'
import { AI_OPPORTUNITY_MAX_MODELS } from '../../shared/aiOpportunity'
import { describeDecider } from '../../shared/aiPanel'
import { AI_WATCH_EVENT_LIMITS, AI_WATCH_FRESH_SECONDS, describeAiWatchCost, type AiWatchBand, type AiWatchConfig } from '../../shared/aiWatch'
import { EVENT_MAX_RANKED, type MarketEvent } from '../../shared/marketEvent'
import { describeError } from '../utils/ipcError'
import { buttonStyle, inputStyle, noteStyle } from './agentStyles'
import { getWatchActivity, priceWatchCall, subscribeWatchActivity, type WatchActivity } from './opportunityWatch'
import type { CandleFetch } from './opportunities'

const fetchCandles: CandleFetch = async (exchange, symbol, interval, startSec, endSec) =>
  (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 16)
}

function listOf(names: string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** What a watch that is on is doing, in a sentence. */
function describeWatch(watch: AiWatchConfig): string {
  const which = watch.minBand === 'urgent' ? 'urgent event' : 'event at candidate or urgent'
  const gate =
    watch.firstModelGates && watch.models.length > 1
      ? ` ${describeDecider(watch.models[0])} is asked first, and the ${watch.models.length === 2 ? 'other' : 'others'} only when it calls a trade.`
      : ''
  return `Each ${which} the scanner puts forward is put to ${listOf(watch.models.map(describeDecider))} as it is raised, at most ${watch.maxEventsPerDay} events a day.${gate}`
}

/** The watch's switch (shared/aiWatch.ts).
 *
 * SWITCHING IT ON IS THE ONE CONFIRMATION IT GETS, so that confirmation states the most a day of
 * it can cost, and what it asks cannot be changed while it is on: the choices below are only
 * there while it is off. Switching it off asks nothing; it only ever makes things cheaper.
 *
 * The card changes one setting through the bridge. It asks no model itself. */
export function WatchCard({
  config,
  onConfig,
  scannerOn,
  events,
  takenToday
}: {
  config: AiConfig
  onConfig: (next: AiConfig) => void
  scannerOn: boolean | null
  /** The scanner's events, newest first: one of them is the question a call is priced on. */
  events: MarketEvent[]
  /** Events the watch has taken up since the last UTC midnight. */
  takenToday: number
}): React.JSX.Element {
  const { watch } = config
  const [models, setModels] = useState<string[]>(watch.models)
  const [limit, setLimit] = useState<number>(watch.maxEventsPerDay)
  const [band, setBand] = useState<AiWatchBand>(watch.minBand)
  const [gates, setGates] = useState(watch.firstModelGates)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [activity, setActivity] = useState<WatchActivity>(getWatchActivity())

  useEffect(() => subscribeWatchActivity(setActivity), [])

  // A model disabled on another tab is no longer one the watch can be given.
  const offered = config.enabledModels
  const chosen = models.filter((model) => offered.includes(model))

  function toggle(model: string): void {
    setModels((current) => (current.includes(model) ? current.filter((entry) => entry !== model) : [...current.filter((entry) => offered.includes(entry)), model].slice(0, AI_OPPORTUNITY_MAX_MODELS)))
  }

  async function switchOn(): Promise<void> {
    if (busy) return
    if (chosen.length === 0) {
      setProblem('Tick at least one model for the watch to ask.')
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      // Free: what one call to each model is expected to cost, on a recent event's question.
      const priced = await priceWatchCall(events, chosen, { fetchCandles, peek: (request) => window.api.ai.peekOpportunity(request) })
      if (priced === null) {
        setProblem('The scanner has not raised an event yet, so there is no question to price a call on. Switch the scanner on under Explorer, and switch the watch on once it has raised one.')
        return
      }
      const next: AiWatchConfig = { enabled: true, models: chosen, maxEventsPerDay: limit, minBand: band, firstModelGates: gates && chosen.length > 1 }
      const agreed = window.confirm(
        describeAiWatchCost({
          watch: next,
          models: priced.models.map((model) => ({ model: model.model, perCallCostUsd: model.perCallCostUsd, costBasis: model.costBasis })),
          budgetRemainingUsd: priced.budgetRemainingUsd,
          dailyCapUsd: config.dailyCapUsd,
          scannerOn: scannerOn === true
        })
      )
      if (!agreed) return
      onConfig(await window.api.ai.setConfig({ watch: next }))
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  async function switchOff(): Promise<void> {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      onConfig(await window.api.ai.setConfig({ watch: { enabled: false } }))
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  const labelStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-primary)', cursor: busy ? 'default' : 'pointer' }

  return (
    <Card title="Watch">
      {watch.enabled ? (
        <>
          <p style={{ ...noteStyle, color: 'var(--text-primary)' }}>
            <strong style={{ color: 'var(--up)' }}>On.</strong> {describeWatch(watch)}
          </p>
          <p style={{ ...noteStyle, color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
            Asked about {takenToday} of {watch.maxEventsPerDay} events today (UTC).
            {activity.asking.length > 0 && ` Asking about ${listOf(activity.asking)} now.`}
          </p>
          {activity.last !== null && (
            <p style={{ ...noteStyle, color: activity.last.ok ? 'var(--text-secondary)' : 'var(--down)', marginTop: '0.3rem' }}>
              Last, at {utcClock(activity.last.at)} UTC: {activity.last.text}
            </p>
          )}
          {scannerOn === false && (
            <p style={{ ...noteStyle, color: 'var(--gold)', marginTop: '0.5rem' }}>The scanner is off, so the watch has nothing to ask about. Switch it on under Explorer.</p>
          )}
          <div style={{ marginTop: '0.8rem' }}>
            <button onClick={() => void switchOff()} disabled={busy} style={buttonStyle('secondary', busy)}>
              Switch the watch off
            </button>
          </div>
        </>
      ) : (
        <>
          <p style={noteStyle}>
            <strong style={{ color: 'var(--text-secondary)' }}>Off.</strong> Nothing below is asked until Ask is pressed on an event. Switched on, the watch puts each event to
            the models ticked here as the scanner raises it, with no click, and a call to trade raises a desktop notice. It places nothing.
          </p>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginTop: '0.8rem' }}>
            {offered.map((model) => (
              <label key={model} style={labelStyle}>
                <input type="checkbox" aria-label={`Watch asks ${model}`} checked={chosen.includes(model)} disabled={busy} onChange={() => toggle(model)} />
                {describeDecider(model)}
                {chosen.length > 1 && chosen.includes(model) && <span style={{ color: 'var(--text-muted)' }}>#{chosen.indexOf(model) + 1}</span>}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.8rem' }}>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              Events a day, at most{' '}
              <select aria-label="Watch events a day" value={limit} disabled={busy} onChange={(event) => setLimit(Number(event.target.value))} style={inputStyle()}>
                {AI_WATCH_EVENT_LIMITS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              Ask about{' '}
              <select aria-label="Watch band" value={band} disabled={busy} onChange={(event) => setBand(event.target.value === 'candidate' ? 'candidate' : 'urgent')} style={inputStyle()}>
                <option value="urgent">urgent events only</option>
                <option value="candidate">candidate and urgent events</option>
              </select>
            </label>
            {chosen.length > 1 && (
              <label style={labelStyle}>
                <input type="checkbox" aria-label="Watch asks the first model alone" checked={gates} disabled={busy} onChange={() => setGates((on) => !on)} />
                Ask {describeDecider(chosen[0])} alone, and the {chosen.length === 2 ? 'other' : 'others'} only when it calls a trade
              </label>
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.9rem' }}>
            <button onClick={() => void switchOn()} disabled={busy} style={buttonStyle('primary', busy)}>
              {busy ? 'Pricing…' : 'Switch the watch on'}
            </button>
            <span style={noteStyle}>The most a day of it can cost is stated before it is switched on.</span>
          </div>
        </>
      )}
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.6rem' }}>{problem}</p>}
      <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
        The watch takes up an event only while it is fresh — raised live in the last {AI_WATCH_FRESH_SECONDS / 60} minutes, among the strongest {EVENT_MAX_RANKED} of its minute
        — and never one that was on file when the app started. Its daily limit is counted from the record of calls, in the main process, and the daily AI budget applies to it as
        to everything else. What it asks cannot be changed while it is on: switch it off, change it, and switching it on states the new price. It runs while this app is open.
      </p>
    </Card>
  )
}
