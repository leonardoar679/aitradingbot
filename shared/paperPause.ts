import type { ExecutorConfig, PaperPauseSettings, PaperPauseState, PositionExecutorParams } from './ipc'
import { describeR, rMultiple } from './paperRisk'
import { ENGLISH, msg, type I18n } from './i18n/translate'

// A LOSING RUN PAUSES THE APP'S OWN PAPER TRADES, UNTIL SOMEONE RESUMES THEM.
//
// The watch and the news rules open paper trades with nobody pressing anything
// (shared/aiWatchPaper.ts, shared/newsActions.ts). Since 5 October 2026, when the user chose it,
// each stops after a losing run: when the last trades it closed -- 20 by default, of those with a
// stop -- lost 5 R or more together (R: what a trade made over what its stop would have lost,
// shared/paperRisk.ts), it opens none until it is resumed on Risk & Safety, and one desktop notice
// says so. Each is judged on its own record, as Performance draws them: the watch on its model's
// calls, the news rules on their shorts. A delisting's short has no stop, so no R, and is not
// counted.
//
// IT HOLDS UNTIL IT IS RESUMED. The scheduler writes the pause down when it finds the run
// (src/risk/PaperPauseScheduler.tsx), so a trade still open that ends ahead does not lift it, and
// nor does a restart. Until it is written down, the same reading of the record refuses a trade
// anyway. Resuming counts again from that moment: the run before it is not held against what
// comes after.
//
// IT ONLY EVER OPENS LESS. It refuses, and closes nothing: a trade open when it pauses runs to its
// end. The watch's own pause for the day after losses in a row (shared/aiWatchPaper.ts) is apart
// from it, and unchanged.
//
// IT IS PAPER. Nothing here reaches an order.

export type PaperPauseSource = 'watch' | 'news' | 'forecast'
export const PAPER_PAUSE_SOURCES: readonly PaperPauseSource[] = ['watch', 'news', 'forecast']
export const PAPER_PAUSE_LOSS_CHOICES = [3, 5, 8, 10] as const
export const PAPER_PAUSE_TRADE_CHOICES = [10, 20, 50] as const

const NOT_PAUSED: PaperPauseState = { countFrom: null, paused: null }

/** What applies until it is changed: 5 R lost together over the last 20. A trade sized by risk
 * loses about 1 R at its stop (shared/paperRisk.ts), so five stopped out, and nothing won back,
 * pause one. */
export const DEFAULT_PAPER_PAUSE: PaperPauseSettings = { lossR: 5, trades: 20, watch: NOT_PAUSED, news: NOT_PAUSED, forecast: NOT_PAUSED }

/** A hair of floating point is not short of the loss: five trades of -1 R each can add up to
 * -4.9999999999999995. */
const EPSILON = 1e-9

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isLossChoice(value: unknown): value is number {
  return (PAPER_PAUSE_LOSS_CHOICES as readonly unknown[]).includes(value)
}

function isTradeChoice(value: unknown): value is number {
  return (PAPER_PAUSE_TRADE_CHOICES as readonly unknown[]).includes(value)
}

/** One side's state, read as one. A pause that cannot be read is dropped, not guessed at: the
 * record it was found in is still on file, and paperPauseBlock reads that again. */
function healState(value: unknown): PaperPauseState {
  if (!isObject(value)) return NOT_PAUSED
  const paused = value.paused
  const readable = isObject(paused) && isFiniteNumber(paused.at) && isFiniteNumber(paused.r) && Number.isInteger(paused.trades) && (paused.trades as number) > 0
  return {
    countFrom: isFiniteNumber(value.countFrom) ? value.countFrom : null,
    paused: readable ? { at: paused.at as number, r: paused.r as number, trades: paused.trades as number } : null
  }
}

/** A stored setting, read as one: settings.json is written by the renderer, so it is healed rather
 * than obeyed. A loss or a run that is not one of its choices takes its default. No pause at all is
 * a choice of its own, stored as null; a file written before the setting existed holds nothing, and
 * has the pause. */
export function healPaperPause(value: unknown): PaperPauseSettings {
  const raw = isObject(value) ? value : {}
  return {
    lossR: raw.lossR === null ? null : isLossChoice(raw.lossR) ? raw.lossR : DEFAULT_PAPER_PAUSE.lossR,
    trades: isTradeChoice(raw.trades) ? raw.trades : DEFAULT_PAPER_PAUSE.trades,
    watch: healState(raw.watch),
    news: healState(raw.news),
    forecast: healState(raw.forecast)
  }
}

