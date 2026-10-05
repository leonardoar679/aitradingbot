# How is the market positioned at an event? — the rule, fixed before the held-out pairs were scored

**Written and committed before `SET=confirm` or `SET=small` was run with `MODE=study`.**
Everything in the first half of this file comes from BTC, ETH, SOL and ADA. BNB, LINK, LTC and
XRP, and the seven smaller pairs, have been scored for events (`research/EVENTS.md`) and for setups
(`research/SETUPS.md`), but never against positioning.

Reproduce with `research/fetch-positioning.mjs`, `research/positioning-live.mjs` and
`research/positioning.ts`. The commands are at the top of each.

## The question

Everything this app has measured so far comes from a pair's own candles, and none of it is a trade:

- Taking every event loses 0.13% to 0.39% a trade, whichever side is taken (`research/EVENTS.md`).
- Five models asked about events did no better than taking every one, and two of them were
  frontier models.
- The one real effect is that falls come back, and it is a third of what a round trip costs.

The futures market says things a candle does not:

- whether traders were opening positions or closing them as the price moved;
- which way ordinary accounts, and the largest traders, lean;
- how far the perpetual trades above or below the spot index, which is the gap funding is computed
  from.

So, two questions:

1. **Does positioning say which events to take?** These are the events the app raises: breakouts and
   breakdowns at candidate or above, from the detector as committed (`events-v1`). The question is
   whether one half of them, split by a positioning reading, makes the bracket a trade. Which half,
   if either, is left for the data to say.
2. **Does a crowded market come before a move on its own?** A crowded market is accounts leaning
   far from where they were over the day, and the premium far from where it usually sits, both
   the same way, with no event. It is scored against arbitrary minutes, as `research/SETUPS.md`
   scored its setups.

## The data

Binance's free archive at `data.binance.vision`:

- `futures/um/daily/metrics`, one row every five minutes. It holds open interest, the long/short
  ratio of all accounts, the long/short ratios of top traders' accounts and positions, and the
  ratio of taker buy to sell volume on the perpetual.
- `futures/um/monthly/premiumIndexKlines`, at five minutes.
- `futures/um/monthly/fundingRate`.

Each archive file is checked against the SHA-256 Binance publishes beside it. The eight large pairs
are fetched from 1 May 2023 and the smaller ones from 1 August 2025, a month before their candles
begin, so the first events have a day behind them.

Every file Binance lists for these pairs and days was fetched, and every one passed its checksum.
What is missing is missing from Binance's own archive:
- **Large pairs:** each has 350,345 to 350,363 of a possible 350,496 metrics rows. The gaps are one
  of 10½ hours from 13:30 UTC on 16 February 2024 in every pair, and a few of 10 to 45 minutes. Each
  column has fewer than 90 empty cells a pair.
- **Smaller pairs:** complete except for one hole of 20 minutes. SUPERUSDT and ARKUSDT have a few
  more short holes, and no taker volume on 292 and 384 rows.
- **Premium index:** missing for all of 29 June 2026, in every pair.

A reading that would span a hole is no reading.

**The archive says what an app would read live.** `research/positioning-live.mjs` set the archive
against `fapi.binance.com`'s public endpoints over the 30 days those keep, on BTCUSDT and DOTUSDT,
8,064 rows a series:

| Series | Against the live endpoint |
|---|---|
| Open interest, contracts and value | identical, at a stamp 5 minutes later |
| Long/short ratio: all accounts; top traders' accounts and positions | equal to the live API's four decimals, at a stamp 5 minutes later |
| Taker buy/sell volume | equal at the same stamp; median difference 0.03%, largest 0.4% |
| Premium index, 5-minute bars | identical at the same stamp |

**When a number exists.** These rules come from what the live API showed:

- The archive stamps a row with the *start* of the five minutes it describes.
- The live API stamps open interest and the ratios with the *end* of those minutes, and taker volume
  with the start.
- Rows appeared on the live endpoints 1 to 4 minutes after their five minutes ended.

So a row is used only once **ten minutes have passed since its archive stamp**. A premium bar is
used only once ten minutes have passed since it opened. This holds here and in anything that reads
the same numbers live. The study asserts it on every read.

