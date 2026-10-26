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
trader, off by default, stays off. Since V6.1 (below) its ranges are widened after a sharp move of
Bitcoin's, at the horizons where the walk forward shows that helps. A direction it could trade would
have to come from information it does not have yet: the news library filling to thirty stories a kind,
or a feature with a measured edge.

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
| rehearsal | Home counted four of the profile's five paper strategies: its grid of 13 August, from before executors had a mode, has none and runs as paper | `770f0f0` |
| rehearsal | the watch's paper trade was refused on a price 17 seconds old: the book was read beside a request for thirty days of candles that timed out after ten seconds, and judged after it; the book is read after the slower reads now | `c88b418` |
| rehearsal | the harness never marked its window as a test, as the check windows are | `fa6a99b` (harness) |

The first model's BUY or SELL was told as a TRADE OPPORTUNITY notice even when the vote then refused
the trade. Since 15 October the notice rings only for a side the vote takes, in the name of the surest
model on it; a refused call stays on the Watch card and on file. Arabic money reads "$US 211.03" by its
locale's own rule, and is left as it is.

## After V6: the ranges after a sharp Bitcoin move (V6.1, 15 October 2026)

`research/rangeLag.ts` set every tested hour's range beside what the market was doing at its moment
(walk forward `run-20261015-0015`, 41 pairs, three weeks):

- Most of the ranges' misses come from moves that begin after the forecast is made. When Bitcoin moved 3
  or more of its usual moves during the horizon, the 80% range held 26-41% at every horizon, and no range
  set at the forecast's moment can know that.
- What is known at the moment is Bitcoin's last fifteen minutes. After 2.5 or more of its usual moves (14
  moments in three weeks), the 80% range held 72.5% at 5 minutes, 71.8% at 15, 63.3% at an hour and 79.9%
  at four.
- Widened by factors fitted on the other weeks (one for the outer pair of levels, one for the inner),
  those moments held 79.7%, 80.7%, 79.3% and 80.2%, with the pinball loss a little higher at 5 minutes,
  a little lower at 15 minutes, 2.7% lower at an hour and a little higher at four.
- The whole market's last fifteen minutes fired only 5 times in three weeks and over-widened; it is not
  used.

So each refit now fits that widening per horizon and adopts it only where, cross-fitted, the 80% range
of those moments comes nearer 80% and their pinball loss is no worse (`shared/forecast/shock.ts`; at least
eight moments and 150 rows). Live, Bitcoin's figure is read at each close from its own bars, and between
closes from its minutes, a crossing making every pair's forecast again.

**The in-app check** (9 of 9, on a copy of the check run's profile, OpenRouter faked):

- The walk forward on file, made before the rule, was calibrated again with no rule, and nothing was
  widened.
- A fresh fit (`run-20261015-0611`) kept Bitcoin's moves and adopted the rule at an hour (64.1% to 79.0%
  held, pinball 0.4191 to 0.4090) and at a day (73.8% to 79.7%, 0.3821 to 0.3808). It refused it at 5
  minutes (pinball worse), at 15 (pinball worse by 0.0002) and at four hours (80.6% already).
  `research/rangeLag.ts` reads the same record to the same figures at 5 minutes, an hour and four hours.
- One of Bitcoin's bar pages faked to fall 3% into the 06:45 close widened the hour's and the day's
  ranges of all 24 pairs, and no other horizon. The record kept their V2 levels and the factors.

The 15-minute verdict changed between two fits six hours apart, which is why the rule is judged again
at every refit rather than fixed. Its evidence is still thin: 14 moments in three weeks.

### The rule in a live afternoon (the rehearsal of 15 October 2026)

A three-hour rehearsal of the user's own profile's next launch (its settings, bots and executors copied
to a scratch profile, never its keys; OpenRouter faked; `FROM_PROFILE` in `scripts/shadow-run.mjs`) ran
from 13:12 to 16:14 UTC, and Bitcoin moved while it did: down 1.0% in fifteen minutes at 13:54, up 1.35%
at 14:10, and up 2.4% between 13:45 and 15:15, NEAR up 9% in an hour. The fit at launch
(`run-20261015-1317`, 27 pairs, 155,438 rows, three minutes, the walk forward seven) adopted the rule at
5 minutes (73.1% to 79.4% held, pinball 0.7035 to 0.7023), at an hour (58.9% to 79.1%, 0.4569 to 0.4424)
and at a day (75.7% to 80.3%), and refused it at 15 minutes (pinball worse by 0.0003) and at four hours
(82.3% held already). Bitcoin's figure was past the line from 13:40 to 14:20 and again at 14:45, up to
6.96, so 260 forecasts were made again for it and 293 of the run's 563 forecasts were widened. Judged by
their outcomes, the Lab's live count and `shared/forecast/forecastRecord.ts`'s record agreeing:

| Horizon | widened, judged | 80% range held, widened | the same, unwidened | 50% held, widened | unwidened | calm forecasts, 80% held |
|---|---|---|---|---|---|---|
| 5 minutes | 293 | 75.8% | 65.9% | 35.5% | 30.4% | 75.2% of 270 |
| 15 minutes (refused) | 0 | | | | | 54.2% of 535 |
| 1 hour | 293 | 39.6% | 15.4% | 10.9% | 6.8% | 25.6% of 160 |

The widening helped wherever it applied and more than doubled the hour's coverage, but a range sized for a
usual hour does not hold an hour in which Bitcoin rises 2%: the 1-hour forecasts made from 13:50 to 14:05,
into the rise, held 10-18% even widened; those made at 14:15, 14:20 and 14:45, once the rise was under way,
held 43%, 62% and 72% against 14%, 8% and 28% unwidened. This is one episode, not a verdict on the rule:
its walk forward's fourteen moments held 79% widened at an hour, this one 40%. The 15-minute verdict has
now turned on 0.0002-0.0004 of pinball at three fits in a row (refused, adopted, refused); whether the rule
should carry a tolerance there is the user's call. The 4-hour and 24-hour outcomes were not due before the
run closed.

## The market's shock states (V7.1 Stage 11, 16 October 2026)

