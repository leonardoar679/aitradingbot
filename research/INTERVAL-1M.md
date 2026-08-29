# Should Short-Term Channel's default interval become 1m?

**Written before the eight-symbol result was visible.** Only BTCUSDT and ETHUSDT had printed, and
both were already known from the three-symbol run in `strategies/types.ts`. The five symbols that
decide this — ADA, BNB, LINK, LTC, XRP — had not.

This file exists because the three-symbol version of this question has already produced two
conclusions that had to be retracted, and because a rule chosen after seeing eight symbols is not a
rule, it is a description.

## The question

`shortTermChannel.preferredInterval` is `15m`. It sets the default interval on the Backtest page,
the Add Bot dialog and Routines, and it is what a live bot actually polls. Three symbols say 1m
earns more (BTC $7,479 → and ETH $10,104 → at 15m, both higher at 1m; SOL prefers 3m). `types.ts`
records this as **NOT YET ACTED ON, because it is three symbols.**

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

## Result

Recorded in `strategies/types.ts` once the run completes, against the rule above and not against a
rule chosen afterwards.
