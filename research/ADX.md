# ADX as a go/no-go filter — one test, on six symbols that have never been used

**Written and committed while the data was still downloading.** DOGE, TRX, ETC, XLM, VET and EOS
have taken no part in any result in this repository. Nothing below has been scored.

## Why this is not moving the goalposts

`research/PRIORMONTH.md` ends with "the search stops here", and that sentence meant something
specific: stop *re-slicing the same eight symbols* until a rule passes. Two rules were pre-registered
against that data and both were rejected, and the data is spent.

This is a different act. One rule, fixed below, scored once against symbols that did not exist in any
earlier run. Acquiring new evidence to resolve an ambiguous result is the opposite of slicing; the
thing that makes it legitimate is that the rule and the criterion are written down first and the test
happens once. If it fails, it is recorded as failed and ADX is finished.

The reason it is worth one more test rather than zero: ADX's record is not weakly positive, it is
**inconsistent**, and inconsistency is resolvable by more data in a way that a weak effect is not.

| ADX ≤ 20, mean month vs baseline | Trend Regime | Short-Term Channel | Channel + Regime |
|---|---|---|---|
| 2023–26, discovery symbols | +9.1% vs +4.6% | +8.3% vs +3.5% | +8.0% vs +4.1% |
| 2023–26, held-out symbols | **−1.1% vs +2.1%** | **+0.3% vs +1.4%** | **+0.2% vs +1.6%** |
| 2019–23, all eight | +12.9% vs +5.0% | +8.3% vs +4.6% | +9.1% vs +3.7% |

Two cuts strongly for, one against. Six virgin symbols across two eras is the cheapest thing that
can distinguish "real but fragile" from "never there".

## The rule

**Run the strategy in a calendar month only if Wilder's ADX(14), computed on daily bars closing
strictly before the 1st, is ≤ 20.**

One condition. The threshold is Wilder's own published boundary for "no meaningful trend", not a cut
fitted to anything here. `ADX ≤ 25` is the other published boundary and is *not* being tested, because
testing both doubles the chance of a false pass and 20 is the stronger of the two on every cut so far.

## What counts as confirmation

Scored once on DOGE, TRX, ETC, XLM, VET, EOS, over **both** eras — 2019-09 → 2023-08 and
2023-09 → 2026-08 — with each month an independent $10,000 account, exactly as every other run here.

Confirms only if **all three** hold:

1. Mean return per deployed month is **higher** than baseline for all three strategies, pooled
   across both eras.
2. It is also higher for at least **two of three** strategies within *each* era separately, so a pass
   cannot be carried entirely by one market period.
3. The summed dollar loss of losing months is **smaller** for all three strategies.

Total profit is not a criterion, for the reason given in `GONOGO.md`: the rule deploys in roughly a
fifth to a third of months, so a lower total is arithmetic rather than evidence.

**Anything less than all three conditions is a rejection**, and ADX is then closed as a question
rather than carried forward as "promising".

## The prior

Genuinely uncertain, which is why the test is worth running. Against: the one clean holdout so far
inverted, and low ADX is a small-sample-prone condition — it selects a minority of months, so each
estimate rests on few observations. For: the mechanism is coherent (a breakout bought into an
already-strong trend is bought late), it is one of the oldest published indicators rather than
something invented here, and it survived an entirely different market era on eight symbols.

If it fails, the honest summary of this whole line of work becomes: **these strategies' losing months
are not predictable in advance from market condition, and the lever that does work is risk shaping,
not timing.**

## Result: CONFIRMED. All three conditions pass.

453 symbol-months across DOGE, TRX, ETC, XLM, VET and EOS, over both eras. (EOS was delisted from
Binance in May 2025, so its later months simply do not exist and are skipped rather than filled.)

| pooled, both eras | months | baseline mean | ADX ≤ 20 months | rule mean | baseline losses | rule losses |
|---|---|---|---|---|---|---|
| Trend Regime | 453 | +5.97% | 130 | **+10.83%** | −$207,061 | **−$41,999** |
| Short-Term Channel | 453 | +4.88% | 130 | **+5.40%** | −$213,352 | **−$72,042** |
| Channel + Regime | 453 | +5.17% | 130 | **+7.37%** | −$137,170 | **−$34,673** |

**Condition 1** — higher mean, all three pooled: **PASS (3/3)**.
**Condition 2** — higher on ≥2 of 3 within *each* era: **PASS**, and in fact 3 of 3 in both. Era
2019–23: +13.6/+6.7/+9.0 against +7.6/+6.4/+6.1. Era 2023–26: +8.5/+4.3/+6.0 against +4.0/+3.0/+4.0.
**Condition 3** — smaller summed losses, all three: **PASS (3/3)**, cut by 66–80%.

## Three things that must be said alongside it

**The win rate goes DOWN, on all three.** 28% → 25%, 42% → 36%, 30% → 28%. This was not a criterion
and it should have been. The rule does not select months that win more often; it selects months whose
winners are larger and whose losers are smaller. Anyone reading "confirmed" as "it wins more often"
would be reading it wrong.

**Total profit falls, as stated in advance.** The rule deploys in 130 of 453 months — 29%. Sitting out
71% of months removes profit. This is only a gain if the capital genuinely sits in cash when the rule
says no, and costs nothing while it waits.

**One earlier cut still contradicts this and is not explained away.** The full record:

| ADX ≤ 20 vs baseline | Trend Regime | Short-Term Channel | Channel + Regime | |
|---|---|---|---|---|
| 2023–26, BTC/ETH/SOL/ADA | +9.1 vs +4.6 | +8.3 vs +3.5 | +8.0 vs +4.1 | for |
| 2023–26, BNB/LINK/LTC/XRP | **−1.1 vs +2.1** | **+0.3 vs +1.4** | **+0.2 vs +1.6** | **against** |
| 2019–23, all eight | +12.9 vs +5.0 | +8.3 vs +4.6 | +9.1 vs +3.7 | for |
| 2019–23, six new | +13.6 vs +7.6 | +6.7 vs +6.4 | +9.0 vs +6.1 | for |
| 2023–26, six new | +8.5 vs +4.0 | +4.3 vs +3.0 | +6.0 vs +4.0 | for |

Four cuts for, one against, and the one against was a clean holdout when it ran. Fourteen symbols
and seven years now support it and four symbols in one era do not. That is a real result with a real
exception, not a clean one — and the exception is why this ships as a **readout the operator reads**,
never as an automatic gate inside a strategy.

## Why it is consistent with `research/beta.ts`

`beta.ts` shows these strategies are 0.80–0.89 correlated with simply holding, lose money in almost
every falling month, and need a strongly rising month to profit. ADX ≤ 20 does not predict market
direction, and nothing here claims it does. What a low ADX marks is a market that has *not already
made its move* — so the months it selects still fail when the market falls, which is why the win rate
does not improve. What changes is the payoff when it does rise: a breakout from a quiet base runs
further than one bought into a trend already three quarters finished.