V6.1 widens every range after one thing, Bitcoin's last fifteen minutes past 2.5 of its usual moves. The
rehearsal of 15 October showed its limit: a range sized for a usual hour does not hold an hour in which
Bitcoin rises 2%, and the forecasts made into the rise held 10-18% even widened, those made once it was
under way 43-72%. A market has more states than calm and that one moment. Stage 11 tells six apart from
what is known at the moment (`shared/forecast/marketShock.ts`), with lines fixed before anything was
measured by them: NORMAL; PRE_EVENT (within the hour before a scheduled release, Stage 12's calendar);
POST_EVENT_SHOCK (the sharp fifteen minutes, a break from forty-five minutes that were not a trend);
TRENDING_SHOCK (the same sharp fifteen minutes with the forty-five before them already at or past 2.5 of
their usual moves the same way); LIQUIDATION_SHOCK (a sharp fall, the breadth of the last fifteen minutes at
or under a fifth, the market's volume at three times its usual or more); RECOVERY (within four hours after a
shock, Bitcoin's hour at least one usual move against it). The state goes on every forecast and every record
line, and each walk forward's record keeps it for every hour (`forecast-oos-v5`).

Three things are then measured, all by the same cross-fitted test as V6.1's and by `research/rangeLag.ts`
on the same record:

- **the models alone, shock-aware**: the rows gained five figures (`features-v2`: Bitcoin's and ether's last
  fifteen minutes, Bitcoin's fifteen against the fifteen before, the breadth of the last fifteen minutes, the
  market's volume against its usual), so a refit's models see a shock as it begins -- "none" in the
  calibration's choice;
- **V6.1's one rule** on top of them, as before;
- **the states' rules**: a widening fitted per state exactly as V6.1's, the V6.1 rule becoming
  POST_EVENT_SHOCK's, each adopted by its own test; the horizon takes the states' rules or the line's by the
  lower pinball loss on every hour either would touch, or neither where neither passed.

Two more reasons make a forecast again between closes: `spread` (the live spread at three times the pair's
usual) and `direction` (the live price crossed the lead horizon's expected price against the call, once per
crossing). What each refit chose, and how the forecasts in each state held live, is on the Forecast Lab's
**The market's shock states** card and in a run's report; the figures of the first fits and runs on the new
rows are Stage 15's to report.

## Scheduled events (V7.1 Stage 12, 16 October 2026)

The macro calendar (`shared/calendar/macro-2026.json`, compiled by `research/fetch-macro-calendar.mjs` from
the BLS and Federal Reserve schedules: 45 releases of 2026 -- 12 CPI, 13 PPI, 12 Employment Situation, 8
FOMC statements; ETF decisions and token unlocks have no free source and are left out) marks the hour
before a release as the market's PRE_EVENT state, in training and live. It never moves a median: the
surprise is the market's own reaction.

**What Bitcoin did after the eleven releases inside a scratch profile's ninety days** (17 July to 16 October
2026; `research/eventImpact.ts`, shipped as `shared/calendar/event-impact-2026.json`; every kind under the
thirty releases the page calls enough):

| Release | 5 min | 15 min | 1 hour | 4 hours | a shock after (15 min past 2.5 usual moves) |
|---|---|---|---|---|---|
| CPI, 3 releases | median 0.24% | 0.64% (4.2 usual moves) | 0.70% (3.0) | 1.32% | 3 of 3 |
| PPI, 3 | 0.40% | 0.23% (0.8) | 1.04% (1.9) | 1.11% | 1 of 3 |
| Employment Situation, 3 | 0.25% | 0.16% (0.7) | 0.05% (0.2) | 1.66% | 1 of 3 |
| FOMC statement, 2 | 0.17% | 0.07% (0.4) | 0.27% (0.7) | 0.46% | 0 of 2 |

The 14 October CPI itself: Bitcoin fell 1.18% in the first five minutes (12.5 usual moves), 1.21% at
fifteen, 1.43% at the hour and 2.53% at four hours, never above the close before by more than 0.09%; one
usual hourly move down was touched at five minutes.

**The 14 October CPI on the walk forward** (`run-20261016-0640`, 31 pairs, out of sample; the Lab's
**Scheduled events** card shows the same): the record's hour before the release, 12:00 UTC, and the first
hour after, 13:00. Made at 12:00, before a fall no range set then could know, the 80% ranges held 16% at 5
minutes, 16% at 15, 23% at an hour and 16% at four hours; made at 13:00, once the fall was in the bars,
they held 94%, 77%, 84% and 94%. The sharp-move rule could not help the hour before (Bitcoin's fifteen
minutes at 12:00 were 0.2 usual moves) and did not fire at 13:00 either (by then its last fifteen minutes
were 0.6: the fall was over in the quarter-hour after the release). The PPI the next day read the same way
at 4 hours (13% before, 14% after, the day's drift) and held at the shorter horizons; the Employment
Situation of 2 October 68-90% before and 87-97% after. That is the case for PRE_EVENT: the hour before a
release is where the ranges are too narrow, and the calendar is what is known then. Its widening is fitted
and judged like any state's at the next refit (each state needs eight moments and 150 rows past the line
before a rule is fitted, so a few releases' hours will not carry it on their own until the record holds
them); the shock-aware figures on the features-v2 rows are Stage 15's to report.

## Champion and challenger (V7.1 Stage 13, 16 October 2026)

Every refit until now replaced the run in use the moment it was read back. V6's own report showed why
that is not safe: the 15-minute sharp-move verdict turned on 0.0002 of pinball between two fits six hours
apart, and the degraded-model notices of 13 October came from refits that fitted worse at 4 and 24 hours.
Since Stage 13 a refit is a challenger (`shared/forecast/challenger.ts`): it is adopted only where its
walk forward's honest figures are no worse than the run in use's beyond three lines at every horizon
(pooled pinball loss at most 1% above, the 80% range at most two points farther from 80%, direction skill
at most one point lower); a refit that loses is logged with the comparison and kept, and the champion stays.
The run before the champion is kept to roll back to from the Lab. The lines are a tolerance for two walk
forwards a day apart covering much the same weeks, not the same rows; Stage 15's model-improvement test
makes a fit on a truncated history so that it is rejected, and rolls back.

The live drift gate (`shared/forecast/drift.ts`) is the other half: a horizon whose outcomes of the last
day, fifty or more, held under 60% of their 80% ranges gets every decision NO TRADE (`ENGINE_DRIFT`) until
the day's outcomes come right -- the forecasts are still made and recorded. On the 12-hour run of 14
October the hour's ranges held 25.6% over the live afternoon of the CPI (160 forecasts): the gate would
have closed the hour to the paper traders that day.

## Extended validation (V7.1 Stage 15, 16-18 October 2026)

**The model-improvement test passed 14 of 14 steps** on a scratch profile with the 12-hour run's bars
(`scratchpad/check_v7_stage15.mjs`, dist/multiday at 170ff3d): the first fit went in use at once with
nothing to beat (run-20261016-0900, 1,425 s); a refit 44 minutes later was judged as a challenger and
adopted (pinball within 0.03% at every horizon, hours4 and hours24 identical -- two fits on much the same
weeks), the Lab offered "Roll back to run-20261016-0900", the click put the champion back in use with the
challenger as the run before, the rollback is on the log and the engine forecast on the champion again;
then a fit on a history cut to 33 days was refused as the challenger with "no figures" at every horizon
(a walk forward needs 4 weeks), the run in use untouched, the refusal on the log and on the Lab, the
refused run kept on file.

**The 12-hour run of 16 October (lab12h, dist/verify at e50c170, from 06:40 UTC) was cut at 321 minutes**:
at about 12:25 UTC every Electron app on the machine was closed, the check apps' TEST-marked windows among
them, so the run ended without its session report. Its five hourly reports all passed every gate; the
scanner raised 8 events (2 urgent), the faked models were asked 5 times, one watch paper trade (WLD, a
breakout at 08:37) took its profit at +2.47 USDT; the stream moved data host 168 times in five hours (the
Binance hosts flapping, as in every run since V3). The 40084 Bitget refusal the user met that morning was
typed into this run's window at 06:46 UTC (the README's Classic-account note).

**Direction on the run's walk forward (run-20261016-0640, 31 pairs, weeks 1-3 tested out of sample,
features-v1):** every model is at or below zero skill from the hour on; the table is
`research/direction.ts`'s.

| horizon | the distribution | dir-logistic | dir-gbt | dir-gbt-tech | dir-gbt-price |
|---|---|---|---|---|---|
| 5 min | -0.03% (338 calls, 58.0% right) | +0.02% (365, 60.3%) promoted | -2.26% | +0.04% (147, 59.2%) promoted | -0.05% |
| 15 min | -0.05% (no calls) | +0.19% (188, 42.0%) promoted | +0.09% (146, 52.7%) promoted | +0.24% (10 calls) promoted | +0.14% (no calls) promoted |
| 1 hour | -0.02% | -0.13% | -0.43% | -0.42% | -0.22% |
| 4 hours | -0.27% (570, 54.2%) | -0.90% | -0.75% | -1.92% | -2.18% |
| 24 hours | -2.20% (4,902, 53.8%) | -5.42% | -7.40% | -4.91% | -6.57% |

Every pair class reads its P(up) from the base rate. The "promoted" verdicts at 5 and 15 minutes rest on
skills of a few hundredths of a percent with calls at the lines right 42-60% of the time: the checklist's
line "a Brier skill above zero" is too permissive, which the next cycle's plan takes up (a minimum skill, a
minimum number of calls, both halves of the weeks). The ranges held as calibrated: the 80% range held
79.7% (5 min), 80.7% (15 min), 78.1% (1 hour) and 77.7% (4 hours) over 15,500 tested hours each, under-held
after Bitcoin's sharpest fifteen minutes (|btc15| >= 3: 70.5%, 65.4%, 52.5%, 85.7%) and brought back to
77-85% by the cross-fitted widening after |btc15| >= 2.5. The replay of the three releases inside the walk
forward: the hour before the 14 October CPI held 16-23%, the hour after 77-94%; the hour before the 2
October jobs report 68-90% and the hour after 74-97%; the 15 October PPI 13-94% before and 14-100% after (the
4-hour ranges on both sides of the PPI held 13% and 14%).

