import { describe, expect, it } from 'vitest'
import { aiContextJson, aiPromptVersion, buildAiContext, withAgentReports, type AiMarketContext } from '../shared/aiContext'
import {
  AI_AGENT_MAX_NOTE_CHARS,
  AI_AGENT_PROMPT_VERSIONS,
  AI_AGENT_ROLES,
  AI_PANEL_CALLS,
  AI_PANEL_PROMPT_VERSION,
  canonicalAgentReports,
  deciderCalls,
  deciderModel,
  describeAgentFinding,
  describeDecider,
  isPanelId,
  panelIdFor,
  panelModelOf,
  validateAgentReport,
  type AiAgentReports
} from '../shared/aiPanel'
import { AI_MAX_REASON_CODES, GPT_LOOKBACK_BARS, GPT_PROMPT_VERSION } from '../shared/aiSignal'
import type { Candle } from '../shared/ipc'

// A panel is three analysts' reports and a decision made from them. These pin the parts that are
// pure: what counts as a panel's name, what a report has to be before it is allowed into the
// decision's prompt, and that the prompt it goes into is the same bytes however the reports were
// handed over -- because those bytes are a cache key.

const MODEL = 'openai/gpt-5-mini'
const PANEL = `panel:${MODEL}`

const REPORTS: AiAgentReports = {
  trend: { regime: 'bull', confidence: 0.7, reasonCodes: ['trend_up', 'timeframes_agree'], note: 'Higher highs on the 4h.' },
  momentum: { momentum: 'up', confidence: 0.6, reasonCodes: ['momentum_up'], note: 'RSI rising through 55.' },
  risk: { riskLevel: 'medium', verdict: 'attractive', confidence: 0.65, reasonCodes: ['low_volatility'], note: 'ATR is contained.' }
}

function context(): AiMarketContext {
  const candles: Candle[] = Array.from({ length: GPT_LOOKBACK_BARS + 1 }, (_, i) => {
    const close = 100 + Math.sin(i / 9) * 3 + i * 0.01
    return { time: 1_700_000_100 + i * 900, open: close - 0.2, high: close + 0.5, low: close - 0.6, close, volume: 50 + (i % 7) }
  })
  const built = buildAiContext(candles, GPT_LOOKBACK_BARS, { exchange: 'binance', symbol: 'BTCUSDT', interval: '15m', position: 'flat' })
  if (!built) throw new Error('no context')
  return built
}

describe('what names a panel', () => {
  it('is the model it runs on with a prefix no real model id can carry', () => {
    expect(panelIdFor(MODEL)).toBe(PANEL)
    expect(panelModelOf(PANEL)).toBe(MODEL)
    expect(panelModelOf('panel:meta-llama/llama-3.3-70b-instruct:free')).toBe('meta-llama/llama-3.3-70b-instruct:free')
    expect(isPanelId(PANEL)).toBe(true)
    // A model is not a panel, whatever it is called.
    expect(panelModelOf(MODEL)).toBeNull()
    expect(isPanelId(MODEL)).toBe(false)
    expect(isPanelId('panelists/model-1')).toBe(false)
  })

  it('reads a malformed one as written like a panel, and as naming no model', () => {
    // "Written like a panel" is what keeps it off the wire; "names no model" is what refuses it.
    for (const id of ['panel:', 'panel:has spaces', `panel:${PANEL}`]) {
      expect(isPanelId(id)).toBe(true)
      expect(panelModelOf(id)).toBeNull()
    }
  })

  it('costs four calls an answer where a model costs one, all of them to the model it runs on', () => {
    expect(AI_PANEL_CALLS).toBe(AI_AGENT_ROLES.length + 1)
    expect(deciderCalls(PANEL)).toBe(4)
    expect(deciderCalls(MODEL)).toBe(1)
    expect(deciderModel(PANEL)).toBe(MODEL)
    expect(deciderModel(MODEL)).toBe(MODEL)
  })

  it('is described to a person as what it is', () => {
    expect(describeDecider(PANEL)).toBe(`the agent panel on ${MODEL}`)
    expect(describeDecider(MODEL)).toBe(MODEL)
  })
})

