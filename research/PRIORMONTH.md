# Run only after a flat or losing month — tested on years no result in this repo has used

**Written and committed before the 2019–2023 run existed.** The window below has never been scored
by anything in this repository.

## Why this needs a fresh window rather than another symbol split

`research/GONOGO.md` pre-registered `ADX ≤ 25 AND prev ≤ 0` and it failed: the ADX half inverted its
sign on held-out symbols. But the *other* half — run only when the strategy's previous calendar month
was flat or down — raised the mean month on all three strategies in **both** halves, and was the only
rule to raise total profit on the confirmation set.

That cannot be claimed from those runs. It was not the rule that was registered, and picking the
surviving half after seeing the confirmation output is precisely the move a discovery/confirmation
split exists to prevent. BNB, LINK, LTC and XRP are **spent** for this question: re-scoring them
against a rule chosen from their own output would be circular no matter how the result reads.

A fresh symbol set is not available — eight is what has 15m history deep enough for an 80-day
warm-up. So the untouched axis is **time**. Every number in this repository comes from 2023-09
onward. The 48 months from **2019-09 to 2023-08** are a different market era entirely: they contain
the 2020 crash, the 2021 mania, and the 2022 bear, none of which any tuning decision here has seen.

## The rule

**Run the strategy in a given calendar month only if its own previous calendar month returned ≤ 0.**

One condition, one threshold, and the threshold is zero rather than anything fitted. It needs no
indicator, no daily bars, and no parameters — only the strategy's own last result, which an operator
already has.

The mechanism it would imply is ordinary mean reversion in strategy performance: a strategy that has
just had a good month has usually just captured a move, and the move it captured is more likely to be
maturing than beginning. It is the same shape as the (rejected) ADX story, but measured on the
strategy's own P&L rather than on an indicator of the price.

## What counts as confirmation

Scored once, on all eight symbols, over 2019-09 → 2023-08. Confirms only if, for **all three**
strategies against the same window's baseline:

1. mean return per deployed month is **higher**, and
2. the summed dollar loss of losing months is **smaller**.

Total profit is *not* a criterion. The rule deploys in roughly two thirds of months, so a lower total
is expected and is not evidence against it — the question is whether the months it selects are
better, not whether fewer months earn more than more months. That is stated here so it cannot be
argued either way afterwards.

A single strategy failing either condition is a failure. Two of three is a failure.

## An honest prior

This has now been observed on two symbol sets and could still be an artifact of the 2023–2026 era —
a period with, broadly, one large uptrend. Monthly mean reversion is exactly what you would expect to
see in a sample where a strong month is often a local top. If it fails on 2019–2023, that is the
likely reason, and the result should be recorded as rejected rather than explained.

## Result

Filled in below, once, after the run.
