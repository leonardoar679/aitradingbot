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

## Result

Filled in below, once, after the run.
