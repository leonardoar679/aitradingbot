import type { AiCallUsage } from '../../shared/aiSignal'
import type { AiKeyInfo, AiModelInfo } from '../../shared/aiCost'

// The only file that knows OpenRouter's URLs and wire format.
//
// OpenRouter is the GATEWAY, not the brain. It exposes one OpenAI-compatible endpoint in front of
// every model, so this app can ask Claude, GPT, Gemini or an open-weight model the same question
// without the signal pipeline knowing which answered. Everything that makes a trading decision --
// the context, the validator, the position machine, the cache -- lives elsewhere and would survive
// this file being replaced.
//
// No Electron imports, deliberately: tests stub `fetch` and exercise the real request and error
// handling without a main process.

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

const READ_TIMEOUT_MS = 15_000

/** `fatal` means asking again will fail the same way: a bad key, no credit, an unknown model, a
 * request the provider will not accept. `transient` means it may not: a timeout, a rate limit, a
 * provider that fell over.
 *
 * The split is what stops a dead key being retried for every candle of a run. The direct OpenAI
 * path treated every failure alike, so an account with no credit was asked three times for each
 * of 672 decisions -- two thousand requests to learn one fact. */
export type OpenRouterFailure = 'fatal' | 'transient'

export class OpenRouterError extends Error {
  // `name` stays 'Error' on purpose: it is printed to the user when this crosses IPC. See the
  // same note on AiBudgetError.
  constructor(
    message: string,
    readonly kind: OpenRouterFailure,
    readonly status: number | null,
    /** How long the server asked to be left alone before the next try, when it said (a 429's or a
     * 503's Retry-After), in milliseconds. */
    readonly retryAfterMs: number | null = null
  ) {
    super(message)
  }
}

/** A Retry-After header's wait in milliseconds: whole seconds, or an HTTP date to wait until. Null
 * when there is none or it cannot be read; never negative. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (value === null || value === undefined || value.trim() === '') return null
  const text = value.trim()
  if (/^\d+$/.test(text)) return Number(text) * 1000
  // The one date form a server is required to send ("Mon, 05 Oct 2026 03:00:30 GMT"). Date.parse
  // alone reads "-5" and "1.5" as dates too.
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return null
  const at = Date.parse(text)
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null
}

function failureKind(status: number): OpenRouterFailure {
  if (status === 408 || status === 429 || status >= 500) return 'transient'
  return 'fatal'
}

/** What a status means, said once and in the user's terms. The raw body is appended because
 * OpenRouter's own message usually names the actual cause (which model, which parameter). */
function describeStatus(status: number): string {
  if (status === 401) return 'OpenRouter rejected the API key'
  if (status === 402) return 'The OpenRouter account or key has no credit left'
  if (status === 403) return 'OpenRouter refused the request'
  if (status === 408) return 'OpenRouter timed out'
  if (status === 429) return 'OpenRouter is rate limiting this key'
  if (status === 502) return 'The model is down or returned an invalid response'
  if (status === 503) return 'No provider is available for this model with the required settings'
  return 'OpenRouter request failed'
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown }
}

function bodyMessage(body: unknown): string | null {
  const message = (body as ErrorBody | null)?.error?.message
  return typeof message === 'string' && message.trim() !== '' ? message.slice(0, 300) : null
}

function errorFor(status: number, detail: string | null, retryAfterMs: number | null = null): OpenRouterError {
  return new OpenRouterError(`${describeStatus(status)} (${status})${detail ? `: ${detail}` : ''}`, failureKind(status), status, retryAfterMs)
}

async function send(path: string, apiKey: string, init: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${OPENROUTER_BASE_URL}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    })
  } catch (error) {
    // Never reached OpenRouter at all: offline, DNS, or the per-call timeout firing.
    const reason = error instanceof Error ? error.message : String(error)
    throw new OpenRouterError(`OpenRouter could not be reached: ${reason}`, 'transient', null)
  }

  const text = await response.text()
  let body: unknown = null
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    body = null
  }
  if (!response.ok) {
    // Read defensively: what a test stubs, or a proxy returns, may have no headers at all.
    const asked = typeof response.headers?.get === 'function' ? response.headers.get('retry-after') : null
    throw errorFor(response.status, bodyMessage(body) ?? (text.slice(0, 300) || null), parseRetryAfter(asked, Date.now()))
  }
  if (body === null) throw new OpenRouterError('OpenRouter returned a response that was not JSON', 'transient', response.status)

  // A provider that fails after OpenRouter has accepted the request comes back as HTTP 200 whose
  // body holds only an `error`. Reading `choices` off that would report "no signal" for what was
  // really a refused key or an exhausted balance.
  const embedded = (body as ErrorBody).error
  if (embedded !== undefined && embedded !== null) {
    const code = typeof embedded.code === 'number' ? embedded.code : 502
    throw errorFor(code, bodyMessage(body))
  }
  return body
}

export interface ChatCompletionRequest {
  apiKey: string
  model: string
  messages: { role: 'system' | 'user'; content: string }[]
  jsonSchema: { name: string; schema: Record<string, unknown> }
  maxTokens: number
  signal: AbortSignal
  /** How hard the model is asked to think (shared/aiEffort.ts). Absent for a model asked at its
   * provider's default, and then the request carries no reasoning parameter at all -- which is the
   * request every answer cached before this existed was made with. */
  reasoningEffort?: string
}

