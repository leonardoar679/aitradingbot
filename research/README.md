# research/

Throwaway tooling used to build `src/backtest/strategies/trendRegimeEnsemble.ts`. Not part of the
app, not covered by either `tsconfig`, not imported by anything in `src/` or `electron/`. Kept so
the numbers in the README's strategy table can be re-derived rather than taken on trust.

## Method

The thing this tooling is actually for is **not** finding a profitable backtest. Iterating on a
backtest until it prints a profit always succeeds and means nothing, and this app can place real
orders, so a curve-fitted strategy here has a route to real money. Three rules were applied:

1. **The last year was held out.** `SPLIT_AT` is 2025-08-27. Every parameter decision was made
   against 2023-08 → 2025-08 only. The holdout was scored once, at the end, after the strategy
   file was written.
2. **Measure before designing.** `probe.ts` establishes what edge exists in the data (fee vs. bar
   size, return autocorrelation, forward return by trend state) *before* any strategy is written.
   Every constant in the shipped strategy answers one of those measurements.
3. **Prefer the plateau to the peak.** The best single sweep result was `+242%` from a config
   taking 8 trades in two years. It was rejected: the argmax of a sweep is the point with the
   least statistical support, and the surrounding parameter surface was non-monotonic. The shipped
   thresholds are unanimity and one-quarter — natural values, not fitted decimals.

`padWarmup` in `harness.ts` exists because of a real error found mid-study: the engine anchors its
buy & hold benchmark at `warmupBars`, so candidates with different lookbacks were being scored on
different windows against different benchmarks. A leave-one-out test read as though dropping the
slowest lookback nearly doubled the return; once windows matched, most of that vanished
(`+242%` → `+162%`). Every comparison after that point pins all candidates to one window.

## Running it

Candles are not committed — `fetch.mjs` downloads them from `data-api.binance.vision` (Binance's
public market-data mirror; `api.binance.com` is geo-blocked from some regions, including wherever
this was run).

```bash
node fetch.mjs '[["BTCUSDT","15m"],["ETHUSDT","15m"],["SOLUSDT","15m"],["BTCUSDT","3m"],["ETHUSDT","3m"]]'

npx esbuild research/final.ts --bundle --platform=node --format=esm --outfile=research/.final.mjs
CANDLE_DIR=<dir with the json> node --max-old-space-size=4096 research/.final.mjs
```

| File | What it does |
|---|---|
| `fetch.mjs` | Paginates 3 years of klines, dedupes, writes `SYMBOL-INTERVAL.json` |
| `harness.ts` | Loading, the train/holdout split, `padWarmup`, result table |
| `probe.ts` | The pre-design measurements: fee vs. bar size, autocorrelation, trend persistence |
| `families.ts` | Candidate shapes that were tried and mostly rejected (band, donchian, asymmetric, ensemble) |
| `baseline.ts` | Reproduces the three shipped strategies losing money on 15m |
| `sweep*.ts` | The tuning passes, train-only |
| `final.ts` | The one holdout scoring — the table in the README |
| `eth3m.ts` | ETHUSDT 3m, which finished downloading after the design was locked |
| `diag.ts` | What costs the two strategies money, measured before anything was changed |
| `conc.ts` | How many entry events the one-position-at-a-time engine never reaches, and what they were worth |
| `slots.ts` | N concurrent positions under two sizing rules, checked against the engine at N = 1 |
| `oostop.ts` | The holdout, scored once, for the only candidate that survived training |
| `fetch.mjs` | **Recreated.** Paginates klines from data-api.binance.vision into `SYMBOL-INTERVAL.json`. The original was never committed and the whole candle set went with it, so every study here was unreproducible until this came back |
| `bear.ts` | Is the bull/bear premise true? Calendar years, plus return decomposed by market regime in log terms |
| `shortside.ts` | Would a mirrored short leg pay? Symmetric simulator, checked against the engine with shorts off |
| `regime.ts` | First cut of the regime attribution, in dollars. Kept because its bug is instructive: dollar attribution on a compounding account reports when a regime happened, not how the strategy did in it |
| `chop.ts` | Four entry filters against the chop band, selected on 2017-2021 and scored once on 2022-2026 |
| `stcgate.ts` | Whether the shipped file reproduces what `chop.ts` measured for it. It did not, and the filter was reverted |
| `ivfair.ts` | Which interval, on a window pinned by tradeable time rather than by slice date |

## What the study did not establish

One asset class, one 3-year window containing a major bull run, on five series that are highly
correlated with each other — BTC/ETH/SOL do not fail independently, so "it worked on three
symbols" is weaker evidence than it looks. The holdout contains roughly 10 trades per series. Fills
are modelled at the signal bar's close with no slippage and no order book, which flatters any
strategy. None of that is fixed by more backtesting.

