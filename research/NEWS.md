# Do Binance's own announcements move prices? — the rule, fixed before the held-out half was scored

**Written and committed before `SET=heldout` was run with `MODE=check` or `MODE=study`.** Every
result in this file so far comes from announcements made before 2025. The held-out half (January
2025 to September 2026) has been fetched, and only counted: which coins had a market the day
before. None of its prices have been looked at.

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

**Sorting them** is `research/newsTitles.ts`, pinned by `tests/newsTitles.test.ts` on titles copied
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
