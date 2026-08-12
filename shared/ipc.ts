// Single source of truth for IPC channel names and payload shapes.
// Imported by both electron/ (main + preload) and src/ (renderer).

export const IpcChannel = {
  AppPing: 'app:ping',
  AppGetVersion: 'app:getVersion',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  MarketListSymbols: 'market:listSymbols',
  MarketSubscribeCandles: 'market:subscribeCandles',
  MarketUnsubscribeCandles: 'market:unsubscribeCandles',
  MarketCandleUpdate: 'market:candleUpdate',
  MarketSubscribeTicker: 'market:subscribeTicker',
  MarketUnsubscribeTicker: 'market:unsubscribeTicker',
  MarketTickerUpdate: 'market:tickerUpdate',
  MarketFetchHistoricalRange: 'market:fetchHistoricalRange',
  MarketHistoricalRangeProgress: 'market:historicalRangeProgress',
  MarketCancelHistoricalRange: 'market:cancelHistoricalRange',
  CredentialsList: 'credentials:list',
  CredentialsSet: 'credentials:set',
  CredentialsTest: 'credentials:test',
  CredentialsRemove: 'credentials:remove'
} as const

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel]

export interface AppSettings {
  theme: 'light' | 'dark'
  bots: Bot[]
}

/** Status of a stored exchange API credential. Crosses IPC — never the raw key/secret, which
 * stay encrypted at rest and are only ever decrypted inside the main process. */
export interface CredentialStatus {
  exchange: Exchange
  configured: boolean
  addedAt: number | null
  lastTestedAt: number | null
  lastTestOk: boolean | null
}

/** OHLCV candle. `time` is a Unix timestamp in seconds (UTC), matching lightweight-charts. */
export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** Progress of an in-flight `fetchHistoricalRange` job. `total` is an estimate derived from
 * the requested range and interval; `done` is the real count of candles fetched so far. */
export interface HistoricalRangeProgress {
  done: number
  total: number
}

export interface HistoricalRangeResult {
  candles: Candle[]
  cancelled: boolean
}

/** 24h rolling ticker stats. `volume` is in the base asset, `quoteVolume` in the quote asset. */
export interface Ticker24h {
  symbol: string
  lastPrice: number
  priceChange: number
  priceChangePercent: number
  highPrice: number
  lowPrice: number
  volume: number
  quoteVolume: number
}

export type Exchange = 'binance' | 'coinbase' | 'kraken' | 'bithumb' | 'upbit' | 'coinone' | 'korbit' | 'gopax'

export type Interval = '1m' | '15m' | '1h' | '4h' | '1d' | '1w'

export interface IntervalInfo {
  id: Interval
  label: string
}

export const INTERVALS: IntervalInfo[] = [
  { id: '1m', label: '1m' },
  { id: '15m', label: '15m' },
  { id: '1h', label: '1H' },
  { id: '4h', label: '4H' },
  { id: '1d', label: '1D' },
  { id: '1w', label: '1W' }
]

export const DEFAULT_INTERVAL: Interval = '15m'

export const INTERVAL_SECONDS: Record<Interval, number> = {
  '1m': 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60
}

/** A trading pair as listed on a given exchange. `symbol` is that exchange's native format
 * (e.g. Binance 'BTCUSDT', Coinbase 'BTC-USD', Kraken 'XBT/USD') — not interchangeable across exchanges. */
export interface SymbolInfo {
  symbol: string
  baseAsset: string
  quoteAsset: string
}

export interface ExchangeInfo {
  id: Exchange
  name: string
  defaultSymbol: SymbolInfo
}

export const EXCHANGES: ExchangeInfo[] = [
  {
    id: 'binance',
    name: 'Binance',
    defaultSymbol: { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }
  },
  {
    id: 'coinbase',
    name: 'Coinbase',
    defaultSymbol: { symbol: 'BTC-USD', baseAsset: 'BTC', quoteAsset: 'USD' }
  },
  {
    id: 'kraken',
    name: 'Kraken',
    defaultSymbol: { symbol: 'XBT/USD', baseAsset: 'XBT', quoteAsset: 'USD' }
  },
  {
    id: 'bithumb',
    name: 'Bithumb',
    defaultSymbol: { symbol: 'BTC_KRW', baseAsset: 'BTC', quoteAsset: 'KRW' }
  },
  {
    id: 'upbit',
    name: 'Upbit',
    defaultSymbol: { symbol: 'KRW-BTC', baseAsset: 'BTC', quoteAsset: 'KRW' }
  },
  {
    id: 'coinone',
    name: 'Coinone',
    defaultSymbol: { symbol: 'BTC_KRW', baseAsset: 'BTC', quoteAsset: 'KRW' }
  },
  {
    id: 'korbit',
    name: 'Korbit',
    defaultSymbol: { symbol: 'btc_krw', baseAsset: 'BTC', quoteAsset: 'KRW' }
  },
  {
    id: 'gopax',
    name: 'GOPAX',
    defaultSymbol: { symbol: 'BTC-KRW', baseAsset: 'BTC', quoteAsset: 'KRW' }
  }
]

export interface Bot {
  id: string
  name: string
  exchange: Exchange
  symbol: string
  baseAsset: string
  quoteAsset: string
  strategy: string
  enabled: boolean
  /** Unix seconds when this bot was last turned on — null while disabled. Dry-run paper trades
   * are only counted from this point on, not from the indicator warmup lookback before it. */
  enabledAt: number | null
}
