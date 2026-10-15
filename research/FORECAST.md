# The price forecast, measured — V6's runs and its walk forward

V6 (13–15 October 2026) added a probabilistic price forecast per pair and horizon: five quantiles at
5 minutes, 15 minutes, 1 hour, 4 hours and 24 hours, calibrated, with news and the AI's readings as
adjusters, and a trade only where a fixed rule finds an edge after costs. This page holds what it was
measured to do and answers the four questions the V6 document's §115 asks of it.

The sources:

- **The walk forward** (Forecast Lab): the models refitted on the weeks before each tested week and
  scored on it. Fitted three times — for a short dry run at 04:38 UTC on 14 October, for the 12-hour
  run 23 minutes later, and for the check run at 00:15 on the 15th. The figures below are the 12-hour
  run's fit, `run-20261014-0501`: 40 pairs, every whole hour from 2026-09-23 06:00 to 2026-10-14
  04:00 UTC, about 19,900 outcomes at each horizon. Price and technical figures only: the free news
  feeds keep no archive. The pairs are today's research universe, so it carries survivorship bias.
- **The 12-hour paper run** (`s16`): 2026-10-14 05:10 to 17:10 UTC, real public data, the real
  models asked (three, the first gating), the forecast trader switched on (paper), settled 65 minutes
  for the last forecasts to come due. 1,212 forecasts of 28 pairs.
- **The 1-hour shadow run** (`s15`): 2026-10-14 02:25 to 03:25 UTC, the same set-up without the
  trader. 101 forecasts of 25 pairs.
- **A 2-hour check run on the fixed build** (`s16v`): 2026-10-15 00:32 to 02:33 UTC, OpenRouter faked
  (nothing spent), the trader on. 251 forecasts of 24 pairs.

## What the forecast does

**Its ranges are calibrated on average, and slightly better than a plain range.** On the walk forward
the 80% range held 75.6–80.2% of outcomes and the 50% range 46.2–50.6%, and the pinball loss was
0.8–2.0% lower than persistence's (the floor every model must beat), at every horizon:

| Walk forward | 80% range held | 50% range held | median's way right | skill over persistence | median error | calls (V2 / V1) |
|---|---|---|---|---|---|---|
| 5 min | 78.5% | 48.4% | 51.6% | +1.4% | 0.30% | 0 / 14 |
| 15 min | 80.2% | 50.6% | 50.5% | +1.5% | 0.45% | 0 / 0 |
| 1 hour | 77.7% | 49.1% | 50.0% | +1.3% | 0.87% | 0 / 0 |
| 4 hours | 75.6% | 46.2% | 49.9% | +0.8% | 1.85% | 0 / 0 |
| 24 hours | 78.6% | 50.4% | 52.1% | +2.0% | 4.88% | 0 / 0 |

The other two fits read the same within three points.

**It has no direction.** The median's sign was right half the time at every horizon, and P(up) did
not beat the base rate on the weeks before, so by the fixed class rule (P(up) at least 0.58 *and* a
skilful direction) the forecast shown made **no BULLISH or BEARISH call in about 98,000 tested
outcomes**. The price-only variant called a way at 5 minutes only: 78 times on the dry run's fit (67%
right), 14 on the 12-hour run's (8 right), none on the check run's — too few, and too unstable, to mean
anything.

**Its ranges are too narrow when the whole market moves at once.** On 14 October the U.S. CPI came in
hot at 12:30 UTC and Bitcoin fell from about $84,000 to below $82,000. Over the 12-hour run:

| 12-hour run | judged | 80% range held | 50% range held | median's way right | median error | bias |
|---|---|---|---|---|---|---|
| 5 min | 1,212 | 78.1% | 51.0% | 48.4% | 0.30% | −0.03% |
| 15 min | 1,212 | 73.8% | 44.2% | 52.5% | 0.48% | −0.08% |
| 1 hour | 1,212 | 73.6% | 46.5% | 46.9% | 0.88% | −0.29% |
| 4 hours | 353 | 50.7% | 34.6% | 24.5% | 2.04% | −1.71% |

