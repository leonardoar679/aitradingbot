// AN UNATTENDED SHADOW RUN OF THE APP: hours of the real market, the real news feeds and the real
// public stream, on a scratch profile and a separate build, with OpenRouter faked in the main process
// so that nothing is spent and no key is used (the V3 document's 1-hour, 12-hour and 24-hour tests).
// At the end: the session report over the last hour, the last twelve hours, the last day and the
// session, saved as JSON (and CSV), then the watch off, the fake key removed, and the app closed.
//
//   npx electron-vite build --outDir dist/day              # never out/, which the user's app runs from
//   RUN_NAME=day RUN_MINUTES=1442 node scripts/shadow-run.mjs
//   RUN_NAME=day RESUME=1 node scripts/shadow-run.mjs      # after a restart killed it: carries on
//   RUN_NAME=day python scripts/shadow-analyze.py          # the gates, the records, every segment
//
// Knobs, all from the environment:
//   RUN_NAME       picks the build (dist/<name>), the profile (<root>/<name>-profile) and the output
//                  (<root>/<name>-out); letters, digits and dashes                       [shadow]
//   RUN_MINUTES    how long to run, in all, over every segment                           [722]
//   MIN_BAND       the lowest event band the watch takes up                              [urgent]
//   UNIVERSE_SIZE  pairs the scanner watches: 20, 40, 60 or 100                          [60]
//   SHADOW_ROOT    the folder profiles and outputs live under                [<tmp>/traderspider-shadow]
//   APP_ENTRY      the built main script                                     [dist/<name>/main/index.js]
//   MODELS_FROM    a saved model catalogue to copy in, for the price estimates   [the real profile's]
//   RESUME         1 keeps the profile and the output of an earlier segment and carries on
//   HOUR_REPORT_MINUTES  how often the last hour's report is saved; lowered for a short check     [60]
//
// IT NEVER TOUCHES THE REAL PROFILE OR out/. The profile has to be inside SHADOW_ROOT and is never
// the real profile or Electron's default; on a resume it has to carry the marker this script leaves;
// and the app's own userData folder is checked after launch. The fake is installed in the main
// process before the first window opens, so even a key left in the profile by a killed segment could
// reach nothing. The only key ever stored is a made-up one the fake answers.
//
// A SEGMENT is one launch. A run killed by a Windows restart is resumed with RESUME=1: the profile
// keeps its events, ledger, executors and stories (the app's own files), the output keeps its logs,
// and the remaining minutes are what RUN_MINUTES has left. What the app keeps only in memory (the
// stream's counts, the refused trades, the alerts) is written here every ten minutes (status.jsonl)
// and once an hour as the last hour's report (hour-reports/), so a day is whole across segments.

import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { APP_DIR, ELECTRON_BIN, reapStaleApps, samePath } from './lib/electron.mjs'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('playwright-core')

const RUN_NAME = process.env.RUN_NAME ?? 'shadow'
if (!/^[a-z0-9-]+$/.test(RUN_NAME)) throw new Error(`a run name of letters, digits and dashes: ${RUN_NAME}`)
const RUN_MINUTES = Number(process.env.RUN_MINUTES ?? 722)
if (!Number.isFinite(RUN_MINUTES) || RUN_MINUTES <= 0) throw new Error(`RUN_MINUTES must be a number of minutes: ${process.env.RUN_MINUTES}`)
const MIN_BAND = process.env.MIN_BAND ?? 'urgent'
const UNIVERSE_SIZE = Number(process.env.UNIVERSE_SIZE ?? 60)
const SHADOW_ROOT = path.resolve(process.env.SHADOW_ROOT ?? path.join(os.tmpdir(), 'traderspider-shadow'))
const PROFILE = path.join(SHADOW_ROOT, `${RUN_NAME}-profile`)
const OUT = path.join(SHADOW_ROOT, `${RUN_NAME}-out`)
const ENTRY = path.resolve(APP_DIR, process.env.APP_ENTRY ?? `dist/${RUN_NAME}/main/index.js`)
const RESUME = process.env.RESUME === '1'
const MODELS_FROM = process.env.MODELS_FROM ?? path.join(process.env.APPDATA ?? '', 'newtradingbot', 'aiModels.json')
const STATUS_EVERY_MS = 10 * 60_000
const SHOT_EVERY_MS = 30 * 60_000
const HOUR_REPORT_EVERY_MS = Number(process.env.HOUR_REPORT_MINUTES ?? 60) * 60_000
const FAKE_KEY = 'sk-or-v1-check-only-not-a-real-key'
const MARKER = path.join(PROFILE, 'shadow-run.json')

