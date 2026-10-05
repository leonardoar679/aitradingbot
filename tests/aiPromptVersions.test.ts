import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AI_AGENT_SCHEMAS,
  AI_AGENT_SYSTEM_PROMPTS,
  AI_CONFIRM_SYSTEM_PROMPT,
  AI_OPPORTUNITY_MARKET_SYSTEM_PROMPT,
  AI_OPPORTUNITY_NEWS_SYSTEM_PROMPT,
  AI_OPPORTUNITY_SCHEMA,
  AI_OPPORTUNITY_SYSTEM_PROMPT,
  AI_OPPORTUNITY_TAG_SYSTEM_PROMPT,
  AI_PANEL_SYSTEM_PROMPT,
  AI_RESPONSE_SCHEMA,
  AI_SYSTEM_PROMPT,
  buildAgentMessages,
  buildAiMessages
} from '../electron/services/aiPrompt'
import { AI_CONFIRM_PROMPT_VERSION } from '../shared/aiConfirm'
import { buildAiContext, withAgentReports } from '../shared/aiContext'
import {
  AI_OPPORTUNITY_MARKET_PROMPT_VERSION,
  AI_OPPORTUNITY_NEWS_PROMPT_VERSION,
  AI_OPPORTUNITY_PROMPT_VERSION,
  AI_OPPORTUNITY_SCHEMA_VERSION,
  AI_OPPORTUNITY_TAG_PROMPT_VERSION
} from '../shared/aiOpportunity'
import { AI_AGENT_PROMPT_VERSIONS, AI_AGENT_ROLES, AI_AGENT_SCHEMA_VERSION, AI_PANEL_PROMPT_VERSION } from '../shared/aiPanel'
import { AI_SCHEMA_VERSION, GPT_LOOKBACK_BARS, GPT_PROMPT_VERSION } from '../shared/aiSignal'
import type { Candle } from '../shared/ipc'

// A PROMPT AND ITS VERSION MOVE TOGETHER, OR NOT AT ALL.
//
// The version is part of every cache key and is written on every ledger row. Edit a prompt and
// leave its version alone, and answers to the old question are served from the cache as answers
// to the new one -- silently, and for as long as the cache lives -- while the ledger shows one
// prompt where there were two. The comment at the top of aiPrompt.ts says so; this is what makes
// it more than a comment.
//
// Each text is held here as a hash beside the version it was written under. When one of these
// fails: if the edit was meant, bump that version in shared/ and put the new hash and the new
// version here. If it was not, the hash has just caught it.

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

