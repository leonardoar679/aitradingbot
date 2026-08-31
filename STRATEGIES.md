# The three shipped strategies, and the arithmetic that makes them profitable

This document answers one question: **where does the money come from?** Not "did the backtest go
up" — that is in [README.md](README.md) — but the actual mechanism, written as equations, with
every number in it recomputed from the repository rather than quoted.

Three strategies ship as the ones worth running. All three are **long-only spot, one all-in
position at a time, no leverage, no shorting**:

| | file | bar size | trades/yr/symbol |
|---|---|---|---|
| **Trend Regime Ensemble** | [trendRegimeEnsemble.ts](src/backtest/strategies/trendRegimeEnsemble.ts) | 4h | 8.8 |
| **Short-Term Channel Breakout** | [shortTermChannel.ts](src/backtest/strategies/shortTermChannel.ts) | 15m | 25.4 |
| **Short-Term Channel + Trend Regime** | [shortTermChannelRegime.ts](src/backtest/strategies/shortTermChannelRegime.ts) | 15m | 15.6 |

Everything below is measured by two scripts you can run yourself:

```bash
# the profit equation, per trade
npx esbuild research/edge.ts --bundle --platform=node --format=esm --outfile=research/.edge.mjs
node research/.edge.mjs

# the same runs scored by month, against buy-and-hold
npx esbuild research/shipped.ts --bundle --platform=node --format=esm --outfile=research/.shipped.mjs
node research/.shipped.mjs
```

---

## 1. The one equation

A strategy that takes `N` round trips, wins a fraction `p` of them, makes `W` on the average
winner and loses `L` on the average loser — both as a percentage of the capital that trade
started with — earns:

```
E[trade]  =  p·W  −  (1−p)·L
```

It is profitable when `p·W > (1−p)·L`. Rearranged, that gives the **break-even win rate**:

```
p*  =  L / (W + L)
```

This is the whole thing. Every design decision in all three files — the lookbacks, the vote, the
hysteresis band, the bar size, the deliberately useless stop — exists only to move `p`, `W`, `L`
or `N`. Nothing else is happening.

Measured over 2021-04 → 2026-08 on eight symbols, each strategy at its own bar size, run
continuously (`research/edge.ts`):

| | N | p | W | L | W/L | p\* | **E[trade]** | gross E | fee |
|---|---|---|---|---|---|---|---|---|---|
| Trend Regime Ensemble (4h) | 376 | 24.5% | +34.6% | −5.3% | 6.49 | 13.3% | **+4.44%** | +4.65% | −0.20% |
| Short-Term Channel (15m) | 1084 | 34.9% | +11.2% | −4.3% | 2.61 | 27.7% | **+1.11%** | +1.31% | −0.20% |
| Channel + Regime (15m) | 664 | 34.8% | +13.4% | −4.6% | 2.92 | 25.5% | **+1.68%** | +1.88% | −0.20% |

Read the Trend Regime row slowly, because it is the entire argument:

> It is **wrong three times out of four**. It needs to be right only 13.3% of the time to break
> even. It is right 24.5% of the time. That 11-point margin is the edge, and it is bought entirely
> with a **6.5:1 payoff** — average winner +34.6%, average loser −5.3%.

There is no version of this where you win most of your trades. A 24% win rate is what the strategy
*is*, and the psychological cost of holding it is the real reason most people cannot run trend
following, not the mathematics.

### Why the payoff ratio is 6.5:1 and not 1:1

Because the exit rule is asymmetric on purpose, and the stop is deliberately too wide to fire:

- **Losers are cut by the regime/channel exit**, which triggers a few days after entry when the
  trend fails to develop. Median hold is 7.9 days for Trend Regime; a loser exits well before
  that.
- **Winners are not cut at all.** There is no take-profit anywhere in these files. A position is
  held until the trend rule itself says the trend is over, which in a real trend is months.
- **The stop almost never fires.** Trend Regime's stop is `close − 10×ATR(14)`; the Channel's is
  half the entry price. Across 376 Trend Regime trades, **2 were stopped out**; across 1,084
  Channel trades, **zero**. They exist because [engine.ts](src/backtest/engine.ts) refuses to open
  a position without a stop price, and as disaster insurance against a gap. They are not risk
  management — the exit rule is.

A tighter stop was measured on both and made things worse: it sells into the noise *inside* a
trend the rule would have held, then pays the round trip again to get back in. Trend Regime at
ATR×3 returns +123% over 40 trades; at ATR×8–25 it returns +142–153% over 21, with the same −26%
drawdown.

### Is the edge broad, or is it two coins?

