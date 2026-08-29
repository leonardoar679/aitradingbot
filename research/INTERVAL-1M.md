# Should Short-Term Channel's default interval become 1m?

**Written before the deciding symbols were visible, and this paragraph was corrected to say that
precisely.** The first version claimed only BTC and ETH had printed. By the time it was committed
the Short-Term Channel rows visible at 1m were BTC, ETH **and SOL** — all three already recorded
in `strategies/types.ts` from the earlier three-symbol run, so none of them is new information.
ADA's *Trend Regime* row had also printed; Trend Regime is not the subject of this decision and
cannot take a 1m default in any case, for the polling reason below.

No Short-Term Channel row had printed for **ADA, BNB, LINK, LTC or XRP** — the five that decide
the rule. That is the claim that matters, and it holds.

This file exists because the three-symbol version of this question has already produced two
conclusions that had to be retracted, and because a rule chosen after seeing eight symbols is not a
rule, it is a description.

## The question

`shortTermChannel.preferredInterval` is `15m`. It sets the default interval on the Backtest page,
the Add Bot dialog and Routines, and it is what a live bot actually polls. On the three symbols
measured so far, 1m beats 15m on two: BTC $6,871 → $7,479 and ETH $10,104 → $12,694, while SOL
goes $17,958 → $17,667 and in fact peaks at 3m ($19,710), an interval that cannot be assigned.
`types.ts` records this as **NOT YET ACTED ON, because it is three symbols.**

1m is the only finer interval that is actionable at all: `Interval` in `shared/ipc.ts` is
`'1m' | '15m' | '1h' | '4h' | '1d' | '1w'`, so 3m and 5m cannot be assigned to `preferredInterval`
without changing the type, `INTERVAL_SECONDS`, and every exchange adapter's non-partial
`Record<Interval, …>`.

## The rule, fixed in advance

Change the default to 1m **only if both hold** over 36 independent $10,000 months, eight symbols:

1. **Total profit at 1m beats 15m on at least 6 of 8 symbols.** Six of eight is the same bar
   `research/enhance.ts` used (≥3 of 4 on each half of a pre-registered split), applied to the
   whole set rather than a new threshold invented for this question.
2. **The median worst month across the eight is no worse at 1m than at 15m.** A default that earns
   more by risking more is not an improvement to hand a user who did not ask for it.

If profit passes and risk fails, or the reverse, the default **stays at 15m** and the split result
is recorded. There is no tie-break, deliberately: an interval change that needs one is not
supported by the evidence.

## A constraint the backtest cannot see, and it binds harder

`src/bots/useDryRun.ts` re-fetches the **entire warm-up window on every poll**, and `POLL_MS` is
60 seconds. The window is `max(LOOKBACK_CANDLES, warmupBarsFor(interval) + 120)` bars, paged from
the exchange 1,000 at a time.

| strategy | warm-up | bars fetched per poll at 15m | at 1m | requests/poll at 1m |
|---|---|---|---|---|
| Short-Term Channel | 8 days | 888 | 11,640 | 12 |
| Trend Regime Ensemble | 80 days | 7,800 | 115,320 | **116** |
| Short-Term Channel + Regime | 80 days | 7,800 | 115,320 | **116** |

So this decision is only ever available to Short-Term Channel. Twelve paged requests per bot per
minute is tolerable; **116 is not** — several bots would exhaust Binance's per-minute weight budget
and start failing, which presents to the user as a broken bot rather than a rate limit.

That is a property of how the app polls, not of the strategies, and it is worth stating plainly:
**no strategy carrying an 80-day look-back can have a 1m default until the dry run fetches
incrementally instead of re-fetching its whole window every minute.** Changing `preferredInterval`
on either regime strategy today would ship a bot that hammers the exchange and stalls.

## Result: rejected. The default stays at 15m.

Short-Term Channel, 36 independent $10,000 months, eight symbols:

| | 1m | 15m | | worst month, 1m | 15m |
|---|---|---|---|---|---|
| BTC | **$7,479** | $6,871 | 1m | −12.3% | −13.5% |
| ETH | **$12,694** | $10,104 | 1m | −18.8% | −15.9% |
| SOL | $17,667 | **$17,958** | 15m | −24.9% | −29.3% |
| ADA | $13,273 | **$15,976** | 15m | −13.5% | −13.7% |
| BNB | **$4,253** | $2,551 | 1m | −16.1% | −18.2% |
| LINK | $5,092 | **$6,481** | 15m | −28.1% | −23.3% |
| LTC | **−$4,167** | −$5,903 | 1m | −15.4% | −17.0% |
| XRP | **$17,883** | $17,053 | 1m | −18.0% | −24.1% |

**Condition 1 fails: 1m wins on 5 of 8, and the rule required 6.** Condition 2 passes — the median
worst month is −17.01% at 1m against −17.60% at 15m, marginally better. A split result leaves the
default alone, as fixed in advance, so `preferredInterval` stays `15m`.

The three-symbol result did not replicate. It looked like 2 of 3 for 1m; the five symbols that had
no part in raising the question split 3–2 the other way on the two that mattered most (ADA and LINK
both prefer 15m by wide margins), and the aggregate lands one symbol short of the bar. Had the rule
been written after seeing this, "5 of 8 and better median risk" would have been easy to accept.

## The same question for the other two strategies, since the run answered it anyway

| strategy | 1m wins profit on | median worst month, 1m vs 15m | verdict |
|---|---|---|---|
| Short-Term Channel | 5 of 8 | −17.01% vs −17.60% | stays 15m (fails 6-of-8) |
| Short-Term Channel + Regime | 4 of 8 | −16.82% vs **−14.55%** | stays 15m, fails both |
| Trend Regime Ensemble | **2 of 8** | −20.31% vs **−19.17%** | stays 15m, fails both, decisively |

Trend Regime's result is the mechanism prediction confirmed on eight symbols rather than three:
finer sampling makes a hysteresis rule cross its own band more often, its trades per month roughly
double (1.2–2.6 at 15m against 3.6–5.1 at 1m), and each extra crossing costs 0.24%. It loses money
at 1m on six of eight symbols *and* has a worse median worst month, which is the clearest single
result in this file.

**So 15m is correct for all three strategies, and nothing needs to change.** That is the answer to
"which candle interval", and it is worth more than a change would have been: the interval question
has now been asked at 1m, 3m, 5m, 15m, 1h, 4h and 1d, on eight symbols, and 15m survives all of it.
