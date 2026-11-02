import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LANGUAGES, type Language } from '../shared/i18n/languages'
import { i18nFor } from '../shared/i18n/translate'
import { NAV_GROUPS, NORMAL_NAV_GROUPS } from '../src/navigation/pages'

// EVERY SIDEBAR LABEL FITS, IN EVERY LANGUAGE (V8 Stage 10; the plan: "label widths are checked in every language").
// The sidebar is 200 pixels wide and draws its labels on one line, clipping what does not fit -- silently. A label's
// width is measured in the app itself, in each of the ten languages and both layouts, every folded group open: how far
// its text runs past the room it has -- the button's padding, or a badge or chevron on the same line -- negative where
// it has room to spare (the Stage 10 check, written to tests/fixtures/sidebar-widths.json). Here every label the
// catalogs give now must be one that was measured, with room to spare: a label changed in any language is measured
// again before it ships.

const MEASURED = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'sidebar-widths.json'), 'utf-8')) as { margin: number; languages: Record<string, Record<string, number>> }

/** Every label either sidebar draws: its groups' titles and its entries. */
const LABELS = [...new Set([...NAV_GROUPS, ...NORMAL_NAV_GROUPS].flatMap((group) => [group.title, ...group.items.map((item) => item.label)]))]

describe("the sidebar's labels", () => {
  it('were measured in the app in every language', () => {
    expect(Object.keys(MEASURED.languages).sort()).toEqual([...LANGUAGES].map((language) => language).sort())
  })

  for (const language of LANGUAGES as readonly Language[]) {
    it(`fit with ${MEASURED.margin} pixels to spare in ${language}`, () => {
      const { t } = i18nFor(language)
      const measured = MEASURED.languages[language] ?? {}
      for (const label of LABELS) {
        const shown = t(label)
        expect(measured[shown], `"${shown}" (${label}) was not measured in ${language}: measure the sidebar again`).toBeDefined()
        expect(measured[shown], `"${shown}" (${label}) runs past its room in ${language}`).toBeLessThanOrEqual(-MEASURED.margin)
      }
    })
  }
})