**What the figures are worth.** None of the figures above carried an interval, and the record keeps one row
an hour for every pair, the 31 pairs moving together: `research/uncertainty.ts` (16 October 2026) resamples the
HOURS of the same walk forward -- every pair's row of an hour together, in circular blocks as long as the
horizon -- a thousand times, and prints each figure with its 95% interval, the effective sample behind the 80%
coverage, and the smallest direction skill the record could tell from zero (2.8 bootstrap standard deviations).
The forecast knows more than persistence about the size of the move at every horizon but the day, and nothing
about its way at any:

| horizon | 80% held | 50% held | pinball skill over persistence | effective sample | detectable direction skill |
|---|---|---|---|---|---|
| 5 min | 79.7% [77.9, 81.6] | 49.9% [47.9, 52.0] | +1.45% [+0.90, +2.08] | 1,772 of 15,582 | 0.7-1.2% |
| 15 min | 80.7% [78.9, 82.3] | 51.3% [49.5, 53.0] | +1.51% [+0.99, +2.07] | 2,036 of 15,579 | 0.4-0.9% |
| 1 hour | 78.1% [76.3, 79.9] | 49.3% [47.5, 51.2] | +1.27% [+0.89, +1.66] | 2,020 of 15,551 | 0.6-1.1% |
| 4 hours | 77.7% [74.3, 80.7] | 48.1% [45.0, 51.3] | +0.77% [+0.16, +1.40] | 652 of 15,458 | 1.6-2.8% |
| 24 hours | 79.5% [71.2, 86.7] | 49.1% [40.2, 57.3] | -0.01% [-0.72, +0.62] | 101 of 14,838 | 10-21% |

No direction source's Brier skill interval excludes zero on the positive side at any horizon; three exclude it on
the negative side (dir-gbt at 5 minutes, -2.26% [-4.18, -0.46]; dir-gbt-tech and dir-gbt-price at 4 hours, -1.92%
[-3.45, -0.81] and -2.18% [-3.59, -1.09]). The calls' precision intervals are 20 to 40 points wide (dir-logistic at
5 minutes: 60.3% right of 365 calls, [45.1%, 74.6%]). The 24-hour figures rest on about a hundred effective
observations: three weeks cannot judge that horizon, which the V7.2 draft's archive stages take up. (The 4-hour
and 24-hour intervals in this table are the uncorrected ones of 16 October; V7.2 Stage 1's corrected intervals
are in its section below.)

**What the promotion rule lets through.** `research/directionNull.ts` (16 October 2026) keeps every forecast where
it is and shifts the outcomes by a random whole number of days -- each pair's outcome taken from the same pair that
many days later, around the span's end, so each hour's cross-section stays intact -- 200 times, scores each shifted
record as the app scores it and puts it to the checklist as it stands (5,000 outcomes, a skill above zero, calls no
less often right than the distribution's where both made 30) and to the lines the V7.2 draft proposes (a skill of at
least 1%, at least 200 calls, calls right more than half the time, a skill above zero in both halves of the weeks).
Readings that have nothing to do with the outcomes are "promoted" by the checklist as it stands in 3% to 26% of the
shifts per model and horizon (dir-gbt-tech 23% at 5 minutes and 26% at 15; dir-gbt-price 26% at 15 minutes;
dir-logistic 23% at an hour; 0% to 19% at 4 and 24 hours), and by the proposed lines in none, except one 5% cell at
24 hours (dir-logistic, where the null's own skills reach +2.8%: the day horizon cannot be judged on three weeks).
The real promotions at 5 minutes (+0.02%, +0.04%) sit inside the null's range; the two at 15 minutes (+0.19%,
+0.24%) sit above its largest shifted skill (+0.04%, +0.06%) -- a relation too small to use (the calls were right 42%
and 20% of the time; the breakeven precision at 15 minutes is 0.77) and the kind a bid-ask bounce would leave.

**The multi-day run** (multiday2, dist/multiday2 at 22241b0, one segment of 49 hours from 12:36 UTC on 16
October to 14:02 UTC on 18 October, the lab's four strategies on paper, the forecast trader on, OpenRouter
faked; `RUN_NAME=multiday2 python scripts/shadow-analyze.py`). Its first start (multiday, 11:27 UTC) had died
with the other apps an hour into its session, after its fit and the lab's funding. **Every one of the 47
hourly reports passed every gate that applies**, and so did the 12-hour, day and session reports (fees,
slippage, tracing and outcomes not measured, with no trade). The two Binance data hosts answered by turns the
whole run: the stream connected 26 times, had 14 gaps (the longest 263 s) and moved its data host 143 times.

The forecast once every horizon came due: 4,369 forecasts of 25 pairs at the quarter-hours and 1,229 made again
between closes (market 724, volume 389, band 118, spread 17); every one of the 16,064 due horizons has its
outcome.

| horizon | judged | 80% held [95%] | 50% held | median error | bias | calls |
|---|---|---|---|---|---|---|
| 5 min | 4,369 | 81.0% [76.9, 85.3] | 53.1% | 0.21% | -0.02% | 0 |
| 15 min | 4,354 | 79.8% [74.8, 85.0] | 51.2% | 0.35% | -0.04% | 0 |
| 1 hour | 4,300 | 80.1% [72.2, 86.8] | 52.6% | 0.63% | -0.16% | 0 |
| 4 hours | 1,858 | 77.9% [56.6, 95.4] | 47.4% | 1.25% | -0.45% | 0 |
| 24 hours | 1,183 | 96.1% [90.3, 100.0] | 76.2% | 2.74% | -2.67% | 0 |

The ranges held at every horizon but the day, which ran wide over two falling days (its interval rests on two
independent blocks). Bitcoin's sharp moves widened 891 forecasts, which held 79.0%, 72.6% and 80.6% of their 80%
ranges at 5 minutes, 15 and an hour, against 71.7%, 62.7% and 69.1% on their own unwidened levels: the V6.1 rule
earned its place live. By the market's state, NORMAL held 82.0% / 81.6% / 79.4% / 80.7% / 94.0% by horizon and
POST_EVENT_SHOCK (890 forecasts) 79.0% / 72.6% / 80.6% / 73.0% / 98.5%; RECOVERY's 144 forecasts held 71.5% at 5
minutes and 93.8% at an hour.

