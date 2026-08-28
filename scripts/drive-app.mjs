// REPL driver for TraderSpider: launches the built Electron app and exposes click/type/read
// commands on stdin, so the UI can be driven without a human at the window.
//
// Run it, then type commands (or pipe them in):
//
//   npm run build
//   node scripts/drive-app.mjs
//   driver> launch
//   driver> nav Backtest
//   driver> ss backtest
//
// Requires playwright-core, which is deliberately NOT a dependency of this app -- it exists only
// to drive the app in development and has no business in a shipped build:
//
//   npm install --no-save playwright-core
//
// See .claude/skills/run-app/SKILL.md for the gotchas. The one that costs the most time is at the
// top of launch() below.

import { _electron as electron } from 'playwright-core'
import * as readline from 'node:readline'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

let app = null
let page = null

const ELECTRON_BIN =
  process.platform === 'win32'
    ? path.join(APP_DIR, 'node_modules/electron/dist/electron.exe')
    : process.platform === 'darwin'
      ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
      : path.join(APP_DIR, 'node_modules/electron/dist/electron')

/** Strips one layer of surrounding quotes. Shells pass them through to argv, and every command
 * here takes the rest of the line as a single string, so a quoted argument arrives quoted. */
function unquote(s) {
  const t = (s || '').trim()
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t
}

function need() {
  if (!page) {
    console.log('ERROR: launch first')
    return false
  }
  return true
}

/** React tracks the previous value on the DOM node itself and skips the synthetic change event
 * when the value is assigned directly, so `el.value = x` updates the widget and leaves the app's
 * state untouched -- the screenshot looks right and the run uses the old value. Going through the
 * prototype's native setter and then dispatching is what React's own test utilities do. */
const NATIVE_SET = `(el, value) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}`