The table above is **pooled** across eight symbols, and this repository already knows that half the
mean month comes from SOL and XRP alone. A pooled win rate above a pooled break-even is compatible
with two completely different claims: a rule that clears its bar almost everywhere, or a rule that
fails on six symbols and is rescued by two. The pooled row cannot tell them apart, so the terms are
computed **per symbol** and the question is asked in the form that can fail — *on how many symbols
does `p` exceed that symbol's own `p*`?*

`p*` moves with the symbol. It is not a fixed bar: a symbol whose losers run further raises its own
break-even. So this is not "which symbols won", it is "on which symbols did the payoff ratio earned
there justify the win rate earned there".

| Trend Regime Ensemble (4h) | N | p | p\* | margin | W/L | E[trade] |
|---|---|---|---|---|---|---|
| BTC | 40 | 30.0% | 15.5% | **+14.5pt** | 5.44 | +3.70% |
| ETH | 35 | 28.6% | 14.8% | **+13.8pt** | 5.75 | +4.75% |
| SOL | 48 | 27.1% | 9.5% | **+17.6pt** | 9.54 | +14.65% |
| ADA | 40 | 25.0% | 21.3% | +3.7pt | 3.70 | +1.45% |
| BNB | 48 | 31.3% | 14.6% | **+16.7pt** | 5.86 | +3.63% |
| LINK | 61 | 19.7% | 17.4% | +2.3pt | 4.76 | +0.65% |
| LTC | 53 | 17.0% | 19.9% | **−2.9pt** | 4.03 | −0.68% |
| XRP | 51 | 21.6% | 8.1% | **+13.5pt** | 11.38 | +8.17% |

**Seven of eight.** The two channel strategies clear six of eight each — Short-Term Channel fails
LINK by 0.2 points and LTC by 2.9; the gated version fails both by 0.2. LTC is the one symbol that
fails for all three, which is consistent with everything else here: it chops.

### Removing the two strongest symbols

The direct test. SOL and XRP are named as a fixed pair rather than computed as "whichever two are
best", which would guarantee a drop on any set of numbers at all:

| | N | p | p\* | margin | E[trade], six | E[trade], all eight |
|---|---|---|---|---|---|---|
| Trend Regime Ensemble (4h) | 277 | 24.5% | 17.5% | **+7.0pt** | +1.99% | +4.44% |
| Short-Term Channel (15m) | 826 | 35.1% | 31.2% | **+3.9pt** | +0.51% | +1.11% |
| Channel + Regime (15m) | 501 | 36.1% | 29.8% | **+6.3pt** | +0.91% | +1.68% |

**The pair inflates the size of the edge and does not create it.** Expectancy per trade roughly
halves without them — the same story the monthly figures tell — but the margin stays positive on
all three. That is the distinction the pooled row could not make, and it is the reason the equation
is worth trusting as a description rather than as a summary of two coins that ran.

### The same terms on six symbols that chose nothing

DOGE, TRX, ETC, XLM, VET and EOS took no part in finding any rule here. Same window, same
intervals:

| | N | p | W | L | W/L | p\* | E[trade] | clears p\* on |
|---|---|---|---|---|---|---|---|---|
| Trend Regime Ensemble (4h) | 256 | 22.3% | +39.0% | −5.6% | 6.98 | 12.5% | **+4.34%** | 5 of 6 |
| Short-Term Channel (15m) | 795 | 31.1% | +14.8% | −4.3% | 3.47 | 22.4% | **+1.66%** | **6 of 6** |
| Channel + Regime (15m) | 437 | 32.5% | +19.8% | −4.6% | 4.26 | 19.0% | **+3.29%** | **6 of 6** |

Trend Regime earns +4.34% per trade on symbols that informed nothing, against +4.44% on the eight
it was built and confirmed on. The two channel strategies do **better** out of sample than in it.

**That is a suspiciously good result and it has its own concentration**, which is worth stating
before anyone quotes it. DOGE alone returns +12.92% per trade at a 9.52 payoff — its 2021 was
extraordinary and it is doing to this set what SOL does to the other. Strip it out and Trend Regime
still clears break-even on four of the remaining five (ETC +11.9pt, TRX +12.8pt, VET +5.6pt, XLM
+5.2pt, EOS −1.7pt), so the conclusion survives, but the *magnitude* on these six should be read
the same way as the magnitude on the eight: carried disproportionately by one coin that ran.

---

## 2. Why the cost floor decides the design before any signal does

A round trip costs **0.24%**: 0.1% fee per side ([`FEE_RATE`](shared/fees.ts)) plus 2bps of
slippage per fill ([`SLIPPAGE_RATE`](shared/fees.ts)). The average 15-minute candle on BTCUSDT
moves 0.16% — mean `|close − open| / open` over 2023-08 → 2026-08; it is 0.22% over the full
history since 2017, so the ratio below is the conservative reading. **The cost of trading is 1.5×
a typical bar.**

