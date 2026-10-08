import { describeOpportunitySide, isActionableOpportunity, opportunityConsensus, opportunitySide, type OpportunityConsensus, type OpportunitySide } from './aiOpportunity'
import type { AiSignalDecision } from './aiSignal'

// THE VOTE THAT ACTS (the V5 document, §39; V5 Stage 5, 8 October 2026). When the watch asks two
// or more models about one event, its paper trade follows what the answers add up to
// (shared/aiOpportunity.ts opportunityConsensus: more than half of the usable answers on one side,
// and none on the other) and not any one model. The plan traded is the agreeing model's with the
// highest confidence. A split -- models on opposite sides, or no side with more than half -- is no
// trade, written down as a refusal and, when the sides are opposite, told (MODEL_DISAGREEMENT).
// With one model asked, nothing here applies: the paper trade follows that model, as it always has.
//
// The rule is deterministic and reads the answers alone. Whether a vote earns more than one model
// is what the Research tab's agreement table measures (shared/research/agreementValue.ts).

export interface OpportunityVote {
  consensus: OpportunityConsensus
  /** The side the answers add up to; null when they add up to no trade, or to a split. */
  side: OpportunitySide | null
  /** The decision the paper trade follows: on the side taken, the highest confidence. */
  chosen: AiSignalDecision | null
  /** Why no trade follows, in words; null when one does. */
  refusal: string | null
  /** "BUY 2/3": the side and how many of the usable answers took it. */
  text: string
}

function sideWord(side: OpportunitySide | 'no_trade'): string {
  return side === 'no_trade' ? 'NO TRADE' : describeOpportunitySide(side)
}

/** The answers of several models to one event, counted. A side taken below the confidence this
 * app acts on is counted as no trade, as the watch would read it alone; a refused or failed
 * answer is not usable. */
export function voteOf(decisions: (AiSignalDecision | null | undefined)[]): OpportunityVote {
  const counted = decisions.map((decision) =>
    decision && decision.error === null && !decision.rejected && !isActionableOpportunity(decision) ? { ...decision, recommendation: 'hold' as const, detail: null } : decision
  )
  const consensus = opportunityConsensus(counted)
  const usable = consensus.long + consensus.short + consensus.noTrade
  const tally = [
    consensus.long > 0 ? `${consensus.long} BUY` : null,
    consensus.short > 0 ? `${consensus.short} SELL` : null,
    consensus.noTrade > 0 ? `${consensus.noTrade} NO TRADE` : null
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
  if (consensus.call === 'long' || consensus.call === 'short') {
    const onSide = decisions.filter((decision): decision is AiSignalDecision => isActionableOpportunity(decision) && decision !== null && opportunitySide(decision) === consensus.call)
    const chosen = onSide.reduce<AiSignalDecision | null>((best, decision) => (best === null || decision.confidence > best.confidence ? decision : best), null)
    const taking = consensus.call === 'long' ? consensus.long : consensus.short
    return { consensus, side: consensus.call, chosen, refusal: null, text: `${sideWord(consensus.call)} ${taking}/${usable}` }
  }
  if (usable === 0) return { consensus, side: null, chosen: null, refusal: 'No model gave a usable answer.', text: 'no usable answer' }
  if (consensus.disagreement) return { consensus, side: null, chosen: null, refusal: `Models split: ${tally}.`, text: `split ${tally}` }
  if (consensus.long > 0 || consensus.short > 0) return { consensus, side: null, chosen: null, refusal: `Models did not agree: ${tally}.`, text: `no majority ${tally}` }
  return { consensus, side: null, chosen: null, refusal: null, text: `NO TRADE ${consensus.noTrade}/${usable}` }
}