**Direction:** every forecast read its P(up) from the base rate (no direction model was a source at any horizon
under V7.1's checklist on this run's fit), the lead horizon called NEUTRAL 4,304 times and UNCERTAIN 65 times, and
the median's sign was right 51.0%, 49.3%, 46.6%, 43.0% and 46.4% of the time by horizon, in a market that fell.
**Trades:** the forecast trader and the four laboratory strategies opened nothing in 49 hours, and the predeclared
sensitivity counts (a direction model's P(up) at or past 0.58, 0.55 and 0.52 with the median on its side) are zero
at every line, since no direction model was a source. **Timing:** the expected price was reached far more often
than said -- at 5 minutes said 31% and reached 86%, at an hour 74% and 92%, at four hours 88% and 91% -- because a
median near zero is the current price, which the path touches at once; the arrival line says nothing while the
forecast calls no way (V7.2-R Stage 3 replaces it with the odds of reaching +-1% and +-2%). The likely high held
85% / 85% / 83% / 86% / 99% and the likely low 82% / 79% / 76% / 72% / 63% by horizon, the lows falling short as
prices fell. **The challenger:** both nightly refits were refused and the first fit stayed in use -- on 17 October
for the hour's direction skill (-1.47% against +0.13%), on 18 October for the day's pinball (0.3036 against
0.2978) and direction skill (-15.12% against -3.40%).

**One forecast gate failed:** forecasts were made at 186 of the run's 192 quarter-hour closes, where the gate
allows one missed. The six misses (19:30 on 16 October; 03:45, 09:30, 10:45, 16:15 and 21:45 on the 17th) fell
where a data pass did not finish while the hosts flapped, and no pass ran for the close; V7.2-R Stage 2 makes a
close whose data pass failed be passed again within the close. V7.1's validation is complete with this run.

## V7.2 Stage 1 -- what the figures are worth (17 October 2026)

Every figure the Lab's tables and the run report show now carries its 95% interval, the independent outcomes
it rests on and the blocks a resample drew (`shared/forecast/uncertainty.ts`; `HonestScore` and
`DirectionScore` gain `ci`, `nEff` and `blocks`, a direction score its `detectable` skill, under
run-calibration-v6; the Lab's `LabMetrics` the same on the walk forward and the live record;
`research/uncertainty.ts`, `research/direction.ts`, `research/rangeLag.ts` and `scripts/shadow-analyze.py`
print them). The arithmetic is the 16 October tool's -- the hours resampled, every pair's row of an hour together,
in circular blocks as long as the horizon, a thousand seeded draws -- with two corrections fixed on simulated
panels before the record was read: outcomes that overlap are the sums of their hours' moves, so blocks as long as
the overlap lose the dependence across their edges and the draws' spread is widened by the root of the long-run
variance over the part a block captures (1.21 at four hours, 1.22 at a day); and the few blocks a long horizon
leaves make the spread itself uncertain, so the interval is widened by Student's t over the normal's quantile for
the blocks drawn. On a thousand panels of ten pairs whose truth was known (a market factor and each pair's own
noise, moving sums over the horizon, 336 or 504 hours):

| overlap, block | 95% interval held the truth, uncorrected | corrected (the app's) |
|---|---|---|
| 1 hour (5 min, 15 min, 1 hour) | 96.1% | 96.1% |
| 4 hours, blocks of 4 | 91.4% | 96.9% |
| 24 hours, blocks of 24 (21 blocks) | 85.7% | 94.0% |

The registered line -- the interval holds the truth in 93-97% of panels at every horizon -- is held, and pinned
in `tests/forecastUncertainty.test.ts` with the panels themselves. A block of an hour on a day's overlap holds
the truth under 85% of the time, which is why the block is the horizon's length; and no block length reaches the
line at a day without the corrections (86% at 24, 36, 48 or 72 hours), since three weeks hold only 7-21 blocks of
a day. An interval that is a share is held inside 0-100%.

**On run-20261016-0640, the app's own intervals** (`research/uncertainty.ts`): at 5 minutes, 15 minutes and an
hour the figures are the 16 October table's to the digit, the corrections being 1 there. At four hours and a
day they are wider than that table said:

| horizon | 80% held | 50% held | pinball skill over persistence | independent outcomes (blocks) | detectable direction skill |
|---|---|---|---|---|---|
| 4 hours | 77.7% [73.6, 81.3] | 48.1% [44.3, 52.0] | +0.77% [+0.03, +1.54] | 440 of 15,458 (125 of 4 h) | 2.0-3.4% |
| 24 hours | 79.5% [68.6, 88.9] | 49.1% [37.5, 59.8] | -0.01% [-0.94, +0.81] | 59 of 14,838 (20 of 24 h) | 14-28% |

So the 4-hour pinball skill now only just excludes zero, and the day's figures rest on fifty-nine independent
outcomes: its direction skills' intervals are twenty to forty points wide (the distribution's -2.2% [-19.0,
+12.6], dir-gbt -7.4% [-29.8, +9.1]) and nothing about that horizon can be read from three weeks, as the draft
said. The direction findings stand at every horizon: no model's skill interval excludes zero on the positive
side; dir-gbt at 5 minutes and dir-gbt-tech and dir-gbt-price at 4 hours exclude it on the negative side. What
Stage 1 changes is not a figure but what each figure is worth, which every later stage reads first. Registered as
V72-S1-INTERVALS and V72-S1-NODIRECTION in `research/preregistered.jsonl` (Stage 3), their results locked to them.

## V7.2 Stage 2 -- the direction bar (17 October 2026)

V7.1's checklist promoted a direction model on 5,000 outcomes, a Brier skill above zero and, where both it and
the distribution's P(up) made thirty calls, calls no less often right: on the record of 16 October it promoted
skills of a few hundredths of a percent, and under the day-shift null (`research/directionNull.ts`) it promoted
noise in 3-26% of shifts per model and horizon. Stage 2 replaces it (`shared/forecast/promotion.ts`,
`DIRECTION_PROMOTION_LINES`, fixed before the null was run again): a skill of at least the hundredth a P(up)
source needs, so "promoted" and "a source" agree; at least 200 calls, whose precision's lower 95% bound (Stage
1's) clears an even chance; a skill above zero in both halves of the weeks and both halves of the pairs (the
pairs split by a fixed hash of their names); no class with 2,000 outcomes under -1%; and, for the model to be
TRADEABLE, the mean realized move in the way its calls called, less the round trip's 0.24%, above zero with its
interval's lower bound above zero. A line the record cannot read holds a direction model back. A direction score
now carries its halves and its calls' edge (run-calibration-v7); a model is a P(up) source only where two walk
forwards in a row found it tradeable -- the run in use's verdicts travel with the walk forward that follows it
(`forecastTrainingService.ts` to `trainWorker.ts`), so the first fit after an install can never make a source,
and a rebuilt calibration (no run before) cannot either. The lab's DIRECTION strategy follows the source. The Lab's
Which way table prints each model's breakeven precision (half plus the round trip over twice the median's error:
0.90 at five minutes, 0.77 at fifteen, 0.64 at an hour, 0.565 at four, 0.525 at a day on this record), its calls'
edge after costs with its interval, both verdicts and whether the run before held.

