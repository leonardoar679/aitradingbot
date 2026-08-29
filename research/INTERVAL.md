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

Two dumps were added after the pre-registration was committed: **3m**, which was always in the plan
but finished last because it is 60x the data, and **1d**, which was not. 1d was run because Trend
Regime improved monotonically from 15m to 1h to 4h, and a monotonic edge is the shape that means
*the ladder was not extended far enough* rather than *this bar size is right*. Extending it is the
test that can kill the result, not one that can only flatter it — and it is reported whichever way
it lands.

### The pre-registered rule, applied literally

| pooled, three strategies | 3m | 15m | 1h | 4h | 1d |
|---|---|---|---|---|---|
| selection mean/sd | **0.171** | 0.164 | 0.151 | 0.151 | 0.133 |
| confirmation mean/sd | 0.072 | 0.070 | **0.075** | 0.074 | 0.066 |

3m wins selection and places **3rd of 5** on confirmation. The rule required top-two. **REJECTED —
15m stands, no change.**

### And the pre-registration used the wrong unit of analysis

That verdict is worth almost nothing, and the fault is in how the rule was written rather than in
the data. `preferredInterval` is a **per-strategy** field. Pooling three strategies into one ranking
can only answer "one bar size for everything", which is not the question the app asks. Worse, the
pooling actively destroys the answer: these three want *opposite* bar sizes, so averaging them
produces a flat row that reads as "no difference".

The per-strategy table below was written into `research/interval.ts` **before** any of this was
scored, with the comment that "if the three disagree, the answer is per-strategy and the report has
to say so". It disagrees.

| mean/sd, best marked | 3m | 15m | 1h | 4h | 1d |
|---|---|---|---|---|---|
| Trend Regime — selection | 0.142 | 0.134 | 0.132 | **0.152** | 0.147 |
| Trend Regime — confirmation | 0.053 | 0.063 | 0.093 | **0.100** | 0.071 |
| Short-Term Channel — selection | **0.203** | 0.191 | 0.168 | 0.154 | 0.121 |
| Short-Term Channel — confirmation | **0.079** | 0.074 | 0.060 | 0.055 | 0.054 |
| Channel + Regime — selection | **0.187** | 0.181 | 0.164 | 0.153 | 0.130 |
| Channel + Regime — confirmation | **0.087** | 0.075 | 0.073 | 0.065 | 0.074 |

**Every strategy's best interval is the same in both halves.** Under a null of no real preference
each has a 1-in-5 chance of repeating, so three for three is roughly 1 in 125. That is the test the
pooled criterion should have been.

### What ships, and what does not

**Trend Regime moves from 1h to 4h.** It wins both halves, and wins on profit and on losses at the
same time rather than trading one for the other:

| Trend Regime | mean | mean/sd | total profit | summed losses | fees | trades/mo | worst |
|---|---|---|---|---|---|---|---|
| selection, 1h | +3.28% | 0.132 | $85,396 | −$110,736 | $5,802 | 1.13 | −41.19% |
| selection, **4h** | **+3.70%** | **0.152** | **$96,277** | **−$100,511** | **$5,073** | 0.98 | **−33.81%** |
| held out, 1h | +2.20% | 0.093 | $57,161 | −$102,864 | $6,961 | 1.37 | **−26.43%** |
| held out, **4h** | **+2.38%** | **0.100** | **$61,883** | **−$101,351** | **$6,067** | 1.19 | −27.25% |

Six of six columns on selection, five of six on the held-out four. The one that worsens is the
single worst month, by 0.8 points, and it is **not excepted** — a change accepted on five columns
and reverted on the sixth is fitted to whichever column happened to disagree.

**1d is worse than 4h on both halves** (0.147 and 0.071), so 4h is an *interior peak* rather than
the end of a monotonic drift. That distinction is the reason to believe it.

**3m wins for both channel strategies, in both halves, and cannot be shipped.** `Interval` in
`shared/ipc.ts` is `'1m' | '15m' | '1h' | '4h' | '1d' | '1w'`. 3m is not a member, cannot be
assigned to `preferredInterval`, and `korbit.ts` and `kraken.ts` declare non-partial
`Record<Interval, …>` maps with no aggregation path — so supporting it means changing the type, the
`INTERVALS` list, `INTERVAL_SECONDS` and every exchange adapter. The gain does not justify that:
0.191 → 0.203 on selection and 0.074 → 0.079 on the held-out four, for **18% more in fees**
($54,217 → $64,199 pooled). Recorded as a real result that is not worth its plumbing, so nobody has
to re-derive it. **Short-Term Channel and Channel + Regime stay at 15m**, which is the best
*shippable* interval for both in both halves.

### One consequence that had to be fixed with it

`src/backtest/marketConditions.ts` held the Market Conditions card's expectations measured at 15m.
Moving Trend Regime to 4h would have left the card printing a 15m number beside a 4h backtest, with
nothing on screen to show they did not match. `research/expect.ts` re-measures each strategy at its
own interval on the same six held-out symbols, and the ADX finding survives the change almost
untouched: **+10.70% against a +5.99% baseline at 4h**, against +10.83/+5.97 at 15m. A test now pins
`MEASURED_EXPECTATIONS[].interval` to that strategy's `preferredInterval`, so the mismatch cannot
return silently.
