import { describe, expect, it } from 'vitest'
import { monitoringTagTickers } from '../research/monitoringTitles'

// research/monitoringTitles.ts reads which coins Binance adds to its Monitoring Tag, for the news
// study (research/NEWS.md). Every title below is one Binance published, copied as its list gives
// it: all 27 that name the tag, from the news list (49) and the delisting list (161).

describe('the Monitoring Tag', () => {
  it('names the coins added to it, however the list is joined', () => {
    expect(monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include AVA, GNS, SCR & TOWNS on 2026-09-04')).toEqual(['AVA', 'GNS', 'SCR', 'TOWNS'])
    expect(monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include GLMR, ICX, MOVR, RARE & SOPH on 2026-08-11')).toEqual(['GLMR', 'ICX', 'MOVR', 'RARE', 'SOPH'])
    expect(monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include ACX, LSK & STX on 2026-07-24')).toEqual(['ACX', 'LSK', 'STX'])
    expect(monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include ACT, BLUR, PIVX & QKC on 2026-06-18')).toEqual(['ACT', 'BLUR', 'PIVX', 'QKC'])
    expect(monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include ALCX, COOKIE, DODO, EPIC, HEI, HFT, STORJ, SYN & TLM on 2026-05-22')).toEqual([
      'ALCX',
      'COOKIE',
      'DODO',
      'EPIC',
      'HEI',
      'HFT',
      'STORJ',
      'SYN',
      'TLM'
    ])
    expect(monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include NFP, NOM, POND, QUICK & VIC on 2026-04-30')).toEqual(['NFP', 'NOM', 'POND', 'QUICK', 'VIC'])
    expect(monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include ATA, A2Z, FIO, GTC, NTRN, PHB, QI & RDNT on 2026-03-13')).toEqual([
      'ATA',
      'A2Z',
      'FIO',
      'GTC',
      'NTRN',
      'PHB',
      'QI',
      'RDNT'
    ])
    expect(monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include ACA, D, DATA & FLOW on 2026-01-02')).toEqual(['ACA', 'D', 'DATA', 'FLOW'])
    expect(monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include CHESS, DENT, DF, GHST & SXP on 2025-12-01')).toEqual(['CHESS', 'DENT', 'DF', 'GHST', 'SXP'])
    expect(monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include BAKE, IDEX & SLF on 2025-07-07')).toEqual(['BAKE', 'IDEX', 'SLF'])
    expect(monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include BIFI, FIS, KMD & MDT on 2025-06-05')).toEqual(['BIFI', 'FIS', 'KMD', 'MDT'])
    expect(monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include ALPHA, HIFI, LEVER, MOVE, PORTAL & REI on 2025-05-07')).toEqual([
      'ALPHA',
      'HIFI',
      'LEVER',
      'MOVE',
      'PORTAL',
      'REI'
    ])
    expect(monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include EPX, FOR, UNFI, WAVES & WNXM on 2024-04-03')).toEqual(['EPX', 'FOR', 'UNFI', 'WAVES', 'WNXM'])
    expect(monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include BETA, BOND, WTC and XEM on 2023-10-04')).toEqual(['BETA', 'BOND', 'WTC', 'XEM'])
  })

  it('reads a title with no "Include", and one that changes the tag first', () => {
    expect(monitoringTagTickers('Binance Will Extend the Monitoring Tag to GPS on 2025-03-07')).toEqual(['GPS'])
    expect(
      monitoringTagTickers(
        'Binance Will Change the Monitoring Tag Inclusion Frequency to Monthly and Extend the Monitoring Tag to Include AERGO, ALPACA, AST, BADGER, BURGER, COMBO, NULS, STPT, UFT & VIDT on 2025-03-04'
      )
    ).toEqual(['AERGO', 'ALPACA', 'AST', 'BADGER', 'BURGER', 'COMBO', 'NULS', 'STPT', 'UFT', 'VIDT'])
  })

  it('leaves out the coins the same title takes a tag off', () => {
    expect(monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include FARM, HIGH, MLN, RESOLV, SYS, TRU & VELODROME, Remove the Seed Tag for XAUT on 2026-04-14')).toEqual([
      'FARM',
      'HIGH',
      'MLN',
      'RESOLV',
      'SYS',
      'TRU',
      'VELODROME'
    ])
    expect(
      monitoringTagTickers(
        'Binance Will Extend the Monitoring Tag to Include COS, DEGO, FORTH, FUN, HOOK, LRC, MBOX, OXT & WIF, Remove the Monitoring Tag for FLOW, and Remove the Seed Tag for ONDO & VIRTUAL on 2026-03-06'
      )
    ).toEqual(['COS', 'DEGO', 'FORTH', 'FUN', 'HOOK', 'LRC', 'MBOX', 'OXT', 'WIF'])
    expect(
      monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include WAN, Remove the Monitoring Tag for GPS & MBL, and Remove the Seed Tag for BERA, BIO, ZK & ZRO on 2025-10-09')
    ).toEqual(['WAN'])
    expect(
      monitoringTagTickers(
        'Binance Will Extend the Monitoring Tag to Include ARDR, BSW, FLM, LTO, NKN, PDA, PERP, VIB, VOXEL & WING, and Remove the Seed Tag for JUP, STRK & TON on 2025-04-03'
      )
    ).toEqual(['ARDR', 'BSW', 'FLM', 'LTO', 'NKN', 'PDA', 'PERP', 'VIB', 'VOXEL', 'WING'])
    expect(
      monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include STMX & TROY, Remove the Monitoring Tag for CVX & SUN, and Remove the Seed Tag for ARKM, BLUR, JTO & TIA on 2025-01-02')
    ).toEqual(['STMX', 'TROY'])
    expect(
      monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include BLZ, CLV, KEY, PROS & VITE and Remove the Seed Tag for PENDLE & SEI on 2024-10-03')
    ).toEqual(['BLZ', 'CLV', 'KEY', 'PROS', 'VITE'])
    expect(
      monitoringTagTickers(
        'Binance Will Extend the Monitoring Tag to Include BAL, CTXC, CVP, CVX, DOCK, HARD, IRIS, MBL, POLS, SNT & SUN and Remove the Monitoring Tag for MLN & ZEN on 2024-07-01'
      )
    ).toEqual(['BAL', 'CTXC', 'CVP', 'CVX', 'DOCK', 'HARD', 'IRIS', 'MBL', 'POLS', 'SNT', 'SUN'])
  })

  it('leaves out a pegged coin', () => {
    expect(monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include AEUR, PYR, SCRT & VANRY on 2026-07-03')).toEqual(['PYR', 'SCRT', 'VANRY'])
    expect(
      monitoringTagTickers('Binance Will Extend the Monitoring Tag to Include ANT, FIRO, KP3R, MDX, MOB, REEF, VAI, XMR, ZEC & ZEN, and Remove the Seed Tag for GMX & SUSHI on 2024-01-04')
    ).toEqual(['ANT', 'FIRO', 'KP3R', 'MDX', 'MOB', 'REEF', 'XMR', 'ZEC', 'ZEN'])
  })

  it('is null for a title that adds no coin to it', () => {
    for (const title of [
      'Binance Will Remove the Monitoring Tag for ZEC and the Seed Tag for ENA, PYTH, TAO & W on 2025-07-09',
      'Introducing Seed Tags & Monitoring Tags for Tokens with High Volatility and Risks',
      'Binance Will Delist ACX, HFT, PIVX, PYR, VANRY, VIC on 2026-08-17',
      'Binance Will List Hyperliquid (HYPE) with Seed Tag Applied'
    ]) {
      expect(monitoringTagTickers(title), title).toBeNull()
    }
  })
})