**On run-20261016-0640 nothing is promoted at any horizon**, which the draft predicted. The calls' edges after costs
are negative at every horizon where enough calls were made, several beyond noise: at five minutes dir-logistic
-0.300% [-0.606, -0.086] on 365 calls, dir-gbt -0.237% [-0.319, -0.166] on 1,748, dir-gbt-tech -0.232%
[-0.437, -0.088], dir-gbt-price -0.386% [-0.799, -0.085]; at fifteen minutes dir-logistic -0.526% [-0.928, -0.166];
at four hours dir-gbt-tech -0.477% [-1.115, +0.106] and dir-gbt-price -0.575% [-1.311, +0.011]; at a day every
interval spans two percent either way. The outcomes a true 1% skill would need to clear the record's interval
(Stage 1's detectable skill scaled by the root of the sample) run from 5,000-15,000 at five minutes and 3,000-12,000
at an hour to 40,000-116,000 at four hours and 1.9-7.8 million at a day: three weeks hold 10,000.

**Under the null** (200 day shifts, each hour's cross-section intact, the intervals at 200 draws, the class floor
not read): V7.1's lines promote noise in 4-23% of shifts at five minutes, 5-26% at fifteen, 5-23% at an hour,
3-13% at four hours and 0-19% at a day; the new lines promote noise in 0% at every model and horizon but one --
dir-logistic at a day, 5% -- and call noise tradeable in 0% everywhere. The registered line (a false-pass rate
of at most 5% per model-horizon) holds, at its edge in that one cell, where twenty blocks of a day leave the
precision's interval wide enough to clear an even chance by chance.

**The exploratory readings** (record-only, each mapped by the weeks before and judged by the same lines, in
cells by market state, regime and class): the distribution's skew, its median in half-widths, the excursion
asymmetry at the 80% level and, at four hours and a day, the shorter horizons' agreement -- 15-20 cells a horizon,
85 in all, none promoted, none tradeable. The best cell is the median in half-widths for the mid class at five
minutes, +0.60% with a lower bound of +0.02%: under the 1% line, a null until it repeats. **The per-hour Spearman
rank correlation** of the shown medians with the realized moves across the 31 pairs: +0.035 [+0.017, +0.051] at
five minutes (positive in 58% of the hours), -0.019 [-0.038, -0.001] at fifteen, +0.011 [-0.005, +0.030] at an
hour, +0.018 [-0.009, +0.048] at four, +0.074 [-0.001, +0.161] at a day. A rank correlation of 0.035 at five
minutes that turns negative at fifteen is the bid-ask bounce a median read off a last price carries, not a
tradeable ordering; the day's +0.074 rests on twenty blocks and sits on zero. The cross-section is the one place
this record shows an ordering at all, which Stage 9's `xs_rank` features are built to ask properly. Registered as
V72-S2-DIRECTIONBAR and V72-S2-EXPLORATORY in `research/preregistered.jsonl` (Stage 3), their results locked to them.

## V7.2 Stage 3 -- pre-registration, and a challenger judged beyond noise (17 October 2026)

**The registry.** Every line the engine judges by has been a pinned constant under the engine version since V4,
and every stage has written its success line before measuring; nothing bound a hypothesis to the record it would
be judged on, or a result to the line it answers. `research/preregistered.jsonl` now does (`shared/forecast/
preregistration.ts`): an append-only file of registration lines -- id, when and under which engine version,
hypothesis, metric, success line, the record judged on, confirmatory or exploratory, the engine constants named
-- and result lines, each carrying the hash of its registration's locked fields, the figure, its interval, the
verdict and the commit. The hash is the lock: `tests/preregistration.test.ts` refuses a registration edited after
its result, a duplicate id, a result without a registration, a malformed line, and an engine constant added since
16 October 2026 that no registration names and the infrastructure list (the intervals' lines) does not hold. The
twenty-one lines of the V7.2 plan are registered (V72-S1-INTERVALS to V72-S13-BUNDLE), Stages 1 and 2 with the
engine version they were measured under and their results locked; the Lab's Registered lines card shows the file
with each line's last result. The run report does not carry the registry: it reads a profile's records, and the
registry is the repository's, shipped with the build.

**The challenger beyond noise** (challenger-v2). Two walk forwards a day apart test much the same hours with much
the same rows, and V7.1's tolerances compared that noise. Now the worker pairs a refit's walk forward with the run
in use's on the hours both tested (every pair's row of an hour together, blocks as long as the horizon, as every
interval since Stage 1): the difference of the pinball loss, of the 80% range's distance from 80% and of the
direction skill, each with its 90% interval. The refit is adopted where it is better beyond the interval at some
horizon and worse beyond it at none, or where its rows reach at least seven days past the champion's
(`CHALLENGER_LINES.newerDays`) and it is worse beyond the interval at none; otherwise the champion stays and the
log says "within noise". The tolerances stay as the floor of materiality: a difference beyond a narrow interval but
under 1% of the pinball loss, 2 points of coverage or 1 point of skill is neither better nor worse. Where the
champion's record cannot be read, the tolerances alone judge, and the verdict says "unpaired". The training log
keeps the verdict's why and a summary line; the Lab's champion card words it.

**On the two-day run's own refit** (`research/pairedChallenge.ts`; run-20261017-0030, the nightly refit of 17
October at 00:30 UTC, against run-20261016-1236, twelve hours apart, the refit's rows reaching 0.50 days past the
champion's; both calibrations built again from their records, the run's files being of the version before):

| horizon | shared hours (blocks) | pinball difference | 80% range's distance from 80%, points | direction skill, points |
|---|---|---|---|---|
| 5 min | 492 (492) | +0.0006 [+0.0003, +0.0009] | +0.06 [-0.13, +0.22] | -0.93 [-1.54, -0.37] |
| 15 min | 492 (492) | +0.0002 [-0.0000, +0.0005] | +0.29 [-0.36, +0.43] | -0.25 [-0.69, +0.09] |
| 1 hour | 491 (491) | -0.0003 [-0.0005, -0.0000] | -0.51 [-0.68, -0.29] | -1.66 [-2.58, -0.69] WORSE |
| 4 hours | 488 (122) | -0.0004 [-0.0012, +0.0003] | +0.20 [-0.26, +0.53] | +0.26 [-0.40, +0.90] |
| 24 hours | 468 (20) | -0.0004 [-0.0017, +0.0008] | +0.56 [-1.02, +1.04] | +0.37 [-2.70, +3.16] |

V7.1 refused the refit on "hour1: direction skill -1.47% against +0.13%"; V7.2 refuses it too, on the same
ground read properly: the hour's direction skill fell 1.66 points, beyond the interval and beyond the floor. The
pinball differences are real at three horizons (their intervals exclude zero) and immaterial at every one (under
the 1% floor: the refit forecast the size of the move the same); the 80% range's distance from 80% is within noise
at every horizon but the hour, where the refit was nearer 80% (-0.51 points [-0.68, -0.29]). The registered line
V72-S3-CHALLENGER asked the pair to read within noise at every horizon: it FAILED at one, and the failure is the
finding. The direction skill of a fit is not a stable property of the data: twelve hours of new rows moved the
hour's P(up) map by 1.7 points, beyond what the hours' sampling noise allows, on a record where no direction skill
is distinguishable from zero (Stage 1). Fit-to-fit variability larger than sampling noise is what a figure made
of noise looks like; Stage 8's cadence study measures it over a year of fits. The line's second clause -- zero
adoptions of a refit within noise and under seven days newer -- held. One design note, recorded and not acted on
(the line was registered as it stands): since Stage 2 no direction model is a P(up) source, and the champion's
own hour-1 skill (+0.13%) is under the 1% line a source needs, so a refusal on direction skill refuses a refit for
losing something nothing trades on; whether the challenger's direction line should weigh only sources in use is a
question for Stage 8, with the year's fits.

## V7.2 Stage 4 -- the clock as a diagnostic, and what a block of figures added (17 October 2026)

**By hour** (`shared/forecast/byHour.ts`, made with every Lab and shown on its By hour card; `research/byHour.ts`).
The rows carry the hour of the day and the day of the week as figures, and the usual move a forecast is scaled by
knows nothing of the clock. The forecast shown, scored out of sample as the app scores it, read by the UTC hour it
was made at, on run-20261016-0640 (the lab12h profile) and on run-20261016-1236 (the two-day run's first fit, whose
record carries the market's states):

| hour1, UTC hour | 80% held (0640) | 80% held (1236) | implied dispersion | the misses in a shock state (1236) | 5-min range vs the day's median | quote volume share |
|---|---|---|---|---|---|---|
| 14 | 61.1% | 61.5% | 1.49 | 18% | 1.40 | 7.4% |
| 15 | 70.8% | 70.7% | 1.22 | 6% | 1.33 | 6.6% |
| 1 | 68.4% | 68.7% | 1.28 | 6% | 1.08 | 3.7% |
| 4 | 71.8% | 71.0% | 1.19 | 31% | 0.92 | 3.4% |
| 13 | 85.6% | 85.1% | 0.88 | 26% | 1.29 | 6.4% |
| 23 | 87.2% | 88.2% | 0.84 | 20% | 0.82 | 3.0% |

At an hour the 80% range held from 61% (14:00 UTC, the hour after the New York open and the 13:30 releases: the
true spread one and a half times the forecast's) to 87-88% (23:00 UTC, the range a sixth too wide); at five
minutes from 67% to 87%, at fifteen from 70-72% to 88%, at four hours from 62-66% to 86%, at a day from 76% to 85%.
The 14:00 band is under 70% in all four halves on both records (60-63%), and the 23:00 band at or over 90% in
two. The weekday reads 72-83% and is not acted on. **The registered line** (V72-S4-CLOCK: a band fails only under
70% or over 90% in all four halves with at least 500 outcomes each) **cannot be read on three weeks**: the largest
half of a band holds 252 outcomes, the smallest 56. By its letter no band fails and Stage 9 would carry no CLOCK
block; in substance the pattern is as large as any this cycle has found and the same on two records twelve
hours apart. The line stands as registered and is recorded NOT MEASURED, to be read on Stage 8's year of bars
(where a half holds thousands); the shock states explain a minority of the misses in the failing hour (18%), so
the band is not the releases alone.

**What a block of figures added** (`shared/forecast/ablation.ts`, `research/ablation.ts`; the Lab's What a block
of figures added card reads the files the tool writes). The walk forward fitted twice on identical folds and
seeds -- once with every block, once with one block's columns held at their training mean -- and the two
forecasts paired on the tested hours with Stage 1's paired bootstrap; and a control with the block's columns
permuted across the tested rows. On the lab12h profile's bars at an hour (85,882 tested rows, 504 shared hours,
the clock block of four columns, 512 s): two full fits differ at zero figures (the registered line V72-S4-ABLATION,
determinism); the clock block saved +0.0003 of a pinball loss of 0.27 [-0.0000, +0.0006], a tenth of a percent and
within noise; the 80% range's distance from 80% it cost 0.36 points [0.14, 0.52], real and under the 2-point
floor; the direction skill it added -0.14 points [-0.33, +0.05]; the permuted control saved the same +0.0003
[+0.0001, +0.0006], 0.11% of the loss and under the 0.2% line. The direction models read the clock as noise:
dir-logistic made 404 calls with it (45.3% right) against 53 without (54.7% right), at the same skill. The clock
as four columns of sines adds nothing the trees can use at an hour, while the by-hour bands say the range is a
third too narrow at the open: the clock is in the rows and not learned, which is what Stage 9's CLOCK block (a
diurnal scale of the usual move, read where Stage 4 found a failing band) is built to try -- on the year, once a
band can fail. `FEATURE_BLOCKS` lives in `shared/forecast/ablation.ts` rather than `features.ts`, and the mask is
on the rows the models are handed, never on the models: the engine's fit is unchanged.