That single ratio is why three of the six strategies in this repo lose money and three do not.
The cost is per trade, so the annual drag is `N × 0.24%`:

| | trades/yr | annual cost |
|---|---|---|
| Trend Regime Ensemble | 8.8 | ~2.1% |
| Channel + Regime | 15.6 | ~3.7% |
| Short-Term Channel | 25.4 | ~6.1% |
| *Bollinger Breakout (rejected)* | *~670* | ***~161%*** |

Bollinger Breakout takes **6,059 trades** over the full BTCUSDT 15m history and finishes at
**−100%** (`research/baseline.ts`) — about 670 round trips a year against an annual cost of roughly
1.6× the account. That is not a tuning failure that better parameters would fix. It is arithmetic:
no signal has an edge large enough to survive being asked that often at 0.24% each.

So the first constraint, written before any indicator, is **a trade budget**. Notice in the table
above that `E[trade]` is *unaffected* by how often you trade — but the fee is charged every time.
Trading the same edge twice as often earns the same expectancy per trade and pays twice the fee.

### Hysteresis is how you buy the trade budget

The naive way to cut `N` is to slow the indicator down. That works, but it costs you the whole
short-term timescale. Measured on BTCUSDT 15m over the two training years 2023-08 → 2025-08, a
plain moving-average trend follower with **one threshold** (`research/tscan.ts`):

| lookback | net | trades |
|---|---|---|
| 0.25 day | −99.99% | 4,152 |
| 1 day | −97.92% | 1,945 |
| 3 days | −82.12% | 1,056 |
| 8 days | −38.31% | 593 |
| 20 days | **+41.79%** | 314 |
| 50 days | **+61.32%** | 219 |

Now add a 1.5% band between the entry line and the exit line, and the *quarter-day* lookback turns
positive: **+37.45% on 130 trades**. Same signal, same timescale, 32× fewer trades.

The mechanism is that a single threshold `θ` is crossed by *noise*: price wobbling around `θ`
generates a crossing pair — and a 0.24% charge — for every wobble, however small. Two thresholds
`θ_exit < θ_enter` require price to travel the whole width of the band before it can reverse the
decision, so every excursion smaller than the band is free. All three strategies use this:

| | enter at | exit at | band |
|---|---|---|---|
| Trend Regime Ensemble | 4 of 4 lookbacks agree | ≤ 1 of 4 still agrees | 3 votes wide |
| Short-Term Channel | 95% up its channels | ≤ 25% up them | 70% of the range |

Closing Trend Regime's gap — entering *and* exiting at half the votes, so the band is zero wide —
is measured in `research/gap.ts`, on full history at 4h:

| BTCUSDT 4h | net | trades |
|---|---|---|
| shipped band, enter 4 of 4 / exit ≤ 1 of 4 | **+9,129%** | 60 |
| closed band, enter and exit both at half | **−65%** | 2,269 |

Same lookbacks, same data, same engine, same stop — the only difference is that price no longer has
to cross the whole band to reverse the decision, so **every wobble becomes a round trip**: 60 trades
become 2,269. ETH and SOL behave the same way (+10,393% → +18%, +7,250% → +789%). The band is not a
tuning parameter; it is the thing that makes the strategy affordable.

> Read the *trade count*, not the fee bill, as the measure of this. Fees are charged on the balance
> at the time, so a strategy that collapses early pays less in absolute dollars than one that
> compounds — BTC's closed-band fees are slightly *lower* than the shipped band's despite 38× the
> trades, purely because the account was gone. SOL, which survives, pays 12× more.

---

## 3. Trend Regime Ensemble — the math

**The claim it trades on**, measured on BTCUSDT 15m as forward 24h return split by whether price
is above or below a moving average:

| lookback | above | below | spread |
|---|---|---|---|
| 1 day | +0.128% | +0.132% | −0.004% |
| 20 days | +0.201% | +0.041% | +0.159% |
| **50 days** | **+0.222%** | **+0.003%** | **+0.219%** |
| 200 days | +0.035% | +0.043% | −0.008% |

Trend persistence exists, but only in the **20–50 day band**, and it is zero at both ends. This is
why a fast EMA(20/50) cross on 15m bars finds nothing, and why a 200-*bar* filter does nothing on
15m candles — 200 bars of 15m is two days, the row where the spread is −0.004%.

### The algorithm

Lookbacks are declared in **days**, not bars:

```ts
const LOOKBACK_DAYS = [20, 30, 50, 80]
```