The market went down through the 4-hour range (bias −1.7%). The next night, in the check run, a broad
sell-off between 01:30 and 02:30 UTC (Bitcoin −1%, ether −2.7%; PUMP −7.5% and PEPE −4.7% in the
hour; 75 scanner events in two hours) did the same at the short horizons: the 80% range held 64.1% at
5 minutes, 50.6% at 15 and 45.0% at an hour. The ranges widen with the volatility the bars show, so they
widen after a move has begun: they are least reliable in exactly the moves that matter most. In the
quiet 1-hour run they were too wide instead (89–94% held at 80%).

Every one of the 1,212 live forecasts called NEUTRAL (8 of them NEUTRAL / UNCERTAIN, their range over
three times their class's usual width), and so did all 251 of the check run's (3 UNCERTAIN). The plan
said, before anything was measured, that the forecast would read NEUTRAL most of the time; it read
NEUTRAL all of the time.

**The news and the AI moved almost nothing.** The four variants on the same moments (§49), live:

| 12-hour run, 80% range held | V1 price only | V2 + technical | V3 + news | V4 + news + AI (shown) |
|---|---|---|---|---|
| 5 min | 78.1% | 78.0% | 78.1% | 78.1% |
| 15 min | 71.6% | 73.6% | 73.8% | 73.8% |
| 1 hour | 71.8% | 73.6% | 73.6% | 73.6% |
| 4 hours | 50.7% | 50.4% | 50.7% | 50.7% |

The technical models add about two points of coverage at 15 minutes and an hour over price alone; the
news rules add a fraction of a point; the AI layer added nothing. The news analyst was switched on, but
it reads only a story rated impact 70 or more, or one whose price reaction is confirmed, and the day had
neither: its stories rated 48 at most, and all 24 reactions measured came out NONE (V4 is V3 where no
reading is on file). A story moved 215 of the
1,212 forecasts; those held their 1-hour range less often than the rest (65.6% against 75.3%), and their
4-hour range more often (55.7% against 48.8%, on 97 and 256). Without a library of thirty stories of a
kind, the news adjuster only widens a range, and that library is not there yet.

## Against the strategies (§50)

The Lab's comparison runs each strategy as its own backtest on the bars on file, over the window where
both strategies' warm-ups had passed (from 2026-10-03 12:00 UTC, 37 pairs; BAT, OP and S too young).
Net is the sum of each trade's percent, a fixed stake a trade, after a 0.24% round trip. It was run on
each of the three fits:

| | dry run's fit (14 Oct 04:38) | 12-hour run's fit (14 Oct 05:01) | check run's fit (15 Oct 00:15) |
|---|---|---|---|
| Window ends | 14 Oct 04:00, bars to 05:00 | 14 Oct 04:00, bars to 15 Oct | 15 Oct 00:00 |
| Trend Regime 4h | +6.2% (38 trades, PF 1.02) | −65.4% (38, 0.79) | −123.2% (38, 0.66) |
| Short-Term Channel 15m | −174.9% (37, 0.38) | −182.0% (37, 0.37) | −181.6% (37, 0.37) |
| Buy and hold, a round trip a pair | +162.7% | +145.2% | −28.5% |
| **The forecast trader, as the rules stand** | **0 trades, every horizon** | **0, every horizon** | **0, every horizon** |
| On the median alone, 1 hour (research) | +16.2% (92, 1.13) | +22.4% (52, 1.27) | −18.6% (43, 0.76) |
| Hybrid: the median's 1-hour trades where Trend Regime agreed | +18.8% (63, 1.21) | +23.9% (48, 1.32) | −3.5% (33, 0.94) |

"On the median alone" is a research row: the trader's rule without its direction gate, trading where
the median clears the round trip. Over each fit's whole three tested weeks:

| On the median alone, three weeks | dry run's fit | 12-hour run's fit | check run's fit |
|---|---|---|---|
| 1 hour | −78.7% (581, 0.87) | −59.3% (498, 0.89) | −15.1% (246, 0.95) |
| 4 hours | −1,014.9% (2,864, 0.68) | −821.7% (2,907, 0.73) | −539.4% (2,287, 0.78) |
| 24 hours | −157.7% (792, 0.90) | −316.9% (793, 0.81) | +291.5% (792, 1.22) |

The same rule over nearly the same weeks changes sign from one refit to the next (24 hours: −317%,
then +291%), and so do the 1-hour rows inside the window; buy and hold went from +145% to −28% as one more
day was read. Eleven days and one stake a trade are too few for any of these rows to be an edge. The
4-hour median alone lost on every fit.

## The four questions (§115)

1. **Is the forecast useful?** As a range, on average: it says how far a pair is likely to move,
   calibrated on three tested weeks and a little better than a plain range at every horizon — but too
   narrow in the first hour of a market-wide move, when it would matter most. As a direction, no: its
   median is a coin toss, and it never calls a way.
2. **Is it tradable?** No. As the rules stand it made no trade in three tested weeks on any of three
   fits, at any horizon, and none in fifteen live hours. No opportunity class can be approved, since one
   needs thirty replayed trades, so the forecast trader cannot open anything.
3. **Does it survive costs?** Nothing was traded by the rules to say. Traded on its median alone, after
   a 0.24% round trip, it loses at 4 hours on every fit, and elsewhere its result changes sign from one
   refit to the next: noise, not an edge.
4. **Does it survive live paper?** Not measurable: no paper trade in 12 hours, nor in the 1-hour and
   2-hour runs. Sample size is too small for a profitability conclusion.

So the forecast ships as a guide to how far a coin may move in calm conditions, and the forecast
trader, off by default, stays off. A direction it could trade would have to come from information it
does not have yet: the news library filling to thirty stories a kind, or a feature with a measured
edge.

## The gates

**The 1-hour run (§113):** every gate passed once its last forecasts had come due — forecasts at
4 of 4 quarter-hour closes, each stamped and made in time, 4 refreshes each naming its reason and the
forecast it replaced, 303 of 303 due horizons judged (2 by a line saying why they could not be),
every notice's sound on file, no duplicate event, no stream gap. No trade, so none on a stale
forecast.

**The 12-hour run (§114):** the session reports over the last hour, twelve hours, day and session
passed every gate that applies (14; fees, slippage and tracing not measured, with no trade). The
forecast's gates:

| Gate | Result | Why |
|---|---|---|
| Calibration recorded | pass | each of the 1,212 forecasts names its model run and its walk forward |
| Refresh linked | pass | each of the 200 refreshes (155 for volume, 62 for a price out of its range, some for both) names its reason and what it replaced |
| Every due forecast judged | pass | 3,986 of 3,986 due horizons |
| News correlation complete | pass | each of the 16 stories naming a traded coin measured to four hours |
| Every notice's sound on file | pass | 17 of 17 |
| Forecasts at every close | **fail** | 46 of 48: 08:00 and 08:15 missed — a data request stalled without a timeout in a network outage and held the pass |
| Stamped and in time | **fail** | 1: BNB made again at 15:55 from its 15:45 bars, the bars after them not read in an outage |
| History complete | **fail** | 7 pairs: single closes skipped where a pair's bars did not come (QNT and STRK at 13:45 in an outage, SOL at 14:30, LTC at 15:00), and LINK, ADA and BAT, which left the research's pairs for hours and came back, counted as skipping every close between |
| No trade on a stale forecast; every trade whole | not measured | no trade |
| Paper P&L | 0 | no trade by the forecast trader, the watch or the news rules |
| AI cost and latency | recorded | below |

This machine's network failed about six times that day (the data host's name would not resolve).
The experiment's own `long_gaps` gate failed on two stream gaps over three minutes from the same
outages. The three forecast failures each led to a fix:

