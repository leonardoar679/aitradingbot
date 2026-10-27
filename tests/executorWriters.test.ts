import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// EVERY FILE THAT WRITES EXECUTORS IS NAMED (V8 Stage 1, 26 October 2026). An executor is a trade: a file that
// writes them into settings.json is either a person's own action or a writer the app runs by itself, and each of
// those is pinned to paper by a block of its own in tests/aiNoLivePath.test.ts. V8 adds writers -- a copied
// trader's follows, a cloned rule, the baseline, a card's paper trade, a link's paper trade -- and a new file that
// writes executors without being named here, and pinned there, fails this test.

const ROOT = join(__dirname, '..')

/** The writers, each with why it writes. */
const WRITERS: Record<string, string> = {
  'src/agents/watchPaperTrade.ts': "the watch's paper trades (automatic; pinned paper in aiNoLivePath)",
  'src/forecast/forecastTrader.ts': 'the forecast trader (automatic; pinned paper in aiNoLivePath)',
  'src/forecast/labTrader.ts': 'the paper laboratory (automatic; pinned paper in aiNoLivePath)',
  'src/news/newsPaperShort.ts': "the news rules' paper shorts (automatic; pinned paper in aiNoLivePath)",
  'src/news/newsBookShort.ts': "the news book's shorts while paper testing runs (automatic once started; pinned paper in aiNoLivePath)",
  'src/traders/paperFollow.ts': "a followed trader's follows, in the copy book (automatic once a person follows; pinned paper in aiNoLivePath)",
  'src/traders/paperClone.ts': "a trader's clone's trades, in the copy book (automatic once a person runs it; pinned paper in aiNoLivePath)",
  'src/controllers/ControllerScheduler.tsx': "a controller stopping its executors on a breach: it changes their status, never opens one",
  'src/livetrading/LiveOrderScheduler.tsx': "the real-order poll writing back what resolved: never opens one",
  'src/executors/ExecutorsPage.tsx': "a person's own executor, made on the form",
  'src/presets/insertStarterPack.ts': 'a starter preset a person chose'
}

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...filesUnder(path))
    else if (/\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

/** A settings write whose object names executors: `settings.set({ executors })`, `setSettings({ ..., executors: x })`. */
const WRITES_EXECUTORS = /(?:settings\.set|setSettings)\(\s*\{[^}]*\bexecutors\b/s

describe('the files that write executors', () => {
  it('are the ones named, every one of them, and no other', () => {
    const found = filesUnder(join(ROOT, 'src'))
      .filter((file) => WRITES_EXECUTORS.test(readFileSync(file, 'utf-8')))
      .map((file) => file.slice(ROOT.length + 1).split(sep).join('/'))
      .sort()
    expect(found).toEqual(Object.keys(WRITERS).sort())
  })

  it('catch every shape of write the app uses', () => {
    for (const text of ['window.api.settings.set({ executors })', 'await deps.setSettings({ executors: [...fresh.executors, executor] })', 'settings.set({\n  controllers: next,\n  executors: changed\n})']) {
      expect(WRITES_EXECUTORS.test(text), text).toBe(true)
    }
    for (const text of ['window.api.settings.set({ routines: next })', 'settings.set({ paperAccount: account }) // executors are derived']) {
      expect(WRITES_EXECUTORS.test(text), text).toBe(false)
    }
  })
})