describe("an analyst's report", () => {
  it('is rebuilt field by field, in one order, with anything else dropped', () => {
    const scrambled = { note: 'Higher highs on the 4h.', extra: true, reasonCodes: ['trend_up', 'timeframes_agree'], confidence: 0.7, regime: 'bull' }
    const verdict = validateAgentReport('trend', scrambled)
    expect(verdict).toEqual({ ok: true, report: REPORTS.trend })
    // The same bytes whatever order the model wrote its fields in.
    expect(verdict.ok && JSON.stringify(verdict.report)).toBe(JSON.stringify(REPORTS.trend))
    expect(validateAgentReport('momentum', REPORTS.momentum)).toEqual({ ok: true, report: REPORTS.momentum })
    expect(validateAgentReport('risk', REPORTS.risk)).toEqual({ ok: true, report: REPORTS.risk })
  })

  it('has its note cut to length and its reason codes counted once, and no more than a signal may give', () => {
    const verdict = validateAgentReport('momentum', {
      momentum: 'none',
      confidence: 0.5,
      reasonCodes: ['range_bound', 'range_bound', 'volume_absent', 'low_volatility', 'oversold', 'overbought', 'breakout'],
      note: 'x'.repeat(AI_AGENT_MAX_NOTE_CHARS + 50)
    })
    if (!verdict.ok) throw new Error(verdict.reason)
    expect(verdict.report.note).toHaveLength(AI_AGENT_MAX_NOTE_CHARS)
    expect(verdict.report.reasonCodes).toEqual(['range_bound', 'volume_absent', 'low_volatility', 'oversold', 'overbought'])
    expect(verdict.report.reasonCodes).toHaveLength(AI_MAX_REASON_CODES)
  })

  it('is refused whole when a field is not what the question allows', () => {
    const refused = (role: 'trend' | 'momentum' | 'risk', value: unknown): string => {
      const verdict = validateAgentReport(role, value)
      return verdict.ok ? 'ACCEPTED' : verdict.reason
    }
    expect(refused('trend', { ...REPORTS.trend, regime: 'sideways' })).toContain('regime')
    expect(refused('momentum', { ...REPORTS.momentum, momentum: 'strong' })).toContain('momentum')
    expect(refused('risk', { ...REPORTS.risk, verdict: 'buy' })).toContain('verdict')
    expect(refused('risk', { ...REPORTS.risk, riskLevel: 'extreme' })).toContain('riskLevel')
    expect(refused('trend', { ...REPORTS.trend, confidence: 1.2 })).toContain('confidence')
    expect(refused('trend', { ...REPORTS.trend, confidence: '0.7' })).toContain('confidence')
    expect(refused('trend', { ...REPORTS.trend, reasonCodes: ['trend_up', 'vibes'] })).toContain('reasonCodes')
    expect(refused('trend', { ...REPORTS.trend, note: undefined })).toContain('note')
    expect(refused('trend', [REPORTS.trend])).toContain('not an object')
    expect(refused('trend', null)).toContain('not an object')
  })

  it('answers its own question and no other: a trend report is not a momentum report', () => {
    expect(validateAgentReport('momentum', REPORTS.trend).ok).toBe(false)
    expect(validateAgentReport('risk', REPORTS.momentum).ok).toBe(false)
  })

  it('is said in a word or two', () => {
    expect(describeAgentFinding('trend', { ...REPORTS.trend, regime: 'strong_bear' })).toBe('strong bear')
    expect(describeAgentFinding('momentum', REPORTS.momentum)).toBe('up')
    expect(describeAgentFinding('risk', REPORTS.risk)).toBe('attractive, medium risk')
  })
})

describe("the question a panel's decision is asked", () => {
  it('is the snapshot its analysts saw, with their reports added last', () => {
    const plain = context()
    const asked = withAgentReports(plain, REPORTS)
    const keys = Object.keys(JSON.parse(aiContextJson(asked)))
    expect(keys[keys.length - 1]).toBe('agents')
    // Take the reports away and it is byte for byte what the analysts were sent.
    const { agents, ...rest } = JSON.parse(aiContextJson(asked))
    expect(JSON.stringify(rest)).toBe(aiContextJson(plain))
    expect(agents).toEqual(REPORTS)
    expect(Object.keys(agents)).toEqual([...AI_AGENT_ROLES])
  })

  it('is the same bytes however the reports were handed over', () => {
    const plain = context()
    const reordered = {
      risk: { note: REPORTS.risk.note, verdict: 'attractive', reasonCodes: ['low_volatility'], riskLevel: 'medium', confidence: 0.65 },
      momentum: { ...REPORTS.momentum, extra: 'ignored' },
      trend: REPORTS.trend
    } as unknown as AiAgentReports
    expect(aiContextJson(withAgentReports(plain, reordered))).toBe(aiContextJson(withAgentReports(plain, REPORTS)))
    expect(canonicalAgentReports(reordered)).toEqual(REPORTS)
  })

  it('cannot be built from a report that would not have passed', () => {
    const broken = { ...REPORTS, risk: { ...REPORTS.risk, verdict: 'buy' } } as unknown as AiAgentReports
    expect(() => withAgentReports(context(), broken)).toThrow(/risk report cannot be used: verdict/)
  })

  it('is asked under its own prompt version, and an analyst under its own', () => {
    const plain = context()
    expect(aiPromptVersion(plain)).toBe(GPT_PROMPT_VERSION)
    expect(aiPromptVersion(withAgentReports(plain, REPORTS))).toBe(AI_PANEL_PROMPT_VERSION)
    expect(new Set([GPT_PROMPT_VERSION, AI_PANEL_PROMPT_VERSION, ...Object.values(AI_AGENT_PROMPT_VERSIONS)]).size).toBe(5)
  })

  it('is asked once: reports are not added to a question that already has them, or to an entry review', () => {
    const plain = context()
    expect(() => withAgentReports(withAgentReports(plain, REPORTS), REPORTS)).toThrow(/standalone signal/)
    const review = { ...plain, strategy: { id: 'trend-regime-ensemble', name: 'Trend Regime', rule: 'rule', stopDistancePct: 2, readings: [] } }
    expect(() => withAgentReports(review, REPORTS)).toThrow(/standalone signal/)
  })
})
