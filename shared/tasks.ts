// THE TASKS RUN AWAY FROM THE MAIN THREAD (V8 Stage 1, 26 October 2026).
//
// The main process carries the live-position watcher, the one piece of this app that has to fire a real exit
// on time, and from V8 it also reads text chosen by strangers: a pasted article's HTML, a trader's ten thousand
// fills. A pathological page or a heavy analysis on the main thread would delay that exit. So such work is a
// TASK: a pure function of its input, run in a worker thread of its own with a memory limit and a deadline
// (electron/tasks/taskWorker.ts, electron/services/taskWorkerService.ts), killed when it overruns either, the
// caller told why. Each task is named here; the worker runs only these.

import { extractArticle, type ExtractedArticle } from './articleExtract'
import { pairRatesOf, type PairRates } from './forecast/pairRates'
import { victimsOf, type VictimRow } from './incidentVictimsBuild'
import { hyperliquidBoardRead, type HyperliquidBoardRead } from './traders/discovery'
import { traderFileOf, type TraderFileRead } from './traders/traderFile'
import { traderTestsOf, type TraderTestsResult } from './traders/traderTests'

export interface TaskTable {
  /** The host's own check: hands its input back. */
  echo: (payload: unknown) => unknown
  /** A pasted article's page read: its title, times, canonical address, author and text (V8 Stage 4;
   * shared/articleExtract.ts). The payload is the page's text. */
  extractArticle: (payload: unknown) => ExtractedArticle
  /** A trader's record judged by V8-S6-SKILL, V8-S6-DELAY and V8-S7-CLONE (V8 Stages 6-7; shared/traders/traderTests.ts):
   * the payload is the tests' input, its maps and arrays copied whole. */
  traderTests: (payload: unknown) => TraderTestsResult
  /** A file of a trader's trades read (V8 Stage 7; shared/traders/traderFile.ts): the payload is its text and the time
   * it is read at. */
  traderFile: (payload: unknown) => TraderFileRead | { refused: string }
  /** A pair's ninety-day move rates and day moves (V8 Stage 10; shared/forecast/pairRates.ts): the payload is its files'
   * texts, oldest month first, and the hour's close they are read at. */
  pairRates: (payload: unknown) => PairRates
  /** Hyperliquid's leaderboard read (V9 Stage 3; shared/traders/discovery.ts): the payload is its text, about 39 MB; the
   * answer is how many rows it held and those who pass the finding rule. */
  traderBoard: (payload: unknown) => HyperliquidBoardRead
  /** A hack's victims by name read again (V9 Stage 8; shared/incidentVictimsBuild.ts): the payload is DefiLlama's two
   * lists' texts, the protocols' about 10 MB, and the tokens Binance trades against USDT. */
  incidentVictims: (payload: unknown) => VictimRow[]
}

export type TaskName = keyof TaskTable

export const TASKS: TaskTable = {
  echo: (payload) => payload,
  extractArticle: (payload) => extractArticle(typeof payload === 'string' ? payload : ''),
  traderTests: (payload) => traderTestsOf(payload),
  traderFile: (payload) => {
    const input = payload as { text?: unknown; nowMs?: unknown } | null
    if (typeof input?.text !== 'string' || typeof input.nowMs !== 'number') throw new Error('A file is read from its text and the time it is read at.')
    return traderFileOf(input.text, input.nowMs)
  },
  pairRates: (payload) => {
    const input = payload as { texts?: unknown; atSec?: unknown } | null
    const texts = input?.texts
    if (!Array.isArray(texts) || !texts.every((text) => typeof text === 'string') || typeof input?.atSec !== 'number') throw new Error("A pair's rates are read from its files' texts and the moment they are read at.")
    return pairRatesOf(texts as string[], input.atSec)
  },
  traderBoard: (payload) => {
    const input = payload as { text?: unknown } | null
    if (typeof input?.text !== 'string') throw new Error("Hyperliquid's leaderboard is read from its text.")
    return hyperliquidBoardRead(input.text)
  },
  incidentVictims: (payload) => {
    const input = payload as { protocolsText?: unknown; chainsText?: unknown; tradable?: unknown } | null
    const tradable = input?.tradable
    if (typeof input?.protocolsText !== 'string' || typeof input.chainsText !== 'string' || !Array.isArray(tradable) || !tradable.every((token) => typeof token === 'string')) throw new Error("A hack's victims are read from DefiLlama's two lists and the tokens Binance trades.")
    const protocols: unknown = JSON.parse(input.protocolsText)
    const chains: unknown = JSON.parse(input.chainsText)
    if (!Array.isArray(protocols) || !Array.isArray(chains)) throw new Error("DefiLlama's lists are not lists.")
    return victimsOf(protocols, chains, new Set(tradable as string[]))
  }
}

/** What a task's run came to. */
export type TaskOutcome = { ok: true; result: unknown } | { ok: false; reason: 'timeout' | 'memory' | 'error'; message: string }

/** A request to the worker, and its answer. */
export interface TaskRequest {
  id: number
  task: string
  payload: unknown
}
export interface TaskReply {
  id: number
  ok: boolean
  result?: unknown
  message?: string
}

/** Runs one named task on its input: what the worker does with each request. */
export function runTask(request: TaskRequest): TaskReply {
  if (!Object.prototype.hasOwnProperty.call(TASKS, request.task)) return { id: request.id, ok: false, message: `No task is named ${String(request.task).slice(0, 60)}` }
  try {
    return { id: request.id, ok: true, result: TASKS[request.task as TaskName](request.payload) }
  } catch (error) {
    return { id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** A task's limits: how long and how much memory it may take. */
export interface TaskLimits {
  timeoutMs: number
  maxOldGenerationSizeMb: number
}

/** The limits a task runs under unless it is given its own (pinned: ENGINE_CONSTANTS.tasks). */
export const TASK_LINES = {
  version: 'tasks-v1',
  defaultTimeoutMs: 2000,
  defaultMaxOldGenerationSizeMb: 256
} as const
