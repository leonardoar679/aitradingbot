# Should the strategy run this month? — the rule, fixed before the held-out symbols were scored

**Written and committed before `SET=confirm` was ever run.** Everything below comes from BTC, ETH,
SOL and ADA. BNB, LINK, LTC and XRP have not been looked at for this question.

## What the diagnosis found

`research/season.ts` computed ten published market-condition features from daily bars closing
strictly **before** each month opened, and bucketed the 36 independent months by each one. Four
features agree, across all three strategies, on a direction that is the **opposite of the textbook
expectation**:

| feature | Trend Regime | Short-Term Channel | Channel + Regime |
|---|---|---|---|
| Kaufman Efficiency Ratio | −11.8% | −12.1% | −9.9% |
| Choppiness Index | +9.4% | +9.5% | +8.9% |
| Wilder ADX(14) | −9.4% | −12.7% | −9.1% |
| strategy's own prior month | −9.2% | −8.8% | −10.7% |

(spread = mean return of the top bucket minus the bottom bucket)

Read together: **a quiet, choppy, weakly-trending, flat-or-down prior month predicts a good month.
A strong, efficient, high-ADX, high-return prior month predicts a poor one.** The conventional
advice — trade trend strategies when the trend is strong — is backwards here.

That is less surprising than it first looks. A breakout strategy earns its money when a *new* move
begins. High ADX means the move is already well advanced, so a breakout bought there is bought late.
Low ADX means the market is coiling, which is the classic pre-expansion setup — Crabel's narrow-range
work, Bollinger's squeeze, Minervini's volatility contraction. The finding is that these are
consolidation-breakout strategies whether or not they were designed as such.

## The uncomfortable part, and it is the main result

**No skip rule raises total profit. Not one, on any of the three strategies.** The best case is
Short-Term Channel under `ADX ≤ 25`, which still gives up $13,263 of the baseline's $50,909. Sitting
out removes profit along with risk, because the skipped months are net positive on average.

So if the question is *"how do I earn more over 36 months while always being in the market"*, the
answer from this data is: **you cannot do it by choosing months.** That is worth stating plainly
rather than burying, because it is the opposite of what a filter is supposed to deliver.

What the rules do instead is change the **quality of a deployed month**, dramatically:

| Short-Term Channel | months run | mean | median | win % | worst | sum of losing months |
|---|---|---|---|---|---|---|
| baseline | 144 | +3.5% | −0.4% | 47% | −29.3% | −$46,475 |
| ADX ≤ 25 | 55 | +6.8% | +0.5% | 53% | −13.3% | −$13,774 |
| ADX ≤ 25 **and** prev ≤ 0 | 32 | **+9.1%** | **+1.5%** | **63%** | **−13.3%** | **−$6,984** |

Losses fall by 85%, the win rate rises 16 points, the median month goes from negative to positive,
and the worst month more than halves.

**Which of those two framings is right depends on the capital, and that is the user's call, not
mine.** If the $10,000 must be working every month, the filter costs money. If it is deployed a
month at a time and can simply sit in cash — the framing the 36-independent-month test was built
around — then a skipped month costs nothing at all, and the filter roughly triples the expected
return of every month actually entered.

## The rule, fixed here

**Run the strategy this month only if both hold, measured on the last daily close before the 1st:**

1. **Wilder ADX(14) ≤ 25** — Wilder's own published boundary for "not a trending market", not a cut
   fitted to this sample.
2. **The strategy's previous calendar month returned ≤ 0** — a zero threshold, also not fitted.

Chosen over the alternatives because it is best or near-best on all three strategies at once
(discovery means: Trend Regime +8.7%, Short-Term Channel +9.1%, Channel + Regime +8.5%) and because
both thresholds are given rather than chosen. `ADX ≤ 20` scores marginally better on Trend Regime
alone and worse on the other two.

## What would count as confirmation

