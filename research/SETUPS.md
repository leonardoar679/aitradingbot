# Does anything come before an event? — the rule, fixed before the held-out pairs were scored

**Written and committed before `SET=confirm` or `SET=small` was run with `MODE=study`.**
Everything in the first half of this file comes from BTC, ETH, SOL and ADA, the pairs
`research/EVENTS.md` was found on. BNB, LINK, LTC and XRP, and the eight smaller pairs, have not
been looked at for this question.

Reproduce with `research/setups.ts` (the commands are at the top of that file).

## The question

An event is raised once a fifteen-minute move has happened: large for its pair, on heavy volume,
clearing the four hours before it. `research/EVENTS.md` found that taking one, either way, loses
a round trip's cost and a little more, and the benchmarks since found that the models asked
about events do not change that: on 5 October 2026 five models, two of them frontier models, all
lost or declined to trade.

So: is there anything *before* an event that a model could be asked about instead — a market
that is about to move, rather than one that already has? Two candidates, each a fixed formula on
the reading the detector already takes, from bars up to the reading and nothing after it:

- **A coil under the four-hour high** (and its mirror over the low). The last hour's whole range,
  high to low, is at most 1.5 of the pair's usual fifteen-minute moves — an ordinary hour spans
  about three — and the close is within half a usual move of the four-hour high, and not above it.
  Side: up toward the high (down toward the low).
- **An early move on rising volume.** A fifteen-minute move of at least 1.5 usual moves, the last
  five minutes trading at least three times the usual, the last five minutes still going the same
  way — while the detector's score is still under candidate. Side: the move's.

Neither is counted inside the half hour after an event (that is the event's aftermath), and each
is counted at most once per pair, side and half hour, as an event is.

**The scales were set by how often each fires, before any outcome was looked at.** The early
move was first written with one usual move and twice the volume, and fired twelve to fourteen
times a pair a day, ten times as often as an event; it was raised to the figures above, which
fire two and a half to three times a day a side. A coil fires one to two and a half times a day.
Events at candidate or above fire 0.7 to 1.3 times.

## How a setup is scored

Two things, each against the same pair's arbitrary minutes:

- **Does an event follow?** The share of setups after which the detector raises an event at
  candidate or above, in the setup's direction, within 30 and 60 minutes — against the same share
  after every fifteenth minute held to the same terms (below candidate, not in an event's
  aftermath). Measured on the detector exactly as committed (`events-v1`).
- **Is it a trade?** The bracket `research/EVENTS.md` scored events by, unchanged: in at the open
  of the second bar after the reading, a stop 1.5 and a target 3 of the pair's usual
  fifteen-minute moves away, sixty minutes at most, a bar touching both counted as the stop, 0.1%
  a side in fees and 0.02% slippage on each market fill (0.05% on the smaller pairs) — against the
  same bracket at every fifteenth minute ("the usual").

As before, every `t` is on hourly means: setups in the same hour are one observation.

## What the four discovery pairs show

1 June 2023 to 29 August 2026, 1,185 days of 1-minute candles.

After an arbitrary minute, an event in a given direction follows within an hour 1.0% to 2.2% of
the time, depending on the pair. The usual bracket loses 0.23% to 0.25% a trade either way: the
cost.

| | Setups | Event within 60 min | Arbitrary | Ratio | Excess, t | Bracket, net | Against the usual |
|---|---|---|---|---|---|---|---|
| Coil, up | 8,770 | 2.77% | 1.77% | 1.6 | +5.9 | −0.263% | −0.024% (t −3.3) |
| Coil, down | 5,820 | 2.41% | 1.75% | 1.4 | +4.2 | −0.247% | −0.012% (t −1.5) |
| Early move, up | 12,584 | 13.14% | 1.66% | 7.9 | +26.9 | −0.277% | −0.037% (t −5.4) |
| Early move, down | 13,950 | 12.65% | 1.68% | 7.5 | +23.6 | −0.301% | −0.067% (t −10.5) |

Read together:

1. **A coil hardly predicts anything.** An event follows one about one and a half times as often
   as an arbitrary minute — real, but one coil in forty — and the bracket from a coil does no
   better than from an arbitrary minute.
2. **An early move predicts an event, and is not worth taking.** One in eight becomes an event
   within the hour, eight times the usual rate; it is, after all, the start of the move the
   detector later names. But the bracket taken in its direction does *worse* than at an arbitrary
   minute, on both sides, and down more than up. Being early to an event is worth what the event
   is, and `research/EVENTS.md` found that is a loss: rises do not continue, and falls come back.

## The rule, fixed here

Three statements, each scored once on each held-out set.

**1. A setup predicts an event.** Confirmed for a setup only if on **both** held-out sets the share
followed within 60 minutes by an event in its direction is **at least twice** the arbitrary
minutes' share, and the excess has **t ≥ 3**. On discovery the early move passes this and the
coil does not.

**2. A setup is a trade by itself.** Confirmed for a setup only if on **both** held-out sets the
bracket's net after costs is **positive** and its excess over the usual has **t ≥ 2**. It failed on
discovery for all four rows, so the held-out sets can only be checked for the same absence; a row
that shows it there is reported as *seen once, unconfirmed*, and is not a result.

**3. What is built.** A setup goes into the app — a record of its own beside events, the scanner
listing it apart from them, and a second benchmark dataset so a model can be asked about it before
the move — **only if statement 2 is confirmed for it**. Statement 1 alone is not enough: a setup
that only predicts an event puts a model in front of the same losing move a few minutes sooner. If
no setup confirms statement 2, the result is written down here and nothing is built on it.

There is no tie-break and no partial credit. Four rows were looked at to write these.

## The held-out sets

The two `research/EVENTS.md` used, unchanged:

- **`confirm`**: BNBUSDT, LINKUSDT, LTCUSDT, XRPUSDT. The same 1,185 days.
- **`small`**: STRKUSDT, FETUSDT, SUPERUSDT, AXSUSDT, RAYUSDT, DOTUSDT, ICPUSDT, ARKUSDT,
  1 September 2025 to 1 October 2026.

## Result

*To be written after the held-out sets are scored, once.*