One consequence is worth knowing before reading any table. At an event, the readings describe the
market 10 to 25 minutes before the reading, not the last minutes of the move: those are not
published yet when a decision would have to be made. On BTCUSDT's first breakout in the series,
perp takers bought heavily in the five minutes before the reading, and the reading cannot see it.

## The five readings

Each is a fixed formula on the rows published by the reading's minute. There are at most 289 rows
of one series, which is one live call. A reading spanning a hole in the series is no reading, never
an older row in its place.

- **Positions added**: open interest in contracts, against an hour before, in percent.
- **Accounts leaning**: the share of accounts long, less its mean over the 24 hours of rows before,
  in points.
- **Top traders leaning**: the same for the share of top traders' positions long.
- **Perp takers buying**: the share of taker volume on the perpetual that bought, over the last
  three published five-minute periods, less a half, in points.
- **Premium**: the perpetual's premium over the index, the mean of the last twelve published
  five-minute closes, in percent.

At an event, the last four are turned to face the move: positive where they lean the way the price
went. Positions added is left as it is, since opening positions has no side.

## How it is scored

Exactly as `research/EVENTS.md` scored events:

- **The bracket:** entry at the open of the second bar after the reading; a stop 1.5 and a target 3
  of the pair's usual fifteen-minute moves away; sixty minutes at most; a bar touching both counted
  as the stop.
- **Costs:** 0.1% a side in fees, and 0.02% slippage on each market fill (0.05% on the smaller pairs).
- **Against the usual:** every result is also set against the same bracket at every fifteenth minute
  of the pair's history.
- **Hours, not events:** observations in the same hour count as one, and every t is on hourly means.

For question 1, each reading splits the events of each type at a point fixed from `MODE=freq` before
any outcome was seen: the reading's median over the discovery pairs' events.

| Reading | Breakouts split at | Breakdowns split at |
|---|---|---|
| Positions added, % | +0.0817 | +0.0058 |
| Accounts leaning, points | −0.5626 | −0.4434 |
| Top traders leaning, points | −0.0344 | −0.0126 |
| Perp takers buying, points | +2.8824 | +3.8131 |
| Premium, % | −0.0423 | +0.0437 |

The medians already describe the market at events, before any outcome:
- Ordinary accounts lean *against* a move: towards shorts on a breakout, towards longs on a
  breakdown.
- Perp takers lean with it.
- The premium sits a little below zero most of the time, so "facing the move" mostly splits
  breakdowns from breakouts by sign.

For question 2, a market is **crowded long** when, at the same time:
- the accounts lean is **+2.712 points** or more;
- the premium is **+0.05109%** or more.

It is **crowded short** at −2.767 points or less, with a premium of −0.05747% or less.

Each threshold is its reading's 90th (or 10th) percentile at every fifth minute on the discovery
pairs. That is the least extreme of 90, 95, 97.5, 99 and 99.5 at which no discovery pair sees a crowd
more than once a day a side: 0.19 to 0.83 times a day. A crowd is counted only below candidate,
outside the half hour after an event, and once per pair, side and half hour. It is scored taking the
crowd's side, and taking the other.

## What the four discovery pairs show

1 June 2023 to 29 August 2026, 1,185 days. There were 4,609 breakouts and breakdowns at candidate or
above, the same count `research/setups.ts` raises on these candles. All five readings were available
on 4,590 of them.

**Every event, before any split.** This agrees with `research/EVENTS.md` to within a few events:

| | Events | Net, per trade | Against the usual | t |
|---|---|---|---|---|
| Breakout, follow (buy the rise) | 2,290 | −0.280% | −0.041% | −2.6 |
| Breakout, fade (short the rise) | 2,290 | −0.198% | +0.037% | +2.3 |
| Breakdown, follow (short the fall) | 2,319 | −0.308% | −0.073% | −4.6 |
| Breakdown, fade (buy the fall) | 2,319 | −0.147% | +0.092% | +4.9 |

**Split by each reading.** Each cell is the high half less the low half, measured against the usual,
with its t:

