import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AI_EFFORTS,
  aiEffortOf,
  aiModelSlugOf,
  describeAiModelId,
  effortIdFor,
  isAiModelId,
  splitAiModelId
} from '../shared/aiEffort'
import { deciderCalls, deciderModel, describeDecider, panelModelOf } from '../shared/aiPanel'
import { parseAiRoute } from '../shared/aiRoute'

// A MODEL ASKED TO THINK LESS IS A SECOND COMPETITOR, NOT A KNOB.
//
// `vendor/model@low` is filed, priced-by-history, benchmarked and pinned as its own model, because
// whether it answers as well as the model at its default is exactly what has to be measured. What
// these pin is the two places the id is taken apart -- the request and the price list -- and that
// nowhere else can an effort slip in unannounced or be read as the plain model.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))
vi.mock('../electron/services/aiCredentialsService', () => ({
  getDecryptedAiCredential: async () => ({ apiKey: 'sk-or-test' })
}))

const MINI = 'openai/gpt-5-mini'
const LOW = 'openai/gpt-5-mini@low'

describe('an id with an effort', () => {
  it('is the model and the effort, and a plain id is the model at its own default', () => {
    expect(splitAiModelId(MINI)).toEqual({ slug: MINI, effort: null })
    expect(splitAiModelId(LOW)).toEqual({ slug: MINI, effort: 'low' })
    expect(splitAiModelId('openai/gpt-5-mini@minimal')).toEqual({ slug: MINI, effort: 'minimal' })
    expect(effortIdFor(MINI, 'low')).toBe(LOW)
    expect(aiModelSlugOf(LOW)).toBe(MINI)
    expect(aiEffortOf(LOW)).toBe('low')
    expect(aiEffortOf(MINI)).toBeNull()
    // OpenRouter's own variant suffix stays part of the model.
    expect(splitAiModelId('meta-llama/llama-3.3-70b-instruct:free@low')).toEqual({ slug: 'meta-llama/llama-3.3-70b-instruct:free', effort: 'low' })
  })

  it('offers only efforts that ask for less thought than the default', () => {
    expect([...AI_EFFORTS]).toEqual(['low', 'minimal'])
  })

  it('is refused whole when the effort is not one on offer, rather than read as the plain model', () => {
    // "@turbo" silently treated as the model at its default would bill default-effort calls under
    // a name that says otherwise.
    for (const id of ['openai/gpt-5-mini@turbo', 'openai/gpt-5-mini@', 'openai/gpt-5-mini@low@low', '@low', 'openai/gpt-5-mini@LOW']) {
      expect(isAiModelId(id), id).toBe(false)
    }
    expect(splitAiModelId('openai/gpt-5-mini@turbo')).toEqual({ slug: 'openai/gpt-5-mini@turbo', effort: null })
    expect(isAiModelId(MINI)).toBe(true)
    expect(isAiModelId(LOW)).toBe(true)
  })

  it('is said as what it is', () => {
    expect(describeAiModelId(MINI)).toBe(MINI)
    expect(describeAiModelId(LOW)).toBe('openai/gpt-5-mini at low effort')
    expect(describeDecider(LOW)).toBe('openai/gpt-5-mini at low effort')
  })

  it('can carry a panel, and be the second step of a route', () => {
    expect(panelModelOf(`panel:${LOW}`)).toBe(LOW)
    expect(deciderModel(`panel:${LOW}`)).toBe(LOW)
    expect(deciderCalls(`panel:${LOW}`)).toBe(4)
    expect(describeDecider(`panel:${LOW}`)).toBe('the agent panel on openai/gpt-5-mini at low effort')
    expect(panelModelOf('panel:openai/gpt-5-mini@turbo')).toBeNull()
    expect(parseAiRoute({ model: LOW, when: 'acting' })).toEqual({ model: LOW, when: 'acting' })
    expect(parseAiRoute({ model: `panel:${LOW}`, when: 'unsure' })).toEqual({ model: `panel:${LOW}`, when: 'unsure' })
    expect(() => parseAiRoute({ model: 'openai/gpt-5-mini@turbo', when: 'acting' })).toThrow(/not a valid model id/)
  })
})