## Round 2: the broad validation

The first round tested 3 years on 5 series. That was too little to conclude anything, so the
second round pulled the whole of Binance's history for eight pairs across five timeframes
(`fetchlong.mjs`, which is `fetch.mjs` with a `START_DATE` env var and the `1d`/`1h` entries the
first version's interval table was missing — that bug silently capped every download at one
1,000-candle page).

| File | What it establishes |
|---|---|
| `broad.ts` | Same strategy, every timeframe and every symbol, full history |
| `byyear.ts` | Calendar-year breakdown — where the losing years are |
| `fair.ts` | Timeframe comparison on an identical tradeable window, and the leverage sweep |
| `portfolio.ts` | Whether blending symbols buys enough drawdown reduction to matter (it does not) |
| `trueoos.ts` | 2017-2023, before tuning began: the cleanest test available |
| `oostf.ts` | The same out-of-sample window across timeframes, and all four strategies compared on it |

Short-term round (`shortTermChannel.ts`):

| File | Question it answers |
|---|---|
| `gap.ts` | What the vote band in the shipped Trend Regime is worth. Written because STRATEGIES.md section 2 asserted a figure for it that no script here produced -- the claim was believed rather than measured, and it was understated by two orders of magnitude |
| `tscan.ts` | **The one that mattered.** Sweeps the trend lookback from a quarter-day to 50 days to find where net-after-fees crosses zero — the test the first short-term study should have run |
| `stgrid.ts` | Channel-position ensemble across lookback sets and thresholds; 288 cells, all positive |
| `stfinal.ts` | Held-out year, true out-of-sample 2017-2023, and head-to-head against the shipped slow strategy |
| `stfinal2.ts` | Per-era comparison, month-by-month, rolling 6-month windows, starting-balance invariance |
| `stbroad.ts` | Nine symbols at full history, year-by-year, and whether running both strategies beats either |
| `stwhich.ts` | The two shipped trend strategies head to head per symbol, on matched windows |
| `stmonthly.ts` | Month by month over 3 years on seven series, with buy & hold per month and year totals |
| `stjson.ts` | The same report as JSON, so a write-up embeds measured numbers instead of re-typed ones |

Two traps caught in this round specifically. **The engine will not open a position without a stop
price** (`signals.stopPrices[i] !== null`), so the first version of `tscan.ts` — which passed
`null` to mean "no stop" — produced a table of clean `0.00%` rows across every lookback and
timeframe that read exactly like a finding and was a harness bug. A stopless trend follower is not
expressible here; "no stop" has to be a deliberately unreachable one. And **voting across Donchian
channels is vacuous**, which is not obvious and looks like the natural way to avoid picking a
lookback: the channels are nested, so "breaks k of the four highs" is just "breaks the k-th
slowest high". `stgrid.ts` averages the *position within* each channel instead, which is not
nested and so is genuinely an ensemble.

The windowing trap caught earlier came back twice in this round and is worth naming again,
because it is not obvious and it flatters whichever variant has the shorter warmup: comparing
timeframes by slicing each from the same *date* gives them different *tradeable* starts, since an
80-day warmup on 15m data that begins in August cannot trade until November. `fair.ts` slices so
the tradeable window matches instead, which moved the daily result from +207% to +141% and turned
"daily is best" into "daily is worst". Any comparison in this directory that does not pin the
window should be assumed wrong.

## What still has not been established

Everything here is spot, long-only, one position at a time, on USDT pairs from a single exchange,
filled at a bar close with 2bps of slippage and no market impact. The strategy has never placed an
order. The next real evidence is a paper Bot running forward in the app, where fills, latency and
data gaps are whatever they actually are rather than whatever this engine models.

That bot could not run at all until 2026-08-30, and the reason is worth recording because nothing
in this folder would have surfaced it. Every script here reads candle files from `.candles/`, which
were fetched from `data-api.binance.vision`; the app fetched from `api.binance.com` and
`api.binance.us`, both unreachable from this region. So the research was healthy and the app was
dead on the same data, and the gap was invisible from inside either one. Measured in the app's main
process, attempting `api.binance.us` also breaks every *subsequent* HTTPS request in that process --
`api.binance.com` went from answering 451 in 1.2s to failing outright in 10.6s once it had been
tried -- so the two-host list could never fail over. Fixed in `electron/services/exchanges/binance.ts`.

Set expectations for how fast forward evidence can accumulate. Trend Regime takes about **9 trades
per symbol per year** at 4h. A dry run only advances while the app is open, and a position the
strategy opened *before* a bot was enabled is deliberately not counted as that bot's. The first
paper round trip is weeks away, not days, and a month of silence is the expected reading rather
than a fault to debug.