## V7.2 Stage 5 -- the pass as pure functions, the fold models, the tape, and a record replayed (18 October 2026)

**The pass as pure functions** (`shared/forecast/pass.ts`; the service keeps the files, the window and the
notices). Everything the live forecast decides at a close and between closes -- every pair's forecast, the
outcomes due and the adaptive levels' step, the trade decision and the ranking, a forecast made again -- is now
a function of what it is handed (the bars as held, the models and the calibration in use, the live book, the
news, the calendar, the class verdicts, the moment) and one state; no clock is read. The service's 29 tests
pass unchanged on the move, and a record the service made before the move (tests/fixtures/forecastReplay: 37
closes of the fixture pairs, 52 grid forecasts and 6 refreshes) replays through the pure pass to four decimals
on every line, the regression anchor of the move. **Each fold's models** of a walk forward are saved beside its
record (`fold-<k>-<horizon>.json`, about a megabyte each, swept with the run), so that Stage 6 can replay the
tested weeks at every five-minute close, not only the hourly rows the record keeps. **The tape**
(`forecasts/tape-YYYY-MM-DD.jsonl`; `shared/forecast/tape.ts`): one line a minute per streamed pair's book
(bid, ask, their sizes, when received) and each of Bitcoin's minutes as it closes; swept with the record;
counted on a run's report. Its clock begins with the next run.

**A record replayed** (`shared/forecast/fidelity.ts`, `research/replayFidelity.ts`). The two-day run's record
(run-20261016-1236 on the multiday2 profile: 3,428 forecasts, 139 passes, 12,528 outcomes, 36 hours to 01:05 UTC
on 18 October) replayed through the pure pass from the profile's bars, the run's model files and its calibration
(made again from its record: the file is run-calibration-v5 and the engine reads v7; the V2 weights and maps are
the same arithmetic), with no live book, no news and no class verdicts, in 14 s:

| horizon | grid horizon lines | replayed to four decimals on V2's own levels | P(up) to three decimals |
|---|---|---|---|
| minutes5 | 2,481 | 99.0% | 100% |
| minutes15 | 2,481 | 26.1% | 100% |
| hour1 | 2,481 | 46.2% | 100% |
| hours4 | 661 | 72.6% | 100% |
| hours24 | 661 | 79.6% | 100% |
| all | 8,765 | 60.0% | 100% |

The market's state agrees on every line. Every remainder is a level difference of 0.0002 to 0.0011 points: the
bars have not changed (every recorded outcome's move recomputes from the bars on file exactly, 12,528 of
12,528), the prices and the cells agree, and the outer levels (P10, P90) agree while the inner ones (P25, P50)
drift, in groups of pairs that share a calibration cell, from 14:00 UTC on the first day on. At the end the
replay's adaptive levels differ from the profile's own in 30 of 80 cells, by multiples of one outcome's share
of a step (gamma 0.005 over a batch of a few outcomes). The cause: the adaptive levels step once a close by the
outcomes settled at it, and an outcome is settled a close late whenever its bars reached the app after the
close's pass -- which they did often while the data host flapped (binance.com and data-api.binance.vision
answering by turns every minute or two around 14:00 on 16 October; 126 switches over the run). The update has
no decay, so one late outcome shifts its cell's levels for the rest of the run. The record did not say when an
outcome was settled, and its write order cannot tell a close passed from a close skipped (a batch of newer
forecasts alone reads the same either way; inferring the moments from the order made the agreement worse,
10%). **The registered line V72-S5-FIDELITY FAILED** on this record (60.0% against the 99% asked), and the
failure is the finding: the arithmetic replays, the timing of the adaptive steps does not, because the record
did not carry it. Since this stage every outcome line says the close it was settled at (`at`) and every
forecast line the day's volatility it was scaled by (`rv`), so that the next run's record can be replayed
exactly and a difference from other bars told from one of arithmetic; the line is read again on Stage 13's
run. The lab12h record the registration named cannot be replayed at all: its models are models-v3 on 63 figures,
from before V7.1 Stage 11 added the fifteen-minute figures, and the engine reads models-v4 on 68 -- a recorded
run is replayable only by the engine version that made it, which Stage 6's replay respects by reading the fold
models' version beside them.

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

## The odds of a move that clears its costs (V7.2-R Stage 3, 20 October 2026)

The user's question after the V7.1 runs: a forecast whose middle is a tenth of a percent from the price is no use when
a swap costs 0.5-1%; say instead how likely a move of 1% or 2% is, and when. Two readings of a forecast already made
need no model: the chance its close is at least t% up or down (read off its five shown levels by straight lines,
past P10 and P90 by an exponential tail), and the chance its path touches t% either way (read off its likely highs and
lows). `research/moveOdds.ts` set both against every outcome of two records under a line registered first
(V72R-S3-ODDS, engine 08ce74aa7ac4): a horizon, move and kind passes where every tenth of stated chance holding 100
outcomes has its mean inside the observed share's 95% interval (hour blocks as long as the horizon) and the Brier score
is under a base rate read on the record's other UTC days.

| | user's record, 16-20 Oct | two-day run, 16-18 Oct |
|---|---|---|
| forecasts (outcomes at 1 h / 4 h / 24 h) | 5,135 (5,057 / 2,331 / 1,468) | 4,392 (4,323 / 1,881 / 1,206) |
| close +1% at 4 h: said / came | 17.5% / 9.1% | 18.4% / 11.1% |
| close -1% at 4 h: said / came | 20.4% / 30.3% | 20.5% / 26.5% |
| touch +1% at 24 h: said / came | 74.2% / 46.6% | 76.8% / 41.2% |
| touch -1% at 24 h: said / came | 67.5% / 84.5% | 68.6% / 85.2% |
| close 1% either way at 1 h: said / came | 20.8% / 19.1% | 21.4% / 20.5% |
| close 1% either way at 4 h: said / came | 37.9% / 39.4% | 38.9% / 37.6% |
| close 1% either way at 24 h: said / came | 72.1% / 58.2% | 76.2% / 63.3% |

**The line failed** at every judged horizon, move and kind on both records but one (the hour's 2% touch on the
user's, which failed on the run's). The failure has one shape: each side's chance is the forecast's, which calls no way,
and both records cover falling days, so rises came less often than said and falls more often, and the base rate read
on the other (also falling) days beat it. The size of the move, both sides together, is close at an hour and at four
hours and too high at a day, as the day's 80% range held 93-96% on these records; that reading came after the line was
judged and is registered as V72R-S3-EITHER for the Stage 9 runs' records and the user's from 20 October 08:25 UTC on.
The intervals at a day rest on four or five day blocks (two on the run's record), so they are wide.

By the registered rule nothing is shown as a chance. The card says, as a frequency of the past, how often the coin's
own price moved 1%, 2% and 5% and touched 1% and 2% over its last ninety days (`shared/forecast/moveRates.ts`), and
shows an expected price only where a source of the way that beat the base rate is in use. The trade decision gains the
user's line of a move worth its costs (MOVE_UNDER_LINE: the likely move, P75 for a buy and P25 for a sell, at least 1%
up to four hours and 2% at a day), registered as exploratory (V72R-S3-LINES) for the Stage 9 runs.

