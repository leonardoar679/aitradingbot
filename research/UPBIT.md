# Do Upbit's notices move a coin on Binance? — the rule, fixed before the held-out half was scored

**The rule below was committed (9fe433f) before `SET=heldout` was run with `MODE=check` or
`MODE=study`.** Until then, every result here came from notices posted before 2025. The held-out
half (January 2025 to September 2026) had only been counted: which coins had a Binance market the
day before. Its result is at the end, under [The held-out half](#the-held-out-half-january-2025-to-september-2026).

**The answer: nothing passes, so nothing is built.**
- **A KRW listing moves the coin on Binance at once:** 38% within the notice's minute in 2025 and
  2026. All of it is gone before an app reading once a minute could buy. From there, the coin fades.
- **A caution starts a slow fall, within an app's reach.** Held short four hours, it made 3.9% a
  coin, and 18 of 24 coins were lower. That misses its bar (t 2.3 against 3), as Binance's
  Monitoring Tag held four hours missed it (`research/NEWS.md`).
- **A delisting's fall is immediate,** 6% in the minute, and nothing is left to trade.

Reproduce with `research/fetch-upbit-notices.mjs`, `research/fetch-news-candles.mjs` and
`research/upbit.ts`; the commands are at the top of `upbit.ts`.

## The question

Upbit is Korea's largest exchange. Three kinds of its trading notices name coins that also trade
on Binance:
- **A KRW listing:** the coin gets a market in Korean won, where nearly all of Upbit's trading is.
- **Its caution designation** (거래 유의 종목 지정): Upbit's warning that it may stop supporting a
  coin.
- **A delisting** (거래지원 종료): Upbit will stop supporting it.

The question is the one `research/NEWS.md` asked of Binance's own announcements: does a notice move
the coin's price on Binance by enough, and for long enough, for an app that reads once a minute to
trade after it?

A KRW listing is the best known of the three. Coins have jumped on other exchanges within seconds
of one. Whether anything is left a minute later is what is measured.

The study was chosen by the user on 5 October 2026, while the on-chain study waits for QuickNode's
key.

## The data

**The notices.** Upbit's list of trading notices (거래), read in full on 5 October 2026: 783
notices from 27 October 2017 to 2 October 2026. Titles and the time each was first posted, to the
second; a notice's body was read only where its title could not say which coin got which market
(below).

**Sorting them** is `shared/upbitTitles.ts` (written as `research/upbitTitles.ts`, and moved
unchanged once the app's record read Upbit's cautions with it), pinned by `tests/upbitTitles.test.ts`
on titles copied from the list. Fixed patterns, no model. Upbit has worded each kind several ways since 2017,
and each wording is a pattern:

| Kind | Example titles |
|---|---|
| **KRW listing** | "돌핀(POD) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)" (from 2023), "폴리스웜(NCT) KRW 마켓 디지털 자산 추가", "KRW 마켓 디지털 자산 추가 (ID)" (2021 to 2024), "원화마켓 신규 상장 (샌드박스 SAND)" (2018 to 2021), and in 2019 the notice that a won market would open: "헤데라해시그래프 (HBAR) 입금 지원 및 원화마켓 오픈 예고" |
| **Caution** | "블라스트(BLAST) 거래 유의 종목 지정 안내" (from 2024), "포튜브(FOR) 유의 종목 지정 안내" (before) |
| **Delisting** | "아이콘(ICX) 거래지원 종료 안내 (10/19 15:00)", "고머니2(GOM2) 거래 지원 종료 안내" (before 2022) |

Every title the patterns turned away was read by hand. Each was one of these, and is left out on
purpose:
- **a listing in Upbit's BTC or USDT market alone.** Upbit's trading is in won; its other markets
  are thin.
- **a pegged coin:** USDC, USD1, USDE, RLUSD, EURC, PYUSD, JPYC, USDG, XAUT.
- **a title that counts its coins rather than naming them:** eight caution notices of 2020 and 2021
  (98 coins, "디지털 자산 유의 종목 지정 안내 (25종)") and nine delisting notices like them. Only the
  title is read.
- **Upbit urging caution** (유의 촉구, 42 notices): a lighter notice, and not the designation.
- **a designation lifted, extended, or made for a token swap** (일시 지정).
- **the end of one market or pair of a coin that stays**, or a delisting with a buyback or a swap.
- **Upbit's first weeks, in 2017,** when it opened its first markets and named coins in Korean
  alone.

**One list of markets for several coins.** Twelve listing titles give several coins one list:
"KRW, BTC 마켓 디지털 자산 추가 (SHIB, GAL)". In nine of them, not every coin got the won market;
GAL, for one, got its own a year later. So for these twelve, the notice's body was read by hand for
which coin got the won market. `research/upbit.ts` keeps each answer beside a quote from its notice.

**The same news twice.** In 2019 Upbit said a won market would open, then that it had, hours apart:
ATOM and HBAR. A coin named again by the same kind of notice within 30 days is the same news, and
only the first is measured.

**The same ticker, another coin.** For every coin with a Binance pair, Upbit's Korean name was set
beside Binance's own name for that pair (Binance's public asset list). One differed: Upbit's 젠신
(AI), Gensyn, listed on 30 June 2026, is not Binance's AI, Sleepless AI. It is left out.