// --- the refusals ------------------------------------------------------------------------------
const appData = process.env.APPDATA ?? ''
for (const forbidden of [path.join(appData, 'newtradingbot'), path.join(appData, 'Electron'), APP_DIR, path.join(APP_DIR, 'out')]) {
  if (appData === '' && forbidden.startsWith(path.sep)) continue
  if (samePath(PROFILE, forbidden)) throw new Error(`refusing the profile ${PROFILE}`)
}
if (!samePath(path.dirname(PROFILE), SHADOW_ROOT)) throw new Error(`the profile must be inside ${SHADOW_ROOT}`)
if (!fs.existsSync(ENTRY)) throw new Error(`${path.relative(APP_DIR, ENTRY)} is missing: build it with npx electron-vite build --outDir dist/${RUN_NAME}`)
if (samePath(path.dirname(path.dirname(ENTRY)), path.join(APP_DIR, 'out'))) throw new Error('refusing to run the out/ build, which the user runs the app from')
if (RESUME) {
  if (!fs.existsSync(MARKER)) throw new Error(`nothing to resume: ${MARKER} is not there, so this profile was not made by this script`)
} else {
  if (fs.existsSync(PROFILE) && !fs.existsSync(MARKER)) throw new Error(`refusing to delete ${PROFILE}: it was not made by this script`)
  fs.rmSync(PROFILE, { recursive: true, force: true })
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(PROFILE, { recursive: true })
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(PROFILE, 'scanner.json'), JSON.stringify({ enabled: true, universeSize: UNIVERSE_SIZE }, null, 2))
  // The public model catalogue (prices, for the cost estimates on screen); nothing in it is a key.
  if (fs.existsSync(MODELS_FROM)) fs.copyFileSync(MODELS_FROM, path.join(PROFILE, 'aiModels.json'))
  fs.writeFileSync(MARKER, JSON.stringify({ createdBy: 'scripts/shadow-run.mjs', runName: RUN_NAME, createdAt: new Date().toISOString(), key: 'fake' }, null, 2))
}
fs.mkdirSync(path.join(OUT, 'hour-reports'), { recursive: true })

// --- the segments ------------------------------------------------------------------------------
const SEGMENTS_FILE = path.join(OUT, 'segments.json')
const STATUS_FILE = path.join(OUT, 'status.jsonl')
const segments = RESUME && fs.existsSync(SEGMENTS_FILE) ? JSON.parse(fs.readFileSync(SEGMENTS_FILE, 'utf8')) : []
/** What earlier segments ran, in ms: a segment that ended says so; one that was killed is counted
 * to its last status tick. */