## Two strategies that need no way, out of sample (V7.2-R Stage 5, 22 October 2026)

The ranges held and the way did not, so the question left after Stage 4 was whether a calibrated range can earn without
a call, and the live laboratory, funded since 16 October, had made no trade to say. `shared/forecast/replay.ts` answers it
on weeks the models never saw: a walk forward's weeks after the first, each forecast again at every five-minute close
through the forecast's own pass with that week's models (kept since V7.2 Stage 5) and a calibration made only from the
weeks before it, the outcomes settled and the adaptive levels moved as live. At every quarter-hour two paper strategies
were played on the bars after it, their rules fixed before any trade was replayed
(`shared/forecast/rangeStrategies.ts`): **band reversion**, a resting bid at a horizon's P10 price, sold at the median,
stopped at the excursion's likely low at the nine-in-ten level, sold at the horizon's end otherwise; and the **range
grid**, a day's bids between P10 and P90 a step apart (at least twice the 0.24% round trip), each sold a step up and bid
again, what is held sold at the day's end. Fills flatter less: a resting order fills only where a later bar trades
through it by 0.02%, at its own price; a stop at the stop or a gap's open, with slippage; a bar that reaches both is a
stop. The laboratory's four were taken through the live decision too. The lines were registered (V72R-S5-BAND, -GRID,
-LAB, -REPLAY, engine 2fc505d8429c) after a blind run that printed counts and times only.

| | band, an hour | band, four hours | band, a day | grid, a day |
|---|---|---|---|---|
| orders / trades (primary record) | 17,862 / 3,894 | 4,792 / 1,162 | 811 / 246 | 744 grids |
| net a trade after costs, primary | -0.223% [-0.259, -0.182] | -0.348% [-0.502, -0.162] | +0.054% [-1.435, +1.756] | -0.423% [-0.807, -0.070]* |
| won / profit factor | 28.6% / 0.45 | 26.9% / 0.49 | 37.4% / 1.04 | 52.2% / 0.29 |
| net a trade, the user's profile | -0.229% [-0.269, -0.189] | -0.283% [-0.473, -0.088] | +0.381% [-4.258, +4.635] | -0.310% [-0.642, -0.014]* |
| the long held over the same lives, primary | -0.228% | -0.162% | +0.479% | +0.128%* |
| verdict | failed | failed | failed | failed |

The primary record is research2-profile's run-20261022-1033 (1-22 October 2026, 40 pairs); the user's profile is a copy of
its run-20261020-0828 (29 September to 20 October, 30 pairs), overlapping weeks, so a second universe and fit rather than
a second sample. Intervals are 95%, resampled by the hour bought in. * The grid's interval under the registered code
(replay-v1) could not be read: it counted its 24-hour blocks in hours that held a grid, and a day's grids all begin in
one hour, so 21 days made one block. The figures marked are the calendar-block reading made after the judgement
(replay-v2, now the app's); the verdict stands on the registered line either way, since a mean below zero leaves no
interval wholly above it.

**Every line failed.** Bought at P10, the price went on down more often than it came back: at an hour 1,838 of 3,894 fills
were stopped and 468 reached the median; at four hours 641 stopped and 102 reached it. That is what the V7.2 draft's
arithmetic expected (under a martingale about a fifth of bids fill, the expected close after a fill is the bid, and the
reversion needed to pay 0.2-0.24% is more than these horizons have shown), and the fills here were 22-30%. A day's band is
noise around zero, its little net made in a handful of hours (748% of it from the best 5%). The grid sold 35 rungs a step
up a day and still lost: what it bought in a fall it held into the day's end, in weeks the coins fell. The laboratory's
four made no trade: all 72,036 replayed forecasts on the primary record and 57,584 on the user's were NO_CALL, P(up) read
from the base rate. Neither strategy is offered on paper; the Lab's card says so beside the replay the app now makes of
its newest walk forward. Two replays of the primary record wrote the same bytes (V72R-S5-REPLAY held).

## The user's direction hypotheses on a year (V7.2-R Stage 6, 22 October 2026)

No model of the way has beaten the base rate, so the user's own ideas of where the way comes from were written as rules
(`shared/forecast/hypotheses.ts`, hypotheses-v1), registered (V72R-S6-GAINERS, -LEADERS, -CATALYST, -BREAKOUT, -RECOVERY)
and measured on a year of Binance's public five-minute bars (`research/fetch-forecast-archive.mjs`, October 2025 to
September 2026). Each month's pairs were the 40 largest by the month before's quote volume among every USDT pair the
archive has held, delisted ones included and stock tokens and pegged coins left out, so the pairs are the ones that were
large then; 130 pairs in all, 10 to 15 of the 40 changing each month; all 653 month files matched Binance's published
checksums (V72R-S6-ARCHIVE held). Each rule was judged at each horizon by the direction bar's lines for calls: 200 calls,
the share right above 50% by its lower bound, a skill of a point over the month's base rate of the way called and above
zero in both halves of the year and of the pairs, and, to trade, the move its way less the 0.24% round trip above zero.

| rule | calls (1 h) | right at 1 h / 4 h / 24 h | skill over the base rate, 1 h / 4 h / 24 h | move its way less the round trip, 1 h / 4 h / 24 h |
|---|---|---|---|---|
| a day's top gainer keeps rising | 28,043 | 44.6% / 42.7% / 39.4% | -2.8 / -4.6 / -6.1 pts | -0.29% / -0.40% / -0.93% |
| Bitcoin and ether set the alts' way | 53,848 | 46.4% / 47.7% / 47.1% | -2.1 / -1.7 / -3.0 pts | -0.25% / -0.19% / -0.31% |
| a news catalyst's way | 119 | 73.1% / 69.7% / 67.8% | +23.9 / +18.5 / +14.5 pts | +1.78% / +3.64% / +1.87% |
| a confirmed breakout goes on | 4,997 | 46.1% / 45.9% / 46.3% | -2.3 / -3.2 / -3.6 pts | -0.06% / -0.06% / -0.30% |
| a fall comes back | 8,137 | 52.4% / 50.5% / 48.7% | +5.1 / +3.3 / +3.7 pts | -0.31% / -0.32% / -0.40% |

**No rule passed: the forecast's way stays NEUTRAL.** A day's top gainer fell more often than the coins around it, and more
so the longer it was held; the leaders' four hours did not set the alts' next move; a breakout confirmed by volume and
acceleration did not go on (its year's second half much worse than its first). A fall does come back more often than the
base rate, in both halves and both pair halves, but by less than a round trip costs -- what research/EVENTS.md found on
its held-out pairs. The news catalyst called right most often, beyond noise at an hour and four hours, but on 119 calls,
under the 200 the line reads, so it is not measured; all 119 were down calls on coins Binance named for a spot delisting
(52, right 40 at an hour, +3.00% a call after costs) or a Monitoring Tag (67, right 47, +0.84%) -- no listing or perpetual
launch of the year had its spot candles on file. That is the way research/NEWS.md found on its held-out half and the way
the app's paper shorts on both kinds already trade; spot cannot sell what it does not hold, so on the user's account it
says what to step out of, not what to buy. The Forecast Lab's **Your direction hypotheses on a year** card shows the
table, each horizon apart, beside the registered verdicts.

## Eight months out of sample (V7.2-R Stage 6, 22 October 2026)

The forecast's own fits (the worker's fitHorizon and seeds, rows purged and embargoed as the app purges them) were
walked forward over eight folds of 28 days of the year archive, February to September 2026, each with at least ninety
days of rows before it, in two modes on identical tested folds: EXPANDING, fitted on every row before the fold, and
ROLLING, fitted on the ninety days before it alone -- the live fit's window (`research/longWalkForward.ts`). Each mode's
record was scored as a walk forward's is: the shown forecast with weights and a calibration from the folds before, so
seven months (March to September) are scored. Registered before it ran (V72R-S6-LONGWF, -DIRYEAR, -COVERAGE, -CADENCE).