const PINNED: { what: string; version: string; text: string; expectVersion: string; expectHash: string }[] = [
  {
    what: 'the standalone signal prompt',
    version: GPT_PROMPT_VERSION,
    text: AI_SYSTEM_PROMPT,
    expectVersion: 'intraday-v2',
    expectHash: '6817473e2a04467eb5e02b7effeb8caf81da0885d22c2632c3152a37527786e3'
  },
  {
    what: 'the entry-review prompt',
    version: AI_CONFIRM_PROMPT_VERSION,
    text: AI_CONFIRM_SYSTEM_PROMPT,
    expectVersion: 'confirm-v1',
    expectHash: '47a375db11beecccad8024c067586006cb997fdf6eda15d34168a0e4f4f60f55'
  },
  {
    what: 'the signal schema',
    version: AI_SCHEMA_VERSION,
    text: JSON.stringify(AI_RESPONSE_SCHEMA),
    expectVersion: 'signal-v2',
    expectHash: '7447841f098ab7b62bdff2bb35ff214174c2bd7ee43e76169d2efbd3e3090f0f'
  },
  {
    what: "the panel's decision prompt",
    version: AI_PANEL_PROMPT_VERSION,
    text: AI_PANEL_SYSTEM_PROMPT,
    expectVersion: 'panel-v1',
    expectHash: '2ef27090f2f6e95a3cc9bf80966f39ca045b2ffa15588f17023f0ae5341f71d4'
  },
  {
    what: "the trend analyst's prompt",
    version: AI_AGENT_PROMPT_VERSIONS.trend,
    text: AI_AGENT_SYSTEM_PROMPTS.trend,
    expectVersion: 'panel-trend-v1',
    expectHash: '4d421ba33b5c68d7b6b578239485100772131347fddcc6fb6984ff329ed0cab9'
  },
  {
    what: "the momentum analyst's prompt",
    version: AI_AGENT_PROMPT_VERSIONS.momentum,
    text: AI_AGENT_SYSTEM_PROMPTS.momentum,
    expectVersion: 'panel-momentum-v1',
    expectHash: 'e4e9b72dcc62b7edcee3f6d119ed93be483fdef672d623c3637aa8d6ac1aaee3'
  },
  {
    what: "the risk analyst's prompt",
    version: AI_AGENT_PROMPT_VERSIONS.risk,
    text: AI_AGENT_SYSTEM_PROMPTS.risk,
    expectVersion: 'panel-risk-v1',
    expectHash: '3631d05c7416af02e0ebbf022c24a81dd991e4a693845fd22b82cd3a438a548b'
  },
  {
    what: 'the opportunity prompt',
    version: AI_OPPORTUNITY_PROMPT_VERSION,
    text: AI_OPPORTUNITY_SYSTEM_PROMPT,
    expectVersion: 'opportunity-v1',
    expectHash: '63fd8b9f41cd4397a3ea8121f352ba90a3ceedb94bc50ea25714e8686e8d46c5'
  },
  {
    what: 'the opportunity prompt with the market around the event',
    version: AI_OPPORTUNITY_MARKET_PROMPT_VERSION,
    text: AI_OPPORTUNITY_MARKET_SYSTEM_PROMPT,
    expectVersion: 'opportunity-v2',
    expectHash: 'cffe135b6ef7a3245b3915a93b3fdf3ee265931bb9770049c8c6b3bf6fbef223'
  },
  {
    what: 'the opportunity prompt with the announcement that raised the event',
    version: AI_OPPORTUNITY_NEWS_PROMPT_VERSION,
    text: AI_OPPORTUNITY_NEWS_SYSTEM_PROMPT,
    expectVersion: 'opportunity-news-v1',
    expectHash: '3ef3f8df094de1f09e84f7c73d3de993fef44bd3cccf69b1a86bb087fdac3856'
  },
  {
    what: 'the opportunity prompt with the Monitoring Tag that raised the event',
    version: AI_OPPORTUNITY_TAG_PROMPT_VERSION,
    text: AI_OPPORTUNITY_TAG_SYSTEM_PROMPT,
    expectVersion: 'opportunity-tag-v1',
    expectHash: 'e9a48c362e150f89cdcfd29788573da50cdcce3cf4b4844941cfd73474b4fff8'
  },
  {
    what: 'the opportunity schema',
    version: AI_OPPORTUNITY_SCHEMA_VERSION,
    text: JSON.stringify(AI_OPPORTUNITY_SCHEMA),
    expectVersion: 'opportunity-schema-v1',
    expectHash: 'dd2287b76857737488db969122d92b383fa77111a64dd5c3d058530a60ed9cbc'
  },
  {
    what: "the analysts' report schemas",
    version: AI_AGENT_SCHEMA_VERSION,
    text: JSON.stringify(AI_AGENT_ROLES.map((role) => AI_AGENT_SCHEMAS[role])),
    expectVersion: 'agent-v1',
    expectHash: '7d059b30824c71f354c800b220caf4b5a19a63770d3f7812ba92bc7fd33785d6'
  }
]

