import { forecastProposal, type AiOrderProposal } from '../../shared/aiProposal'
import type { PricePrediction } from '../../shared/forecast/prediction'
import { planValid, tradePlanOf, type TargetLevel, type TradePlan } from '../../shared/forecast/tradePlan'
import { reasonText, type TradeDecision } from '../../shared/forecast/tradeDecision'
import { ENGLISH, type I18n } from '../../shared/i18n/translate'

// TRADE THIS (the V6 document, §107-108; V6 Stage 12, 13 October 2026): a TRADE decision's plan, from the
// live price, filled into the Position form -- paper until a person makes it otherwise there, a sell
// paper only -- or, where there is no plan to fill in, why not. It fills in a form; a person places it.

export function tradeThisOf(
  input: {
    prediction: PricePrediction
    decision: TradeDecision | null | undefined
    livePrice: number | null
    targetLevel: TargetLevel
    nowSec: number
  },
  i18n: I18n = ENGLISH
): { proposal: AiOrderProposal; plan: TradePlan } | { problem: string } {
  const { t } = i18n
  const { prediction, decision } = input
  if (decision === null || decision === undefined) return { problem: t('No decision yet.') }
  if (decision.decision !== 'TRADE') {
    const first = decision.reasons[0]
    return { problem: t('NO TRADE: {reason}', { reason: first === undefined ? t('it is not worth trading.') : reasonText(first, decision.horizon, i18n) }) }
  }
  if (input.livePrice === null || !(input.livePrice > 0)) return { problem: t('No live price: the plan is read from it.') }
  const plan = tradePlanOf({ decision, prediction, livePrice: input.livePrice, atr5mPct: prediction.market?.atr5mPct ?? null, targetLevel: input.targetLevel })
  if (plan === null) return { problem: t('From the live price its {level} target does not clear a round trip.', { level: input.targetLevel }) }
  if (!planValid(plan, input.livePrice, input.nowSec)) return { problem: t('Its plan no longer holds: the next close has come, or the price has left its zone.') }
  const range = prediction.horizons[decision.horizon]
  const confidence = range === undefined ? 0.5 : plan.side === 'BUY' ? range.pUp : 1 - range.pUp
  return { proposal: forecastProposal({ plan, confidence, barTime: prediction.barTime }), plan }
}