- `856170b`: a page of bars is waited for 15 seconds at most, so a stalled request fails its pair,
  not the pass and the closes after it; and no forecast is made again from bars more than a close old.
- `5be8789`: each recorded close writes the pairs its pass held bars for, and the history gate wants a
  pair only where its pass held it, from its first forecast on. The old rule (first to last) counted a
  coin that left the research's pairs as skipping; nearly every long run would have failed it. Over
  the 12-hour run the forecast's pairs went from 24 to 19 and back to 25 as coins crossed the $20
  million floor: ONDO and INJ left for good, TAO, WAL and PUMP joined.

**The check run on the fixed build (`s16v`):** every forecast gate that applies passed — forecasts at 8
of 8 quarter-hour closes, each stamped and made in time, each of the 24 pairs at every close its pass
held bars for, 71 refreshes linked, 730 of 730 due horizons judged, every notice's sound on file — and so
did the session reports' and the experiment's own gates, with no stream gap. The watch's two paper
trades in it came from faked answers and are not a result.

**An outage, made on purpose:** no outage came during the check run, so on a copy of its profile one
pair's bar requests (SOL's) were made to hang until their own signal ended them, as the 14th's had. The
04:00 and 04:05 closes were each forecast for the other 25 pairs, the passes done in 34 and 23 ms after
the data's; SOL was left out, not forecast from stale bars; each of its 6 stalled requests ended on its
15-second timeout; and once its requests answered, SOL was forecast again at the 04:10 close.