Scored once on **BNB, LINK, LTC, XRP**, which have taken no part in any of the above. The rule
confirms only if, for **all three** strategies, against the same symbols' baseline:

1. mean return per deployed month is **higher**, and
2. the summed dollar loss of losing months is **smaller**, and
3. the win rate is **not lower**.

Failing any of the three on any strategy is a failure, recorded as one. There is no tie-break and no
partial credit, because the discovery effect is large enough that a real one should survive a strict
test — and because eight rules were compared to find this one, which is exactly the situation where
a weak criterion manufactures a winner.

**Total profit is expected to fall on the confirmation set too.** That is not a failure of the rule;
it is the rule doing what it does. It is written down here so it cannot later be presented as a
surprise or explained away.

## Result: REJECTED. The rule failed confirmation on all three strategies.

Scored once on BNB, LINK, LTC and XRP. Criterion 1 — mean return per deployed month must be
*higher* than baseline — fails everywhere:

| | baseline mean | rule mean | verdict |
|---|---|---|---|
| Trend Regime | +2.1% | **+0.8%** | worse |
| Short-Term Channel | +1.4% | +1.4% | equal, not higher |
| Channel + Regime | +1.6% | +1.6% | equal, not higher |

The rule did cut losses hard (−$61,119 → −$21,455 on Trend Regime, −$57,847 → −$18,282 on the
channel) and lifted Short-Term Channel's win rate from 39% to 43%. It still fails, because the
criterion was all three conditions on all three strategies and was written down in advance
precisely so that a partial pass could not be talked into a success.

**The ADX half did not merely weaken — it inverted.** That is the finding worth keeping:

| ADX ≤ 25, mean month | discovery | confirmation |
|---|---|---|
| Trend Regime | +7.1% (vs +4.6% base) | **−0.8%** (vs +2.1% base) |
| Short-Term Channel | +6.8% (vs +3.5%) | **+0.3%** (vs +1.4%) |
| Channel + Regime | +6.3% (vs +4.1%) | **+0.5%** (vs +1.6%) |

On the four symbols it was found on, low ADX marked the best months by a wide margin. On four
symbols it had never seen, it marks the *worst* ones. A sign flip is not a weak effect; it is the
signature of a pattern that was never there. Kaufman's Efficiency Ratio inverts the same way
(+3.9%/+3.4%/+3.7% on discovery, −0.9%/+0.3%/−0.4% on confirmation), which is consistent — the two
measure nearly the same thing.

So the headline from `season.ts` — that a quiet, weakly-trending prior month predicts a good one —
**does not survive contact with held-out symbols.** Four indicators agreeing with each other is not
four pieces of evidence when they are all computing trend strength from the same prices.

## One thing survived, and it cannot be claimed from this data

`prev month ≤ 0` — run only after a flat or losing month — raised the mean on **all three
strategies in both halves**, and was the only rule to raise *total profit* on the confirmation set:

| | discovery mean | confirmation mean | confirmation total |
|---|---|---|---|
| Trend Regime | +5.2% (vs +4.6%) | +3.0% (vs +2.1%) | +$32,520 (vs +$30,586) |
| Short-Term Channel | +4.4% (vs +3.5%) | +2.6% (vs +1.4%) | +$23,557 (vs +$20,183) |
| Channel + Regime | +5.6% (vs +4.1%) | +2.4% (vs +1.6%) | +$25,678 (vs +$23,504) |

**This is not a confirmed result and must not be reported as one.** The rule that was pre-registered
was `ADX ≤ 25 AND prev ≤ 0`. Picking out the half that worked, after seeing the confirmation set, is
exactly the move the split exists to prevent — the confirmation symbols are now spent for this
question, and re-scoring them against a rule chosen from their own output would be circular.

It is promising enough to deserve a real test, so it gets one on data neither half has touched: the
**48 months from 2019-09 to 2023-08**, before the window every result in this repository is drawn
from. See `research/PRIORMONTH.md`.
