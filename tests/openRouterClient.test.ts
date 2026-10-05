import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OPENROUTER_BASE_URL,
  OpenRouterError,
  chatCompletion,
  fetchKeyInfo,
  fetchModelCatalogue,
  parseRetryAfter
} from '../electron/services/openRouterClient'

// The transport, against a stubbed fetch. Nothing here reaches OpenRouter: the shapes below are
// the ones its documentation describes, and a call that really spent would be a test that costs
// money every time the suite runs.

interface Seen {
  url: string
  init: RequestInit
}

function stubFetch(reply: (seen: Seen) => { status?: number; body: unknown } | Promise<never>): Seen[] {
  const calls: Seen[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const seen = { url, init }
    calls.push(seen)
    const { status = 200, body } = await reply(seen)
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    }
  })
  return calls
}

const REQUEST = {
  apiKey: 'sk-or-test',
  model: 'openai/gpt-5-mini',
  messages: [
    { role: 'system' as const, content: 'system' },
    { role: 'user' as const, content: '{}' }
  ],
  jsonSchema: { name: 'intraday_signal', schema: { type: 'object' } },
  maxTokens: 3000,
  signal: new AbortController().signal
}

function completion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'OpenAI',
    choices: [{ finish_reason: 'stop', message: { content: '{"recommendation":"hold"}' } }],
    usage: { prompt_tokens: 1500, completion_tokens: 420, cost: 0.0021 },
    ...overrides
  }
}

async function failure(run: Promise<unknown>): Promise<OpenRouterError> {
  try {
    await run
  } catch (error) {
    if (error instanceof OpenRouterError) return error
    throw error
  }
  throw new Error('expected the call to fail')
}

afterEach(() => vi.unstubAllGlobals())

