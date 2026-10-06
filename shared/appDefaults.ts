import type { PaperPauseSettings, PaperRiskSettings } from './ipc'
import { DEFAULT_PAPER_PAUSE, describePaperPause, savePaperPause } from './paperPause'
import { DEFAULT_PAPER_RISK, describePaperRisk } from './paperRisk'

// WHAT A FRESH INSTALL STARTS WITH, AND THE RISK LEVEL IN A WORD.
//
// The V3 document asks for "smart defaults first, advanced controls second": a DefaultConfig, and a
// ConfigResolver that gives every missing setting its default. In this app that resolver already
// exists, one heal function per store, each run on every read:
// - settings.json: healPaperRisk, healPaperPause, healPaperDigest, healAlerts;
// - aiConfig.json: the budget and models in electron/services/aiConfigService.ts, healAiWatch and
//   healAiWatchPaper;
// - scanner.json: marketScannerService.ts against DEFAULT_SCANNER_CONFIG;
// - news.json: healNewsConfig.
// tests/appDefaults.test.ts reads each of the shared ones empty and checks it comes back as its
// default, so a default changes only where it is defined.
//
// THE RISK LEVEL is how Settings says the rest in a word, as the document asks ("Risk:
// Conservative" instead of twelve fields). Conservative is the shipped defaults of the two
// settings for the app's own paper trades that may be changed at any time -- how they are sized and
// capped, and the losing run that pauses them -- every one of which only ever opens less. Anything
// else is Custom. The limits on real orders are their own, set on Risk & Safety, and nothing here
// changes them.

export type RiskLevel = 'conservative' | 'custom'

/** What Conservative is: the paper sizing and cap, and the pause's loss and run, at their defaults. */
export const CONSERVATIVE_PAPER: { paperRisk: PaperRiskSettings; pause: Pick<PaperPauseSettings, 'lossR' | 'trades'> } = {
  paperRisk: DEFAULT_PAPER_RISK,
  pause: { lossR: DEFAULT_PAPER_PAUSE.lossR, trades: DEFAULT_PAPER_PAUSE.trades }
}

/** Conservative when every one of those is at its default; Custom otherwise, whichever way it was
 * changed. */
export function riskLevelOf(input: { paperRisk: PaperRiskSettings; paperPause: Pick<PaperPauseSettings, 'lossR' | 'trades'> }): RiskLevel {
  const { paperRisk, pause } = CONSERVATIVE_PAPER
  const same =
    input.paperRisk.sizing === paperRisk.sizing &&
    input.paperRisk.riskQuote === paperRisk.riskQuote &&
    input.paperRisk.maxOutQuote === paperRisk.maxOutQuote &&
    input.paperPause.lossR === pause.lossR &&
    input.paperPause.trades === pause.trades
  return same ? 'conservative' : 'custom'
}

/** The paper settings put back to Conservative. Whether the watch or the news rules are paused is
 * kept as it is: a reset is not a Resume. */
export function conservativePaper(stored: PaperPauseSettings): { paperRisk: PaperRiskSettings; paperPause: PaperPauseSettings } {
  return { paperRisk: { ...CONSERVATIVE_PAPER.paperRisk }, paperPause: savePaperPause(stored, CONSERVATIVE_PAPER.pause) }
}

/** The level in a word, and what it holds the app's own paper trades to, as set. */
export function describeRiskLevel(input: { paperRisk: PaperRiskSettings; paperPause: Pick<PaperPauseSettings, 'lossR' | 'trades'> }): { label: string; detail: string } {
  const level = riskLevelOf(input)
  return {
    label: level === 'conservative' ? 'Conservative' : 'Custom',
    detail: `For the paper trades the app opens by itself: ${describePaperRisk(input.paperRisk)} ${describePaperPause(input.paperPause)}`
  }
}
