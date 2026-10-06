import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import type { AiConfig } from '../../shared/aiCost'
import { AI_OPPORTUNITY_MAX_MODELS } from '../../shared/aiOpportunity'
import { describeDecider } from '../../shared/aiPanel'
import { AI_WATCH_EVENT_LIMITS, AI_WATCH_FRESH_SECONDS, describeAiWatchCost, describeWatchPause, type AiWatchBand, type AiWatchConfig } from '../../shared/aiWatch'
import {
  AI_WATCH_PAPER_BTC_MOVES,
  AI_WATCH_PAPER_LOSING_RUNS,
  AI_WATCH_PAPER_OPEN_LIMITS,
  AI_WATCH_PAPER_SAME_SIDE_LIMITS,
  AI_WATCH_PAPER_STAKES,
  describeAiWatchPaper,
  describeWatchPaperSafeguards,
  describeWatchPaperSize,
  type AiWatchPaperConfig
} from '../../shared/aiWatchPaper'
import { healPaperRisk } from '../../shared/paperRisk'
import { describePaperPause, healPaperPause } from '../../shared/paperPause'
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
  return `Each ${which} the scanner puts forward -- and each delisting, or coin added to the Monitoring Tag, Binance announces, when those are put to the models under Settings › Market -- is put to ${listOf(watch.models.map(describeDecider))} as it is raised, at most ${watch.maxEventsPerDay} events a day.${gate}`
}

/** What the tab knows of the watch's own paper trades, read from the executors on file. */
export interface WatchPaperStanding {
  /** Whether a paper account is set up to hold them to a balance. Null until it has been read. */
  hasAccount: boolean | null
  /** The pairs of the ones open now. */
  open: string[]
  /** How many the watch has opened that are still on file, open or stopped. */
  total: number
  /** What the ones that have ended add up to, in a sentence. Empty when none has. */
  ended: string
  /** Why none is being opened: a losing run, until they are resumed on Risk & Safety
   * (shared/paperPause.ts), or losses in a row, until midnight UTC (shared/aiWatchPaper.ts
   * watchPaperPause). Null when neither holds. */
  pause?: string | null
  /** How the app's own paper trades are sized and capped, as settings.json holds it (healed here;
   * shared/paperRisk.ts). */
  risk?: unknown
  /** The losing run that pauses them, as settings.json holds it (healed here; shared/paperPause.ts). */
  pauseSetting?: unknown
}

/** The watch's switch (shared/aiWatch.ts), and the switch for its paper trades
 * (shared/aiWatchPaper.ts).
 *
 * SWITCHING THE WATCH ON IS THE ONE CONFIRMATION IT GETS, so that confirmation states the most a
 * day of it can cost, and what it asks cannot be changed while it is on: the choices below are
 * only there while it is off. Switching it off asks nothing; it only ever makes things cheaper.
 *
 * PAPER TRADES ARE A SECOND SWITCH WITH A CONFIRMATION OF THEIR OWN, which says what will be
 * opened with nobody pressing anything, and that it is paper. They cost nothing and ask nothing.
 *
 * The card changes two settings through the bridge. It asks no model and opens nothing itself. */