**Step 1 — infer the bar size.** `inferBarSeconds()` takes the **median** gap between candles, not
the mean and not `candles[1] − candles[0]`. One 3-day exchange outage would drag a mean far enough
to misread 15m data as hourly; reading the first gap bets everything on two rows being adjacent.

**Step 2 — convert days to bars.**

```
P_k = max(2, round(D_k × 86400 / barSeconds))     for D_k ∈ {20, 30, 50, 80}
```

This conversion is the difference between a strategy and a strategy-plus-a-timeframe-assumption.
Written as "1,920 bars", the 20-day lookback is 20 days of 15m candles but 4 days of 3m ones — and
4 days is the row in the table above where the measured edge is exactly zero.

**Step 3 — four simple moving averages.**

```
SMA_k(i) = (1/P_k) · Σ_{j=i−P_k+1}^{i} close_j
```

Computed in O(n) by a running sum. Before the window fills, the value is `NaN` — and `close > NaN`
is `false`, so **an unwarmed lookback abstains by voting NO**. That is the safe direction.

**Step 4 — the vote.**

```
A(i) = (1/4) · Σ_k 1[ close_i > SMA_k(i) ]        ∈ {0, 0.25, 0.5, 0.75, 1}
```

**Step 5 — the hysteresis band.**

```
enter when  A(i) ≥ 1.00      (all four agree)
exit  when  A(i) ≤ 0.25      (at most one still does)
```

**Step 6 — the disaster stop**, set at entry and effectively never touched:

```
stop = close_i − 10 × ATR(14)_i
```

If that computes to ≤ 0 or non-finite, `stopPrices[i]` is `null` and **the engine declines the
entry entirely** rather than opening a position with an unreachable stop.

**Warm-up** is `max_k P_k` — the slowest lookback. At 4h that is 480 bars; at 15m it is 7,680. The
same arithmetic backs the exported `warmupBarsFor(barSeconds)`, so a caller sizing its data fetch
and the strategy's own warm-up cannot disagree about how much history is needed.

### Why a vote and not a chosen lookback

Sweeping single lookbacks produced a non-monotonic surface — 50d scored +171%, 60d +99%, 80d
+154% *on the same window*. A parameter picked off a surface like that is fitted to the sample,
not measured from it. Asking four lookbacks and counting votes **removes the choice instead of
tuning it**. Dropping any one of the four moves the result by a few points (115–162% against 132%
for all four) rather than reorganising it — which is what robustness looks like.

The two thresholds are the two *natural* values, not fitted decimals: enter on unanimity, leave
when it has essentially collapsed.

---

## 4. Short-Term Channel Breakout — the math

Same skeleton, one decade faster: `LOOKBACK_DAYS = [2, 3, 5, 8]`, `ENTER_AT = 0.95`,
`EXIT_AT = 0.25`, disaster stop at half the entry price.

**Step 1 — Donchian channels**, one per lookback:

```
H_k(i) = max( high_{i−P_k+1} … high_i )
L_k(i) = min( low_{i−P_k+1}  … low_i  )
```

**Step 2 — where price sits inside each channel**, read as of the **previous** bar:

```
x_k(i) = clamp( (close_i − L_k(i−1)) / (H_k(i−1) − L_k(i−1)),  0,  1 )
```

Using bar `i−1`'s channel is essential. If the current bar's own high were included, a new high
would be at position 1.0 *by construction* and the signal would fire on every up bar. A degenerate
flat channel (`H = L`) scores 0.5 rather than dividing by zero.

**Step 3 — average across the four:**

```
C(i) = (1/4) · Σ_k x_k(i)

enter when  C(i) ≥ 0.95
exit  when  C(i) ≤ 0.25
```

### Why average the *position* rather than vote on the breakouts

This is the one genuinely non-obvious piece of mathematics in the repository. The obvious move —
copy Trend Regime and vote across four channels — is **vacuous**, and provably so.

Donchian channels are **nested**. A 8-day window contains the 5-day window contains the 3-day
window contains the 2-day window, so:

```
H_2d(i)  ≤  H_3d(i)  ≤  H_5d(i)  ≤  H_8d(i)      for all i
```

Therefore "`close` breaks `k` of the four highs" is *exactly identical* to "`close` breaks the
k-th slowest high". The vote re-picks a single lookback under another name and adds nothing.

The channel **position** `x_k` is not nested — a price can sit at 0.9 of its 2-day range and 0.4
of its 8-day range — so averaging it is a genuinely different signal from any one of its
components, and it degrades gracefully instead of flipping on one tick through one level.

### Why these lookbacks are not fitted

