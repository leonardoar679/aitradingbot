import {
  NEWS_READING_DIRECTIONS,
  NEWS_READING_HORIZONS,
  NEWS_READING_MAX_REASONS,
  NEWS_READING_RELATIONSHIPS,
  type AiAdditionKind
} from '../../shared/aiAdditions'

// WHAT EACH AI ADDITION IS TOLD, AND THE SHAPE IT MUST ANSWER IN (shared/aiAdditions.ts).
//
// Versioned by AI_ADDITION_PROMPT_VERSIONS and AI_ADDITION_SCHEMA_VERSIONS: both are part of a cache
// key and are written on every ledger row, so ANY edit to a text or a schema here must bump the
// matching constant. tests/aiAdditions.test.ts holds a hash of each beside its version.
//
// None of them is asked whether to trade, or told what an answer will be used for beyond what it
// needs to answer it: a reading is a reading.

export const AI_ADDITION_SYSTEM_PROMPTS: Record<AiAdditionKind, string> = {
  news: [
    'You read crypto news for a trading app. Return only the requested JSON.',
    'The user message is one story as it was published: its source, title, summary, the time it was published (Unix seconds), and what fixed keyword rules made of it -- its kind, and the coins they found named in it (DIRECT in the title, INDIRECT in the summary only). The rules can be wrong; read the story itself.',
    'You do not decide whether to trade. Say what the story is, for the coin it concerns most.',
    'ticker: the coin the story concerns most, as Binance names it (for example BTC, ETH, SOL), or null when it concerns no single coin.',
    `relationship: ${NEWS_READING_RELATIONSHIPS.join(', ')} -- DIRECT when the story is about that coin, INDIRECT when it only touches it, NONE when ticker is null.`,
    `direction: ${NEWS_READING_DIRECTIONS.join(', ')} -- which way the story would move that coin's price, or none when it would not, or could go either way.`,
    'impact: a whole number from 0 to 100 -- how much the story could move that coin, against everything else that moves it. A routine update is under 30; a hack, a delisting or a large listing is over 70.',
    `horizon: ${NEWS_READING_HORIZONS.join(', ')} -- over how long that move would play out.`,
    'confidence: 0 to 1. How clearly the story supports your reading. It is not a probability; never claim certainty.',
    'pricedIn: true when the story reports something markets already knew, or a move that has already happened.',
    `reasons: at most ${NEWS_READING_MAX_REASONS} characters, plain text: what your reading rests on.`
  ].join('\n')
}

export const AI_ADDITION_SCHEMAS: Record<AiAdditionKind, { name: string; schema: Record<string, unknown> }> = {
  news: {
    name: 'news_reading',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ticker: { type: ['string', 'null'] },
        relationship: { type: 'string', enum: [...NEWS_READING_RELATIONSHIPS] },
        direction: { type: 'string', enum: [...NEWS_READING_DIRECTIONS] },
        impact: { type: 'integer' },
        horizon: { type: 'string', enum: [...NEWS_READING_HORIZONS] },
        confidence: { type: 'number' },
        pricedIn: { type: 'boolean' },
        reasons: { type: 'string' }
      },
      required: ['ticker', 'relationship', 'direction', 'impact', 'horizon', 'confidence', 'pricedIn', 'reasons']
    }
  }
}

/** The question as it is sent: the addition's own instruction, and its payload as JSON. */
export function buildAdditionMessages(kind: AiAdditionKind, payload: unknown): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: AI_ADDITION_SYSTEM_PROMPTS[kind] },
    { role: 'user', content: JSON.stringify(payload) }
  ]
}

/** Characters in one request, for estimating what a call will cost before any has been made. */
export function additionPromptChars(kind: AiAdditionKind, payload: unknown): number {
  return AI_ADDITION_SYSTEM_PROMPTS[kind].length + JSON.stringify(payload).length + JSON.stringify(AI_ADDITION_SCHEMAS[kind]).length
}