const COMMANDS = {
  async launch() {
    if (app) return console.log('already launched')
    if (!fs.existsSync(path.join(APP_DIR, 'out/main/index.js'))) {
      return console.log('ERROR: out/main/index.js missing — run `npm run build` first')
    }
    // THE gotcha. Claude Code and VS Code are themselves Electron apps and export
    // ELECTRON_RUN_AS_NODE=1 to their child processes. With it set, electron.exe runs as plain
    // Node: it rejects every Chromium flag with "bad option: --remote-debugging-port" and never
    // prints the "DevTools listening on ws://..." line Playwright waits for, so launch fails with
    // a bare "Process failed to launch!" that names no cause at all.
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE

    app = await electron.launch({ executablePath: ELECTRON_BIN, args: [APP_DIR], cwd: APP_DIR, env, timeout: 60_000 })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // The renderer mounts React, then fetches settings and candles over IPC. There is no ready
    // signal to wait on, so wait for the sidebar the app always renders.
    await page.waitForFunction(
      () => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Portfolio'),
      { timeout: 30_000 }
    )
    console.log('launched:', app.windows().map((w) => w.url()).join(', '))
  },

  /** Sidebar navigation. Every page in this app is a plain <button> carrying its label. */
  async nav(label) {
    if (!need()) return
    const r = await page.evaluate((t) => {
      const el = [...document.querySelectorAll('button')].find((e) => e.textContent?.trim() === t)
      if (!el) return 'NOT_FOUND'
      el.click()
      return 'OK'
    }, unquote(label))
    console.log('nav', unquote(label), '→', r)
  },

  async ss(name) {
    if (!need()) return
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png')
    await page.screenshot({ path: f })
    console.log('screenshot:', f)
  },

  async 'click-text'(text) {
    if (!need()) return
    const r = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('button, a, [role="button"]')]
      const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t))
      if (!el) return 'NOT_FOUND'
      el.click()
      return 'OK'
    }, unquote(text))
    console.log('click-text', JSON.stringify(unquote(text)), '→', r)
  },

  /** Click a button inside the card that names something -- "the Enable Bot in the Trend Regime
   * BTC card". Usage: click-in-card <card text> :: <button text>
   *
   * Walks UP from each candidate button rather than filtering divs by text, because this UI nests
   * deeply and the innermost div matching a bot's name is the name label itself, which holds no
   * buttons.
   *
   * Then takes the button whose NEAREST matching ancestor is closest, which is the part that is
   * easy to get wrong and silently destructive. Accepting the first button that finds the text
   * within some fixed number of levels picks whichever button the DOM happens to list first: the
   * cards share a grid container that contains every card's text, so from far enough up EVERY
   * button "matches" EVERY name. Measured: asking to disable "Trend Regime BTC" disabled
   * CloudSpider instead, and reported OK. Depth is what distinguishes the card you meant from the
   * page that contains it. */
  async 'click-in-card'(arg) {
    if (!need()) return
    const [cardText, buttonText] = arg.split('::').map((s) => unquote(s))
    const r = await page.evaluate(
      ({ cardText, buttonText }) => {
        const buttons = [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === buttonText)
        if (buttons.length === 0) return 'NO_SUCH_BUTTON'
        let best = null
        for (const btn of buttons) {
          let node = btn
          for (let depth = 1; depth <= 12 && node.parentElement; depth++) {
            node = node.parentElement
            if ((node.innerText || '').includes(cardText)) {
              if (!best || depth < best.depth) best = { btn, depth }
              break
            }
          }
        }
        if (!best) return 'NO_MATCHING_CARD'
        best.btn.click()
        return `OK (depth ${best.depth})`
      },
      { cardText, buttonText }
    )
    console.log('click-in-card', JSON.stringify(arg), '→', r)
  },

  /** set-select <index> <value> — see NATIVE_SET for why this is not `el.value = ...`. */
  async 'set-select'(arg) {
    if (!need()) return
    const [index, ...rest] = arg.split(/\s+/)
    const value = rest.join(' ')
    const r = await page.evaluate(
      ({ index, value, src }) => {
        const el = document.querySelectorAll('select')[Number(index)]
        if (!el) return 'NOT_FOUND'
        // eslint-disable-next-line no-eval
        eval(`(${src})`)(el, value)
        return el.value
      },
      { index, value, src: NATIVE_SET }
    )
    console.log('set-select', index, '→', r)
  },

  async 'set-input'(arg) {
    if (!need()) return
    const [index, ...rest] = arg.split(/\s+/)
    const value = rest.join(' ')
    const r = await page.evaluate(
      ({ index, value, src }) => {
        const el = document.querySelectorAll('input')[Number(index)]
        if (!el) return 'NOT_FOUND'
        // eslint-disable-next-line no-eval
        eval(`(${src})`)(el, value)
        return el.value
      },
      { index, value, src: NATIVE_SET }
    )
    console.log('set-input', index, '→', r)
  },

  /** Every form control on the current page, with its index — what to read before setting one. */
  async form() {
    if (!need()) return
    console.log(
      await page.evaluate(() => {
        const sel = [...document.querySelectorAll('select')]
          .map((s, i) => `select[${i}] = "${s.value}"  {${[...s.options].map((o) => o.value).slice(0, 10).join(', ')}}`)
          .join('\n')
        const inp = [...document.querySelectorAll('input')]
          .map((s, i) => `input[${i}] type=${s.type} placeholder="${s.placeholder}" = "${s.value}"`)
          .join('\n')
        return sel + '\n' + inp
      })
    )
  },

  /** Wait until the symbol dropdown holds real symbols.
   *
   * Needed before Start on the Backtest page, and before adding a bot. Symbols arrive over IPC
   * after the page renders, and until they do the select holds the single placeholder option
   * "Loading symbols...". Pressing Start in that state does nothing at all and says nothing --
   * the handler's first line is `if (!route.symbol ...) return` -- so the run appears to hang
   * while the page sits idle. Waiting on page TEXT does not help: every tab label and heading is
   * already on screen, so a wait-text matches instantly and races ahead of the fetch. */
  async 'wait-symbols'() {
    if (!need()) return
    try {
      await page.waitForFunction(
        () => [...document.querySelectorAll('select')].some((s) => [...s.options].some((o) => /^[A-Z0-9]{5,}$/.test(o.value))),
        { timeout: 30_000 }
      )
      console.log('symbols loaded')
    } catch {
      // Two different situations, and the message must not assert the alarming one: the page may
      // have no symbol picker at all (Bots, Portfolio), in which case waiting here is simply the
      // wrong command rather than a sign of anything broken.
      console.log('no symbol dropdown filled after 30s — either this page has none, or the exchange is unreachable')
    }
  },

  /** Poll until the page text matches a regex — for fetches that take an unknown time. */
  async 'wait-text'(pattern) {
    if (!need()) return
    // Quotes are stripped because a shell here-doc or printf passes them through as literal
    // characters: `wait-text "Total Net Profit"` arrives with the quote marks still attached, and
    // the regex then hunts for a `"` that is not in the page. It matched nothing, waited the full
    // three minutes, and reported a timeout for text that was on screen the whole time.
    const re = new RegExp(unquote(pattern), 'i')
    for (let i = 0; i < 90; i++) {
      const t = await page.evaluate(() => document.body.innerText)
      if (re.test(t)) return console.log('matched:', pattern)
      await new Promise((r) => setTimeout(r, 2000))
    }
    console.log('TIMEOUT waiting for:', pattern)
  },

  async text(sel) {
    if (!need()) return
    console.log(
      await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null)
    )
  },

  async eval(expr) {
    if (!need()) return
    try {
      console.log(JSON.stringify(await page.evaluate(expr)))
    } catch (e) {
      console.log('ERROR:', e.message)
    }
  },

  async quit() {
    if (app) await app.close().catch(() => {})
    app = null
    page = null
  },

  help() {
    console.log('commands:', Object.keys(COMMANDS).join(', '))
    console.log('e.g.  launch | nav Backtest | form | set-select 4 trend-regime-ensemble |')
    console.log('      click-text Start | wait-text "Total Net Profit" | ss result |')
    console.log('      click-in-card Trend Regime BTC :: Enable Bot')
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'driver> ' })

// Commands are serialised through a promise chain, and this matters far more when the input is a
// pipe than when a human is typing. readline does not await an async 'line' handler, so a piped
// script emits every line at once and `launch` would still be connecting while `nav` and `ss` ran
// against a null page. Chaining keeps a piped run identical to a typed one -- which is the point,
// since the whole reason to script this is to reproduce what you did by hand.
let chain = Promise.resolve()
let ended = false

async function runLine(line) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return
  const i = trimmed.indexOf(' ')
  const cmd = i < 0 ? trimmed : trimmed.slice(0, i)
  const arg = i < 0 ? '' : trimmed.slice(i + 1)
  const fn = COMMANDS[cmd]
  if (!fn) return console.log('unknown:', cmd, '— try: help')
  try {
    await fn(arg)
  } catch (e) {
    console.log('ERROR:', e.message)
  }
}

rl.on('line', (line) => {
  chain = chain.then(() => runLine(line)).then(() => {
    if (!ended) rl.prompt()
  })
})

// Waits for the queue to drain before closing, or a piped run kills the app mid-command and the
// last screenshot never lands.
rl.on('close', () => {
  ended = true
  chain = chain.then(async () => {
    await COMMANDS.quit()
    process.exit(0)
  })
})

console.log('TraderSpider driver — "help" for commands, "launch" to start')
rl.prompt()