function ranBefore() {
  let ms = 0
  const ticks = fs.existsSync(STATUS_FILE) ? fs.readFileSync(STATUS_FILE, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
  for (const segment of segments) {
    const end = segment.endedAt ?? Math.max(segment.startedAt, ...ticks.filter((tick) => tick.segment === segment.n).map((tick) => tick.at))
    ms += Math.max(0, end - segment.startedAt)
  }
  return ms
}
const SEGMENT = segments.length + 1
const t0 = Date.now()
const remainingMs = Math.max(0, RUN_MINUTES * 60_000 - ranBefore())
segments.push({ n: SEGMENT, startedAt: t0, endedAt: null })
fs.writeFileSync(SEGMENTS_FILE, JSON.stringify(segments, null, 2))

const logFile = fs.createWriteStream(path.join(OUT, 'run.log'), { flags: 'a' })
const mainLog = fs.createWriteStream(path.join(OUT, 'main.log'), { flags: 'a' })
const consoleLog = fs.createWriteStream(path.join(OUT, 'console.log'), { flags: 'a' })
const mins = () => ((Date.now() - t0) / 60000).toFixed(1)
function say(line) {
  const text = `[${new Date().toISOString().slice(11, 19)} +${mins()}m s${SEGMENT}] ${line}`
  console.log(text)
  logFile.write(text + '\n')
}

const env = { ...process.env }
// Claude Code and VS Code export this to their children; with it set electron.exe runs as plain Node.
delete env.ELECTRON_RUN_AS_NODE

let app = null
let page = null
let startSec = Math.floor(segments[0].startedAt / 1000)

async function main() {
  say(`run ${RUN_NAME}: segment ${SEGMENT}, ${Math.round(remainingMs / 60_000)} of ${RUN_MINUTES} minutes left${RESUME ? ' (resumed)' : ''}`)
  const stale = await reapStaleApps(PROFILE)
  if (stale > 0) say(`cleared ${stale} stale Electron process(es) of an earlier segment`)
  app = await electron.launch({ executablePath: ELECTRON_BIN, args: [ENTRY, `--user-data-dir=${PROFILE}`], cwd: APP_DIR, env, timeout: 60_000 })
  const proc = app.process()
  proc.stdout?.on('data', (chunk) => mainLog.write(`[${new Date().toISOString()}] ${chunk}`))
  proc.stderr?.on('data', (chunk) => mainLog.write(`[${new Date().toISOString()}] ERR ${chunk}`))
  const actual = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  if (!samePath(actual, PROFILE)) {
    await app.close().catch(() => {})
    throw new Error(`asked for ${PROFILE}, the app opened ${actual}`)
  }
  say(`scratch profile: ${actual}`)

  // BEFORE anything can ask a model: OpenRouter faked; notices recorded, not shown; saves into OUT.
  const stubbed = await app.evaluate(({ ipcMain, dialog, BrowserWindow }, outDir) => {
    globalThis.__notices = []
    ipcMain.removeHandler('app:notify')
    ipcMain.handle('app:notify', async (_event, title, body, severity) => {
      globalThis.__notices.push({ at: Date.now(), title, body, severity: severity ?? null })
      return true
    })
    dialog.showSaveDialog = async (...args) => {
      const options = args.find((arg) => arg && typeof arg === 'object' && 'defaultPath' in arg)
      return { canceled: false, filePath: outDir + '/' + String(options.defaultPath).split(/[\\/]/).pop() }
    }
    for (const win of BrowserWindow.getAllWindows()) win.webContents.setAudioMuted(true)

    const hash = (text) => {
      let h = 2166136261
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i)
        h = Math.imul(h, 16777619) >>> 0
      }
      return h
    }
    const p = (value) => Number(value.toPrecision(8))
    // The canned answers, by the schema each question names. They are shaped like a model's and
    // mean nothing: the run measures the machinery, never the trading.
    const answers = {
      market_opportunity(question) {
        const event = question.event
        const price = event.price
        const pick = hash(`${question.symbol}:${event.time}`) % 3
        if (pick === 2) {
          return {
            recommendation: 'hold', confidence: 0.55, entryMin: null, entryMax: null, validMinutes: 15, stopLoss: null, takeProfit: null,
            horizonBars: 16, marketRegime: 'neutral', riskLevel: 'medium', reasonCodes: ['cost_exceeds_edge'],
            rationale: 'Fake answer for the check: no trade.'
          }
        }
        const buy = event.direction === 'up'
        const entryMin = p(price * 0.998)
        const entryMax = p(price * 1.002)
        return {
          recommendation: buy ? 'buy' : 'sell',
          confidence: pick === 0 ? 0.7 : 0.66,
          entryMin,
          entryMax,
          validMinutes: 15,
          stopLoss: buy ? p(entryMin * 0.985) : p(entryMax * 1.015),
          takeProfit: buy ? p(entryMax * 1.025) : p(entryMin * 0.975),
          horizonBars: pick === 0 ? 4 : 16,
          marketRegime: 'neutral',
          riskLevel: 'medium',
          reasonCodes: buy ? ['momentum_up', 'volume_confirms'] : ['momentum_down', 'volume_confirms'],
          rationale: `Fake answer for the check: follows the ${event.direction} move.`
        }
      },
      news_reading(question) {
        const story = question.story
        const coin = story.coins.find((entry) => entry.relationship === 'DIRECT') ?? story.coins[0] ?? null
        const way = { hack: 'down', delisting: 'down', unlock: 'down', listing: 'up', etf: 'up', partnership: 'up', upgrade: 'up' }
        return {
          ticker: coin ? coin.ticker : null,
          relationship: coin ? coin.relationship : 'NONE',
          direction: coin ? (way[story.kind] ?? 'none') : 'none',
          impact: ['hack', 'delisting', 'listing', 'etf'].includes(story.kind) ? 72 : story.kind === 'regulation' ? 50 : 30,
          horizon: '4h',
          confidence: 0.6,
          pricedIn: false,
          reasons: `Fake reading for the check: a ${story.kind} story${coin ? ` naming ${coin.ticker}` : ''}.`
        }
      },
      why_conclusion(question) {
        const cites = question.evidence.slice(0, 2).map((item) => item.id)
        return {
          conclusion: `Fake conclusion for the check: the ${question.movePct}% move in ${question.pair} set against ${question.evidence[0]?.text ?? 'the evidence'}.`.slice(0, 400),
          cites,
          confidence: 0.55
        }
      },
      exit_verdict(question) {
        const triggers = question.triggers
        const verdict = triggers.includes('near_stop') || triggers.includes('opposite_move') ? 'EXIT' : triggers.includes('news') ? 'REDUCE' : 'KEEP'
        return { verdict, confidence: 0.62, reason: `Fake verdict for the check: ${triggers.join(', ')}.` }
      },
      review_verdict(question) {
        const verdict = hash(`${question.event.pair}:${question.call.entryMin}`) % 4 === 0 ? 'REJECT' : 'APPROVE'
        return { verdict, confidence: 0.6, reason: `Fake review for the check: ${question.triggers.join(', ')}.` }
      }
    }

    const real = globalThis.fetch
    globalThis.__asked = []
    globalThis.__other = []
    const reply = (body, status = 200) => ({
      ok: status === 200, status, statusText: status === 200 ? 'OK' : 'Error', headers: { get: () => null },
      text: async () => JSON.stringify(body), json: async () => body
    })
    globalThis.fetch = async (url, init) => {
      const u = String(url instanceof Request ? url.url : url)
      if (!u.startsWith('https://openrouter.ai')) return real(url, init)
      if (u.startsWith('https://openrouter.ai/api/v1/key')) {
        return reply({ data: { label: 'check', usage: 0, limit: null, limit_remaining: null, is_free_tier: false } })
      }
      if (u.startsWith('https://openrouter.ai/api/v1/chat/completions')) {
        const started = Date.now()
        const body = JSON.parse(init.body)
        const name = body.response_format?.json_schema?.name ?? '?'
        const system = String(body.messages?.[0]?.content ?? '')
        const user = String(body.messages?.[1]?.content ?? '')
        const make = answers[name]
        await new Promise((resolve) => setTimeout(resolve, 1500 + (hash(user) % 4500)))
        if (!make) {
          globalThis.__asked.push({ at: started, name, model: body.model, ms: Date.now() - started, status: 400 })
          return reply({ error: { code: 400, message: `${name} is not faked in this check` } }, 400)
        }
        let answer
        try {
          answer = make(JSON.parse(user))
        } catch (failure) {
          globalThis.__asked.push({ at: started, name, model: body.model, ms: Date.now() - started, status: 500, error: String(failure) })
          return reply({ error: { code: 500, message: 'the fake could not read the question' } }, 500)
        }
        const promptTokens = Math.round((system.length + user.length) / 4)
        const completionTokens = 250 + (hash(user) % 400)
        const cost = promptTokens * 0.25e-6 + completionTokens * 2e-6
        globalThis.__asked.push({
          at: started, name, model: body.model, ms: Date.now() - started, status: 200,
          said: answer.recommendation ?? answer.verdict ?? answer.direction ?? (answer.cites ? 'cites ' + answer.cites.join(',') : '?')
        })
        return reply({
          id: `gen-check-${started}`,
          model: body.model,
          provider: 'Check',
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer) } }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, cost }
        })
      }
      globalThis.__other.push({ at: Date.now(), url: u.split('?')[0] })
      return reply({ error: { code: 404, message: 'not faked in this check' } }, 404)
    }
    return 'stubbed'
  }, OUT)
  say(`main process: ${stubbed}`)

  page = await app.firstWindow()
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') consoleLog.write(`[${new Date().toISOString()}] ${msg.type()}: ${msg.text()}\n`)
  })
  page.on('pageerror', (error) => consoleLog.write(`[${new Date().toISOString()}] PAGEERROR: ${error.stack ?? error}\n`))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Overview'), null, { timeout: 60_000 })
  say('launched')

  // A one-second heartbeat in the page: how late the page's own timers ran, all run.
  await page.evaluate(() => {
    const hb = { started: Date.now(), last: Date.now(), ticks: 0, maxGapMs: 0, over5s: 0, over30s: 0, over60s: 0, visibility: document.visibilityState, visibilityChanges: 0, hiddenSince: null, hiddenMs: 0 }
    window.__hb = hb
    setInterval(() => {
      const now = Date.now()
      const gap = now - hb.last
      hb.last = now
      hb.ticks++
      if (gap > hb.maxGapMs) hb.maxGapMs = gap
      if (gap > 5000) hb.over5s++
      if (gap > 30000) hb.over30s++
      if (gap > 60000) hb.over60s++
    }, 1000)
    document.addEventListener('visibilitychange', () => {
      hb.visibilityChanges++
      hb.visibility = document.visibilityState
      if (document.visibilityState === 'hidden') hb.hiddenSince = Date.now()
      else if (hb.hiddenSince !== null) {
        hb.hiddenMs += Date.now() - hb.hiddenSince
        hb.hiddenSince = null
      }
    })
  })

  // The user's watch, as on their profile, with a fake key the fake above answers. Setting it again
  // on a resumed segment changes nothing.
  const setup = await page.evaluate(
    async ([minBand, fakeKey]) => {
      const key = await window.api.ai.setCredentials(fakeKey)
      await window.api.ai.setConfig({ dailyCapUsd: 5, callsPerMinute: 30 })
      const watch = await window.api.ai.setConfig({
        watch: { enabled: true, models: ['openai/gpt-5-mini'], maxEventsPerDay: 10, minBand, firstModelGates: false }
      })
      const paper = await window.api.ai.setConfig({ watchPaper: { enabled: true, model: 'openai/gpt-5-mini', stakeQuote: 100, maxOpen: 3 } })
      return { key: key.configured, watch: watch.watch, watchPaper: paper.watchPaper, additions: paper.additions, cap: paper.dailyCapUsd }
    },
    [MIN_BAND, FAKE_KEY]
  )
  say(`setup: ${JSON.stringify(setup)}`)

  await nav('Performance')
  const started = await inReportCard(async (card) => {
    // The card keeps the session's start in the profile's local storage; a resumed segment keeps it.
    const stored = Number(window.localStorage.getItem('sessionReport.startedAt'))
    if (Number.isFinite(stored) && stored > 0) return `kept: a session started at ${new Date(stored * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    const button = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Start a session')
    button.click()
    await new Promise((r) => setTimeout(r, 500))
    return card.innerText.match(/A session started at [^\n]+/)?.[0] ?? 'no note'
  })
  say(`session: ${started}`)
  await nav('Overview')
  await shot(`s${SEGMENT}-00-overview`)

  const endAt = t0 + remainingMs
  let nextStatus = Date.now() + 60_000
  let nextShot = Date.now() + SHOT_EVERY_MS
  let nextHourReport = Date.now() + HOUR_REPORT_EVERY_MS
  let shots = 1
  let hours = 0
  while (Date.now() < endAt) {
    await new Promise((r) => setTimeout(r, 5000))
    if (Date.now() >= nextStatus) {
      await status()
      nextStatus += STATUS_EVERY_MS
    }
    if (Date.now() >= nextShot) {
      await shot(`s${SEGMENT}-${String(shots++).padStart(2, '0')}-overview`)
      nextShot += SHOT_EVERY_MS
    }
    if (Date.now() >= nextHourReport && Date.now() + 5 * 60_000 < endAt) {
      await hourReport(++hours)
      nextHourReport += HOUR_REPORT_EVERY_MS
    }
  }
  await status()

  // The reports.
  await nav('Performance')
  await new Promise((r) => setTimeout(r, 1500))
  const texts = {}
  texts.twelve = await report('Last 12 hours', 'twelve', true)
  await shot(`s${SEGMENT}-90-report-twelve`)
  texts.day = await report('Last 24 hours', 'day', true)
  await shot(`s${SEGMENT}-93-report-day`)
  texts.session = await report('This session', 'session', false)
  await shot(`s${SEGMENT}-91-report-session`)
  texts.hour = await report('Last hour', 'hour', false)
  fs.writeFileSync(path.join(OUT, 'card-text.json'), JSON.stringify(texts, null, 2))
  for (const [name, text] of Object.entries(texts)) say(`report ${name}: ${text.headline}`)

  // The news tab, for the record.
  await nav('Discovery')
  await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 1500))
    const tab = [...document.querySelectorAll('button')].find((b) => /News/.test(b.textContent ?? '') && /Market Events/.test(b.textContent ?? ''))
    if (tab) tab.click()
    await new Promise((r) => setTimeout(r, 2000))
  })
  await shot(`s${SEGMENT}-92-news`)
  segments[segments.length - 1].endedAt = Date.now()
  fs.writeFileSync(SEGMENTS_FILE, JSON.stringify(segments, null, 2))
}

async function nav(label) {
  const result = await page.evaluate((text) => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
    if (!button) return 'NOT_FOUND'
    button.click()
    return 'OK'
  }, label)
  if (result !== 'OK') say(`nav ${label}: ${result}`)
  await new Promise((r) => setTimeout(r, 1200))
}

async function inReportCard(fn, arg = null) {
  return page.evaluate(async ([source, arg]) => {
    const until = Date.now() + 30000
    let card = null
    while (Date.now() < until && card === null) {
      const title = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === 'Session report')
      let el = title
      while (el && el.tagName !== 'SECTION') el = el.parentElement
      card = el ?? null
      if (card === null) await new Promise((r) => setTimeout(r, 500))
    }
    if (card === null) return 'no card'
    card.scrollIntoView({ block: 'start' })
    // eslint-disable-next-line no-new-func
    return new Function('card', 'arg', `return (${source})(card, arg)`)(card, arg)
  }, [fn.toString(), arg])
}

/** Presses the span's button on the report card, waits for the report, and saves it as JSON and,
 * when asked, CSV, into `into` under `<name>.<format>`. Returns what the card showed. */
async function report(label, name, withCsv, into = OUT, prefix = 'session-report-') {
  const read = await inReportCard(async (card, label) => {
    const before = card.innerText.match(/From \d{4}-[^\n]*? to [^\n]*?UTC:/)?.[0] ?? null
    const button = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === label)
    if (!button) return { error: 'no button', headline: `no button for ${label}`, gates: [], text: card.innerText }
    button.click()
    const until = Date.now() + 120000
    let line = null
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500))
      if (card.innerText.includes('Reading…')) continue
      line = card.innerText.match(/From \d{4}-[^\n]*? to [^\n]*?UTC:/)?.[0] ?? null
      if (line !== null && line !== before) break
    }
    return {
      headline: card.innerText.match(/From \d{4}-[^\n]+/)?.[0] ?? 'no report',
      gates: [...card.querySelectorAll('tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ')),
      text: card.innerText
    }
  }, label)
  if (read.error) return read
  for (const format of withCsv ? ['json', 'csv'] : ['json']) {
    const saved = await inReportCard(async (card, format) => {
      const button = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === `Save as ${format}`)
      if (!button) return 'no save button'
      button.click()
      const until = Date.now() + 15000
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 300))
        const note = card.innerText.match(/(Saved to|Could not save)[^\n]+/)?.[0]
        if (note) return note
      }
      return 'no note'
    }, format.toUpperCase())
    say(`${label} ${format}: ${saved}`)
    const match = /Saved to (.+)$/.exec(saved)
    if (match) {
      const from = match[1].trim()
      const to = path.join(into, `${prefix}${name}.${format}`)
      try {
        fs.renameSync(from, to)
      } catch (failure) {
        say(`rename failed: ${failure}`)
      }
    }
  }
  return read
}

/** The last hour's report, once an hour, into hour-reports/: the refused trades, the alerts and the
 * stream's counts are kept only while the app runs, and this keeps each hour of them on file. */
async function hourReport(n) {
  try {
    await nav('Performance')
    await new Promise((r) => setTimeout(r, 1000))
    const read = await report('Last hour', `s${SEGMENT}-hour-${String(n).padStart(2, '0')}`, false, path.join(OUT, 'hour-reports'), '')
    say(`hour ${n}: ${read.headline}`)
    await nav('Overview')
  } catch (failure) {
    say(`hour report ${n} failed: ${failure}`)
  }
}

async function shot(name) {
  try {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) })
  } catch (failure) {
    say(`screenshot ${name} failed: ${failure}`)
  }
}

async function status() {
  try {
    const fake = await app.evaluate(() => {
      const byName = {}
      for (const call of globalThis.__asked) byName[`${call.name}:${call.status}`] = (byName[`${call.name}:${call.status}`] ?? 0) + 1
      const bySeverity = {}
      for (const notice of globalThis.__notices) bySeverity[notice.severity ?? 'none'] = (bySeverity[notice.severity ?? 'none'] ?? 0) + 1
      return { asked: globalThis.__asked.length, byName, notices: bySeverity, other: globalThis.__other.length }
    })
    const seen = await page.evaluate(async (since) => {
      const events = (await window.api.scanner.listEvents({ sinceSec: since })).rows
      const calls = (await window.api.ai.listCalls({ sinceSec: since })).rows
      const settings = await window.api.settings.get()
      const bands = {}
      for (const event of events) bands[event.band] = (bands[event.band] ?? 0) + 1
      const callKinds = {}
      for (const call of calls) {
        const key = `${call.source}${call.addition ? ':' + call.addition : ''}:${call.status}`
        callKinds[key] = (callKinds[key] ?? 0) + 1
      }
      const executors = {}
      for (const ex of settings.executors) {
        const key = `${ex.mode}:${ex.status}:${ex.watch ? 'watch' : ex.newsRule ? 'news' : 'other'}`
        executors[key] = (executors[key] ?? 0) + 1
      }
      const feed = await window.api.feed.getState()
      const live = await window.api.market.liveState()
      const now = Date.now()
      return {
        events: bands,
        calls: callKinds,
        executors,
        feed: { stories: feed.stories.length, sources: feed.sources.map((s) => `${s.id}:${s.ok}:${s.items}${s.error ? ':' + s.error.slice(0, 60) : ''}`) },
        live: {
          open: live.connection.open,
          host: live.connection.host ?? null,
          hostSwitches: live.connection.hostSwitches ?? 0,
          dataHostSwitches: live.connection.dataHostSwitches ?? 0,
          connects: live.connection.connects,
          drops: live.connection.drops,
          lastMessageAgoS: live.connection.lastMessageAt === null ? null : Math.round((now - live.connection.lastMessageAt) / 1000),
          gaps: live.connection.gaps.length,
          books: Object.keys(live.books).length
        },
        hb: { ...window.__hb, started: undefined, last: undefined },
        visible: document.visibilityState
      }
    }, startSec)
    const tick = { segment: SEGMENT, at: Date.now(), fake, ...seen }
    fs.appendFileSync(STATUS_FILE, JSON.stringify(tick) + '\n')
    say(`status ${JSON.stringify({ fake, ...seen })}`)
  } catch (failure) {
    say(`status failed: ${failure}`)
  }
}

async function shutDown() {
  if (app) {
    try {
      const asked = await app.evaluate(() => ({ asked: globalThis.__asked, other: globalThis.__other, notices: globalThis.__notices }))
      fs.writeFileSync(path.join(OUT, `main-fake-s${SEGMENT}.json`), JSON.stringify(asked, null, 2))
    } catch (failure) {
      say(`the fake's record could not be read: ${failure}`)
    }
  }
  if (page) {
    try {
      const off = await page.evaluate(async () => {
        const watch = await window.api.ai.setConfig({ watch: { enabled: false } })
        const paper = await window.api.ai.setConfig({ watchPaper: { enabled: false } })
        await window.api.ai.removeCredentials()
        return { watch: watch.watch.enabled, paper: paper.watchPaper.enabled, key: (await window.api.ai.credentialsStatus()).configured }
      })
      say(`switched off: ${JSON.stringify(off)}`)
    } catch (failure) {
      say(`switching off failed: ${failure}`)
    }
  }
  if (app) await app.close().catch((failure) => say(`close failed: ${failure}`))
  say('closed')
}

try {
  await main()
} catch (failure) {
  say(`FAILED: ${failure?.stack ?? failure}`)
} finally {
  await shutDown()
  logFile.end()
  mainLog.end()
  consoleLog.end()
}
