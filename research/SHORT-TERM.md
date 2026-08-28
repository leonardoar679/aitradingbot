# Short-term trading: what was measured, and why nothing shipped

> ## CORRECTION — the conclusion below was wrong, and the reason is the useful part
>
> This file originally ended with "short-term trading in this app loses to its own costs". That
> was overreach. A short-term strategy **was** subsequently found, validated and shipped as
> `src/backtest/strategies/shortTermChannel.ts`: on 2017-2023 data that no parameter had seen it
> returns +1,294% on BTCUSDT 1h against buy & hold's +252%, at less than half the drawdown.
>
> **The error was in the instrument, not the arithmetic.** Everything below measures *mean forward
> return at a fixed horizon* after some condition — 1h and 4h after dips, volume spikes,
> volatility quartiles, each hour of the day. That test cannot detect a trend-following edge even
> when one is present. A trend follower does not earn a positive mean at a fixed horizon; it earns
> from an **asymmetric exit over a variable holding period**, being wrong often and small and right
> occasionally and large. Every strategy in this app wins under half of its trades. Fixed-horizon
> means can only ever find mean reversion, so "nothing clears the fee at 1h" was a true statement
> that did not support the conclusion drawn from it.
>
> Re-measured as a trend sweep (`research/tscan.ts`), a moving-average trend follower on BTCUSDT
> 15m goes from −99.98% at a quarter-day lookback to +61% at 20 days — but adding a 1.5%
> hysteresis band makes the *quarter-day* lookback profitable too (+32.9%), because the band cuts
> the trade count fivefold. **The binding constraint was never the trend horizon; it is the trade
> count.** That single correction is what made a short-term strategy possible.
>
> What stays true below: the fee wall is real, a stop destroys a holding-period strategy, and the
> single-position engine still throws away ~94% of a signal that fires 2,585 times. The dip edge
> itself was never the problem — the way it was harnessed was.

A short-term strategy was researched to the same standard as Trend Regime Ensemble and **was not
adopted**. This file records the measurements so the next attempt starts from evidence rather than
from scratch — the same reason `rsiReversion.ts` records why it is left broken instead of retuned.

Reproduce with `research/stprobe.ts`, `stprobe2.ts`, `dip.ts`, `dipsweep.ts`, `dipsweep2.ts`,
`dipvalidate.ts`, `dipfee.ts`.

## The wall every short-term idea hits

A round trip costs **0.240%** — 0.2% fee plus 0.04% slippage. The average 15m candle moves 0.16%.
So a strategy holding for minutes-to-hours must extract more than one-and-a-half typical bars of
movement, per trade, after being right about direction.

Measured on 3 years of BTCUSDT 15m, forward returns by condition. Everything at a **1h or 4h**
horizon loses to the cost — every row, without exception:

| Condition | horizon | mean | after cost |
|---|---|---|---|
| after −1% in 1h | +1h | +0.080% | −0.160% |
| after −1% in 1h | +4h | +0.137% | −0.103% |
| volume ≥ 3× its 24h average | +4h | +0.022% | −0.218% |
| wildest volatility quartile | +4h | +0.057% | −0.183% |
| UTC hour 18:00 (the best hour) | +4h | +0.070% | −0.170% |

Time-of-day, volume spikes and volatility regime were all tested and none of them survives the
fee. That is the honest reason this app has no scalping strategy.

## The one real edge: buying dips, held about a day

At a **24h** horizon a genuine effect appears, and it survives the control that matters — the
excess over what an arbitrary 24h hold earned in the same window (BTC drifted +0.129% per 24h over
this period, so a raw mean means nothing on its own):

| BTCUSDT 15m | mean 24h | excess over baseline | t |
|---|---|---|---|
| dip ≤ −0.5% in 1h | +0.302% | **+0.173%** | 5.9 |
| dip ≤ −1% in 1h | +0.641% | **+0.511%** | 8.5 |
| dip ≤ −2% in 1h | +1.244% | **+1.115%** | 6.5 |
| dip ≤ −3% in 1h | +1.778% | **+1.649%** | 4.2 |
| pop ≥ +1% in 1h | +0.202% | +0.073% | 1.3 |

