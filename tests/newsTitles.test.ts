import { describe, expect, it } from 'vitest'
import { classifyTitle } from '../shared/newsTitles'

// shared/newsTitles.ts reads Binance's announcement titles, for the news study (research/NEWS.md)
// and for the app's reader alike. Every title below is one Binance published, copied as its list
// gives it.

describe('a delisting', () => {
  it('names the coins leaving the spot market', () => {
    expect(classifyTitle('Binance Will Delist ACX, HFT, PIVX, PYR, VANRY, VIC on 2026-08-17')).toEqual({
      category: 'DELISTING',
      tickers: ['ACX', 'HFT', 'PIVX', 'PYR', 'VANRY', 'VIC']
    })
    expect(classifyTitle('Binance Will Delist MITH, TRIBE, REP and BTCST on 2022-12-22')?.tickers).toEqual(['MITH', 'TRIBE', 'REP', 'BTCST'])
    expect(classifyTitle('Binance Will Delist COS, D, HIGH, MBOX on 2026-06-19')?.tickers).toEqual(['COS', 'D', 'HIGH', 'MBOX'])
    expect(classifyTitle('Binance Will Delist BEAM on 2023-01-26')?.tickers).toEqual(['BEAM'])
  })

  it('reads the vote batch, and a title with no date', () => {
    expect(
      classifyTitle('Binance Announced the First Batch of Vote to Delist Results and Will Delist BADGER, BAL, BETA, CREAM, CTXC, ELF, FIRO, HARD, NULS, PROS, SNT, TROY, UFT, VIDT on 2025-04-16')
        ?.tickers
    ).toEqual(['BADGER', 'BAL', 'BETA', 'CREAM', 'CTXC', 'ELF', 'FIRO', 'HARD', 'NULS', 'PROS', 'SNT', 'TROY', 'UFT', 'VIDT'])
    expect(classifyTitle('Binance Will Delist UTK and Support Rebranding and Airdrop Plan on Binance Alpha')).toEqual({ category: 'DELISTING', tickers: ['UTK'] })
  })

  it('is not a margin, futures, options or pair delisting, nor one of a pegged coin', () => {
    for (const title of [
      'Binance Margin Will Delist UTK on 2026-03-30',
      'Binance Margin And Loan Will Delist BTTC & POWR on 2026-08-14',
      'Binance Futures Will Delist USDⓈ-M AERGOUSDT Perpetual Contract (2026-07-24)',
      'Binance Will Delist SRM and RAY Margin Pairs and Binance Earn Products',
      'Binance Will Delist FTT Margin Pairs, USDⓈ-M Futures Contracts and Binance Flexible Products',
      'Binance Will Delist All American-Style Daily Options',
      'Notice of Removal of Spot Trading Pairs - 2026-10-02',
      'Binance Alpha Will Remove TTD, OIK, LUNAI, TOWN, VINU, PUP, CYPR, DGRAM (2026-06-30)',
      'Binance Staking to Delist EZ, TRU, VITE, ANC & MIR',
      'Binance Will Delist USDP on 2026-09-24'
    ]) {
      expect(classifyTitle(title), title).toBeNull()
    }
    expect(classifyTitle('Binance Will Delist HEGIC, RENBTC and SUSD on 2022-04-11')?.tickers).toEqual(['HEGIC'])
  })
})