/** Why a setting cannot be saved, or null when it can. */
export function paperPauseProblem(setting: Pick<PaperPauseSettings, 'lossR' | 'trades'>): string | null {
  if (setting.lossR !== null && !isLossChoice(setting.lossR)) return `A losing run of ${PAPER_PAUSE_LOSS_CHOICES.join(', ')} R pauses them, or none does`
  if (!isTradeChoice(setting.trades)) return `The run is their last ${PAPER_PAUSE_TRADE_CHOICES.join(', ')} closed trades`
  return null
}

/** Which of the two opened a paper trade: a paper Position carrying the watch's mark or a news
 * rule's. Anything else -- a trade a person made, a bot's, one that is not paper -- is neither's. */
function sourceOf(executor: ExecutorConfig): PaperPauseSource | null {
  if (executor.mode !== 'paper' || executor.type !== 'position') return null
  if (executor.watch !== undefined) return 'watch'
  if (executor.newsRule !== undefined) return 'news'
  return executor.forecast !== undefined ? 'forecast' : null
}

export interface PaperRun {
  /** How many closed trades it is: the last ones, up to the setting's. */
  trades: number
  /** What they made in R, added up. */
  r: number
}

/** The run one side is judged on: of its paper trades that entered, had a stop and closed since it
 * was last resumed, the last `trades` to close, and what they made in R together. One stopped by
 * hand carries no result, and one that never entered made nothing: neither is counted. */
export function paperRun(executors: ExecutorConfig[], source: PaperPauseSource, setting: Pick<PaperPauseSettings, 'trades' | PaperPauseSource>): PaperRun {
  const from = setting[source].countFrom
  const closed: { closedAt: number; r: number }[] = []
  for (const executor of executors) {
    if (executor.status !== 'stopped' || sourceOf(executor) !== source) continue
    const result = executor.watch?.result ?? executor.newsRule?.result ?? executor.forecast?.result
    if (result === undefined || result.exit === 'entry_expired' || result.exit === 'btc_moved') continue
    if (from !== null && result.closedAt <= from) continue
    const r = rMultiple(result.pnlQuote, executor.params as PositionExecutorParams)
    // No stop, no R: a delisting's short. A result that is not a number is not a loss to count.
    if (r === null || !Number.isFinite(r)) continue
    closed.push({ closedAt: result.closedAt, r })
  }
  const last = closed.sort((a, b) => a.closedAt - b.closedAt).slice(-setting.trades)
  return { trades: last.length, r: last.reduce((sum, trade) => sum + trade.r, 0) }
}

/** Whether a run has lost the loss. Every choice of loss is above nothing, so a run of no trades,
 * which adds up to nothing, never has. */
function reached(run: PaperRun, lossR: number | null): boolean {
  return lossR !== null && run.r <= -lossR + EPSILON
}

const SIDES: Record<
  PaperPauseSource,
  { name: string; whose: string; its: string; it: string; is: string; has: string; opens: string; one: string; many: string; counted: string }