| horizon | pinball, expanding less rolling | 80% range covered (expanding) | months within 5 points | the distribution's direction skill |
|---|---|---|---|---|
| 5 min | -0.14% [beyond noise] | 80.2% [79.8, 80.7] | 7 of 7 (78-82%) | +0.08% [-0.08, +0.22] |
| 15 min | -0.08% [beyond noise] | 80.4% [79.9, 80.9] | 7 of 7 (79-81%) | +0.05% [-0.02, +0.12] |
| 1 hour | -0.12% [beyond noise] | 79.4% [78.9, 80.0] | 7 of 7 (78-82%) | +0.02% [-0.07, +0.11] |
| 4 hours | -0.16% [beyond noise] | 80.2% [79.3, 81.2] | 7 of 7 (79-82%) | -0.10% [-0.35, +0.10] |
| 24 hours | -0.71% [beyond noise] | 80.7% [78.4, 82.8] | 7 of 7 (76-83%) | -0.32% [-1.37, +0.37] |

**The ranges hold over a year (V72R-S6-COVERAGE held):** the 80% range covered 79.4-80.7% pooled at every horizon and
stayed within five points of 80% in every month tested. **More data is not the fix (V72R-S6-LONGWF failed):** a year of
rows lowers the loss beyond noise at every horizon, but by a tenth of a percent up to four hours and 0.7% at a day,
under the 1% the line asks; the live fit stays ninety days. **There is no direction (V72R-S6-DIRYEAR failed):** no
horizon's direction skill is above zero beyond noise, and of the direction models the few above zero are a fifth of a
point at most (dir-logistic at five minutes +0.21%, dir-gbt-price at an hour +0.20%), none promoted or tradeable by the
direction bar. Over eight months out of sample the forecast knows how far a coin may move and not which way; the
settled finding takes direction-model work out of the plan. **The refit cadence (V72R-S6-CADENCE, exploratory):** a fit
on one more day of rows, the same seeds, scored on the week after, differs from the day before's within noise in 14 of
15 readings (the one beyond noise a quarter of a percent): a weekly refit with the calibration made again nightly would
lose about nothing. The cadence changes only with the user's yes.

## New information for the way, measured (V7.2-R Stage 7, 22 October 2026)

Two blocks of figures the forecast's rows do not hold were appended to every row of the year's long walk forward
(`shared/forecast/blocksV3.ts`) and fitted again on the same folds, seeds and rows, each beside a control with the same
columns shuffled across the rows (`research/blockAblation.ts`): CROSS and FLOW together -- the coin's moves less
Bitcoin's share of them over fifteen minutes, four hours and a day, its rank among the pairs, the pairs' spread and the
share that shocked, the buyers' share and its change, the trades' pace and size, Bitcoin's and the market's buyers --
and POSITIONING -- the funding rate, the premium, the open interest's change and its way with the price, the long/short
ratios against their week and the perpetual's buyers, read from Binance's futures archive for the 27 pairs with a year
of it, ten minutes or more before each moment. Registered before either was fitted (V72R-S7-CROSSFLOW, -POSITIONING).

| block | 5 min | 15 min | 1 hour | 4 hours | 24 hours |
|---|---|---|---|---|---|
| cross and flow | +0.03% | +0.05% | -0.05%* | -0.06% | -0.01% |
| its shuffled control | -0.02% | +0.02% | +0.01% | -0.05%* | +0.04% |
| positioning | +0.00% | +0.00% | +0.02% | -0.07%* | +0.02% |
| its shuffled control | -0.00% | -0.00% | +0.02% | -0.06%* | +0.06% |

The shown forecast's mean pinball loss with the block less without (* beyond noise). **Neither block passed.** No
difference reached the 1% the lines ask, the controls -- the same columns with their information shuffled away --
moved the loss as much as the blocks did, and no direction model was promoted or tradeable with either (the best,
dir-logistic at five minutes, +0.25% of skill with cross and flow against +0.21% without). Where a coin stands among the
others, who pressed its trades and what the futures crowd holds tell the forecast nothing its own figures do not, on a
year of bars out of sample. Both blocks stay measured in research and out of the forecast's rows.

## A challenger proven forward (V7.2-R Stage 8, 22 October 2026)

A walk forward says how a refit would have done on the weeks it was tested on, much the same weeks as the run in use's;
it does not say how the refit does now, on the market the run in use faces. Since challenger-v3 a refit that clears the
run in use beyond noise (or is a week newer and no worse) is its shadow for seven days (`shared/forecast/shadow.ts`,
shadow-v1): every close is forecast a second time with its models and calibration from the same bars, books and news,
into its own record, shown and traded on nowhere. At the week's end each horizon's grid forecasts of the two are paired
on the same pair and close, the realized move scored against each one's levels (pinball loss, the share inside the 80%
range) and P(up) (the Brier score against an even chance), and the differences read with 90% intervals by hour blocks
and the challenger's floors (1% of the pinball, two points of coverage, a point of skill), as the walk forward pairs two
runs. The shadow is put in use where no horizon with 200 paired outcomes or more is worse beyond noise; otherwise it is
dropped, unread where no horizon had 200. No refit is made while a shadow is in its week, or a week-old run in use would
be cleared by every refit and no week would end. Registered before any shadow ran: V72R-S8-SHADOW, judged on Stage 9's
runs (the shadow forecasting the closes the run in use forecasts, its owed outcomes settled, nothing of the run in use's
record or paper trades naming it, a verdict read again equal to the logged one).

## The runs of V7.2-R (Stage 9, 22-25 October 2026; judged in V8 Stage 0, 26 October 2026)

Three runs on scratch profiles were registered before they started (V72R-S9-GATES): an hour with OpenRouter faked
(v72r-1h), then twelve hours with the real models resumed to three days in all (v72r-12h, the $3 ceiling for every run's
real calls). The hour passed every gate. The twelve hours and their resumption ran 3,843 of their 5,040 minutes: the
machine lost power at about 14:40 UTC on 25 October, and the run, its supervisor and its last reports went with it.
It was judged as it stands, not resumed: a 21-hour hole cannot be filled, and the gate line had already failed by its
letter before it.

| line | verdict | what it rests on |
|---|---|---|
| V72R-S9-GATES | **failed** | 62 of 62 hourly reports passed; roles and served held (11 calls, all asked and answered by the roles' models, $0.09; the deciding role never asked); the shadow held; but 3 of 199 quarter-hours went without a forecast while the data hosts flapped (19:10-19:12 UTC 23 October; 343 host moves over the run), no final forecast section was made, and the hour and the twelve hours ran from two builds |
| V72R-S8-SHADOW | **held** | the run in use's 4,059 grid forecasts paired 100% by the shadow's, its 13,350 due horizons settled, nothing of the run in use's naming it; its week ends 30 October, after the run, so its verdict is unread |
| V72R-S3-EITHER | **failed** | the chance of a 1% or 2% close either way runs a fifth above what came at an hour on both legs (1%: 20.6% said, 17.1% seen); at four hours 1% held on both legs and 2% on one; the user's record (58 hourly outcomes) is too short to read; a day not measured |
| V72R-S3-LINES | not measured | 6,178 decisions, all NO_CALL: the 1%/2% line never had a call to hold back |
| V72R-S4-COSTS | not measured | no demo key, and no trade of any kind on the runs |

What the runs show beyond the lines: the app ran unattended for 64 hours on the real market with nothing broken that
the hourly gates read; the models answered as routed; the forecast called no way, so nothing traded, which is what the
year's walk forward said it would do. The card keeps the ninety-day move rates: the either-way odds are not shown, and
V8 reads them again on seven months of saved records (V8-R1-EITHER). The run's scratch profile held copies of the
user's encrypted AI key after the power loss, with the watch switched on; they were deleted by hand on 26 October and
the profile's AI switched off, and from V8 every harness start and session start sweeps such copies.
