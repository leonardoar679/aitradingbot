import { ENGLISH, type I18n } from './i18n/translate'
import {
  AI_MARKET_REGIMES,
  AI_MAX_REASON_CODES,
  AI_REASON_CODES,
  AI_RISK_LEVELS,
  type AiMarketRegime,
  type AiReasonCode,
  type AiRiskLevel
} from './aiSignal'
import { describeAiModelId, isAiModelId } from './aiEffort'

// A panel of agents for one decision.
//
// One model asked one question gives one answer. A panel splits the question: a trend analyst
// says what the regime is, a momentum analyst says whether anything is moving right now, a risk
// analyst says whether a position is attractive given what the account holds, and a fourth call --
// the decision -- is shown the same market snapshot plus those three reports and answers in the
// shape every other signal has. Four calls to one model instead of one.
//
// IT IS A DECIDER, NOT A STRATEGY. A panel is named like a model -- `panel:` in front of the model
// it runs on -- and its answer is an ordinary decision, so everything downstream of "who decides"
// is unchanged: the position machine, the validator, the tape, a benchmark's scoring, a route.
// That is also what makes it measurable. Ticked beside its own model on the Benchmark tab, a panel
// is asked the very questions the model was asked alone, and the two are scored side by side.
//
// IT IS NEVER THE DEFAULT. A panel can be chosen where someone is told its price before it runs --
// Analyze, a benchmark, and as the second step of a route, where it is asked only about the
// decisions the first model passes on. It cannot be made the default model, so nothing that asks
// "the default" (the chart, an entry review, a bot switched on before panels existed) can start
// costing four calls a question because of a setting.
//
// EVERY CALL IS ITS OWN ANSWER, cached, budgeted and recorded on its own. A panel stopped half-way
// by the budget keeps the reports it has, and the next attempt asks only for what is missing.

export const AI_PANEL_PREFIX = 'panel:'

/** The analysts, in the order they are asked. */
export const AI_AGENT_ROLES = ['trend', 'momentum', 'risk'] as const
export type AiAgentRole = (typeof AI_AGENT_ROLES)[number]

/** Calls one panel decision takes: each analyst once, then the decision. */
export const AI_PANEL_CALLS = AI_AGENT_ROLES.length + 1

/** The prompt the panel's DECISION is asked under. Like every prompt version it is part of the
 * cache key and is written on every ledger row; see electron/services/aiPrompt.ts. */
export const AI_PANEL_PROMPT_VERSION = 'panel-v1'
/** The prompt each analyst is asked under. */
export const AI_AGENT_PROMPT_VERSIONS: Record<AiAgentRole, string> = {
  trend: 'panel-trend-v1',
  momentum: 'panel-momentum-v1',
  risk: 'panel-risk-v1'
}
/** The shape of an analyst's report. */
export const AI_AGENT_SCHEMA_VERSION = 'agent-v1'

export const AI_AGENT_MOMENTUM = ['up', 'down', 'none'] as const
export type AiAgentMomentum = (typeof AI_AGENT_MOMENTUM)[number]
export const AI_AGENT_VERDICTS = ['attractive', 'marginal', 'unattractive'] as const
export type AiAgentVerdict = (typeof AI_AGENT_VERDICTS)[number]
export const AI_AGENT_MAX_NOTE_CHARS = 300

interface AiAgentReportBase {
  /** 0 to 1: how consistent the evidence looked to the analyst. Not a probability. */
  confidence: number
  reasonCodes: AiReasonCode[]
  note: string
}

/** "What is the current market regime?" */
export interface AiTrendReport extends AiAgentReportBase {
  regime: AiMarketRegime
}

/** "Is there short-term momentum?" */
export interface AiMomentumReport extends AiAgentReportBase {
  momentum: AiAgentMomentum
}

/** "Is a position attractive relative to what the account holds?" */
export interface AiRiskReport extends AiAgentReportBase {
  riskLevel: AiRiskLevel
  verdict: AiAgentVerdict
}

export interface AiAgentReports {
  trend: AiTrendReport
  momentum: AiMomentumReport
  risk: AiRiskReport
}

export type AiAgentReport = AiAgentReports[AiAgentRole]

/** `panel:openai/gpt-5-mini`: the panel that runs on that model. */
export function panelIdFor(model: string): string {
  return `${AI_PANEL_PREFIX}${model}`
}

/** The model a panel runs on, or null when `id` does not name a panel.
 *
 * No real model id can be mistaken for one: OpenRouter's are `vendor/model`, with the slash before
 * any colon. A panel of a panel is not a thing and is not read as one. */
