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
import { describeModelHealth } from '../../shared/modelHealth'
import { healPaperRisk } from '../../shared/paperRisk'
import { describePaperPause, healPaperPause } from '../../shared/paperPause'
import { EVENT_MAX_RANKED, type MarketEvent } from '../../shared/marketEvent'
import { describeError } from '../utils/ipcError'
import { buttonStyle, inputStyle, noteStyle } from './agentStyles'
import { getWatchActivity, priceWatchCall, subscribeWatchActivity, type WatchActivity } from './opportunityWatch'
import { getModelHealthReport, subscribeModelHealth, type ModelHealthReport } from './modelHealthWatch'
import { describeModelFacts, loadModelFacts, type ModelFacts } from './modelFacts'
import type { CandleFetch } from './opportunities'
import { useI18n, type I18n } from '../i18n'

/** How far back the ledger is read for each model's record on the card. */
const FACTS_DAYS = 30

const fetchCandles: CandleFetch = async (exchange, symbol, interval, startSec, endSec) =>
  (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles

/** What a watch that is on is doing, in a sentence. */
function describeWatch(watch: AiWatchConfig, i18n: I18n): string {
  const { t } = i18n
  const models = i18n.list(watch.models.map((model) => describeDecider(model, i18n)))
  const values = { models, count: watch.maxEventsPerDay }
  const said =
    watch.minBand === 'urgent'
      ? t('Each urgent event the scanner puts forward -- and each delisting, or coin added to the Monitoring Tag, Binance announces, when those are put to the models under Settings › Market -- is put to {models} as it is raised, at most {count} events a day.', values)
      : t('Each event at candidate or urgent the scanner puts forward -- and each delisting, or coin added to the Monitoring Tag, Binance announces, when those are put to the models under Settings › Market -- is put to {models} as it is raised, at most {count} events a day.', values)
  const gate =
    watch.firstModelGates && watch.models.length > 1
      ? ` ${
          watch.models.length === 2
            ? t('{model} is asked first, and the other only when it calls a trade.', { model: describeDecider(watch.models[0], i18n) })
            : t('{model} is asked first, and the others only when it calls a trade.', { model: describeDecider(watch.models[0], i18n) })
        }`
      : ''
  return `${said}${gate}`
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
  const i18n = useI18n()
  const { t, utcTime, share } = i18n
  const listOf = (names: string[]): string => i18n.list(names)
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
  const [confirmLive, setConfirmLive] = useState(watch.confirmLive)
  const [askAt, setAskAt] = useState<AiWatchConfig['askAt']>(watch.askAt)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [activity, setActivity] = useState<WatchActivity>(getWatchActivity())

  useEffect(() => subscribeWatchActivity(setActivity), [])
  // The daily look's mark on each model (./modelHealthWatch.ts): shown here, and nothing unticked by it.
  const [health, setHealth] = useState<ModelHealthReport | null>(getModelHealthReport())
  useEffect(() => subscribeModelHealth(setHealth), [])

  // A model disabled on another tab is no longer one the watch can be given.
  const offered = config.enabledModels
  const chosen = models.filter((model) => offered.includes(model))
  const [facts, setFacts] = useState<Record<string, ModelFacts>>({})
  const offeredKey = offered.join('|')
  useEffect(() => {
    let cancelled = false
    void loadModelFacts(offered, Math.floor(Date.now() / 1000) - FACTS_DAYS * 86_400).then((next) => {
      if (!cancelled) setFacts(next)
    })
    return (): void => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the models offered, not the array's identity
  }, [offeredKey])

  function toggle(model: string): void {
    setModels((current) => (current.includes(model) ? current.filter((entry) => entry !== model) : [...current.filter((entry) => offered.includes(entry)), model].slice(0, AI_OPPORTUNITY_MAX_MODELS)))
  }

  async function switchOn(): Promise<void> {
    if (busy) return
    if (chosen.length === 0) {
      setProblem(t('Tick at least one model for the watch to ask.'))
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      // Free: what one call to each model is expected to cost, on a recent event's question.
      const priced = await priceWatchCall(events, chosen, { fetchCandles, peek: (request) => window.api.ai.peekOpportunity(request) })
      if (priced === null) {
        setProblem(t('The scanner has not raised an event yet, so there is no question to price a call on. Switch the scanner on under Settings › Market, and switch the watch on once it has raised one.'))
        return
      }
      const next: AiWatchConfig = { enabled: true, models: chosen, maxEventsPerDay: limit, minBand: band, firstModelGates: gates && chosen.length > 1, confirmLive, askAt }
      const agreed = window.confirm(
        describeAiWatchCost(
          {
            watch: next,
            models: priced.models.map((model) => ({ model: model.model, perCallCostUsd: model.perCallCostUsd, costBasis: model.costBasis })),
            budgetRemainingUsd: priced.budgetRemainingUsd,
            dailyCapUsd: config.dailyCapUsd,
            scannerOn: scannerOn === true
          },
          i18n
        )
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

  /** When to ask under a running watch (at the raise, or once confirmed): not a term of its price,
   * so no second confirmation. */
  async function setAskAtChoice(choice: AiWatchConfig['askAt']): Promise<void> {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      onConfig(await window.api.ai.setConfig({ watch: { askAt: choice } }))
      setAskAt(choice)
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  /** CONFIRM on or off under a running watch: not a term of its price, so no second confirmation. */
  async function setConfirm(on: boolean): Promise<void> {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      onConfig(await window.api.ai.setConfig({ watch: { confirmLive: on } }))
      setConfirmLive(on)
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
      setProblem(t('Paper trades follow one of the models the watch asks, and it asks none yet.'))
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
    if (!window.confirm(describeAiWatchPaper({ config: next, risk, pause: pauseSetting, watchOn: watch.enabled, hasPaperAccount: paper.hasAccount === true }, i18n))) return
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
    <Card title={t('Watch')}>
      {watch.enabled ? (
        <>
          <p style={{ ...noteStyle, color: 'var(--text-primary)' }}>
            <strong style={{ color: 'var(--up)' }}>{t('On.')}</strong> {describeWatch(watch, i18n)}
          </p>
          <p style={{ ...noteStyle, color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
            {t('Asked about {taken} of {count} events today (UTC).', { taken: takenToday, count: watch.maxEventsPerDay })}
            {activity.asking.length > 0 && ` ${t('Asking about {pairs} now.', { pairs: listOf(activity.asking) })}`}
          </p>
          <label style={{ ...labelStyle, marginTop: '0.5rem' }}>
            <input type="checkbox" aria-label={t('Tell me when a paper trade is ready to confirm as a real order')} checked={watch.confirmLive} disabled={busy} onChange={() => void setConfirm(!watch.confirmLive)} />
            {t('CONFIRM: tell me when a paper BUY it opens is ready to confirm as a real order, sized by my risk setting. I place it; it never does.')}
          </label>
          <label style={{ ...labelStyle, marginTop: '0.3rem' }}>
            {t('Ask@@when')}{' '}
            <select
              aria-label={t('When the watch asks')}
              value={watch.askAt}
              disabled={busy}
              onChange={(event) => void setAskAtChoice(event.target.value === 'confirmed' ? 'confirmed' : 'detected')}
              style={inputStyle()}
            >
              <option value="detected">{t('at the raise, within three minutes')}</option>
              <option value="confirmed">{t('once the event is confirmed, a pass later')}</option>
            </select>
          </label>
          {watch.models.length > 1 && (
            <p style={{ ...noteStyle, color: 'var(--text-secondary)', marginTop: '0.3rem' }}>
              {t('With {count} models the paper trade follows their vote: more than half of the usable answers on one side and none on the other, and the plan of the surest among them. A split is refused, written down and told.', { count: watch.models.length })}
            </p>
          )}
          {activity.last !== null && (
            <p style={{ ...noteStyle, color: activity.last.ok ? 'var(--text-secondary)' : 'var(--down)', marginTop: '0.3rem' }}>
              {t('Last, at {time} UTC: {what}', { time: utcTime(activity.last.at * 1000), what: activity.last.text })}
            </p>
          )}
          {paused.map((model) => (
            <p key={model} style={{ ...noteStyle, color: 'var(--gold)', marginTop: '0.3rem' }}>
              {describeWatchPause(model, i18n)}
            </p>
          ))}
          {watch.models.map((model) => {
            const mark = health?.models[model]
            return mark === undefined || !mark.degraded ? null : (
              <p key={`degraded:${model}`} style={{ ...noteStyle, color: 'var(--gold)', marginTop: '0.3rem' }}>
                <strong>{t('DEGRADED.')}</strong> {describeModelHealth(model, mark, i18n)}
              </p>
            )
          })}
          {scannerOn === false && (
            <p style={{ ...noteStyle, color: 'var(--gold)', marginTop: '0.5rem' }}>
              {t("The scanner is off, so the watch asks only about delistings and Monitoring Tags, when Binance's announcements are read and put to the models. Both are switched under Settings › Market.")}
            </p>
          )}
          <div style={{ marginTop: '0.8rem' }}>
            <button onClick={() => void switchOff()} disabled={busy} style={buttonStyle('secondary', busy)}>
              {t('Switch the watch off')}
            </button>
          </div>
        </>
      ) : (
        <>
          <p style={noteStyle}>
            <strong style={{ color: 'var(--text-secondary)' }}>{t('Off.')}</strong>{' '}
            {t('Nothing below is asked until Ask is pressed on an event. Switched on, the watch puts each event to the models ticked here as the scanner raises it, with no click, and a call to trade raises a desktop notice. It places nothing real.')}
          </p>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginTop: '0.8rem' }}>
            {offered.map((model) => (
              <label key={model} style={{ ...labelStyle, alignItems: 'flex-start' }}>
                <input type="checkbox" aria-label={t('Watch asks {model}', { model })} checked={chosen.includes(model)} disabled={busy} onChange={() => toggle(model)} style={{ marginTop: '0.2rem' }} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
                  <span>
                    <span dir="ltr">{describeDecider(model, i18n)}</span>
                    {health?.models[model]?.degraded === true && <span style={{ color: 'var(--gold)', fontWeight: 600 }}> {t('DEGRADED')}</span>}
                    {chosen.length > 1 && chosen.includes(model) && <span style={{ color: 'var(--text-muted)' }}> #{chosen.indexOf(model) + 1}</span>}
                  </span>
                  {facts[model] !== undefined && (
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }} data-testid="model-facts">
                      {describeModelFacts(facts[model], i18n)}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
          {chosen.length > 1 && (
            <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
              {t('With {count} models the paper trade follows their vote: more than half of the usable answers on one side and none on the other, and the plan of the surest among them. A split is refused, written down and told.', { count: chosen.length })}
            </p>
          )}
          <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.8rem' }}>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              {t('Events a day, at most')}{' '}
              <select aria-label={t('Watch events a day')} value={limit} disabled={busy} onChange={(event) => setLimit(Number(event.target.value))} style={inputStyle()}>
                {AI_WATCH_EVENT_LIMITS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              {t('Ask about')}{' '}
              <select aria-label={t('Watch band')} value={band} disabled={busy} onChange={(event) => setBand(event.target.value === 'candidate' ? 'candidate' : 'urgent')} style={inputStyle()}>
                <option value="urgent">{t('urgent events only')}</option>
                <option value="candidate">{t('candidate and urgent events')}</option>
              </select>
            </label>
            {chosen.length > 1 && (
              <label style={labelStyle}>
                <input type="checkbox" aria-label={t('Watch asks the first model alone')} checked={gates} disabled={busy} onChange={() => setGates((on) => !on)} />
                {chosen.length === 2
                  ? t('Ask {model} alone, and the other only when it calls a trade', { model: describeDecider(chosen[0], i18n) })
                  : t('Ask {model} alone, and the others only when it calls a trade', { model: describeDecider(chosen[0], i18n) })}
              </label>
            )}
            <label style={labelStyle}>
              <input type="checkbox" aria-label={t('Tell me when a paper trade is ready to confirm as a real order')} checked={confirmLive} disabled={busy} onChange={() => setConfirmLive((on) => !on)} />
              {t('CONFIRM: tell me when a paper BUY it opens is ready to confirm as a real order, sized by my risk setting. I place it; it never does.')}
            </label>
            <label style={labelStyle}>
              {t('Ask@@when')}{' '}
              <select aria-label={t('When the watch asks')} value={askAt} disabled={busy} onChange={(event) => setAskAt(event.target.value === 'confirmed' ? 'confirmed' : 'detected')} style={inputStyle()}>
                <option value="detected">{t('at the raise, within three minutes')}</option>
                <option value="confirmed">{t('once the event is confirmed, a pass later')}</option>
              </select>
            </label>
          </div>
          <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.9rem' }}>
            <button onClick={() => void switchOn()} disabled={busy} style={buttonStyle('primary', busy)}>
              {busy ? t('Pricing…') : t('Switch the watch on')}
            </button>
            <span style={noteStyle}>{t('The most a day of it can cost is stated before it is switched on.')}</span>
          </div>
        </>
      )}
      <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border)', paddingTop: '0.8rem' }}>
        <div style={{ fontSize: '0.66rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>{t('Paper trades from the watch')}</div>
        {watchPaper.enabled ? (
          <>
            <p style={{ ...noteStyle, color: 'var(--text-primary)' }}>
              <strong style={{ color: 'var(--up)' }}>{t('On.')}</strong>{' '}
              {t('Each call by {model} at 65% confidence or more opens a paper position by itself, staking {size}, with its own stop, target and time limit. At most {count} open at once, one an event, one on a pair.', {
                model: describeDecider(watchPaper.model ?? '', i18n),
                size: describeWatchPaperSize(watchPaper, risk, i18n),
                count: watchPaper.maxOpen
              })}{' '}
              {describeWatchPaperSafeguards(watchPaper, i18n)}
              {risk.maxOutQuote !== null && ` ${t("With the news rules' paper shorts, they stake at most {amount} together.", { amount: i18n.num(risk.maxOutQuote, 0, 2) })}`}
              {pauseSetting.lossR !== null && ` ${describePaperPause(pauseSetting, i18n)}`} {t('Nothing real is placed.')}
            </p>
            {paper.pause != null && (
              <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.4rem' }}>
                <strong>{t('Paused.')}</strong> {paper.pause}
              </p>
            )}
            <p style={{ ...noteStyle, color: 'var(--text-secondary)', marginTop: '0.4rem' }}>
              {paper.total === 0
                ? t('None opened yet.')
                : `${paper.open.length === 0 ? t('None open now.') : t('{count} open now: {pairs}.', { count: paper.open.length, pairs: listOf(paper.open) })} ${t('{count} on Strategies › Execution in all.', { count: paper.total })}`}
              {paper.ended !== '' && ` ${paper.ended}`}
              {!watch.enabled && ` ${t('The watch is off, so none will be opened until it is switched on.')}`}
            </p>
            {paper.hasAccount === false && (
              <p style={{ ...noteStyle, marginTop: '0.3rem' }}>{t('No paper account is set up, so their results are added to no balance. Each card on Strategies › Execution says how its trade ended.')}</p>
            )}
            <div style={{ marginTop: '0.7rem' }}>
              <button onClick={() => void paperOff()} disabled={busy} style={buttonStyle('secondary', busy)}>
                {t('Switch paper trades off')}
              </button>
            </div>
          </>
        ) : watch.models.length === 0 ? (
          <p style={noteStyle}>
            <strong style={{ color: 'var(--text-secondary)' }}>{t('Off.')}</strong> {t('They follow one of the models the watch asks, so they can be switched on once the watch has been.')}
          </p>
        ) : (
          <>
            <p style={noteStyle}>
              <strong style={{ color: 'var(--text-secondary)' }}>{t('Off.')}</strong>{' '}
              {t('Switched on, a call the watch would act on opens a paper position by itself: the one the Paper trade button would fill in, at the stake set here, or less where Risk & Safety sizes paper trades by what their stop would lose. It is paper only and cannot be pointed at real money.')}
            </p>
            <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.7rem' }}>
              <label style={selectLabelStyle}>
                {t('Follow')}{' '}
                <select aria-label={t('Paper trades follow')} value={followed} disabled={busy} onChange={(event) => setPaperModel(event.target.value)} style={inputStyle()}>
                  {watch.models.map((model) => (
                    <option key={model} value={model}>
                      {describeDecider(model, i18n)}
                    </option>
                  ))}
                </select>
              </label>
              <label style={selectLabelStyle}>
                {t('Stake a trade')}{' '}
                <select aria-label={t('Paper trade stake')} value={paperStake} disabled={busy} onChange={(event) => setPaperStake(Number(event.target.value))} style={inputStyle()}>
                  {AI_WATCH_PAPER_STAKES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label style={selectLabelStyle}>
                {t('Open at once, at most')}{' '}
                <select aria-label={t('Paper trades open at once')} value={paperOpen} disabled={busy} onChange={(event) => setPaperOpen(Number(event.target.value))} style={inputStyle()}>
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
                {t('In one direction, at most')}{' '}
                <select aria-label={t('Paper trades open in one direction')} value={paperSameSide} disabled={busy} onChange={(event) => setPaperSameSide(Number(event.target.value))} style={inputStyle()}>
                  {AI_WATCH_PAPER_SAME_SIDE_LIMITS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label style={selectLabelStyle}>
                {t('Pause for the day after')}{' '}
                <select aria-label={t('Losses in a row that pause paper trades')} value={paperLosses} disabled={busy} onChange={(event) => setPaperLosses(Number(event.target.value))} style={inputStyle()}>
                  {AI_WATCH_PAPER_LOSING_RUNS.map((value) => (
                    <option key={value} value={value}>
                      {value === 0 ? t('never') : t('{count} losses in a row', { count: value })}
                    </option>
                  ))}
                </select>
              </label>
              <label style={selectLabelStyle}>
                {t('Drop one not yet entered if Bitcoin moves against it')}{' '}
                <select aria-label={t('Bitcoin move that drops a paper trade')} value={paperBtc} disabled={busy} onChange={(event) => setPaperBtc(Number(event.target.value))} style={inputStyle()}>
                  {AI_WATCH_PAPER_BTC_MOVES.map((value) => (
                    <option key={value} value={value}>
                      {value === 0 ? t('never') : share(value)}
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={() => void paperOn()} disabled={busy} style={buttonStyle('primary', busy)}>
                {t('Switch paper trades on')}
              </button>
            </div>
            {paper.total > 0 && (
              <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
                {t('{count} opened earlier are on Strategies › Execution.', { count: paper.total })}
                {paper.ended !== '' && ` ${paper.ended}`}
              </p>
            )}
          </>
        )}
      </div>
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.6rem' }}>{problem}</p>}
      <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
        {t(
          'The watch takes up an event only while it is fresh — raised live in the last {minutes} minutes, among the strongest {count} of its minute — and never one that was on file when the app started. Its daily limit is counted from the record of calls, in the main process, and the daily AI budget applies to it as to everything else. What it asks cannot be changed while it is on: switch it off, change it, and switching it on states the new price. It runs while this app is open.',
          { minutes: AI_WATCH_FRESH_SECONDS / 60, count: EVENT_MAX_RANKED }
        )}
      </p>
    </Card>
  )
}