**The candles** are Binance's 1-minute spot archives, read as `research/NEWS.md` read them:
- the coin's USDT pair, which must have traded the day before the notice;
- the days read are three before the notice's, its own, and the next;
- every file is checked against the SHA-256 Binance publishes and its own CRC.

Of 486,220 minutes read for the discovery half, none had no trade.

| | Notices | Coins named | Measured | Left out |
|---|---|---|---|---|
| KRW listing, before 2025 | 111 | 124 | 47 | 77 with no USDT spot pair the day before |
| KRW listing, held out | 143 | 144 | — | 64 had a USDT pair the day before |
| Caution, before 2025 | 28 | 45 | 12 | 33 with no USDT spot pair |
| Caution, held out | 45 | 45 | — | 24 had one |
| Delisting, before 2025 | 28 | 47 | 8 | 38 with no USDT spot pair; 1 with no candle at its minute |
| Delisting, held out | 34 | 34 | — | 12 had one |

Most of the coins left out before 2025 traded on Binance only against BTC, or not at all.

**The minutes are right.** For each discovery coin, the largest one-minute move within ten minutes
either side of the notice's minute was found:

| | Coins | Largest move 0 to 2 minutes after | By chance | Before the notice |
|---|---|---|---|---|
| KRW listing | 47 | 96% (39 in the minute itself) | 14% | none |
| Caution | 12 | 50% (6 in the minute itself) | 14% | 1 |
| Delisting | 8 | 50% | 14% | 1 |

## The method

Everything is `research/NEWS.md`'s method, scored by the same code: `research/announcementStudy.ts`,
moved out of `research/news.ts` unchanged. The news study's plan, minute checks and both halves'
scores are the same to the byte.
- **Entry** at the open of the second bar after the notice's minute.
- **The bracket:** stop at 1.5 and target at 3 of the coin's usual fifteen-minute moves, out after
  60 minutes otherwise.
- **The hold:** out at the open four hours after the notice's minute.
- **Costs:** fees of 0.1% a side. Slippage of 0.05% a side for a listing, and 0.1% for a coin Upbit
  warns about or drops, as for Binance's own delisted and tagged coins.
- **The usual:** the same trades and moves at every fifteenth minute of the same coin in the days
  before.
- **t** on hourly means.

Each kind is traded in its natural direction: long after a KRW listing, short after a caution or a
delisting. A short is paper only here.

## The discovery half: notices before 2025

Means in percent, in the direction the notice is traded, with t on hourly means.