Monotonic in dip depth, strongly significant, and asymmetric — pops give nothing, so this is
dip-buying rather than drift. It replicates on ETH (t=4.3) and SOL (t=7.1).

**It is also regime-dependent**, which is the first warning. Split by era on 1h candles, the
excess after a −1% dip:

| era | excess | t |
|---|---|---|
| 2017–2019 (incl. 2018 bear) | +0.209% | 1.3 |
| 2020–2021 (bull) | +0.319% | 2.0 |
| 2022–2023 (bear) | +0.104% | 0.5 |
| 2023–2026 | +0.594% | 5.1 |

The effect is strongest in exactly the window most looked at, and nearly absent in a sustained
bear. Buying dips works when the market recovers.

## Why the edge does not become a strategy

Built as `research/dip.ts` — dip entry, holding-period exit, trend filter — and swept on the
training years only. Two findings, then the verdict.

**A stop destroys it.** Holding period caps the winners while a stop lets losers run, which is the
truncation backwards. Measured, dip −1% / hold 24h:

| stop | net |
|---|---|
| ATR×1.5 | −38.1% |
| ATR×3 | −31.1% |
| ATR×6 | −7.9% |
| none | **+4.6%** |

**Only ~6% of the signal is capturable.** There are 2,585 dip signals in 3 years, and the engine
holds one all-in position at a time, so the best configuration takes **146** non-overlapping
trades. The measured per-signal excess never reaches the account because the account is already
busy. Exploiting a signal that fires 2,585 times needs concurrent positions and position sizing,
which this engine cannot express at all.

### The verdict

Best configuration (dip −1%, hold 48h, above the 30-day MA, no working stop):

| | train | **held-out year** | 3 years | buy & hold |
|---|---|---|---|---|
| BTCUSDT | +16.2% | **−8.3%** | +6.6% | +121.7% |
| ETHUSDT | +58.3% | **−9.1%** | +43.9% | +26.1% |
| SOLUSDT | +99.1% | **−20.4%** | +58.2% | +76.8% |

Negative on the holdout for all three, exactly as the era table predicted — the held-out year was
a downtrend. Month by month on BTC: 15 up, 14 down, 8 flat, and **the single best month
contributed 3,908 of a 655 total profit**, meaning everything else together lost money. The top
three months are 65% of all profit.

Even at **zero fees** BTC returns +42.7% against buy & hold's +121.7%, so this is not a cost
problem that a better fee tier fixes:

| per-side fee | BTC | ETH | SOL |
|---|---|---|---|
| 0.100% (shipped) | +6.6% | +43.9% | +58.2% |
| 0.040% (BNB discount) | +26.9% | +79.2% | +109.2% |
| 0.020% (maker) | +34.6% | +92.7% | +129.6% |
| 0.000% | +42.7% | +107.3% | +151.9% |

## What would have to change

Not parameters. Three structural things, in order of how much they matter:

1. **Concurrent positions with sizing.** The single largest loss is throwing away 94% of the
   signals. This is an engine limitation, not a strategy one.
2. **Maker fills.** A dip entry is a natural limit order — it is *already* below the market — so
   the fee could be the maker tier rather than the taker one. That roughly quadruples the net on
   ETH and SOL above, though it does not save BTC.
3. **A shorting leg.** The edge is regime-dependent because the strategy can only be long. The
   2022 column is where a long-only dip buyer catches falling knives.

Until at least the first of those exists, *this dip-buying shape* loses to its own costs. That is
not the same claim as "short-term trading loses to its own costs", which is how this paragraph
originally read and which the correction at the top of this file retracts — see
`research/tscan.ts` and `research/stgrid.ts` for the trend-shaped version that works.