describe('enabling a model at an effort', () => {
  let dir: string

  const listed = (id: string, reasoning: boolean, structuredOutputs = true): Record<string, unknown> => ({
    id,
    name: id,
    contextLength: 400_000,
    promptPricePerToken: 0.00000025,
    completionPricePerToken: 0.000002,
    structuredOutputs,
    reasoning
  })

  function writeCatalogue(models: Record<string, unknown>[], fetchedAt = Math.floor(Date.now() / 1000)): void {
    writeFileSync(join(dir, 'aiModels.json'), JSON.stringify({ fetchedAt, models }))
  }

  async function config() {
    return import('../electron/services/aiConfigService')
  }

  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'ai-effort-'))
    process.env.AI_TEST_USER_DATA = dir
  })

  afterEach(() => vi.unstubAllGlobals())

  it('takes a model that reasons, and can make it the default', async () => {
    writeCatalogue([listed(MINI, true)])
    const { setAiConfig } = await config()
    expect((await setAiConfig({ enabledModels: [MINI, LOW] })).enabledModels).toEqual([MINI, LOW])
    expect((await setAiConfig({ defaultModel: LOW })).defaultModel).toBe(LOW)
  })

  it('refuses a model that takes no effort, an effort not on offer, and a model that is not listed', async () => {
    writeCatalogue([listed(MINI, true), listed('acme/plain', false), listed('acme/prose', true, false)])
    const { setAiConfig, getAiConfig } = await config()
    // Asked at an effort it does not take, a model has no provider to go to: better said here than
    // on the first paid call of a run.
    await expect(setAiConfig({ enabledModels: [MINI, 'acme/plain@low'] })).rejects.toThrow(/does not take a reasoning effort/)
    await expect(setAiConfig({ enabledModels: [MINI, 'openai/gpt-5-mini@turbo'] })).rejects.toThrow(/not a valid model id/)
    await expect(setAiConfig({ enabledModels: [MINI, 'ghost/model@low'] })).rejects.toThrow(/ghost\/model is not in the model catalogue/)
    await expect(setAiConfig({ enabledModels: [MINI, 'acme/prose@low'] })).rejects.toThrow(/strict JSON schema/)
    expect((await getAiConfig()).enabledModels).toEqual([MINI])
  })

  it('prices it from the one entry the model has', async () => {
    writeCatalogue([listed(MINI, true)])
    const { findAiModel } = await config()
    expect(await findAiModel(LOW)).toMatchObject({ id: MINI, promptPricePerToken: 0.00000025 })
    expect(await findAiModel('ghost/model@low')).toBeNull()
  })

  it('a panel on it needs IT enabled, not just the model', async () => {
    writeCatalogue([listed(MINI, true)])
    const { resolveAiDecider, setAiConfig } = await config()
    await expect(resolveAiDecider(`panel:${LOW}`)).rejects.toThrow(/openai\/gpt-5-mini@low is not enabled/)
    await setAiConfig({ enabledModels: [MINI, LOW] })
    expect(await resolveAiDecider(`panel:${LOW}`)).toBe(`panel:${LOW}`)
  })

  it('keeps an older price list for its prices, and replaces it at the next free listing', async () => {
    // A list stored before models carried `reasoning`. It still prices a call, but it cannot say
    // which models take an effort, so it must not be trusted for a day on that.
    const old = { id: MINI, name: MINI, contextLength: 400_000, promptPricePerToken: 0.00000025, completionPricePerToken: 0.000002, structuredOutputs: true }
    writeCatalogue([old])
    let listings = 0
    vi.stubGlobal('fetch', async () => {
      listings++
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ data: [{ id: MINI, name: 'GPT-5 Mini', pricing: { prompt: '0.00000025', completion: '0.000002' }, supported_parameters: ['structured_outputs', 'reasoning'] }] })
      }
    })
    const { findAiModel, listAiModels, setAiConfig } = await config()
    expect(await findAiModel(MINI)).toMatchObject({ promptPricePerToken: 0.00000025, reasoning: false })
    await expect(setAiConfig({ enabledModels: [MINI, LOW] })).rejects.toThrow(/does not take a reasoning effort/)

    const fresh = await listAiModels(false)
    expect(listings).toBe(1)
    expect(fresh.models[0]).toMatchObject({ id: MINI, reasoning: true })
    expect((await setAiConfig({ enabledModels: [MINI, LOW] })).enabledModels).toEqual([MINI, LOW])
    // A current list is not fetched again.
    await listAiModels(false)
    expect(listings).toBe(1)
  })
})
