# Do Binance's own announcements move prices? — the rule, fixed before the held-out half was scored

**The rule below was committed (4c9028f) before `SET=heldout` was run with `MODE=check` or
`MODE=study`.** Until then, every result here came from announcements made before 2025, and the
held-out half (January 2025 to September 2026) had only been counted: which coins had a market the
day before. Its result is at the end, under [The held-out half](#the-held-out-half-january-2025-to-september-2026).

**The answer:**
- **A delisting passes, held for four hours as a paper short.** The coin is 13.2% lower four hours
  on, after costs. 75 of 87 coins were lower, and two squeezes cost 44% and 80%.
- **The bracket does not pass for any of the first three kinds.**
- **A futures launch or a listing moves the price at once.** It is over before an app reading once a
  minute could act.
- **Binance's Monitoring Tag passes, narrowly, on the bracket.** It was added after, under
  [A fourth kind](#a-fourth-kind-the-monitoring-tag), its rule committed before any of its candles
  were read. The bracket made 0.35% a trade after costs and beat the usual with t 2.3, against a bar
  of 2. Held four hours, a short made 4.5% a trade but missed its bar.

Reproduce with `research/fetch-announcements.mjs`, `research/fetch-news-candles.mjs` and
`research/news.ts`; the commands are at the top of `news.ts`.

## The question

The V3 document asks for news (its sections 12–16 and 76): a feed of what is happening, classified,
put to the models. Before anything is built: does any kind of news move a price by enough, and for
long enough, for an app that reads it once a minute to trade after it?

Binance's own announcements are the place to start:
- They are free, and each one says the minute it was released.
- Their titles follow fixed patterns, so they can be sorted without a model.
- Three kinds name coins this app can read the price of:

| Kind | Example title | Traded | Price read on |
|---|---|---|---|
| **Delisting** | "Binance Will Delist ACX, HFT, PIVX, PYR, VANRY, VIC on 2026-08-17" | short (paper only) | the coin's USDT spot pair |
| **Futures launch** | "Binance Futures Will Launch USDⓈ-Margined CTUSDT Perpetual Contract" | long | the coin's USDT spot pair |
| **Spot listing** of a coin with a perpetual | "Binance Will List Hyperliquid (HYPE) with Seed Tag Applied" | long | the coin's USDT perpetual |

A brand-new coin has no Binance price before Binance lists it, so a listing can only be measured
when the coin was already trading as a perpetual.

## The data

**The announcements.** Binance's public lists, read in full on 5 October 2026: titles and release
times only, never an article's body.

| List | Articles | From |
|---|---|---|
| New Cryptocurrency Listing (48) | 2,276 | July 2017 |
| Delisting (161) | 439 | February 2022 |

**Sorting them** is `shared/newsTitles.ts` (written as `research/newsTitles.ts`, and moved unchanged
once the app read news with it), pinned by `tests/newsTitles.test.ts` on titles copied
from both lists. Fixed patterns, no model:
- **Delisting:** "Binance Will Delist …" and the vote batch's "… and Will Delist …". Not a margin,
  futures, options, earn, loans or pair delisting.
- **Futures launch:** a USDT perpetual only. Not coin-, USDC- or BUSD-margined, not a quarterly, not
  a pre-IPO, pre-market, TradFi or index contract. "Multiple" launches name no coin in their titles,
  so they are left out.
- **Spot listing:** the tickers in brackets of "Binance Will List …". Not leveraged tokens or a
  vote's winner.
- **Pegged coins** (stablecoins, gold, wrapped coins) are dropped from every list: news cannot move
  a price that is held.

Every title of those families the patterns turned away was read by hand. Each was one of these:
- a contract in another margin, a quarterly, or a pre-market, stock or index contract;
- leveraged tokens or a vote's winner;
- a pegged coin;
- a title naming its coin without brackets, or in a script the pattern does not read ("Binance
  Will List ZRX Market", "BSC Projects, CAKE and SPARTA", 牛来).

Only the last kind is missed rather than meant. Its listings are from 2018 to 2020, when none of
those coins had a perpetual to read, apart from the one in Chinese characters.

**The candles** are 1-minute archives from `data.binance.vision`, which keeps coins Binance has
since delisted. For each coin:
- the first symbol that traded the whole day before the announcement is read (a cheap coin's
  perpetual is often `1000…`);
- the days read are three before the announcement's, its own, and the next;
- every file is checked against the SHA-256 Binance publishes and its own CRC.

Of 2,012,566 minutes read for the discovery half, 2 had no trade; those carry the last close.

| | Announcements | Coins named | Measured | Left out |
|---|---|---|---|---|
| Delisting, before 2025 | 23 | 75 | 45 | 30 with no USDT spot pair the day before (they traded only against BTC, BUSD or others) |
| Delisting, held out | 18 | 87 | — | all 87 had a USDT pair the day before |
| Futures launch, before 2025 | 278 | 327 | 221 | 89 with no spot pair; 17 with under a day of candles |
| Futures launch, held out | 126 | 182 | — | 15 had a spot pair the day before; recent launches are mostly of coins Binance spot does not list |
| Spot listing, before 2025 | 175 | 191 | 6 | 185 with no perpetual the day before |
| Spot listing, held out | 26 | 33 | — | 29 had a perpetual the day before |

**The minutes are right.** For each discovery coin, the largest one-minute move within ten minutes
either side of the announcement's minute was found:

| | Coins | Largest move 0 to 2 minutes after | By chance | Before the announcement |
|---|---|---|---|---|
| Futures launch | 238 | 74% (140 in the minute itself) | 14% | 18 |
| Delisting | 45 | 49% | 14% | none |
| Spot listing | 6 | all 6, in the minute itself | 14% | none |

## The method

Each coin an announcement names is one observation. Coins in one announcement move together, and
so do announcements in the same hour, so every t below is computed on hourly means
(`research/events.ts` did the same).

- **Entry** at the open of the second bar after the announcement's minute. An app that reads the
  list once a minute sees an announcement within the minute after it, and can act no sooner.
- **The bracket** is the trade every study here has used (`research/EVENTS.md`), unchanged:
  - stop at 1.5 of the coin's usual fifteen-minute moves and target at 3 of them, measured over
    twelve hours that end fifteen minutes before the announcement;
  - out after 60 minutes otherwise;
  - fees of 0.1% a side;
  - slippage of 0.05% a side, or 0.1% for a coin being delisted, whose book thins.
- **The usual:** the same trade, and the same moves, at every fifteenth minute of the same coin in
  the days before the announcement. Each is finished before the announcement's minute begins.
  "Vs the usual" is the announcement less that.
- **Plain moves:** from the open of the announcement's minute to 1, 5, 15, 60 and 240 minutes and
  a day later, in the news's direction.
- **What an app would miss:** the plain move up to the entry.

## The discovery half: announcements before 2025

Means in percent, in the direction the news is traded, with t on hourly means.

| | Delisting (short) | Futures launch (long) | Spot listing (long) |
|---|---|---|---|
| Coins (announcement hours) | 45 (15) | 221 (195) | 6 (6) |
| The hour before the announcement | −0.28 (t −0.4) | +0.68 (t +3.5) | +3.00 (t +2.6) |
| Move over 1 minute | +3.53 (t +3.4) | +6.80 (t +9.8) | +9.45 (t +4.3) |
| 5 minutes | +9.47 (t +6.3) | +7.58 (t +9.5) | +8.62 (t +5.5) |
| 15 minutes | +14.96 (t +9.0) | +7.98 (t +8.8) | +9.60 (t +3.6) |
| 1 hour | +24.60 (t +7.5) | +7.66 (t +7.4) | +10.11 (t +3.3) |
| 4 hours | +29.32 (t +9.2) | +7.55 (t +7.0) | +12.20 (t +3.5) |
| 1 day | +30.39 (t +9.5) | +6.99 (t +5.0) | +12.31 (t +1.9) |
| 1 day, vs the usual | +29.03 (t +9.8) | −3.06 (t −1.5) | +1.90 (t +0.2) |
| **Missed before the entry** | +4.98 (t +3.7) | **+7.20 (t +9.6)** | +7.77 (t +4.0) |
| **The bracket, net** | **+0.63 (t +2.6)**, 62% ahead | −0.33 (t −1.5), 40% ahead | +0.63 (t +0.4) |
| **The bracket, vs the usual** | **+1.01 (t +4.1)** | −0.20 (t −0.9) | +0.58 (t +0.3) |
| Held four hours, net | **+25.03 (t +7.4)**, 42 of 45 ahead, worst −11.9 | −0.05 (t −0.1), worst −37.9 | +3.81 (t +1.4) |
| Held four hours, vs the usual | **+25.24 (t +7.5)** | −1.15 (t −1.8) | +2.24 (t +0.8) |

### What it says

**A futures launch moves the coin, and is over in a minute.**
- The spot price jumps 6.8% in the announcement's own minute and is no higher an hour later.
- Of the 7.7% it gains in the hour, 7.2% has gone before an app reading once a minute could buy.
- The bracket loses 0.33% a trade. Held for four hours it loses too, and once the coin's usual run
  is taken off, it is 1.1% worse.
- The coins had risen 0.68% in the hour before the announcement: either word gets out early, or
  Binance launches futures on coins already moving.

**A delisting is a slow fall.**
- 5% of the fall happens before an app could act, and about 20% more follows within the hour.
- 42 of 45 coins were lower four hours on than at the entry, by more than the costs.
- The bracket keeps little of that. Its target is three of the coin's usual moves, a few percent;
  the bounces on the way down reach its stop. It still nets +0.63%, with t 2.6.
- Held for four hours, the same entry made 25%.
- **This is what the price did, not a trade anyone could have taken on Binance.** Binance spot
  cannot be sold short, and Binance often closes margin borrowing and the perpetual of a coin it is
  delisting. In this app a short is paper only in any case: on 3 October the user decided that a
  short can never be placed for real.

**A listing of a coin that already had a perpetual:** six before 2025, so nothing can be said. The
held-out half, with 29, is the first test of it.

## The rule, fixed now

The held-out half is the announcements from 1 January 2025 to 30 September 2026. On it, each kind
of news is scored exactly as above, with nothing changed: the sorting, the symbols, the costs, the
usual and the entry. Two trades are scored for each kind:

1. **The bracket.** Fixed in the plan before any data was read. It passes if its mean net over the
   hourly means is above zero, and its mean excess over the usual has **t ≥ 2**.
2. **Held four hours**, the same entry with no stop, out at the open 240 minutes after the
   announcement's minute. Written down after seeing the discovery half, so it is held to a
   stricter bar: mean net above zero, and excess over the usual with **t ≥ 3**.

A kind of news passes if either of its trades passes. All three kinds are scored, whatever their
discovery half showed. The minutes are checked on the held-out half as they were above, first.

**What a pass would build (V3 Stage 7):**
- a reader of the same public list, once a minute, sorted by these same patterns (the module moved
  to `shared/` and kept under its tests);
- the news on Discovery;
- a passing kind raised as an event for the watch, so it is put to the models like any other.

**A delisting can only ever be a paper short.** For someone holding the coin it would be a reason to
sell, not a trade, and a notice of that kind is not in the approved plan: it would be offered, not
built.

**If nothing passes, nothing is built,** and this file says so.

## The held-out half: January 2025 to September 2026

Scored once, after the rule above was committed.

**The minutes are right here too.** The largest one-minute move fell in the announcement's minute
or the two after it for most coins, and for none before it:

| | Coins | 0 to 2 minutes after |
|---|---|---|
| Delisting | 87 | 49 (56%) |
| Futures launch | 15 | 14 (93%) |
| Spot listing | 29 | 26 (90%) |

**The results.** Means in percent, in the direction the news is traded, with t on hourly means. One
spot listing had under a day of candles before it and is left out.

| | Delisting (short) | Futures launch (long) | Spot listing (long) |
|---|---|---|---|
| Coins (announcement hours) | 87 (18) | 15 (11) | 28 (23) |
| The hour before the announcement | +0.30 (t +0.8) | −0.63 (t −1.2) | −0.15 (t −0.3) |
| Move over 1 minute | +3.57 (t +1.2) | +9.90 (t +3.6) | +13.18 (t +4.6) |
| 5 minutes | +5.85 (t +1.0) | +12.99 (t +3.1) | +15.41 (t +4.2) |
| 15 minutes | +3.24 (t +0.5) | +12.33 (t +2.9) | +16.31 (t +3.9) |
| 1 hour | +2.59 (t +0.2) | +11.45 (t +3.6) | +19.53 (t +3.5) |
| 4 hours | +14.57 (t +3.1) | +11.35 (t +2.9) | +19.00 (t +3.5) |
| 1 day | +18.51 (t +4.9) | +4.50 (t +0.8) | +16.59 (t +1.9) |
| 1 day, vs the usual | +16.77 (t +4.5) | −13.79 (t −1.2) | +10.61 (t +1.3) |
| Missed before the entry | +0.11 (t +0.0); +5.37 a coin | +12.22 (t +3.2) | +16.53 (t +4.0) |
| The bracket, net | +0.29 (t +0.7), 47% ahead | −0.40 (t −0.3), 33% ahead | −0.56 (t −0.7), 18% ahead |
| The bracket, vs the usual | +0.69 (t +1.7) | −0.22 (t −0.2) | −0.37 (t −0.5) |
| **Held four hours, net** | **+13.17 (t +4.8)**, 75 of 87 ahead, worst −80.3 | −0.94 (t −0.7), worst −21.9 | +2.39 (t +0.6), worst −45.1 |
| **Held four hours, vs the usual** | **+13.37 (t +4.9)** | −3.25 (t −1.7) | +1.91 (t +0.5) |

**Against the rule:**

| | The bracket (t ≥ 2) | Held four hours (t ≥ 3) | |
|---|---|---|---|
| Delisting | +0.29 net, vs the usual t 1.7: fails | **+13.17 net, vs the usual t 4.9: passes** | **passes** |
| Futures launch | −0.40 net: fails | −0.94 net: fails | fails |
| Spot listing | −0.56 net: fails | +2.39 net, t 0.5: fails | fails |

### What it says

**A delisting is still a slow fall, held for four hours.**
- From the second bar to four hours on, the short made 13.2% a coin on hourly means and 15.5% a
  coin over all coins. That is half what it made before 2025, and far beyond its costs.
- The bracket still keeps too little of it to pass.

**One announcement was not a plain delisting.** UTK's, on 14 April 2026, came with a rebrand and an
airdrop, and the coin doubled at once.
- The patterns read it as a delisting, as was written down before this half was scored, so it
  stays in.
- It is its own hour, and it pulls the hourly means at 1 to 60 minutes to nearly nothing. Per coin,
  the fall at an hour was 14%.
- Shorted from the second bar, when it had already doubled, it still made about 23% by four hours.

**The tail is part of the trade.** Two coins were squeezed upward after their announcements. Held
short with no stop:

| Coin | Announced | Rose | Lost |
|---|---|---|---|
| ALPACA | April 2025 | 84% within the hour | 44% |
| BSW | June 2025 | 73% within four hours | 80% |

A coin about to be delisted is a crowded short. The mean is what is left after those.

**A futures launch and a listing move the price at once, and are done.**
- 15 futures launches added 12% before an app reading once a minute could buy.
- 28 listings of coins that already had a perpetual added 16.5%.
- From the entry on, neither trade pays for either kind.

### What it means for the app

By the rule, delisting passes, so Stage 7 goes ahead for it alone. But what passed is not quite
what the plan proposed to build.

**Raising it for the watch would not capture it.** The plan raises a passing kind "as an event, so
the watch takes it up like a scanner event". The watch's paper trade follows the model's own entry,
stop and target, which is a bracket by another name, and the bracket is what failed.

**What paid is a rule.** Sell short at once and hold four hours, with no stop.
- A short is paper only here.
- Binance spot cannot be sold short in any case.

**For real money, the same finding points the other way: to holders.** A holder who sold at the
second bar rather than four hours later kept about 13% of the coin's value, on average. That is a
reason to sell, not a trade. A notice of it is not in the approved plan.

So the parts every use of it needs were built first:
- the reader of Binance's list;
- the patterns, moved to `shared/`;
- the news on Discovery.

How a delisting should act was left to the user. On 5 October they chose three of the four
choices offered, and not "leave it":
- **a notice** to someone holding the coin;
- **the paper short by the rule**, the trade above;
- **the models**, as the plan first said, alongside the rule.

The README describes what was built (Discovery, "Binance's announcements on Discovery").

## A fourth kind: the Monitoring Tag

**This section was committed before a single candle of a tagged coin was fetched.** Its result is
added below it, once.

**What it is.** Since July 2023, Binance has marked the coins it may delist with a Monitoring Tag
("Introducing Seed Tags & Monitoring Tags for Tokens with High Volatility and Risks"). Coins are
added to it in announcements like "Binance Will Extend the Monitoring Tag to Include AVA, GNS, SCR &
TOWNS on 2026-09-04".

**Why it is next.** The tag is the warning before the delisting that passed above. From the titles
alone, before any price was read:
- 81 of the 87 coins delisted in the held-out half had been tagged first, a median of 57 days
  before.
- 84 of the 97 coins tagged before April 2026 had been delisted by 5 October 2026.

If a delisting is a slow fall, the tag may be where it starts. The question is the one asked of the
other kinds: does the tag's announcement move the price by enough, and for long enough, for an app
that reads once a minute to trade after it?

**The announcements.** They are in Binance's news list (catalog 49): 4,439 articles back to July
2017, read on 5 October 2026, titles and release times only. 26 of them name the tag, and one more
is in the delisting list. A fixed pattern reads them (written as `research/monitoringTitles.ts`, and
moved unchanged to `shared/newsTitles.ts` once the app read the tag; pinned on all 27 titles by
`tests/newsTitles.test.ts`):
- Only the coins being added are named. Coins the same title takes the tag, or a Seed Tag, off are
  left out.
- Pegged coins (AEUR, VAI) are left out, as for every kind.
- Two of the 27 add no coin: the one introducing the tag, and one that only takes tags off.

| | Announcements | Coins named |
|---|---|---|
| Before 2025 | 5 | 34 |
| Held out, January 2025 to September 2026 | 20 | 103 |

**The three kinds already scored are untouched.** They are still read from the two lists they were
scored on. With the news list added, the coins they name are byte for byte what they were.

### The rule

Everything is as for the other kinds, unchanged:
- the candles and the symbols;
- the entry, at the second bar after the announcement's minute;
- the bracket, and the four-hour hold;
- the usual, fees, and t on hourly means.

The tag is traded short (paper only), on the coin's USDT spot pair. Slippage is 0.1% a side, as for
a delisting, because a tagged coin's book is thin.

The same two trades are held to the same bars:
1. **The bracket** passes if its mean net is above zero, and its excess over the usual has
   **t ≥ 2**.
2. **Held four hours** passes if its mean net is above zero, and its excess over the usual has
   **t ≥ 3**.

The tag passes if either trade passes **on the held-out half**: 20 announcements, 103 coins.
- Before 2025 is scored and shown beside it, and decides nothing.
- Five announcements are too few to choose a rule from, and none was chosen from them. These are
  the delisting's trades, carried over before any tagged coin's price was read.
- The minutes are checked first, on both halves, as they were above.

**A pass builds nothing by itself.** The user is asked what the app should do with it, as they were
for a delisting. A short stays paper only.

**If it fails, nothing is built,** and this section says so.

### The result

Scored once, after the rule above was committed (c1faf2a). Every one of the 137 coins had a USDT
spot pair trading the day before, and none had under a day of candles before it.

**The minutes are right.** The largest one-minute move within ten minutes of the announcement fell
in its own minute or the two after it:

| | Coins | 0 to 2 minutes after | By chance | Before the announcement |
|---|---|---|---|---|
| Before 2025 | 34 | 14 (41%) | 14% | 3 |
| Held out | 103 | 75 (73%) | 14% | none |

**What the tag did.** Means in percent, short (a fall is positive), with t on hourly means.

| | Before 2025 | Held out |
|---|---|---|
| Coins (announcement hours) | 34 (5) | 103 (20) |
| The hour before the announcement | +0.25 (t +0.9) | +0.67 (t +1.6) |
| Move over 1 minute | +0.91 (t +1.5) | +4.15 (t +5.4) |
| 5 minutes | +2.54 (t +1.3) | +7.51 (t +5.3) |
| 15 minutes | +3.33 (t +1.5) | +6.92 (t +7.0) |
| 1 hour | +5.58 (t +2.6) | +7.65 (t +4.2) |
| 4 hours | +8.93 (t +4.2) | +9.68 (t +5.5) |
| 1 day | +12.14 (t +6.1) | +11.92 (t +7.7) |
| 1 day, vs the usual | +8.89 (t +4.1) | +11.26 (t +5.4) |
| Missed before the entry | +1.43 (t +1.4) | +4.76 (t +5.9) |
| **The bracket, net** | +0.56 (t +2.9), 71% ahead | **+0.35 (t +1.2)**, 57% ahead |
| **The bracket, vs the usual** | +0.91 (t +4.5) | **+0.71 (t +2.3)** |
| Held four hours, net | +7.19 (t +4.9), 28 of 34 ahead, worst −9.7 | +4.48 (t +2.0), 82 of 103 ahead, worst −39.2 |
| Held four hours, vs the usual | +7.25 (t +4.8) | +4.73 (t +2.1) |

**Against the rule:**

| | The bracket (t ≥ 2) | Held four hours (t ≥ 3) | |
|---|---|---|---|
| Monitoring Tag | **+0.35 net, vs the usual t 2.3: passes** | +4.48 net, vs the usual t 2.1: fails | **passes** |

#### What it says

**The tag starts a fall, and half of the first four hours of it comes at once.**
- In the held-out half, a tagged coin was 4.1% lower within its minute, 9.7% four hours on and
  11.9% a day on.
- 4.8% of that had gone before an app reading once a minute could act.

**The bracket passes, narrowly.**
- It made 0.35% a trade after costs, and beat the usual with t 2.3 against a bar of 2.
- Its net alone has t 1.2: on its own it cannot be told from nothing.
- It was ahead after 13 of the 20 announcements, and on 57% of the coins.

**Held four hours, the short made more, and missed its bar.**
- It made 4.5% a trade, and was ahead after 17 of the 20 announcements and on 80% of the coins.
- Its t of 2.1 falls short of the 3 it was held to: the hold was written down after the delisting's
  discovery half had been seen.
- One announcement carried much of its mean. On 3 April 2025, ten coins each fell 17% to 40% in
  four hours; without that hour, the hold's mean is 3.2%.
- **A tagged coin can be squeezed, as a delisted one can.** LEVER, tagged in May 2025, rose and the
  short lost 39%; GPS, tagged alone that March, lost the short 18%.

**Before 2025, both trades looked stronger,** on five announcements. The first minute's fall was
smaller then (0.9%), and more of the fall came within an app's reach.

**For someone holding the coin,** the tag is a warning twice over:
- A holder who sold at the second bar, rather than a day later, kept about 7% more of the coin's
  value, on average.
- 84 of the 97 coins tagged before April 2026 were delisted by 5 October 2026, and a delisting is a
  further fall (above).

#### What it means for the app

By the rule, the tag passes. As promised above, nothing is built until the user says what it
should do. The app's reader does not read Binance's news list yet, so any use of it starts there.

What passed is the bracket, with a stop and a target, out within the hour. It is the trade the
delisting failed, and closer to the watch's own paper trades, which follow a model's entry, stop and
target. It passes by a small margin, and a paper short is the only way it can be traded here.

On 5 October the user chose the same three for a tag as for a delisting, and not "only show it":
- **a notice** to someone holding the coin;
- **the paper short by the rule**: the bracket above, entered at the second bar after the
  announcement's minute, as it was measured;
- **the models**, alongside the rule.

The app's reader now reads Binance's news, and sorts the tag by these same patterns, moved to
`shared/newsTitles.ts`. Each of the three is switched on its own, beside a delisting's, under
Settings › Market; the README describes what was built ("What a Monitoring Tag does").

## After the study: the record

The study's held-out half ended on 30 September 2026. From 1 October, each rule that passed is kept
to account in the app, on Discovery ("The news rules since the study"):
- every delisting and every coin Binance adds to the Monitoring Tag is scored as its rule trades it,
  whether or not anything was traded;
- the scoring is this study's own arithmetic, moved to `shared/newsRules.ts`, which `news.ts` now
  imports. Its output is unchanged to the byte: the plan, the minute checks and both halves' scores;
- each rule's mean per coin sits beside the held-out half's: a delisting held short made 15.5% a
  coin there, and the tag's bracket 0.6%.

On 5 October 2026, when the record began, Binance had announced neither since the study ended.

The same day, after `research/UPBIT.md` was scored, the user chose to keep two near misses on
record beside the rules, the same way:
- **the Monitoring Tag held short four hours** (above: 4.5% a trade, t 2.1 against a bar of 3);
- **Upbit's caution designation held short four hours** on the coin's Binance pair (3.9% a coin,
  t 2.3 against 3).

Both are a slow fall after an exchange's warning, short of its bar on its own. The record shows
whether that goes on. Nothing in the app acts on either.