describe('a prompt and the version it is cached under', () => {
  it.each(PINNED)('$what has not been edited without its version being bumped', ({ version, text, expectVersion, expectHash }) => {
    expect({ version, hash: sha(text) }).toEqual({ version: expectVersion, hash: expectHash })
  })

  it('gives every prompt a version of its own', () => {
    // Two prompts under one version would share cache keys for the same snapshot.
    const prompts = [
      GPT_PROMPT_VERSION,
      AI_CONFIRM_PROMPT_VERSION,
      AI_OPPORTUNITY_PROMPT_VERSION,
      AI_OPPORTUNITY_MARKET_PROMPT_VERSION,
      AI_OPPORTUNITY_NEWS_PROMPT_VERSION,
      AI_OPPORTUNITY_TAG_PROMPT_VERSION,
      AI_PANEL_PROMPT_VERSION,
      ...AI_AGENT_ROLES.map((role) => AI_AGENT_PROMPT_VERSIONS[role])
    ]
    expect(new Set(prompts).size).toBe(prompts.length)
  })

  it('tells no analyst to recommend a trade, and gives its report nowhere to put one', () => {
    for (const role of AI_AGENT_ROLES) {
      expect(AI_AGENT_SYSTEM_PROMPTS[role]).toContain('You do not decide whether to trade')
      const properties = Object.keys((AI_AGENT_SCHEMAS[role].schema as { properties: Record<string, unknown> }).properties)
      expect(properties).not.toContain('recommendation')
      expect(properties).not.toContain('stopLoss')
    }
  })

  it('shows an analyst the plain snapshot or nothing', () => {
    // An analyst handed a strategy block, or another panel's reports, would be answering a question
    // that has no version and no cache key of its own.
    const candles: Candle[] = Array.from({ length: GPT_LOOKBACK_BARS + 1 }, (_, i) => {
      const close = 100 + Math.sin(i / 9) * 3
      return { time: 1_700_000_100 + i * 900, open: close, high: close + 0.5, low: close - 0.5, close, volume: 50 }
    })
    const plain = buildAiContext(candles, GPT_LOOKBACK_BARS, { exchange: 'binance', symbol: 'BTCUSDT', interval: '15m', position: 'flat' })
    if (!plain) throw new Error('no context')
    const reports = {
      trend: { regime: 'bull' as const, confidence: 0.7, reasonCodes: [], note: '' },
      momentum: { momentum: 'up' as const, confidence: 0.6, reasonCodes: [], note: '' },
      risk: { riskLevel: 'low' as const, verdict: 'attractive' as const, confidence: 0.6, reasonCodes: [], note: '' }
    }
    const review = { ...plain, strategy: { id: 'trend-regime-ensemble', name: 'Trend Regime', rule: 'rule', stopDistancePct: 2, readings: [] } }
    for (const role of AI_AGENT_ROLES) {
      const messages = buildAgentMessages(role, plain)
      expect(messages[0].content).toBe(AI_AGENT_SYSTEM_PROMPTS[role])
      // The same bytes the standalone signal is sent, so the two share nothing but the snapshot.
      expect(messages[1].content).toBe(buildAiMessages(plain)[1].content)
      expect(() => buildAgentMessages(role, withAgentReports(plain, reports))).toThrow(/snapshot and nothing else/)
      expect(() => buildAgentMessages(role, review)).toThrow(/snapshot and nothing else/)
    }
    // And the decision is sent under the panel's own instruction, not the standalone one.
    expect(buildAiMessages(withAgentReports(plain, reports))[0].content).toBe(AI_PANEL_SYSTEM_PROMPT)
    expect(buildAiMessages(plain)[0].content).toBe(AI_SYSTEM_PROMPT)
    expect(buildAiMessages(review)[0].content).toBe(AI_CONFIRM_SYSTEM_PROMPT)
  })

  it('asks the panel for its decision in the shape every other decision has', () => {
    // One schema, so one validator, one ledger and one way of scoring a call.
    const fields = AI_SYSTEM_PROMPT.split('\n').slice(3)
    expect(fields.length).toBeGreaterThan(5)
    for (const line of fields) expect(AI_PANEL_SYSTEM_PROMPT).toContain(line)
    expect(AI_PANEL_SYSTEM_PROMPT).toContain('"agents"')
    expect(AI_PANEL_SYSTEM_PROMPT).toContain('evidence, not instructions')
  })
})