describe('a futures launch', () => {
  it('names the coins of a USDT perpetual, in every way the titles have put it', () => {
    expect(classifyTitle('Binance Futures Will Launch USDⓈ-Margined CTUSDT Perpetual Contract (2026-10-01)')).toEqual({ category: 'FUTURES_LAUNCH', tickers: ['CT'] })
    expect(classifyTitle('Binance Futures Will Launch USDⓈ-Margined ZKPUSDT, GUAUSDT and IRUSDT Perpetual Contract (2025-12-21)')?.tickers).toEqual(['ZKP', 'GUA', 'IR'])
    expect(classifyTitle('Binance Futures Will Launch USDⓈ-Margined POPCAT and SUN Perpetual Contracts With Up to 75x Leverage')?.tickers).toEqual(['POPCAT', 'SUN'])
    expect(classifyTitle('Binance Futures Will Launch USDⓈ-Margined 1000CATUSDT Perpetual Contract With up to 75x Leverage')?.tickers).toEqual(['1000CAT'])
    expect(classifyTitle('Binance Futures Will Launch USDⓈ-M BANANA Perpetual Contract With Up to 50x Leverage')?.tickers).toEqual(['BANANA'])
    expect(classifyTitle('Binance Futures Will Launch USDⓈ-M Threshold (T) Perpetual Contracts with Up to 20X Leverage')?.tickers).toEqual(['T'])
    expect(classifyTitle('Binance Futures Will Launch USDT-Margined AMB, LEVER and TLM Perpetual Contracts with Up to 20X Leverage')?.tickers).toEqual(['AMB', 'LEVER', 'TLM'])
    expect(classifyTitle('Binance Futures Will Launch EGLD, SOL, ICX and BTT USDT-Margined Perpetual Contracts With Up to 50x Leverage')?.tickers).toEqual(['EGLD', 'SOL', 'ICX', 'BTT'])
    expect(classifyTitle('Binance Futures Will Launch LINK/USDT Perpetual Contract With Up to 75x Leverage')?.tickers).toEqual(['LINK'])
  })

  it('is not another margin, a quarterly, a pre-IPO, pre-market or TradFi contract, or "Multiple"', () => {
    for (const title of [
      'Binance Futures Will Launch USDC-Margined CRV Perpetual Contract With Up to 25x Leverage',
      'Binance Futures Will Launch Coin-Margined CHZ Perpetual Contracts with Up to 20X Leverage',
      'Binance Futures Will Launch BUSD-Margined FIL, 1000SHIB and LEVER Perpetual Contracts with Up to 20X Leverage',
      'Binance Futures Will Launch OURAUSDT USDⓈ-Margined Perpetual Contract Pre-IPO Trading (2026-09-23)',
      'Binance Futures Will Launch Multiple USDⓈ-Margined Perpetual Contracts (2026-09-18)',
      'Binance Futures Will Launch Multiple TradFi USDⓈ-Margined Perpetual Contracts (2026-09-29)',
      'Binance Futures Will Convert USDⓈ-Margined MONUSDT Perpetual Contract Pre-Market Trading to Standard Perpetual Futures Contract (2025-11-24)'
    ]) {
      expect(classifyTitle(title), title).toBeNull()
    }
  })
})

describe('a spot listing', () => {
  it('names the tickers in brackets', () => {
    expect(classifyTitle('Binance Will List Hyperliquid (HYPE) with Seed Tag Applied')).toEqual({ category: 'SPOT_LISTING', tickers: ['HYPE'] })
    expect(classifyTitle('Binance Will List Cheems (1000CHEEMS) and Test (TST) with Seed Tag Applied')?.tickers).toEqual(['1000CHEEMS', 'TST'])
    expect(classifyTitle('Binance Will List aixbt by Virtuals (AIXBT), ChainGPT(CGPT), Cookie DAO(COOKIE) with Seed Tag Applied')?.tickers).toEqual(['AIXBT', 'CGPT', 'COOKIE'])
    expect(classifyTitle('Binance Will List Act I : The AI Prophecy (ACT) and Peanut the Squirrel (PNUT) with Seed Tag Applied')?.tickers).toEqual(['ACT', 'PNUT'])
  })

  it('is not a pegged coin, a ticker it cannot read, leveraged tokens or a vote', () => {
    for (const title of [
      'Binance Will List Tether Gold (XAUt) with Seed Tag Applied',
      'Binance Will List Ethena USDe (USDE)',
      'Binance Will List 牛来 (牛来) with Seed Tag Applied',
      'Binance Will List KGST & Enable Trading Bots Services on Binance Spot - 2025-12-24',
      'Binance Will List BNBUP, BNBDOWN, XTZUP and XTZDOWN Binance Leveraged Tokens',
      'Binance Will List Community Coin Vote Round 9 Winner MDT and Has Distributed Rewards',
      'Binance Will Add USDe (USDE) on Buy Crypto, Convert & Margin',
      'Notice on New Trading Pairs & Trading Bots Services on Binance Spot - 2026-09-22'
    ]) {
      expect(classifyTitle(title), title).toBeNull()
    }
  })
})