## What the runs found and what was fixed

| Found by | What | Fix |
|---|---|---|
| 1-hour run | a notice's sound was dropped when the alert went on file (since Stage 13) | `9edee9c` |
| 1-hour run | the report judged a run's forecasts only to its end, so the last hour's were never wanted judged | `0027282` |
| 1-hour run | a pair that left the research stopped being brought up to date, so its last forecasts went unjudged | `c5ddd38` |
| 1-hour run | the report called an outcome missing ten minutes after due; the engine waits an hour for its bars | `c5ddd38` |
| 12-hour run | a stalled data request held the whole pass; a refresh restated stale bars | `856170b` |
| 12-hour run | Home said "no live price newer than ten seconds" beside the live price it showed; the trade decision was the pass's, made on the books the stream held then (the pairs on screen), so the forecast trader could never have traded a pair off screen | `d6d4cdc` |
| 12-hour run | the forecast trader's own pairs were not streamed, as the watch's are | `d6d4cdc` |
| 12-hour run | the history gate counted pairs that left the universe | `5be8789` |
| 12-hour run | the sidebar, collapsed by hand mid-run, hid the pages' names from the harness, so the Lab's comparison did not run (it was run afterwards on a copy of the run's profile) | `d6d4cdc` (harness) |
| check run | the analysis stopped at a coin with a Chinese name, its output's code page unable to hold it | `c514d80` |
| check run | a faked run left its emptied key file in its scratch profile (only ever a placeholder key) | the harness deletes it at the end |

Seen and left as they are: the first model's BUY or SELL is told as a TRADE OPPORTUNITY notice even
when the vote then refuses the trade (by design, so the call is not lost); Arabic money reads
"$US 211.03" by its locale's own rule.

## The models' calls and their cost

| Run | calls | answered | valid | latency, median / 95th | spent |
|---|---|---|---|---|---|
| 1 hour | 4 | 4 | 4 | 16.1 s / 19.2 s | $0.0445 |
| 12 hours | 4 | 4 | 4 | 9.5 s / 13.9 s | $0.0454 |

The scanner raised two events in twelve hours; the one in the watch's band (TIA's urgent breakdown at
05:55) drew SELL from gpt-5-mini at 72% and HOLD from the other two, so the vote refused it. The fourth
call was the daily summary. **$0.0899 of the $3 ceiling** for both runs together; the check run asked
nothing real. The encrypted key and the Local State that unlocks it were copied into each real run's
scratch profile and deleted after it closed; no scratch profile holds a key file now.