Across 36 parameter combinations × 8 symbol/timeframe blocks, **all 288 cells were profitable** on
the training window. There was no sharp optimum to find. The best worst-case cell was `[2,4,8]` at
`0.98/0.15` and was **deliberately not taken** — that is a tight corner of the grid, and the argmax
of a sweep is the point with the least statistical support. `[2,3,5,8]` is Trend Regime's
`[20,30,50,80]` shape moved one decade down, and it lands mid-plateau.

The frequency/return trade-off is **monotone**, which is the honest answer to "why not trade more":

| trades/yr | worst-case net across 8 blocks |
|---|---|
| 56 | +37.5% |
| 43 | +45.0% |
| 33 | +57.7% |
| **24** | **+76.0%** ← this configuration |
| 15 | +80.8% |

More trades is *strictly worse* after costs on this data. The shipped point is where the curve has
flattened but the strategy still turns over about twice a month.

---

## 5. Short-Term Channel + Trend Regime — the gate

The smallest of the three files, and a pure set intersection:

```ts
entries = base.entries.map((entry, i) => entry && agreement[i] >= 1)
exits   = base.exits          // untouched, on purpose
warmup  = max(channel warmup, regime warmup)     // 80 days, not 8
```

**Why it exists.** Over 36 independent months, Short-Term Channel loses money in precisely the
months Trend Regime declines to trade at all: mean −4.7%, −3.1% and −9.3% on BTC/ETH/SOL in those
months, against +3.8%, +5.4% and +8.4% in the months Trend Regime is active. The ungated strategy
walks into those months blind.

**The first idea was the opposite one** — run both, so the channel covers the months the regime
sits out. Those numbers kill it: the two are *positively* correlated, so pairing them concentrates
the bad months rather than diversifying them.

**Exits are deliberately not gated.** Gating them too was measured and was worse on every symbol
but one, because an exit blocked by a falling regime is blocked exactly when it is needed.

**4-of-4 is not a tuned number.** It is Trend Regime's own `ENTER_VOTE_FRACTION`, read through the
*same exported* `regimeAgreement()` the other strategy acts on, so the two can never silently
drift apart. Thresholds of 2/4 and 3/4 score better on subsets, but the ranking between them flips
across symbols — that is noise, and choosing one would add a free parameter fitted on the same
data used to justify it.

**What it actually buys is not profit.** Net across 288 symbol-months the gate is worth $11,436,
and the best *five* months carry 86% of that; by count it helps 108 months and hurts 104, with a
median effect of exactly **$0**. What does hold is a rule about the *distribution*: sort every
month by what the ungated strategy did, cut into fifths, and the gate's effect falls monotonically
from **+5.8% in the worst fifth to −3.6% in the best**. It trades upside for downside at a
predictable rate. Expect the smaller drawdown to repeat; do not count on the extra dollars.

The cost is warm-up: 80 days instead of 8. On the Backtest page's default 90-day range that leaves
about **twelve tradeable days**.

---

## 6. How signals become money — the execution model

[engine.ts](src/backtest/engine.ts) owns all of this and is identical for every strategy. Per
candle, in this exact order:

1. **Below `warmupBars`, nothing happens at all.** No entry, no exit, no position.
2. If a position is open, checked in order: liquidation → stop (`low ≤ stopPrice`) → strategy exit
   → trailing give-back → equity ≤ 0.
3. A stop that gaps through fills at `min(open, stopPrice)`, worse of the two, as a real stop
   order would.
4. If flat and not just stopped out and `entries[i]` and `stopPrices[i] !== null` and not cooling
   down → **open at this candle's close**.

Fills are priced against the trader in both directions:

```
buy  fills at  price × (1 + 0.0002)
sell fills at  price × (1 − 0.0002)
fee  = notional × 0.001, charged on entry AND exit
```

A model where slippage sometimes helps would let a strategy earn money from the noise in its own
fill assumptions, so it never does.

**The edge does not depend on trading the close it just saw.** Delaying every fill by one, two or
four whole 15-minute bars after the signal moves the three-year result by a few points in either
direction and sometimes *improves* it. A signal that needed that precision would be a signal made
of noise — this is the cheapest check a backtest can run and the one intraday strategies most
often fail.

---

## 7. What it actually earned — and the statistic that reverses the answer

Scored over **520 independent $10,000 months** (65 months × 8 symbols, 2021-04 → 2026-08), each
strategy at its own bar size, from `research/shipped.ts`:

| | mean month | median | sd | mean/sd | worst | flat (in cash) |
|---|---|---|---|---|---|---|
| Trend Regime Ensemble (4h) | +3.04% | +0.00% | 24.1 | 0.126 | −33.8% | 27% |
| Short-Term Channel (15m) | +2.62% | −1.00% | 20.1 | 0.130 | −42.3% | 1% |
| Channel + Regime (15m) | +2.36% | +0.00% | 18.7 | 0.126 | −43.1% | 28% |