export function WatchCard({
  config,
  onConfig,
  scannerOn,
  events,
  takenToday,
  paused = [],
  paper = { hasAccount: null, open: [], total: 0, ended: '' }
}: {
  config: AiConfig
  onConfig: (next: AiConfig) => void
  scannerOn: boolean | null
  /** The scanner's events, newest first: one of them is the question a call is priced on. */
  events: MarketEvent[]
  /** Events the watch has taken up since the last UTC midnight. */
  takenToday: number
  /** Models the watch has stopped asking today, because they keep failing or being refused. */
  paused?: string[]
  paper?: WatchPaperStanding
}): React.JSX.Element {
  const { watch, watchPaper } = config
  const risk = healPaperRisk(paper.risk)
  const pauseSetting = healPaperPause(paper.pauseSetting)
  const [paperModel, setPaperModel] = useState<string>(watchPaper.model ?? '')
  const [paperStake, setPaperStake] = useState<number>(watchPaper.stakeQuote)
  const [paperOpen, setPaperOpen] = useState<number>(watchPaper.maxOpen)
  const [paperSameSide, setPaperSameSide] = useState<number>(watchPaper.maxSameSide)
  const [paperLosses, setPaperLosses] = useState<number>(watchPaper.pauseAfterLosses)
  const [paperBtc, setPaperBtc] = useState<number>(watchPaper.dropOnBtcMovePct)
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
        setProblem('The scanner has not raised an event yet, so there is no question to price a call on. Switch the scanner on under Settings › Market, and switch the watch on once it has raised one.')
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

  // The model paper trades would follow: the one picked, while the watch still asks it.
  const followed = watch.models.includes(paperModel) ? paperModel : (watch.models[0] ?? '')

  async function paperOn(): Promise<void> {
    if (busy) return
    if (followed === '') {
      setProblem('Paper trades follow one of the models the watch asks, and it asks none yet.')
      return
    }
    const next: AiWatchPaperConfig = {
      enabled: true,
      model: followed,
      stakeQuote: paperStake,
      maxOpen: paperOpen,
      maxSameSide: paperSameSide,
      pauseAfterLosses: paperLosses,
      dropOnBtcMovePct: paperBtc
    }
    if (!window.confirm(describeAiWatchPaper({ config: next, risk, pause: pauseSetting, watchOn: watch.enabled, hasPaperAccount: paper.hasAccount === true }))) return
    setBusy(true)
    setProblem(null)
    try {
      onConfig(await window.api.ai.setConfig({ watchPaper: next }))
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  async function paperOff(): Promise<void> {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      onConfig(await window.api.ai.setConfig({ watchPaper: { enabled: false } }))
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  const labelStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-primary)', cursor: busy ? 'default' : 'pointer' }
  const selectLabelStyle: React.CSSProperties = { fontSize: '0.8rem', color: 'var(--text-secondary)' }

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
          {paused.map((model) => (
            <p key={model} style={{ ...noteStyle, color: 'var(--gold)', marginTop: '0.3rem' }}>
              {describeWatchPause(model)}
            </p>
          ))}
          {scannerOn === false && (
            <p style={{ ...noteStyle, color: 'var(--gold)', marginTop: '0.5rem' }}>
              The scanner is off, so the watch asks only about delistings and Monitoring Tags, when Binance&apos;s announcements are read and put to the models.
              Both are switched under Settings › Market.
            </p>
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
            the models ticked here as the scanner raises it, with no click, and a call to trade raises a desktop notice. It places nothing real.
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
      <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border)', paddingTop: '0.8rem' }}>
        <div style={{ fontSize: '0.66rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>Paper trades from the watch</div>
        {watchPaper.enabled ? (
          <>
            <p style={{ ...noteStyle, color: 'var(--text-primary)' }}>
              <strong style={{ color: 'var(--up)' }}>On.</strong> Each call by {describeDecider(watchPaper.model ?? '')} at 65% confidence or more opens a paper position by itself,
              staking {describeWatchPaperSize(watchPaper, risk)}, with its own stop, target and time limit. At most {watchPaper.maxOpen} open at once, one an event, one on
              a pair. {describeWatchPaperSafeguards(watchPaper)}
              {risk.maxOutQuote !== null && ` With the news rules' paper shorts, they stake at most ${risk.maxOutQuote.toLocaleString('en-US')} together.`}
              {pauseSetting.lossR !== null && ` ${describePaperPause(pauseSetting)}`} Nothing real is placed.
            </p>
            {paper.pause != null && (
              <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.4rem' }}>
                <strong>Paused.</strong> {paper.pause}
              </p>
            )}
            <p style={{ ...noteStyle, color: 'var(--text-secondary)', marginTop: '0.4rem' }}>
              {paper.total === 0
                ? 'None opened yet.'
                : `${paper.open.length === 0 ? 'None open now.' : `${paper.open.length} open now: ${listOf(paper.open)}.`} ${paper.total} on Strategies › Execution in all.`}
              {paper.ended !== '' && ` ${paper.ended}`}
              {!watch.enabled && ' The watch is off, so none will be opened until it is switched on.'}
            </p>
            {paper.hasAccount === false && (
              <p style={{ ...noteStyle, marginTop: '0.3rem' }}>
                No paper account is set up, so their results are added to no balance. Each card on Strategies › Execution says how its trade ended.
              </p>
            )}
            <div style={{ marginTop: '0.7rem' }}>
              <button onClick={() => void paperOff()} disabled={busy} style={buttonStyle('secondary', busy)}>
                Switch paper trades off
              </button>
            </div>
          </>
        ) : watch.models.length === 0 ? (
          <p style={noteStyle}>
            <strong style={{ color: 'var(--text-secondary)' }}>Off.</strong> They follow one of the models the watch asks, so they can be switched on once the watch has been.
          </p>
        ) : (
          <>
            <p style={noteStyle}>
              <strong style={{ color: 'var(--text-secondary)' }}>Off.</strong> Switched on, a call the watch would act on opens a paper position by itself: the one the Paper trade
              button would fill in, at the stake set here, or less where Risk &amp; Safety sizes paper trades by what their stop would lose. It is paper only and cannot be pointed at real money.
            </p>
            <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.7rem' }}>
              <label style={selectLabelStyle}>
                Follow{' '}
                <select aria-label="Paper trades follow" value={followed} disabled={busy} onChange={(event) => setPaperModel(event.target.value)} style={inputStyle()}>
                  {watch.models.map((model) => (
                    <option key={model} value={model}>
                      {describeDecider(model)}
                    </option>
                  ))}
                </select>
              </label>
              <label style={selectLabelStyle}>
                Stake a trade{' '}
                <select aria-label="Paper trade stake" value={paperStake} disabled={busy} onChange={(event) => setPaperStake(Number(event.target.value))} style={inputStyle()}>
                  {AI_WATCH_PAPER_STAKES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label style={selectLabelStyle}>
                Open at once, at most{' '}
                <select aria-label="Paper trades open at once" value={paperOpen} disabled={busy} onChange={(event) => setPaperOpen(Number(event.target.value))} style={inputStyle()}>
                  {AI_WATCH_PAPER_OPEN_LIMITS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.6rem' }}>
              <label style={selectLabelStyle}>
                In one direction, at most{' '}
                <select aria-label="Paper trades open in one direction" value={paperSameSide} disabled={busy} onChange={(event) => setPaperSameSide(Number(event.target.value))} style={inputStyle()}>
                  {AI_WATCH_PAPER_SAME_SIDE_LIMITS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label style={selectLabelStyle}>
                Pause for the day after{' '}
                <select aria-label="Losses in a row that pause paper trades" value={paperLosses} disabled={busy} onChange={(event) => setPaperLosses(Number(event.target.value))} style={inputStyle()}>
                  {AI_WATCH_PAPER_LOSING_RUNS.map((value) => (
                    <option key={value} value={value}>
                      {value === 0 ? 'never' : `${value} losses in a row`}
                    </option>
                  ))}
                </select>
              </label>
              <label style={selectLabelStyle}>
                Drop one not yet entered if Bitcoin moves against it{' '}
                <select aria-label="Bitcoin move that drops a paper trade" value={paperBtc} disabled={busy} onChange={(event) => setPaperBtc(Number(event.target.value))} style={inputStyle()}>
                  {AI_WATCH_PAPER_BTC_MOVES.map((value) => (
                    <option key={value} value={value}>
                      {value === 0 ? 'never' : `${value}%`}
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={() => void paperOn()} disabled={busy} style={buttonStyle('primary', busy)}>
                Switch paper trades on
              </button>
            </div>
            {paper.total > 0 && (
              <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
                {paper.total} opened earlier {paper.total === 1 ? 'is' : 'are'} on Strategies › Execution.{paper.ended !== '' && ` ${paper.ended}`}
              </p>
            )}
          </>
        )}
      </div>
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.6rem' }}>{problem}</p>}
      <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
        The watch takes up an event only while it is fresh — raised live in the last {AI_WATCH_FRESH_SECONDS / 60} minutes, among the strongest {EVENT_MAX_RANKED} of its minute
        — and never one that was on file when the app started. Its daily limit is counted from the record of calls, in the main process, and the daily AI budget applies to it as
        to everything else. What it asks cannot be changed while it is on: switch it off, change it, and switching it on states the new price. It runs while this app is open.
      </p>
    </Card>
  )
}
