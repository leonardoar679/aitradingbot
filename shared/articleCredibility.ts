// WHO SAYS IT (V8 Stage 4, 26 October 2026). A pasted article's source, by its host: an exchange speaking of its own
// markets, a regulator, a news outlet, a project's own site, a social network where anyone posts, or unknown. A class
// is a fact about the host, said as such -- not a verdict on the article, and nothing is traded on it. Binance's own
// announcement counts only on www.binance.com and only where its code is in Binance's own list: a page that merely
// looks like one is an exchange's page and no more. Arithmetic on strings.

export type CredibilityClass = 'exchange' | 'regulator' | 'outlet' | 'project' | 'social' | 'unknown'

export const CREDIBILITY_VERSION = 'credibility-v1'

/** The hosts of each class, matched as the host or a subdomain of it. */
export const CREDIBILITY_HOSTS: Readonly<Record<Exclude<CredibilityClass, 'project' | 'unknown'>, readonly string[]>> = {
  exchange: ['binance.com', 'bitget.com', 'okx.com', 'coinbase.com', 'kraken.com', 'bybit.com', 'kucoin.com', 'gate.io', 'gate.com', 'htx.com', 'upbit.com', 'bithumb.com', 'mexc.com', 'crypto.com', 'gemini.com', 'bitstamp.net', 'bitfinex.com', 'hyperliquid.xyz'],
  regulator: ['sec.gov', 'cftc.gov', 'federalreserve.gov', 'treasury.gov', 'justice.gov', 'fca.org.uk', 'esma.europa.eu', 'eba.europa.eu', 'mas.gov.sg', 'sfc.hk', 'fsa.go.jp', 'bafin.de', 'amf-france.org', 'asic.gov.au', 'osc.ca', 'finma.ch', 'consob.it', 'cnmv.es'],
  outlet: [
    'coindesk.com',
    'theblock.co',
    'cointelegraph.com',
    'decrypt.co',
    'blockworks.co',
    'dlnews.com',
    'thedefiant.io',
    'bitcoinmagazine.com',
    'cryptoslate.com',
    'reuters.com',
    'bloomberg.com',
    'ft.com',
    'wsj.com',
    'cnbc.com',
    'apnews.com',
    'bbc.com',
    'bbc.co.uk',
    'nytimes.com',
    'axios.com',
    'fortune.com',
    'forbes.com',
    'businessinsider.com',
    'theinformation.com',
    'finance.yahoo.com'
  ],
  social: ['x.com', 'twitter.com', 't.me', 'telegram.me', 'reddit.com', 'medium.com', 'substack.com', 'youtube.com', 'youtu.be', 'discord.com', 'discord.gg', 'facebook.com', 'instagram.com', 'tiktok.com', 'mirror.xyz', 'warpcast.com', 'threads.net', 'linkedin.com']
}

const within = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`)

/** A host's class; `project` where its name is a coin's the article names (a project speaking of itself). */
export function credibilityOf(host: string, projectNames: readonly string[] = []): CredibilityClass {
  const name = host.toLowerCase().replace(/\.$/, '')
  for (const [cls, domains] of Object.entries(CREDIBILITY_HOSTS) as [Exclude<CredibilityClass, 'project' | 'unknown'>, readonly string[]][]) {
    if (domains.some((domain) => within(name, domain))) return cls
  }
  const labels = name.split('.')
  const registrable = labels.length >= 2 ? labels[labels.length - 2] : name
  if (projectNames.some((project) => project.length >= 3 && registrable === project.toLowerCase().replace(/[^a-z0-9]/g, ''))) return 'project'
  return 'unknown'
}

/** The code of a Binance announcement link, where the link is one on www.binance.com: the last part of
 * /…/support/announcement/[detail/]<code>, or the 32 hex characters that end it. Null for any other link. */
export function binanceAnnouncementCodeOf(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname.toLowerCase() !== 'www.binance.com') return null
  const match = /^\/(?:[a-z]{2}(?:-[A-Za-z]{2,4})?\/)?support\/announcement\/(?:detail\/)?([A-Za-z0-9-]{4,200})\/?$/.exec(parsed.pathname)
  if (match === null) return null
  const segment = match[1]
  return /([0-9a-f]{32})$/.exec(segment)?.[1] ?? segment
}