export function panelModelOf(id: string): string | null {
  if (!id.startsWith(AI_PANEL_PREFIX)) return null
  const model = id.slice(AI_PANEL_PREFIX.length)
  return isAiModelId(model) && !model.startsWith(AI_PANEL_PREFIX) ? model : null
}

/** True for anything written as a panel, well formed or not: the test for "this must not be
 * handed to OpenRouter as a model". */
export function isPanelId(id: string): boolean {
  return id.startsWith(AI_PANEL_PREFIX)
}

/** The model whose calls a decider's answers are made of: the panel's model, or the model itself. */
export function deciderModel(id: string): string {
  return panelModelOf(id) ?? id
}

/** Model calls one answer from this decider takes when nothing is cached. */
export function deciderCalls(id: string): number {
  return isPanelId(id) ? AI_PANEL_CALLS : 1
}

/** A decider as it is named to a person: a model by its id, a panel as what it is. */
export function describeDecider(id: string, i18n: I18n = ENGLISH): string {
  const model = panelModelOf(id)
  return model === null ? describeAiModelId(id, i18n) : i18n.t('the agent panel on {model}', { model: describeAiModelId(model, i18n) })
}

export type AiAgentVerdictOf<R extends AiAgentRole> = { ok: true; report: AiAgentReports[R] } | { ok: false; reason: string }

function isOneOf<T>(allowed: readonly T[], value: unknown): value is T {
  return allowed.includes(value as T)
}

/** Decides whether an analyst's answer can be used, by the rule validateAiAnswer follows: the
 * schema sent to the provider carries types and enums only, so every range is checked here, and
 * an answer that fails is refused whole. The report is REBUILT, field by field in one order,
 * because it goes on into the decision's prompt and from there into a cache key. */
export function validateAgentReport<R extends AiAgentRole>(role: R, value: unknown): AiAgentVerdictOf<R> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'the report is not an object' }
  const record = value as Record<string, unknown>
  const { confidence, reasonCodes, note } = record
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, reason: 'confidence is missing or out of range' }
  }
  if (!Array.isArray(reasonCodes) || !reasonCodes.every((code) => isOneOf(AI_REASON_CODES, code))) {
    return { ok: false, reason: 'reasonCodes holds a value outside the allowed list' }
  }
  if (typeof note !== 'string') return { ok: false, reason: 'note is missing' }
  const base = {
    confidence,
    reasonCodes: [...new Set(reasonCodes as AiReasonCode[])].slice(0, AI_MAX_REASON_CODES),
    note: note.slice(0, AI_AGENT_MAX_NOTE_CHARS)
  }

  let report: AiAgentReport
  if (role === 'trend') {
    if (!isOneOf(AI_MARKET_REGIMES, record.regime)) return { ok: false, reason: 'regime is not an allowed value' }
    report = { regime: record.regime, ...base }
  } else if (role === 'momentum') {
    if (!isOneOf(AI_AGENT_MOMENTUM, record.momentum)) return { ok: false, reason: 'momentum is not an allowed value' }
    report = { momentum: record.momentum, ...base }
  } else {
    if (!isOneOf(AI_RISK_LEVELS, record.riskLevel)) return { ok: false, reason: 'riskLevel is not an allowed value' }
    if (!isOneOf(AI_AGENT_VERDICTS, record.verdict)) return { ok: false, reason: 'verdict is not an allowed value' }
    report = { riskLevel: record.riskLevel, verdict: record.verdict, ...base }
  }
  return { ok: true, report: report as AiAgentReports[R] }
}

/** The three reports as the decision is shown them: each rebuilt through its validator, in the
 * order the analysts are asked. Throws on a report that would not have passed, so a malformed one
 * can never reach a prompt by being handed over directly. */
export function canonicalAgentReports(reports: AiAgentReports): AiAgentReports {
  const rebuilt = <R extends AiAgentRole>(role: R): AiAgentReports[R] => {
    const verdict = validateAgentReport(role, reports[role])
    if (!verdict.ok) throw new Error(`The ${role} report cannot be used: ${verdict.reason}`)
    return verdict.report
  }
  return { trend: rebuilt('trend'), momentum: rebuilt('momentum'), risk: rebuilt('risk') }
}

/** What an analyst concluded, in a word or two: `bull`, `up`, `attractive, medium risk`. */
export function describeAgentFinding(role: AiAgentRole, report: AiAgentReport): string {
  if (role === 'trend') return (report as AiTrendReport).regime.replace(/_/g, ' ')
  if (role === 'momentum') return (report as AiMomentumReport).momentum
  const risk = report as AiRiskReport
  return `${risk.verdict}, ${risk.riskLevel} risk`
}
