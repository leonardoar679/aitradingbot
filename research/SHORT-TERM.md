# Short-term trading: what was measured, and why nothing shipped

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

Until at least the first of those exists, short-term trading in this app loses to its own costs,
and the honest place to put capital is the multi-week trend strategy that already ships.
