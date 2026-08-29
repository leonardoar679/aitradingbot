# Which candle interval, decided once on eight symbols over sixty-five identical months

**Written and committed before the runs finished.** Nothing below the pre-registration line had been
scored when the criterion was fixed.

## Why re-ask a question that already has an answer

15m is what ships, and two earlier results support it: `research/ivfair.ts` (BTCUSDT, 2021-06 →
2026-08, one symbol, continuous compounding) and `research/monthiv.ts` (BTC/ETH/SOL, 36 independent
months, 1m/3m/5m/15m). Both are thinner than the question deserves:

- **One or three symbols.** Every other rule in this repository is judged on eight. An interval that
  wins on BTC and loses on LTC is a fact about BTC.
- **Only fast intervals were compared month-by-month.** 1m/3m/5m/15m. But `research/m15.ts` found
  Trend Regime returns essentially the same at 1h for **13% less in fees**, and that comparison was
  continuous-compounding on three symbols, never re-asked a month at a time.
- **The gated strategy was never in the interval comparison at all** on more than three symbols.

So the real candidates are **3m, 15m, 1h and 4h**, and the honest state of the evidence is that 15m
and 1h have never been separated on a sample wide enough to separate them.

## The window is forced by the data, not chosen

3m candles exist from **2021-01** for these symbols; 15m/1h/4h go back to 2017–2019. A comparison
across intervals is only meaningful on months every interval can trade, so the window is
**2021-04 → 2026-08, 65 months**, the longest span where all four intervals have the 80-day warm-up
lead Trend Regime declares. Picking a longer window for the slower intervals would hand them a
different market and a different buy-and-hold anchor — the trap `research/README.md` records being
fallen into twice.

Every interval therefore scores **the same 65 calendar months on the same 8 symbols**, each month an
independent $10,000 account with its own exact warm-up lead.

## The rule, fixed before scoring

Selection on **BTC, ETH, SOL, ADA**. Confirmation on **BNB, LINK, LTC, XRP**, which take no part in
choosing. This is the same split `research/enhance.ts` used, for the same reason: comparing four
intervals across three strategies is twelve comparisons, and the best of twelve is a winner by
chance if it is picked afterwards.

The ranking column is **mean month ÷ standard deviation of months**, pooled over the four selection
symbols and all three strategies. Not total profit, because the user's ask is "more profit *and*
less loss" and a total answers only the first half; not the worst month alone, because an interval
that never trades has no worst month. Mean/sd is the column `research/gen.mjs` already ranks on, so
it is not a metric chosen to suit this result.

**An interval is adopted only if it wins the selection set AND is at least second on the
confirmation set.** If the winner on selection is not top-two on confirmation, **15m stands**, because
the incumbent should not be displaced by a result that does not repeat.

Fees are reported but are not a criterion. They are already inside the returns.

## Prior

Weakly expecting **1h** to win on Trend Regime and lose on Short-Term Channel, which would mean no
single interval is right for both and the answer is per-strategy. Genuinely expecting **3m to lose**:
it costs the most in fees of the four and the earlier three-symbol run already put it behind 15m for
two of the three strategies.

---

## RESULT

*(scored after this line was committed)*