export interface ChatCompletionResult {
  /** The model's text. Empty only when `finishReason` is `length`: the model was cut off. */
  content: string
  finishReason: string | null
  provider: string | null
  /** The model OpenRouter says answered, as it names it -- a dated version where the provider has
   * one. A name like `openai/gpt-5-mini` can be pointed at a newer model on any day; this is what
   * a result was actually got from. Null when the response does not say. */
  servedModel: string | null
  usage: AiCallUsage
}

interface CompletionBody {
  model?: unknown
  provider?: unknown
  choices?: { finish_reason?: unknown; message?: { content?: unknown } }[]
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** One question, one answer.
 *
 * `require_parameters` restricts routing to providers that honour every parameter sent -- above
 * all the strict JSON schema. Without it OpenRouter may route to a provider that ignores
 * `response_format` and returns prose, which the validator then refuses after it has been paid
 * for. */
export async function chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
  const startedAt = performance.now()
  const body = (await send('/chat/completions', request.apiKey, {
    method: 'POST',
    signal: request.signal,
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      response_format: {
        type: 'json_schema',
        json_schema: { name: request.jsonSchema.name, strict: true, schema: request.jsonSchema.schema }
      },
      provider: { require_parameters: true },
      max_tokens: request.maxTokens,
      // With require_parameters above, a model that takes no reasoning effort has no provider to
      // go to and the call is refused before it is billed, rather than answered at full effort
      // under a name that says otherwise.
      ...(request.reasoningEffort !== undefined ? { reasoning: { effort: request.reasoningEffort } } : {})
    })
  })) as CompletionBody
  const latencyMs = Math.round(performance.now() - startedAt)

  const choice = body.choices?.[0]
  if (!choice) throw new OpenRouterError('The model returned no answer', 'transient', null)
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null
  if (finishReason === 'error') throw new OpenRouterError('The model failed part-way through its answer', 'transient', null)
  const content = typeof choice.message?.content === 'string' ? choice.message.content : ''
  // An empty answer is a failure UNLESS the model ran out of room: that one was generated, and
  // billed, and the caller has to be able to say so rather than quietly ask again.
  if (content === '' && finishReason !== 'length') {
    throw new OpenRouterError('The model returned an empty answer', 'transient', null)
  }

  const cost = body.usage?.cost
  return {
    content,
    finishReason,
    provider: typeof body.provider === 'string' ? body.provider : null,
    servedModel: typeof body.model === 'string' && body.model.trim() !== '' ? body.model.slice(0, 200) : null,
    usage: {
      promptTokens: count(body.usage?.prompt_tokens),
      completionTokens: count(body.usage?.completion_tokens),
      costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
      latencyMs
    }
  }
}

interface KeyBody {
  data?: { label?: unknown; usage?: unknown; limit?: unknown; limit_remaining?: unknown; is_free_tier?: unknown }
}

function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Asks OpenRouter about the key itself. Costs nothing, which is why it is how a key is verified:
 * a key can be proven valid before it is stored without spending a token to do it. */
export async function fetchKeyInfo(apiKey: string): Promise<AiKeyInfo> {
  const body = (await send('/key', apiKey, { method: 'GET', signal: AbortSignal.timeout(READ_TIMEOUT_MS) })) as KeyBody
  const data = body.data
  if (!data) throw new OpenRouterError('OpenRouter returned no key information', 'transient', null)
  return {
    label: typeof data.label === 'string' ? data.label : '',
    usageUsd: amount(data.usage) ?? 0,
    limitUsd: amount(data.limit),
    limitRemainingUsd: amount(data.limit_remaining),
    isFreeTier: data.is_free_tier === true
  }
}

interface ModelsBody {
  data?: {
    id?: unknown
    name?: unknown
    context_length?: unknown
    pricing?: { prompt?: unknown; completion?: unknown }
    supported_parameters?: unknown
  }[]
}

/** OpenRouter publishes prices as decimal strings in USD per token, and uses a negative value for
 * models with no fixed price. */
function price(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/** Every model OpenRouter offers, with what it costs and whether it can be held to a schema. Also
 * free to call. */
export async function fetchModelCatalogue(apiKey: string): Promise<AiModelInfo[]> {
  const body = (await send('/models', apiKey, { method: 'GET', signal: AbortSignal.timeout(READ_TIMEOUT_MS) })) as ModelsBody
  if (!Array.isArray(body.data)) throw new OpenRouterError('OpenRouter returned no model list', 'transient', null)
  const models: AiModelInfo[] = []
  for (const entry of body.data) {
    if (typeof entry.id !== 'string' || entry.id === '') continue
    const supported = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : []
    models.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id,
      contextLength: amount(entry.context_length),
      promptPricePerToken: price(entry.pricing?.prompt),
      completionPricePerToken: price(entry.pricing?.completion),
      structuredOutputs: supported.includes('structured_outputs'),
      reasoning: supported.includes('reasoning')
    })
  }
  return models.sort((a, b) => a.id.localeCompare(b.id))
}
