# What follows a market event? — the rule, fixed before the held-out pairs were scored

**Written and committed before `SET=confirm`, `SET=small`, `SET=flow-a` or `SET=flow-b` was ever
run.** Everything in the first half of this file comes from BTC, ETH, SOL and ADA. BNB, LINK, LTC
and XRP, and the eight smaller pairs, have not been looked at for this question.

Reproduce with `research/events.ts` (the commands are at the top of that file).

## The question

The scanner (`shared/marketEvent.ts`) reads every watched pair once a minute and raises an event
when a fifteen-minute move is large for that pair, on heavy volume, with wide bars, closing at
their extremes, and clearing the high or low of the four hours before it. A model is then asked
whether the event is a trade.

That is only worth paying for if events are different from other minutes. So before any model is
asked anything: **after an event, does the market do something it does not do at arbitrary
times, and is it enough to pay for a round trip?**

`research/SHORT-TERM.md` asked a version of this on 15-minute bars and found that volume spikes
and one-hour rises are followed by nothing, and one-hour falls by a recovery that takes a day.
This asks it of the scanner's own events, on 1-minute bars, with a trade that has an entry delay,
a stop, a target and a time limit.

## How an event is scored

One trade, fixed here and the same for every pair:

- **Entry** at the open of the second bar after the reading: at least a full minute after the
  last price the detector saw. Nothing is filled at a price that had already been seen.
- **Stop** 1.5 and **target** 3 of the pair's usual fifteen-minute moves away, the usual move
  being measured over the hours before the event began. **Time limit** 60 minutes.
- A bar touching both levels counts as the stop. A bar that opens beyond the stop fills at its
  open.
- **Costs**: 0.1% a side in fees, and 0.02% slippage on every market fill — 0.05% on the smaller
  pairs, which is an assumption, since a historical spread is not in a candle.

*Follow* takes the event's side (long a rise, short a fall). *Fade* takes the other.

Two things every figure below is measured against:

- **The usual.** The same bracket at every fifteenth minute of the pair's whole history, each
  side. On BTCUSDT that earns −0.237% long and −0.237% short: the cost, and nothing else. An
  event's result means nothing until this is taken off it.
- **Hours, not events.** When the whole market moves, four pairs raise an event in the same
  minute and their outcomes are nearly one outcome. Every `t` is computed on hourly means.

## What the four discovery pairs show

1 June 2023 to 29 August 2026, 1,185 days of 1-minute candles.

**How often.** Per pair per day: 1.8 to 2.3 events at the watch band, 0.6 to 1.0 at candidate,
0.3 to 0.7 at urgent. A rise or fall that does not clear the prior four hours never reaches
candidate at all (65 and 86 of them at watch, none above), so above the watch band every event
with a direction is a breakout or a breakdown. The fifteen-minute move behind a typical one is
0.8% on BTC, 1.1% on ETH and 1.7% on SOL and ADA.

**What followed**, at candidate or above:

| | Events | Hours | Net, per trade | Against the usual | t |
|---|---|---|---|---|---|
| Breakout, follow (buy the rise) | 2,244 | 1,236 | −0.278% | −0.039% | −2.4 |
| Breakout, fade (short the rise) | 2,244 | 1,236 | −0.199% | +0.036% | +2.1 |
| Breakdown, follow (short the fall) | 2,268 | 992 | −0.307% | −0.072% | −4.4 |
| Breakdown, fade (buy the fall) | 2,268 | 992 | −0.145% | **+0.094%** | **+5.0** |

And the plain move in the event's direction, before costs and less the pair's own drift:

| | +15m | +60m | +4h | +24h |
|---|---|---|---|---|
| Breakout | −0.043% (t −2.2) | −0.073% (t −2.2) | −0.065% (t −1.3) | +0.054% (t +0.5) |
| Breakdown | −0.116% (t −4.2) | −0.172% (t −4.8) | −0.128% (t −2.2) | −0.330% (t −2.8) |
| Volume spike, no direction (as a rise) | +0.016% (t +1.2) | −0.023% (t −0.9) | −0.036% (t −0.8) | −0.037% (t −0.4) |

Read together:

1. **Nothing clears its costs.** Every row of the first table is negative after fees. Taking
   every event, either way, is a way to lose between 0.15% and 0.31% a trade.
2. **Rises do not continue.** A breakout bought a minute later does slightly *worse* than a buy
   at an arbitrary minute, and the price gives back a few hundredths of a percent over the next
   hour. This is the premise the scanner was built on, and on these pairs it is false.
3. **Falls come back.** After a breakdown the price recovers about 0.17% over the next hour and
   0.33% over the next day beyond its usual drift, and buying it beats an arbitrary buy by 0.09%
   a trade. It is the one effect here that is large against its own noise — and it is a third of
   what a round trip costs.
4. **A volume spike with no direction says nothing** about the next five minutes or the next
   day.

## The rule, fixed here

Four statements, each scored once on each held-out set.

**1. No event type is tradable by itself.** It failed on discovery already: no row has a positive
net. So the held-out pairs cannot confirm a trade; they can only be checked for the same absence.
If a held-out row shows a positive net with t ≥ 3 it is reported as *seen once, unconfirmed*, and
is not a result — a rule picked from the set it is scored on is a description.

**2. Falls come back.** At candidate or above, the fade of a breakdown beats the usual.
Confirmed only if **on both** held-out sets that row is positive with **t ≥ 2**.