describe('chatCompletion', () => {
  it('asks for a strict schema and refuses providers that would ignore it', async () => {
    const calls = stubFetch(() => ({ body: completion() }))
    await chatCompletion(REQUEST)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`)
    expect(calls[0].init.method).toBe('POST')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test')

    const body = JSON.parse(calls[0].init.body as string)
    expect(body.model).toBe('openai/gpt-5-mini')
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'intraday_signal', strict: true, schema: { type: 'object' } }
    })
    // Without this OpenRouter may route to a provider that drops response_format and returns
    // prose, which is then paid for and refused.
    expect(body.provider).toEqual({ require_parameters: true })
    expect(body.max_tokens).toBe(3000)
  })

  it('sends no reasoning parameter unless an effort is named, and the effort when one is', async () => {
    const calls = stubFetch(() => ({ body: completion() }))
    await chatCompletion(REQUEST)
    // The request every answer cached before efforts existed was made with: unchanged, key for key.
    expect(Object.keys(JSON.parse(calls[0].init.body as string)).sort()).toEqual(['max_tokens', 'messages', 'model', 'provider', 'response_format'])

    await chatCompletion({ ...REQUEST, reasoningEffort: 'low' })
    const body = JSON.parse(calls[1].init.body as string)
    expect(body.reasoning).toEqual({ effort: 'low' })
    // The model is still asked for by the id OpenRouter knows it by.
    expect(body.model).toBe('openai/gpt-5-mini')
    expect(body.provider).toEqual({ require_parameters: true })
  })

  it('reports what the call consumed, including what it was charged', async () => {
    stubFetch(() => ({ body: completion() }))
    const result = await chatCompletion(REQUEST)
    expect(result.content).toBe('{"recommendation":"hold"}')
    expect(result.provider).toBe('OpenAI')
    expect(result.finishReason).toBe('stop')
    expect(result.usage.promptTokens).toBe(1500)
    expect(result.usage.completionTokens).toBe(420)
    expect(result.usage.costUsd).toBe(0.0021)
    expect(result.usage.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('leaves the cost unknown rather than calling it zero when none is reported', async () => {
    stubFetch(() => ({ body: completion({ usage: { prompt_tokens: 10, completion_tokens: 5 } }) }))
    expect((await chatCompletion(REQUEST)).usage.costUsd).toBeNull()
  })

  // The split that stops a dead key being retried for every candle of a run.
  it.each([
    [401, 'fatal'],
    [402, 'fatal'],
    [403, 'fatal'],
    [400, 'fatal'],
    [404, 'fatal'],
    [408, 'transient'],
    [429, 'transient'],
    [502, 'transient'],
    [503, 'transient']
  ])('treats HTTP %i as %s', async (status, kind) => {
    stubFetch(() => ({ status, body: { error: { code: status, message: 'details from OpenRouter' } } }))
    const error = await failure(chatCompletion(REQUEST))
    expect(error.kind).toBe(kind)
    expect(error.status).toBe(status)
    expect(error.message).toContain('details from OpenRouter')
  })

  it('reads a 200 whose body is only an error as the failure it is', async () => {
    // What a provider failing after OpenRouter accepted the request looks like. Read as a normal
    // response it has no choices, and would be reported as "no answer" instead of "no credit".
    stubFetch(() => ({ status: 200, body: { error: { code: 402, message: 'Insufficient credits' } } }))
    const error = await failure(chatCompletion(REQUEST))
    expect(error.kind).toBe('fatal')
    expect(error.message).toContain('Insufficient credits')
  })

  it('treats an unreachable network as worth trying again', async () => {
    stubFetch(() => Promise.reject(new Error('getaddrinfo ENOTFOUND openrouter.ai')))
    const error = await failure(chatCompletion(REQUEST))
    expect(error.kind).toBe('transient')
    expect(error.message).toContain('could not be reached')
  })

  it('returns a cut-off answer instead of throwing, because it was billed', async () => {
    stubFetch(() => ({ body: completion({ choices: [{ finish_reason: 'length', message: { content: null } }] }) }))
    const result = await chatCompletion(REQUEST)
    expect(result.finishReason).toBe('length')
    expect(result.content).toBe('')
  })

  it('treats an empty answer that was not cut off as a failed call', async () => {
    stubFetch(() => ({ body: completion({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }) }))
    expect((await failure(chatCompletion(REQUEST))).kind).toBe('transient')
    stubFetch(() => ({ body: completion({ choices: [] }) }))
    expect((await failure(chatCompletion(REQUEST))).kind).toBe('transient')
    stubFetch(() => ({ body: completion({ choices: [{ finish_reason: 'error', message: { content: 'partial' } }] }) }))
    expect((await failure(chatCompletion(REQUEST))).kind).toBe('transient')
  })

  it('says which version of the model answered, as OpenRouter names it, when it says', async () => {
    stubFetch(() => ({ body: completion({ model: 'openai/gpt-5-mini-2025-08-07' }) }))
    expect((await chatCompletion(REQUEST)).servedModel).toBe('openai/gpt-5-mini-2025-08-07')
    // Not said, or not a name: not invented.
    stubFetch(() => ({ body: completion() }))
    expect((await chatCompletion(REQUEST)).servedModel).toBeNull()
    stubFetch(() => ({ body: completion({ model: 42 }) }))
    expect((await chatCompletion(REQUEST)).servedModel).toBeNull()
    stubFetch(() => ({ body: completion({ model: '  ' }) }))
    expect((await chatCompletion(REQUEST)).servedModel).toBeNull()
  })

  it("carries a refusal's Retry-After, in milliseconds", async () => {
    const withHeaders = (status: number, retryAfter: string | null): void => {
      vi.stubGlobal('fetch', async () => ({
        ok: false,
        status,
        headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
        text: async () => JSON.stringify({ error: { code: status, message: 'slow down' } })
      }))
    }
    withHeaders(429, '7')
    expect(await failure(chatCompletion(REQUEST))).toMatchObject({ kind: 'transient', status: 429, retryAfterMs: 7000 })
    withHeaders(503, null)
    expect((await failure(chatCompletion(REQUEST))).retryAfterMs).toBeNull()
    // A response with no headers at all is read as one that said nothing.
    stubFetch(() => ({ status: 429, body: { error: { code: 429, message: 'slow down' } } }))
    expect((await failure(chatCompletion(REQUEST))).retryAfterMs).toBeNull()
  })
})

describe('parseRetryAfter', () => {
  const NOW = Date.parse('2026-10-05T03:00:00Z')

  it('reads whole seconds, and a date to wait until', () => {
    expect(parseRetryAfter('0', NOW)).toBe(0)
    expect(parseRetryAfter('12', NOW)).toBe(12_000)
    expect(parseRetryAfter(' 3 ', NOW)).toBe(3000)
    expect(parseRetryAfter('Mon, 05 Oct 2026 03:00:30 GMT', NOW)).toBe(30_000)
    // A date already past is no wait, never a negative one.
    expect(parseRetryAfter('Mon, 05 Oct 2026 02:59:00 GMT', NOW)).toBe(0)
  })

  it('is nothing for nothing, and for what it cannot read', () => {
    for (const value of [null, undefined, '', '   ', 'soon', '-5', '1.5']) expect(parseRetryAfter(value, NOW)).toBeNull()
  })
})

describe('fetchKeyInfo', () => {
  it('asks about the key itself, which costs nothing', async () => {
    const calls = stubFetch(() => ({
      body: { data: { label: 'sk-or-...abc', usage: 1.25, limit: 10, limit_remaining: 8.75, is_free_tier: false } }
    }))
    const info = await fetchKeyInfo('sk-or-test')
    expect(calls[0].url).toBe(`${OPENROUTER_BASE_URL}/key`)
    expect(calls[0].init.method).toBe('GET')
    expect(info).toEqual({ label: 'sk-or-...abc', usageUsd: 1.25, limitUsd: 10, limitRemainingUsd: 8.75, isFreeTier: false })
  })

  it('keeps "no limit on this key" distinct from "nothing left"', async () => {
    stubFetch(() => ({ body: { data: { label: 'k', usage: 0, limit: null, limit_remaining: null, is_free_tier: true } } }))
    const info = await fetchKeyInfo('sk-or-test')
    expect(info.limitUsd).toBeNull()
    expect(info.limitRemainingUsd).toBeNull()
  })

  it('refuses a bad key as fatal, so it is never stored', async () => {
    stubFetch(() => ({ status: 401, body: { error: { code: 401, message: 'No auth credentials found' } } }))
    expect((await failure(fetchKeyInfo('nope'))).kind).toBe('fatal')
  })
})

describe('fetchModelCatalogue', () => {
  it('reads prices as numbers and marks which models can be held to a schema', async () => {
    stubFetch(() => ({
      body: {
        data: [
          {
            id: 'openai/gpt-5-mini',
            name: 'GPT-5 Mini',
            context_length: 400000,
            pricing: { prompt: '0.00000025', completion: '0.000002' },
            supported_parameters: ['max_tokens', 'structured_outputs', 'response_format']
          },
          {
            id: 'acme/prose-only',
            name: 'Prose Only',
            context_length: 8192,
            pricing: { prompt: '0.000001', completion: '0.000001' },
            supported_parameters: ['max_tokens']
          },
          // No fixed price is published as a negative number.
          { id: 'openrouter/auto', name: 'Auto', pricing: { prompt: '-1', completion: '-1' } },
          { name: 'no id, so not a model' }
        ]
      }
    }))
    const models = await fetchModelCatalogue('sk-or-test')
    expect(models.map((model) => model.id)).toEqual(['acme/prose-only', 'openai/gpt-5-mini', 'openrouter/auto'])

    const mini = models.find((model) => model.id === 'openai/gpt-5-mini')!
    expect(mini.promptPricePerToken).toBe(0.00000025)
    expect(mini.completionPricePerToken).toBe(0.000002)
    expect(mini.structuredOutputs).toBe(true)
    expect(mini.contextLength).toBe(400000)

    expect(models.find((model) => model.id === 'acme/prose-only')!.structuredOutputs).toBe(false)
    const auto = models.find((model) => model.id === 'openrouter/auto')!
    expect(auto.promptPricePerToken).toBeNull()
    expect(auto.structuredOutputs).toBe(false)
  })

  it('marks which models take a reasoning effort', async () => {
    stubFetch(() => ({
      body: {
        data: [
          { id: 'a/thinks', supported_parameters: ['structured_outputs', 'reasoning'] },
          { id: 'b/plain', supported_parameters: ['structured_outputs'] },
          { id: 'c/unlisted' }
        ]
      }
    }))
    const models = await fetchModelCatalogue('sk-or-test')
    expect(models.map((model) => [model.id, model.reasoning])).toEqual([
      ['a/thinks', true],
      ['b/plain', false],
      ['c/unlisted', false]
    ])
  })
})