> = {
  watch: { name: 'The watch', whose: "The watch's", its: 'its', it: 'it', is: 'is', has: 'has', opens: 'it opens', one: 'paper trade', many: 'paper trades', counted: '' },
  news: {
    name: 'The news rules',
    whose: "The news rules'",
    its: 'their',
    it: 'they',
    is: 'are',
    has: 'have',
    opens: 'they open',
    one: 'paper short',
    many: 'paper shorts',
    counted: ' with a stop'
  },
  forecast: { name: 'The forecast trader', whose: "The forecast trader's", its: 'its', it: 'it', is: 'is', has: 'has', opens: 'it opens', one: 'paper trade', many: 'paper trades', counted: '' }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "14:20 UTC on 5 Oct". */
function utcMoment(sec: number): string {
  const date = new Date(sec * 1000)
  const clock = `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
  return `${clock} UTC on ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`
}

/** "last 20 closed paper trades", "last closed paper short with a stop". */
function lastClosed(source: PaperPauseSource, trades: number): string {
  const side = SIDES[source]
  return trades === 1 ? `last closed ${side.one}${side.counted}` : `last ${trades} closed ${side.many}${side.counted}`
}

/** "5.30 R together", or for one trade "5.30 R". */
function lostR(run: PaperRun): string {
  return `${Math.abs(run.r).toFixed(2)} R${run.trades === 1 ? '' : ' together'}`
}

/** The pause's sentences, whole, side by side (V6 Stage 14): each says one side's run in full, so that a
 * language says it in its own order. `one` is a run of a single trade. */
const PAUSE_SENTENCES: Record<PaperPauseSource, { paused: [string, string]; reached: [string, string]; title: string; body: [string, string] }> = {
  watch: {
    paused: [
      msg("The watch's last closed paper trade had lost {loss} R by {moment}, so it opens none until they are resumed on Risk & Safety."),
      msg("The watch's last {count} closed paper trades had lost {loss} R together by {moment}, so it opens none until they are resumed on Risk & Safety.")
    ],
    reached: [
      msg("The watch's last closed paper trade lost {loss} R, so it opens none until they are resumed on Risk & Safety."),
      msg("The watch's last {count} closed paper trades lost {loss} R together, so it opens none until they are resumed on Risk & Safety.")
    ],
    title: msg("The watch's paper trades are paused"),
    body: [
      msg("The watch's last closed paper trade lost {loss} R: Risk & Safety pauses them at {line} R. It opens none until they are resumed there, and any still open run to their end. Nothing real was placed or closed."),
      msg("The watch's last {count} closed paper trades lost {loss} R together: Risk & Safety pauses them at {line} R. It opens none until they are resumed there, and any still open run to their end. Nothing real was placed or closed.")
    ]
  },
  news: {
    paused: [
      msg("The news rules' last closed paper short with a stop had lost {loss} R by {moment}, so they open none until they are resumed on Risk & Safety."),
      msg("The news rules' last {count} closed paper shorts with a stop had lost {loss} R together by {moment}, so they open none until they are resumed on Risk & Safety.")
    ],
    reached: [
      msg("The news rules' last closed paper short with a stop lost {loss} R, so they open none until they are resumed on Risk & Safety."),
      msg("The news rules' last {count} closed paper shorts with a stop lost {loss} R together, so they open none until they are resumed on Risk & Safety.")
    ],
    title: msg("The news rules' paper shorts are paused"),
    body: [
      msg("The news rules' last closed paper short with a stop lost {loss} R: Risk & Safety pauses them at {line} R. They open none until they are resumed there, and any still open run to their end. Nothing real was placed or closed."),
      msg("The news rules' last {count} closed paper shorts with a stop lost {loss} R together: Risk & Safety pauses them at {line} R. They open none until they are resumed there, and any still open run to their end. Nothing real was placed or closed.")
    ]
  },
  forecast: {
    paused: [
      msg("The forecast trader's last closed paper trade had lost {loss} R by {moment}, so it opens none until they are resumed on Risk & Safety."),
      msg("The forecast trader's last {count} closed paper trades had lost {loss} R together by {moment}, so it opens none until they are resumed on Risk & Safety.")
    ],
    reached: [
      msg("The forecast trader's last closed paper trade lost {loss} R, so it opens none until they are resumed on Risk & Safety."),
      msg("The forecast trader's last {count} closed paper trades lost {loss} R together, so it opens none until they are resumed on Risk & Safety.")
    ],
    title: msg("The forecast trader's paper trades are paused"),
    body: [
      msg("The forecast trader's last closed paper trade lost {loss} R: Risk & Safety pauses them at {line} R. It opens none until they are resumed there, and any still open run to their end. Nothing real was placed or closed."),
      msg("The forecast trader's last {count} closed paper trades lost {loss} R together: Risk & Safety pauses them at {line} R. It opens none until they are resumed there, and any still open run to their end. Nothing real was placed or closed.")
    ]
  }
}

/** One of a pair of sentences, by the run's length. */
const byRun = (pair: [string, string], trades: number): string => (trades === 1 ? pair[0] : pair[1])

/** Why one side opens no paper trade now, or null when it may: a losing run paused it and it has
 * not been resumed, or its run has just reached the loss and the pause is not yet written down.
 * Switched off, nothing pauses. In English unless handed a language (V6 Stage 14). */
export function paperPauseBlock(input: { setting: PaperPauseSettings; executors: ExecutorConfig[]; source: PaperPauseSource }, { t, num, utcTime, utcDay }: I18n = ENGLISH): string | null {
  const { setting, source } = input
  if (setting.lossR === null) return null
  const sentences = PAUSE_SENTENCES[source]
  const paused = setting[source].paused
  if (paused !== null) {
    return t(byRun(sentences.paused, paused.trades), {
      count: paused.trades,
      loss: num(Math.abs(paused.r), 2, 2),
      moment: t('{time} UTC on {day}', { time: utcTime(paused.at * 1000), day: utcDay(paused.at * 1000) })
    })
  }
  const run = paperRun(input.executors, source, setting)
  if (!reached(run, setting.lossR)) return null
  return t(byRun(sentences.reached, run.trades), { count: run.trades, loss: num(Math.abs(run.r), 2, 2) })
}

/** What the desktop is told, once, when a run pauses one side, in a language. */
export function paperPauseNotice(source: PaperPauseSource, run: PaperRun, lossR: number, { t, num }: I18n = ENGLISH): { title: string; body: string } {
  const sentences = PAUSE_SENTENCES[source]
  return {
    title: t(sentences.title),
    body: t(byRun(sentences.body, run.trades), { count: run.trades, loss: num(Math.abs(run.r), 2, 2), line: num(lossR, 0, 2) })
  }
}

/** What a look finds: each side whose run has reached the loss, and that is not paused yet, is
 * paused now, with the notice that says so. Null when there is nothing to write: switched off, or
 * no new pause. */
export function planPaperPause(
  input: {
    setting: PaperPauseSettings
    executors: ExecutorConfig[]
    nowSec: number
  },
  i18n: I18n = ENGLISH
): { setting: PaperPauseSettings; notices: { title: string; body: string }[] } | null {
  const { lossR } = input.setting
  if (lossR === null) return null
  let next = input.setting
  const notices: { title: string; body: string }[] = []
  for (const source of PAPER_PAUSE_SOURCES) {
    if (input.setting[source].paused !== null) continue
    const run = paperRun(input.executors, source, input.setting)
    if (!reached(run, lossR)) continue
    next = { ...next, [source]: { ...input.setting[source], paused: { at: input.nowSec, r: run.r, trades: run.trades } } }
    notices.push(paperPauseNotice(source, run, lossR, i18n))
  }
  return notices.length === 0 ? null : { setting: next, notices }
}

/** The setting with one side resumed at `nowSec`: not paused, and its run counted again from then. */
export function resumePaperPause(setting: PaperPauseSettings, source: PaperPauseSource, nowSec: number): PaperPauseSettings {
  return { ...setting, [source]: { countFrom: nowSec, paused: null } }
}

/** The setting as Risk & Safety saves it: the loss and the run as chosen, and each side's pause
 * kept -- except switched off, when a pause is lifted, as nothing pauses then. Switched on again,
 * the record since each was last resumed is judged as it stands. */
export function savePaperPause(stored: PaperPauseSettings, chosen: Pick<PaperPauseSettings, 'lossR' | 'trades'>): PaperPauseSettings {
  if (chosen.lossR !== null) return { ...stored, lossR: chosen.lossR, trades: chosen.trades }
  return { lossR: null, trades: chosen.trades, watch: { ...stored.watch, paused: null }, news: { ...stored.news, paused: null }, forecast: { ...stored.forecast, paused: null } }
}

/** The setting in a sentence, as it is set, in the words the watch's other limits use: "them" is
 * the trades of the one it is said of. */
export function describePaperPause(setting: Pick<PaperPauseSettings, 'lossR' | 'trades'>, { t, num }: I18n = ENGLISH): string {
  if (setting.lossR === null) return t('No losing run pauses them.')
  return t('Once the last {count} of them to close have lost {loss} R together, none is opened until they are resumed on Risk & Safety.', { count: setting.trades, loss: num(setting.lossR, 0, 2) })
}

/** Where one side stands, for Risk & Safety: paused, and since when, or what its run adds up to. */
export function describePaperPauseStanding(input: { setting: PaperPauseSettings; executors: ExecutorConfig[]; source: PaperPauseSource }): {
  paused: boolean
  text: string
} {
  const { setting, source } = input
  const side = SIDES[source]
  const state = setting[source]
  if (setting.lossR !== null && state.paused !== null) {
    return {
      paused: true,
      text: `${side.name} ${side.has} been paused since ${utcMoment(state.paused.at)}: ${side.its} ${lastClosed(source, state.paused.trades)} had lost ${lostR(state.paused)}.`
    }
  }
  const run = paperRun(input.executors, source, setting)
  if (reached(run, setting.lossR)) return { paused: true, text: `${side.name} ${side.is} paused: ${side.its} ${lastClosed(source, run.trades)} have lost ${lostR(run)}.` }
  const since = state.countFrom === null ? '' : ` since ${side.it} ${source === 'watch' ? 'was' : 'were'} resumed at ${utcMoment(state.countFrom)}`
  if (run.trades === 0) return { paused: false, text: `${side.name} ${side.has} closed no ${side.one}${side.counted}${since === '' ? ' yet' : since}.` }
  const made = run.trades === 1 ? `made ${describeR(run.r)}` : `add up to ${describeR(run.r)}`
  return { paused: false, text: `${side.whose} ${lastClosed(source, run.trades)}${since} ${made}.` }
}