Against simply holding the same coin over the same months, **on the mean, all three lose**:

| | mean | holding | sd | holding sd | worst | holding worst |
|---|---|---|---|---|---|---|
| Trend Regime Ensemble (4h) | +3.04% | **+3.19%** | 24.1 | 30.0 | −33.8% | −56.6% |
| Short-Term Channel (15m) | +2.62% | **+3.15%** | 20.1 | 30.3 | −42.3% | −56.6% |
| Channel + Regime (15m) | +2.36% | **+3.15%** | 18.7 | 30.3 | −43.1% | −56.6% |

If that were the end of it, the honest advice would be "buy the coin". **It is not the end of it,
because the mean is the wrong statistic.**

### Volatility drag

Nobody trades 65 independent accounts. A person leaves the money in, and what they get is the
**product** of the monthly returns, not the average. A +50% month and a −50% month average to
zero and compound to **−25%**:

```
1.50 × 0.50 = 0.75
```

The gap between the two is governed by variance. To second order:

```
geometric ≈ arithmetic − σ²/2
```

Holding has σ = 30%/month, so its drag is `0.30²/2 = 4.50` points per month — **larger than its
own +3.19% mean**. Trend Regime has σ = 24.1%, so its drag is 2.90 points. The approximation gets
each *level* wrong by about a point (crypto's right tail is far too fat for a second-order
expansion), but it gets the **gap** right: it predicts the strategy should beat holding by 1.45
points a month, and the measured gap is 1.24.

Measured, not approximated:

| | arithmetic mean | holding | **geometric mean** | **holding** |
|---|---|---|---|---|
| Trend Regime Ensemble (4h) | +3.04% | +3.19% | **+1.26%** | **+0.02%** |
| Short-Term Channel (15m) | +2.62% | +3.15% | **+1.30%** | **−0.07%** |
| Channel + Regime (15m) | +2.36% | +3.15% | **+1.25%** | **−0.07%** |

**Holding's geometric mean is essentially zero.** Five and a half years of holding these eight
coins, compounded, returned almost nothing on average — because the −56.6% months take back more
than the +200% months can give.

### One account, never topped up

Chaining the 65 months (legitimate here specifically because these strategies take one all-in
position and pay proportional fees, so a month's percentage return does not depend on the balance
it started with):

| $10,000 becomes | BTC | ETH | SOL | ADA | BNB | LINK | LTC | XRP | beats holding |
|---|---|---|---|---|---|---|---|---|---|
| **Trend Regime Ensemble (4h)** | $32,450 | $36,260 | $122,676 | $6,902 | $36,803 | $8,036 | $3,984 | $57,861 | **8 of 8** |
| holding, same months | $14,846 | $12,560 | $53,365 | $1,761 | $23,388 | $4,309 | $2,145 | $28,775 | |
| **Short-Term Channel (15m)** | $24,143 | $37,327 | $233,724 | $22,161 | $19,284 | $8,261 | $4,204 | $26,491 | **7 of 8** |
| **Channel + Regime (15m)** | $27,478 | $30,819 | $154,168 | $21,567 | $16,174 | $9,211 | $7,155 | $20,836 | **6 of 8** |
| holding, same 15m months | $13,193 | $12,466 | $52,190 | $1,643 | $22,335 | $3,787 | $2,335 | $24,577 | |

Both tables are true. They answer different questions. **"What does the average month return"** is
won by holding; **"what does one account end with"** is won by the strategies, on 8, 7 and 6
symbols out of 8. The second is the question an actual account asks.

One asymmetry worth knowing runs *against* the strategies here: the independent-month design
forces a flat position at every month boundary, so the chained figures include 64 close-outs and
re-entries the strategies did not choose. Holding's chain is continuous. Their advantage is
therefore understated, not flattered.

### The same reversal, on a longer window and six symbols that chose nothing

The eight symbols above were used to select things. DOGE, TRX, ETC, XLM, VET and EOS took no part
in finding any rule here, and `research/vshold.ts` scores them over 84 months from 2019-09 —
almost seven years, including the 2019 chop, the March 2020 crash, the 2021 bull and the 2022
bear:

| Trend Regime Ensemble (4h), 488 symbol-months | mean month | sd | worst | $10,000 becomes | beats holding |
|---|---|---|---|---|---|
| simply holding | **+7.04%** | 52.5 | −45.3% | $94,810 | — |
| the strategy, every month | +5.99% | 45.8 | −40.7% | **$165,625** | **5 of 6** |

