import { AI_ADDITION_PROMPT_VERSIONS, ARTICLE_READING_LINES, articleCallsOf, articleQuestionOf, validateArticleReading, type ArticleReadingResult } from '../../shared/aiAdditions'
import { SOURCE_RECORD_VERSION, dayUnitOf, sourcePredictionId, type SourcePrediction } from '../../shared/evaluation/predictionRecord'
import { additionCacheKey, askAddition } from './aiAdditionsService'
import { getEffectiveConfig } from './effectiveConfigService'
import { livePriceOf, noteArticleReading, urlRecordOf } from './newsUrlService'
import { recordSourcePrediction } from './predictionLedgerService'

// THE ARTICLE READING, ASKED (V8 Stage 5, 26 October 2026; shared/aiAdditions.ts). Only on a click on News URLs, never
// by itself: the record is read here by its id and the question built from it -- the article's passages as the app
// read them, and the coins its rules found -- never handed in by the window. It is asked as every addition is: its
// switch, its twenty a day, the day's budget immediately before the request, the pace, the validator after it, the
// cache and a ledger row either way (aiAdditionsService.ts). A fresh answer's size calls are recorded as the article
// source's predictions on the subject's pair at its price once answered, settled from the venue's bars as every
// source's are; and the record notes the reading, its ledger row and its calls. Nothing here trades, sizes or arms
// anything, and nothing but News URLs' own panel and the prediction record reads a reading.

export const ARTICLE_SOURCE = 'article'

/** What the service reads and writes through: a test hands in its own. */
export const aiArticleSeam = {
  now: (): number => Math.floor(Date.now() / 1000),
  record: urlRecordOf,
  price: livePriceOf,
  note: noteArticleReading,
  versions: async (): Promise<{ engine: string; config: string }> => {
    const config = await getEffectiveConfig()
    return { engine: config.engineVersion, config: config.configVersion }
  },
  recordPrediction: recordSourcePrediction
}

/** A record's article, read by the deciding model on a person's click. */
export async function readArticle(id: unknown): Promise<ArticleReadingResult> {
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw new Error('A link on file is named by its record id.')
  const record = await aiArticleSeam.record(id)
  if (record === null) throw new Error('That link is not on file.')
  const question = articleQuestionOf(record, aiArticleSeam.now())
  if (question === null) return { asked: false, outcome: null, predictionIds: [], note: 'Nothing of the article was read, so there is nothing to put to a model.' }
  const subject = question.subject === null ? null : (record.coins.find((coin) => coin.ticker === question.subject) ?? null)
  const outcome = await askAddition({
    kind: 'article',
    subjectId: record.id,
    symbol: subject?.pair ?? 'NEWS',
    candleTime: question.askedAt,
    payload: question,
    automatic: false,
    validate: (value) => {
      const checked = validateArticleReading(value, question)
      return checked.ok ? { ok: true, answer: checked.reading } : checked
    }
  })

  const predictionIds: string[] = []
  let note: string | null = null
  // An answer held was given, and its calls recorded, when it was first had.
  if (outcome.status === 'answered' && !outcome.cached && subject !== null) {
    const calls = articleCallsOf(outcome.answer, question)
    if (calls.length > 0) {
      // The calls speak from when they were answered: the price is read then, and the outcome from the minute after.
      const madeAt = aiArticleSeam.now()
      const price = await aiArticleSeam.price(subject)
      if (price === null) note = `Its size calls were not recorded: no price of ${subject.pair} was read when it answered.`
      else {
        const versions = await aiArticleSeam.versions().catch(() => ({ engine: 'unknown', config: 'unknown' }))
        const rowId = additionCacheKey('article', outcome.model, question)
        for (const call of calls) {
          const prediction: SourcePrediction = {
            v: SOURCE_RECORD_VERSION,
            id: sourcePredictionId(ARTICLE_SOURCE, subject.pair, madeAt, ARTICLE_READING_LINES.calls.findIndex((line) => line.key === call.key) + 1),
            source: ARTICLE_SOURCE,
            sourceVersion: `${AI_ADDITION_PROMPT_VERSIONS.article}@${outcome.model}`,
            kind: 'size',
            pair: subject.pair,
            venue: subject.venue,
            madeAt,
            bar: null,
            horizonSec: call.horizonSec,
            refPrice: price,
            side: null,
            movePct: call.movePct,
            targetPrice: null,
            window: null,
            dist: { pRight: null, q: null, pMove: null },
            scenarios: null,
            cost: null,
            expectedNet: null,
            reason: outcome.answer.summary,
            evidence: [record.id, rowId],
            unit: dayUnitOf(madeAt),
            versions
          }
          try {
            await aiArticleSeam.recordPrediction(prediction)
            predictionIds.push(prediction.id)
          } catch (error) {
            note = `A size call could not be recorded: ${error instanceof Error ? error.message : String(error)}`
          }
        }
      }
    }
  }

  // Asked and answered, on the record's trail: a fresh answer, a refusal or a call with no answer. Nothing asked, or an
  // answer held, adds nothing.
  const fresh = outcome.status === 'failed' || ((outcome.status === 'answered' || outcome.status === 'refused') && !outcome.cached)
  if (fresh) {
    const calls = predictionIds.length === 0 ? '' : predictionIds.length === 1 ? '; one size call recorded' : `; ${predictionIds.length} size calls recorded`
    const text =
      outcome.status === 'answered'
        ? `Read by ${outcome.model}${calls}.`
        : outcome.status === 'refused'
          ? `A reading by ${outcome.model} was refused: ${outcome.reason}`
          : `A reading was asked and no answer came: ${outcome.status === 'failed' ? outcome.reason : ''}`
    await aiArticleSeam
      .note(record.id, { analysisId: outcome.status === 'answered' ? additionCacheKey('article', outcome.model, question) : null, predictionIds, text })
      .catch((error) => console.error("A news link's reading could not be noted on its record:", error))
  }
  return { asked: true, outcome, predictionIds, note }
}