**3. Rises do not continue.** At candidate or above, the follow of a breakout does not beat the
usual. It **fails** on a set where that row is positive with t ≥ 2, which would mean pumps do
carry on there — the thing most worth knowing about the smaller pairs.

**4. The recovery lasts a day.** At candidate or above, the plain move 24 hours after a
breakdown, in the direction of the fall and less drift, is negative. Confirmed only if on both
held-out sets it is negative with **t ≤ −2**.

There is no tie-break and no partial credit. Sixteen directional rows were looked at to find
these, which is the situation in which a weak criterion manufactures a winner.

**And one question about the detector itself.** Its buy-pressure reading is made from candles:
where each bar closed inside its own range. Binance also publishes how much of each bar's volume
was bought by someone lifting the offer. That column is carried into the app only if it predicts
something the candle reading does not. Among events at candidate or above with a direction, the
follow bracket's net is compared between the half with more taker flow in the event's direction
and the half with less. It is adopted only if on the first four smaller pairs (`flow-a`) the
difference has **t ≥ 3** and the same split by the candle reading shows less, **and** on the
last four (`flow-b`) the difference has the same sign with **t ≥ 2**.

## The held-out sets

- **`confirm`**: BNBUSDT, LINKUSDT, LTCUSDT, XRPUSDT. The same 1,185 days, already on disk.
- **`small`**: STRKUSDT, FETUSDT, SUPERUSDT, AXSUSDT, RAYUSDT, DOTUSDT, ICPUSDT, ARKUSDT. Chosen
  by a rule and not by eye: Binance's USDT pairs ranked by 24-hour volume on 4 October 2026,
  stablecoins and pegged tokens excluded, every fifth from the 21st, taking the next one down
  where a pair was listed after 1 September 2025. 1 September 2025 to 1 October 2026, downloaded
  with the taker-buy column (`COLS=flow`).

## Result

Scored once on each held-out set, on 4 October 2026. At candidate or above:

| | Discovery | `confirm` (4 large pairs) | `small` (8 smaller pairs) |
|---|---|---|---|
| Breakout, follow, net | −0.278% | −0.266% | −0.381% |
| Breakout, follow, against the usual | −0.039% (t −2.4) | −0.024% (t −1.2) | −0.079% (t −2.5) |
| Breakdown, fade, net | −0.145% | −0.132% | −0.229% |
| Breakdown, fade, against the usual | +0.094% (t +5.0) | **+0.111% (t +4.9)** | **+0.072% (t +2.3)** |
| Breakdown, plain move after 24h | −0.330% (t −2.8) | −0.335% (t −2.5) | −0.075% (t −0.4) |
| Breakouts and breakdowns scored | 2,244 and 2,268 | 1,607 and 1,827 | 1,586 and 1,496 |

**1. No event type is tradable by itself: holds.** Every net row on both held-out sets is
negative, as on discovery. Taking every event loses between 0.13% and 0.39% a trade, whichever
side is taken.

**2. Falls come back: confirmed.** Buying a breakdown beats an arbitrary buy by 0.11% a trade on
the large pairs (t = 4.9) and 0.07% on the smaller ones (t = 2.3). Both clear the bar. It is a
real property of these markets and it is between a quarter and a half of what a round trip costs.

**3. Rises do not continue: holds, on the smaller pairs most of all.** The follow of a breakout
is below the usual on both sets, and on the smaller pairs it is below it by 0.08% with t = −2.5.
The pairs where a pump was most expected to carry on are the ones where buying it does worst.

**4. The recovery lasts a day: not confirmed.** It holds on the large pairs (−0.335%, t = −2.5)
and is absent on the smaller ones (−0.075%, t = −0.4). One set out of two is a failure by the
rule above, and it is recorded as one. What statement 2 confirmed is a recovery inside the hour.

**Taker flow: not adopted.** On `flow-a` the half of events with more taker flow in their
direction did 0.008% better than the half with less (t = +0.7), where the rule needed t ≥ 3, and
the candle-only reading split the same events just as well (t = +0.7). `flow-b` showed more
(t = +2.3), which under the rule changes nothing: it was the confirmation half, and there was
nothing to confirm. The detector keeps its candle-only reading and the column is not carried into
the app.

## What this changes

- **A volume spike with no direction is no longer raised as an event.** On every set, at every
  horizon from five minutes to a day, what followed one was indistinguishable from nothing — and
  on the smaller pairs they are most of what fires: 6,052 of them at candidate or above in
  thirteen months, against 3,082 breakouts and breakdowns. The scanner still shows one in its
  table. It does not record it or put it forward.
  Every figure above was produced before this change, by the detector as committed in `0799a63`.
  With it, a spike no longer starts a pair's half-hour cooldown, so a few more breakouts and
  breakdowns are raised than were scored here: 4,609 against 4,512 on the discovery pairs.
- **The thresholds stay where the document put them.** With spikes gone, a pair raises about one
  event a day at candidate or above, large or small (0.7 to 1.3 on the discovery pairs, 0.6 to 2.1
  on the smaller ones). Nothing here argues for moving them, and a threshold moved to improve
  these tables would be fitted to them.
- **A model has to beat the usual, and the usual is losing.** The rows it is set beside in the
  benchmark are these: follow every event, and fade every event. Both lose a trade's costs and a
  little more. A model that picks which events to take has to find 0.25% to 0.4% a trade that
  the events do not carry on their own, and the first table says where the little there is sits:
  in falls, not in rises.