Holding wins the mean by a full point and still ends with **43% less money**, because its σ is
52.5 against the strategy's 45.8 and the drag scales with variance. The identical pattern holds
for the other two: Channel $138,577 against $105,897, gated Channel $167,419 against $108,065,
both 5 of 6 symbols. This is the result that matters most, because none of these six symbols
informed a single parameter.

---

## 8. So how do you actually make money with this

**Pick one strategy and run it at its own `preferredInterval`.** These are measured, not
preferred, and they differ per strategy for a reason — Trend Regime peaks at 4h, the two channel
strategies at 15m. Running a strategy at the wrong bar size does not "adapt" it; the lookbacks are
in days, so a finer bar re-asks the same question more often, crosses the hysteresis band on
noise, and charges 0.24% for each extra answer.

**Choose on which number matters to you.** On the four held-out symbols that took no part in
choosing anything:

| | mean month | mean/sd | worst | total profit | summed losses |
|---|---|---|---|---|---|
| Trend Regime Ensemble (4h) | +2.38% | 0.100 | −27.3% | **$61,883** | −$101,351 |
| Channel + Regime (15m) | +1.45% | 0.075 | −43.1% | $37,823 | **−$83,485** |
| Short-Term Channel (15m) | +1.52% | 0.074 | −42.3% | $39,625 | −$106,777 |

Nothing wins both. Trend Regime makes the most money; the gated channel loses the least. That is a
real choice and the repository declines to make it for you.

**Do not run two of them expecting diversification.** Their monthly returns correlate 0.70 to
0.97, and structurally so: the gate's threshold *is* Trend Regime's entry condition, so every
entry the gated strategy takes lands on a bar where Trend Regime's rule is also satisfied. Running
both is one bet at 1.7× size.

**Do not add leverage.** On BTCUSDT daily over the last 3 years, 5× returns +774% and survives.
Over the full 9 years the *same* 5× is liquidated on its **first trade** and ends at −100%. CAGR
divided by max drawdown is flat near 1.5 from 1× to 3× — leverage buys no risk-adjusted return at
all, only a bigger number attached to a position nobody holds through a −92% drawdown.

> Both leverage windows in `fair.ts` are pinned at the start and end wherever the candles end, so
> the two return figures move every time the candle set is extended. They are quoted here against
> candles through **2026-08-28**. The liquidation, the flat CAGR/drawdown ratio and the −92% are
> what the point rests on, and none of them moves.

**Expect the return to be concentrated and lumpy.** The **top five winning trades supply 42% of
all gross gains** for Trend Regime (17% and 22% for the two channel strategies). Month by month
over three years on BTCUSDT 15m, Short-Term Channel is up in 18 months and down in 19, never
spending a whole month in cash — and the **top three months supply 56% of all gains**, the best of
them 2024-11 at +26.7%. A year that misses those months is a losing year, and that is a normal
outcome rather than a malfunction.

**Expect long flat stretches, and understand they are the product.** Trend Regime is in cash 27%
of all months and in the market only 40% of the time. For the faster strategy the same instinct
shows up as damage avoided rather than as whole months skipped: Short-Term Channel on BTCUSDT 15m
returned −0.5%, −4.8% and +0.0% in 2025-11, 2026-02 and 2026-06, months in which simply holding
returned −17.5%, −15.6% and −20.6%. The rule that produces that also gives back a few percent in a
month that chops sideways. **That is the trade, and it cannot be had one-sided.**

**Give it enough history to warm up.** Trend Regime and the gated channel need 80 days *before*
they can trade at all. On the Backtest page's default 90-day range that leaves about twelve
tradeable days, and a run that reports "0 trades" on a short window is a warm-up problem, not a
broken strategy.

**Watch the readings rather than the price.** The app's **Backtest → Live** tab shows the same
quantities this document is about, updated every minute against live candles: the regime vote out
of four, the channel position against its 0.95/0.25 band, and one sentence on what has to change
for the strategy to act. It is the only view that distinguishes "flat and nowhere near a signal"
from "flat and one vote away" — which, given that these strategies act about nine times a year,
is most of what there is to watch.

---

## 9. What is not established, stated plainly

- **These are backtests.** No forward paper-traded evidence exists yet. The next real evidence is
  a paper Bot running forward in the app, where fills, latency and data gaps are whatever they
  actually are rather than whatever this engine models. That bot can now run — until 2026-08-30 it
  could not, because no Binance market data host was reachable from this region and every backtest
  and every bot dry run failed on it. Expect the evidence to arrive slowly even so, and for
  structural reasons rather than faults: Trend Regime takes about **9 trades per symbol per year**,
  a position opened before a bot was enabled is correctly not counted as that bot's, and dry runs
  only advance while the app is open. Weeks per round trip, not days.