| | KRW listing (long) | Caution (short) | Delisting (short) |
|---|---|---|---|
| Coins (notice hours) | 47 (42) | 12 (10) | 8 (6) |
| The hour before the notice | +1.02 (t +3.2) | −2.20 (t −1.2) | −1.03 (t −1.9) |
| Move over 1 minute | +21.86 (t +4.9) | −4.02 (t −2.0) | +2.17 (t +2.2) |
| 5 minutes | +22.90 (t +5.8) | −3.30 (t −1.5) | +2.59 (t +2.3) |
| 15 minutes | +23.85 (t +5.6) | −1.86 (t −0.7) | +3.46 (t +1.9) |
| 1 hour | +21.79 (t +5.0) | +1.21 (t +0.5) | +6.58 (t +1.5) |
| 4 hours | +24.12 (t +5.1) | +9.70 (t +1.2) | +7.40 (t +1.9) |
| 1 day | +18.08 (t +3.4) | +13.92 (t +1.5) | +7.00 (t +2.0) |
| 1 day, vs the usual | +17.36 (t +3.2) | +9.92 (t +1.9) | +9.17 (t +2.1) |
| **Missed before the entry** | **+22.55 (t +5.5)** | −4.15 (t −1.9) | +2.39 (t +2.3) |
| **The bracket, net** | −0.37 (t −1.2), 30% ahead | +1.68 (t +0.7), 42% ahead | +0.81 (t +1.3), 50% ahead |
| **The bracket, vs the usual** | −0.09 (t −0.3) | +1.84 (t +0.9) | +1.29 (t +2.0) |
| Held four hours, net | +1.12 (t +0.5), 23 of 47 ahead, worst −31.1 | +12.92 (t +1.7), 6 of 12 ahead, worst −4.1 | +4.90 (t +1.5), 8 of 8 ahead |
| Held four hours, vs the usual | +1.22 (t +0.5) | +12.30 (t +1.8) | +5.59 (t +1.6) |

### What it says

**A KRW listing moves the coin at once, and that is all of it.**
- The Binance price jumped 21.9% in the notice's own minute, and was no higher four hours on.
- Of it, 22.6% had gone before an app reading once a minute could buy.
- From the entry, neither trade pays. Held four hours, the coins scattered from −31% (NEAR, December
  2021) to +169% (NU, October 2021), with no edge in the mean.
- It is Binance's own futures launches and listings again (`research/NEWS.md`): over within a
  minute.

**A caution is twelve coins, and one of them is LUNA.**
- LUNA, warned about on 11 May 2022 in the middle of its collapse, made the short 79% in four hours.
- Without it, the four-hour short still averaged about 5.6%: MBL, WAVES, DCR and OMG fell after
  their warnings.
- In the minute itself the price rose, on average. With twelve coins, nothing more can be said.

**A delisting is a small, slow fall:** eight coins, all lower four hours on, by 0.2% to 3.5%, and
21.5% for PDA. Eight coins are too few to choose a rule from.

## The rule, fixed now

The held-out half is the notices from 1 January 2025 to 30 September 2026. On it, each kind is
scored exactly as above, with nothing changed: the patterns, the twelve notices read by hand, the
same-news rule, the coin left out, the symbols, the costs, the usual and the entry.

Nothing is added from the discovery half. The two trades are the news study's own, carried over in
each kind's natural direction, and held to the same bars:
1. **The bracket** passes if its mean net over the hourly means is above zero, and its mean excess
   over the usual has **t ≥ 2**.
2. **Held four hours** passes if its mean net is above zero, and its excess over the usual has
   **t ≥ 3**.

A kind passes if either of its trades passes. All three kinds are scored, whatever their discovery
half showed. The minutes are checked on the held-out half first, as they were above.

**A pass builds nothing by itself.** The user is asked what the app should do with it, as they were
for Binance's delisting and tag. A short stays paper only. Nothing real is ever placed or sold
because of news.

**If nothing passes, nothing is built,** and this file says so.

## The held-out half: January 2025 to September 2026

Scored once, after the rule above was committed (9fe433f).

**The minutes are right here too.** The largest one-minute move fell in the notice's minute or the
two after it for most coins, and for none before it:

| | Coins | 0 to 2 minutes after |
|---|---|---|
| KRW listing | 64 | 64 (100%; 62 in the minute itself) |
| Caution | 24 | 16 (67%) |
| Delisting | 12 | 11 (92%) |

**The results.** Means in percent, in the direction the notice is traded, with t on hourly means.
Six KRW listings are left out: Binance had listed those coins too shortly before Upbit did to say
what is usual for them.

