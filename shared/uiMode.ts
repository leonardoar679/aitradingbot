// TWO PERSONALITIES (the V6 document, §64-65 and §116; V6 Stage 1, 13 October 2026).
//
// A normal user sees the few pages the normal path runs through -- Home, then the prediction, the
// opportunity, the position -- with RESEARCH and ALL FEATURES folded away, one click from opening.
// An expert sees every group open. Nothing is removed in either: every page the app had is in the
// sidebar in both, and the mode only decides which groups start open. It ships NORMAL, as the
// document asks, and only "expert" in the file reads as expert.

export const UI_MODES = ['normal', 'expert'] as const
export type UiMode = (typeof UI_MODES)[number]

export const DEFAULT_UI_MODE: UiMode = 'normal'

/** A stored setting, read as one: settings.json is written by the renderer, so it is healed rather
 * than obeyed. */
export function healUiMode(value: unknown): UiMode {
  return value === 'expert' ? 'expert' : DEFAULT_UI_MODE
}

export function describeUiMode(mode: UiMode): { label: string; detail: string } {
  return mode === 'expert'
    ? { label: 'Expert', detail: 'Every group in the sidebar is open: research, and every feature the app has, beside the prediction.' }
    : { label: 'Normal', detail: 'The sidebar opens on the prediction, the opportunities and the positions; Research and All Features are folded away, one click from opening.' }
}