- **Market impact is not modelled at all.** 2bps of slippage is generous for a four-figure order
  in BTCUSDT and meaningless for an order large relative to the book.
- **Held-out years have been negative.** 2025-08 → 2026-08: Short-Term Channel returned −12.1%,
  −12.8% and −19.4% on BTC/ETH/SOL, against holding's −29.3%, −45.4% and −47.8%. Losing half of
  what holding lost is a trend follower doing its job — but it is a loss, not a profit.
- **Choppy assets are where it fails**, and no filter here detects that in advance. LTCUSDT loses
  money over the full history for all three strategies. LINKUSDT returned +90% against holding's
  +955% — that pair is `trueoos.ts`'s pinned 2017-08 → 2023-08 window, not full history; measured
  to 2026-08 the same symbol is +512% against +1,930% (`stbroad.ts`, 4h). It underperforms holding
  badly on every window measured here, which is the claim; the margin depends on which one.
- **Half the mean comes from two symbols.** Remove SOL and XRP and the mean month falls from
  +3.04% to +1.67% for Trend Regime (−45%), +2.62% to +1.38% for the Channel (−47%) and +2.36% to
  +1.33% for the gated version (−44%). The per-trade margin does survive their removal (section 1),
  so the pair inflates the edge rather than constituting it — but any figure quoted from this
  family leans heavily on two coins that ran.
- **The ADX readout is not a gate.** Deploying only in months opening with ADX(14) ≤ 20 picks
  better months exactly as measured, but deploys in only 28% of them — and sitting out the rest
  costs far more compounding than the better months return ($44,960 against $165,625 for Trend
  Regime on six held-out symbols). It ships as a panel that tells you what the posture has
  historically meant, and nothing acts on it.

---

## Reproduce every number in this document

```bash
for s in edge shipped vshold tscan gap baseline fair stfinal stfinal2 shape trueoos; do
  npx esbuild research/$s.ts --bundle --platform=node --format=esm --outfile=research/.$s.mjs
  CANDLE_DIR=.candles node --max-old-space-size=4096 research/.$s.mjs
done
```

| script | what it establishes |
|---|---|
| `edge.ts` | section 1, the trades-per-year column in section 2, and the concentration/time-in-market figures in section 8 |
| `tscan.ts` | the one-threshold lookback sweep and the 1.5%-band result in section 2 |
| `gap.ts` | what closing Trend Regime's vote band costs, in section 2 |
| `baseline.ts` | the Bollinger Breakout trade count and outcome in section 2 |
| `shipped.ts` | section 7, and the held-out ranking in section 8 |
| `vshold.ts` | the six-symbol confirmation in section 7, and the ADX gate result in section 9 |
| `fair.ts` | the leverage sweep in section 8 |
| `stfinal.ts` | the held-out-year returns in section 9 |
| `stfinal2.ts` | the month counts and the top-three-months share in section 8 |
| `shape.ts` | the 0.70–0.97 correlation in section 8 |
| `trueoos.ts` | the LINKUSDT 2017-08 → 2023-08 pair in section 9 |

Only `edge.ts`, `shipped.ts` and `vshold.ts` default their candle directory; the other eight need
`CANDLE_DIR` set, and `fair.ts` exits with an unhelpful `path` TypeError without it — which is why
the loop above sets it for all eleven. They read the candle dumps in `.candles/` and the month dumps
in `research/.*.json`; if those are missing, `research/monthiv.ts` regenerates them.

**Two kinds of number live in this document, and only one of them is stable.** Figures from a
window pinned at both ends — sections 1 and 7, the held-out year, the 2017-08 → 2023-08 pair —
reproduce byte for byte and will keep doing so. Figures from a window that *ends wherever the
candles end* move every time the candle set is extended: the leverage returns, the month counts,
and everything in section 2 measured over full history. All figures here were re-run against
candles through **2026-08-28**, which is the date to compare against before treating any
disagreement as a bug.

Section 2 is worth a specific warning. Its numbers were the *least* reproducible in this document —
the lookback sweep disagreed in every row, and the vote-band claim had no script behind it at all
until `gap.ts` was written to check it. That claim turned out to be understated by two orders of
magnitude. If you are re-deriving anything here, start there.

Further detail: [README.md](README.md) for the full research narrative,
[research/README.md](research/README.md) for the study index,
[research/INTERVAL.md](research/INTERVAL.md) for how the bar sizes were chosen, and
[research/ADX.md](research/ADX.md) for the market-posture readout.