| Reading | Breakout, follow | Breakout, fade | Breakdown, follow | Breakdown, fade |
|---|---|---|---|---|
| Positions added | −0.035% (−1.2) | +0.004% (+0.1) | +0.023% (+0.8) | −0.031% (−0.9) |
| Accounts leaning | −0.055% (−1.9) | +0.038% (+1.2) | −0.078% (−2.5) | +0.065% (+1.9) |
| Top traders leaning | +0.013% (+0.4) | −0.050% (−1.6) | −0.004% (−0.1) | +0.034% (+1.0) |
| Perp takers buying | −0.040% (−1.4) | −0.011% (−0.4) | −0.008% (−0.3) | +0.023% (+0.7) |
| Premium | +0.020% (+0.7) | −0.040% (−1.3) | +0.004% (+0.1) | −0.027% (−0.8) |

Of the forty halves, the best nets −0.115% a trade: buying a breakdown where accounts lean towards
shorts more than they had over the day.

**A crowded market:**

| | Seen | Against the crowd: net, against the usual (t) | With the crowd: net, against the usual (t) |
|---|---|---|---|
| Crowded long | 3,113 | −0.265%, −0.031% (−1.5) | −0.232%, +0.008% (+0.4) |
| Crowded short | 1,855 | −0.158%, **+0.081% (+3.4)** | −0.305%, −0.070% (−3.1) |

And the plain move against the crowd, before costs, less the pair's own drift:

| | +1 hour | +4 hours | +24 hours |
|---|---|---|---|
| After a crowded long | −0.001% (t −0.0) | +0.104% (t +1.9) | +0.307% (t +2.6) |
| After a crowded short | +0.062% (t +2.2) | +0.229% (t +4.1) | **+0.413% (t +3.4)** |

Read together:

1. **Positioning does not sort events.** None of the twenty differences reaches t = 3, and no half
   of any split nets positive. The largest is in breakdowns: following one does worse where accounts
   lean towards shorts more than usual (t = −2.5). That is "falls come back" from another angle,
   not a new effect.
2. **A crowded market is not a trade within the hour.** Buying a market crowded short beats an
   arbitrary buy by 0.08% a trade (t = 3.4). That is a third of a round trip's cost again, the same
   size as buying a fall.
3. **A crowd is wrong over the next day.** After a crowded short, the price rises 0.41% more than
   usual over 24 hours. After a crowded long, it falls 0.31% more. This is before costs, at a
   horizon the app does not trade. Two cautions:
   - A crowd short is often a market that has just fallen, since accounts turn short and the
     perpetual slips to a discount as the price drops. So this may be `EVENTS.md`'s recovery seen
     through positioning, and nothing here separates the two.
   - Crowds a few hours apart have overlapping 24-hour windows, which an hourly t does not account
     for, so these t values are optimistic.

## The rule, fixed here

Three statements, each scored once on each held-out set at the same fixed points and thresholds.

**1. Positioning makes an event a trade.** Nothing went forward: on discovery no difference between
halves reached t ≥ 3, and no half netted positive. The held-out sets can only be checked for the same
absence. A half that nets positive there and beats the usual with t ≥ 2 is reported as *seen once,
unconfirmed*, and is not a result. A rule picked from the set it is scored on is a description.

**2. A crowded market is a trade, at the bracket.** Nothing went forward: neither side of either
crowd netted positive on discovery. It is checked for the same absence, in the same way.

**3. A crowd is wrong over the next day.** This is a description, fixed here because it is the
largest thing discovery showed. It is confirmed only if, on **both** held-out sets, the plain move
against the crowd over the 24 hours after it, less the pair's drift, is **positive with t ≥ 2**.
That has to hold for crowds long and for crowds short, each. It is a statement about direction
before costs.

**4. What is built.** A positioning reading goes into the app only if statement 1 or 2 is confirmed.
Neither can be, since nothing went forward, so **nothing is built under this plan**, whatever the
held-out sets show. Statement 3, confirmed or not, is written down as a result. Holding against a
crowd for a day is a different trade, with its own costs and risks, and whether it pays is a
question for a plan of its own.

There is no tie-break and no partial credit. Forty halves, four crowd rows and six crowd moves were
looked at to write these.

## The held-out sets

- **`confirm`**: BNBUSDT, LINKUSDT, LTCUSDT, XRPUSDT. The same 1,185 days.
- **`small`**: STRKUSDT, FETUSDT, SUPERUSDT, AXSUSDT, DOTUSDT, ICPUSDT, ARKUSDT, from 1 September
  2025 to 1 October 2026. These are `research/EVENTS.md`'s eight smaller pairs without RAYUSDT,
  which has no perpetual.