| | KRW listing (long) | Caution (short) | Delisting (short) |
|---|---|---|---|
| Coins (notice hours) | 58 (58) | 24 (24) | 12 (11) |
| The hour before the notice | +1.21 (t +2.5) | −0.03 (t −0.1) | −1.48 (t −0.7) |
| Move over 1 minute | +38.30 (t +7.2) | −0.06 (t −0.1) | +6.29 (t +5.4) |
| 5 minutes | +41.22 (t +6.6) | +1.46 (t +2.1) | +7.25 (t +6.4) |
| 15 minutes | +39.97 (t +6.3) | +2.47 (t +3.3) | +7.05 (t +5.2) |
| 1 hour | +38.69 (t +6.4) | +3.98 (t +3.8) | +7.71 (t +3.4) |
| 4 hours | +33.53 (t +6.7) | +5.02 (t +3.2) | +6.00 (t +1.7) |
| 1 day | +27.86 (t +3.7) | +6.32 (t +3.5) | +7.30 (t +1.8) |
| 1 day, vs the usual | +26.75 (t +3.5) | +3.00 (t +1.4) | +10.56 (t +6.2) |
| **Missed before the entry** | **+40.30 (t +7.4)** | **+0.68 (t +1.5)** | +6.23 (t +6.0) |
| The bracket, net | −0.38 (t −1.0), 21% ahead | +0.12 (t +0.4), 54% ahead | −0.87 (t −1.5), 25% ahead |
| The bracket, vs the usual | −0.11 (t −0.3) | +0.49 (t +1.5) | −0.43 (t −0.7) |
| **Held four hours, net** | −3.87 (t −2.0), 22 of 58 ahead, worst −32.8 | **+3.93 (t +2.4)**, 18 of 24 ahead, worst −8.6 | −0.62 (t −0.2), 6 of 12 ahead, worst −33.8 |
| **Held four hours, vs the usual** | −3.89 (t −2.0) | **+3.87 (t +2.3)** | +0.12 (t +0.0) |

**Against the rule:**

| | The bracket (t ≥ 2) | Held four hours (t ≥ 3) | |
|---|---|---|---|
| KRW listing | −0.38 net: fails | −3.87 net: fails | fails |
| Caution | +0.12 net, vs the usual t 1.5: fails | +3.93 net, vs the usual t 2.3: fails | fails |
| Delisting | −0.87 net: fails | −0.62 net: fails | fails |

### What it says

**A KRW listing is a bigger jump than it was, and it is over in the minute.**
- In 2025 and 2026 the Binance price jumped 38% in the notice's own minute, against 22% before
  2025.
- An app reading once a minute would have bought 40% above the price at the notice.
- From there the coin faded. Four hours on, the long was behind on 36 of 58 coins, and lost 3.9% a
  coin. COMP, CYBER, ALT, OPG and YGG each lost more than 23%.
- That fade is the other side of the trade written down, and it is not claimed. The discovery half
  did not show it (the long made 1.1% there). A trade chosen after seeing it would be held to t ≥ 3,
  and it has t 2.0.

**A caution starts a slow fall.**
- Nothing happened in the notice's minute. The fall came over the hours after: 2.5% at fifteen
  minutes, 4.0% at an hour, 5.0% at four.
- So an app reading once a minute missed only 0.7% of it, unlike every other kind measured here or
  in `research/NEWS.md`.
- Held short four hours, it made 3.9% a coin after costs, and 18 of 24 coins were lower. Two coins
  carried half of that: ZKC (October 2025) and SXP (January 2026), each down over 20%. Without them
  it made 2.1%.
- Its t of 2.3 falls short of the 3 the hold is held to. The bracket, whose stop the bounces reach,
  kept little of the fall.
- **Binance's Monitoring Tag looked the same** (`research/NEWS.md`): held short four hours, 4.5% a
  coin, t 2.1, short of the same bar. Two exchanges' warnings show the same slow fall, and neither
  passes on its own.

**A delisting falls at once, and stops.**
- 6.3% in the notice's minute and 7.7% after an hour, nearly all of it before an app could act.
- Held short from the entry, it lost. DENT, in February 2026, rose after its notice and cost the
  short 34%.

### What it means for the app

Nothing passed, so nothing is built, as the rule said: nothing in the app acts on an Upbit notice.

For someone holding a coin Upbit warns about, the warning came before a fall on Binance of 5% over
four hours, slowly enough to sell into. It is the same reason a notice was built for Binance's tag.
It is not built for Upbit's: the caution did not pass its bar.

**Kept on record instead.** On 5 October 2026 the user chose to keep the caution's four-hour short
on record from 1 October, beside Binance's tag held four hours, the other near miss. It is on
Discovery, under the two news rules that passed ("The news rules since the study"):
- The app reads Upbit's list of trading notices for it, only while that card is shown.
- It sorts the notices by this study's patterns, moved unchanged to `shared/upbitTitles.ts` (the
  plan and both halves' scores the same to the byte).
- It scores each caution on the coin's Binance pair, by this study's arithmetic.

It is a record, not a signal: it shows whether the slow fall goes on.
