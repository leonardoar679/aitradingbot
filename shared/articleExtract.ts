import { decodeEntities } from './newsFeed'

// AN ARTICLE READ FROM ITS PAGE (V8 Stage 4, 26 October 2026). A pasted link's page is a stranger's HTML: what the
// News URLs page needs of it is its title, the times it says it was published and changed -- each kept with where it
// was read, since a page can say several -- its canonical address, its author, and its main text, cut into numbered
// snippets a person can check and a model (V8 Stage 5) can cite. Characters that reorder or hide text -- the
// direction controls and the zero-width ones -- are dropped first, so that what is shown is what is read. A pure
// function of the page's text, run in a worker of its own (shared/tasks.ts 'extractArticle') with a deadline and a
// memory limit: no script on the page is run, no link on it followed, nothing fetched.

export const ARTICLE_EXTRACT_VERSION = 'article-extract-v1'

export const EXTRACT_LINES = {
  version: ARTICLE_EXTRACT_VERSION,
  /** The main text kept, in characters, and the longest snippet. */
  maxTextChars: 8000,
  snippetChars: 400,
  /** A paragraph shorter than this is a caption or a menu, not text. */
  minParagraphChars: 40
} as const

/** Where a time was read: the page's structured data, its Open Graph tags, a dated byline, or another meta tag. */
export type TimeSource = 'jsonld' | 'og' | 'byline' | 'meta'

export interface TimeCandidate {
  source: TimeSource
  field: string
  text: string
  /** Unix seconds; null where the text names no moment with its zone (a date alone is read as its UTC midnight). */
  sec: number | null
  dateOnly: boolean
}

export interface ExtractedArticle {
  version: typeof ARTICLE_EXTRACT_VERSION
  title: string | null
  description: string | null
  siteName: string | null
  canonical: string | null
  author: string | null
  published: TimeCandidate[]
  modified: TimeCandidate[]
  text: string
  snippets: { n: number; text: string }[]
}

/** The characters that reorder text or hide it: the direction embeddings, overrides, isolates and marks, and the
 * zero-width ones. */
const INVISIBLE = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, '')
}

/** A time as a page writes it, read only where it names its zone: an ISO moment with Z or an offset, or a date alone
 * (its UTC midnight, said as such). A moment with no zone could be any of thirty, so it is kept unread. */
export function readTime(text: string): { sec: number | null; dateOnly: boolean } {
  const value = text.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const ms = Date.parse(`${value}T00:00:00Z`)
    return { sec: Number.isFinite(ms) ? Math.floor(ms / 1000) : null, dateOnly: true }
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const ms = Date.parse(value.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
    return { sec: Number.isFinite(ms) ? Math.floor(ms / 1000) : null, dateOnly: false }
  }
  // RFC 2822, as some feeds and pages write it, with its zone.
  if (/^[A-Za-z]{3}, \d{1,2} [A-Za-z]{3} \d{4} \d{2}:\d{2}(:\d{2})? (GMT|UTC|[+-]\d{4})$/.test(value)) {
    const ms = Date.parse(value)
    return { sec: Number.isFinite(ms) ? Math.floor(ms / 1000) : null, dateOnly: false }
  }
  return { sec: null, dateOnly: false }
}

const candidate = (source: TimeSource, field: string, text: string): TimeCandidate => {
  const clean = stripInvisible(text).trim().slice(0, 80)
  return { source, field, text: clean, ...readTime(clean) }
}

/** A tag's attributes, by lower-case name. */
function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of tag.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const name = match[1].toLowerCase()
    if (!(name in out)) out[name] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? '')
  }
  return out
}

/** The meta tags' contents by the name they are read under: property, name or itemprop, lower-cased. */
function metaTags(html: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0])
    const key = (attrs.property ?? attrs.name ?? attrs.itemprop ?? '').toLowerCase()
    const content = attrs.content ?? attrs.datetime
    if (key === '' || content === undefined) continue
    out.set(key, [...(out.get(key) ?? []), content])
  }
  return out
}

/** The objects of the page's JSON-LD blocks, flattened through arrays and @graph. */
function jsonLdObjects(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 50)) visit(item, depth + 1)
      return
    }
    const object = value as Record<string, unknown>
    out.push(object)
    if (Array.isArray(object['@graph'])) visit(object['@graph'], depth + 1)
  }
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(match[1].trim()), 0)
    } catch {
      // A block that is not JSON is skipped, as a browser would.
    }
  }
  return out
}

const ARTICLE_TYPES = /^(NewsArticle|Article|BlogPosting|ReportageNewsArticle|AnalysisNewsArticle|Report|TechArticle|LiveBlogPosting|SocialMediaPosting)$/

const typesOf = (object: Record<string, unknown>): string[] => {
  const type = object['@type']
  return Array.isArray(type) ? type.filter((item): item is string => typeof item === 'string') : typeof type === 'string' ? [type] : []
}

const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? stripInvisible(decodeEntities(value)).trim() : null)

/** An author's name from JSON-LD: a name, a Person or a list of them. */
function authorOf(value: unknown): string | null {
  if (typeof value === 'string') return textOf(value)
  if (Array.isArray(value)) {
    const names = value.map(authorOf).filter((name): name is string => name !== null)
    return names.length === 0 ? null : names.slice(0, 5).join(', ')
  }
  if (value !== null && typeof value === 'object') return textOf((value as Record<string, unknown>).name)
  return null
}

const DROPPED_BLOCKS = ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'form', 'nav', 'footer', 'aside', 'button', 'select', 'figure']
const BLOCK_ENDS = /<\/(p|div|li|h[1-6]|section|blockquote|tr|article|main|header|pre|dd|dt)>|<br\s*\/?>|<hr\s*\/?>/gi

/** The page's main text, as lines: the largest <article>, else <main>, else the body, with what is not text dropped. */
function mainLines(html: string): string[] {
  let body = html
  for (const name of DROPPED_BLOCKS) body = body.replace(new RegExp(`<${name}\\b[\\s\\S]*?<\\/${name}>`, 'gi'), '\n')
  body = body.replace(/<!--[\s\S]*?-->/g, '')
  const articles = [...body.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((match) => match[1])
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body)?.[1]
  const bodyPart = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(body)?.[1]
  const chosen = articles.length > 0 ? articles.reduce((a, b) => (b.length > a.length ? b : a)) : (main ?? bodyPart ?? body)
  const text = decodeEntities(chosen.replace(BLOCK_ENDS, '\n').replace(/<[^>]*>/g, ' '))
  return stripInvisible(text)
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f\v ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
}

/** A paragraph cut into snippets of at most the lines' length, at sentence ends where it can be. */
function cut(paragraph: string, max: number): string[] {
  if (paragraph.length <= max) return [paragraph]
  const out: string[] = []
  let rest = paragraph
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const end = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '))
    const at = end >= max / 2 ? end + 1 : window.lastIndexOf(' ') > max / 2 ? window.lastIndexOf(' ') : max
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest.length > 0) out.push(rest)
  return out
}

/** Everything the News URLs page reads of an article's page. */
export function extractArticle(html: string, lines: typeof EXTRACT_LINES = EXTRACT_LINES): ExtractedArticle {
  const page = stripInvisible(html)
  const meta = metaTags(page)
  const first = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = meta.get(key)?.find((item) => item.trim() !== '')
      if (value !== undefined) return stripInvisible(value).trim()
    }
    return null
  }
  const objects = jsonLdObjects(page)
  const article = objects.find((object) => typesOf(object).some((type) => ARTICLE_TYPES.test(type))) ?? null
  const published: TimeCandidate[] = []
  const modified: TimeCandidate[] = []
  if (article !== null) {
    if (typeof article.datePublished === 'string') published.push(candidate('jsonld', 'datePublished', article.datePublished))
    if (typeof article.dateCreated === 'string') published.push(candidate('jsonld', 'dateCreated', article.dateCreated))
    if (typeof article.dateModified === 'string') modified.push(candidate('jsonld', 'dateModified', article.dateModified))
  }
  for (const value of meta.get('article:published_time') ?? []) published.push(candidate('og', 'article:published_time', value))
  for (const value of meta.get('article:modified_time') ?? []) modified.push(candidate('og', 'article:modified_time', value))
  for (const value of meta.get('og:updated_time') ?? []) modified.push(candidate('og', 'og:updated_time', value))
  const byline = /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["'][^>]*>/i.exec(page)
  if (byline !== null) published.push(candidate('byline', 'time', decodeEntities(byline[1])))
  for (const key of ['datepublished', 'pubdate', 'publishdate', 'publish_date', 'publish-date', 'date', 'dc.date', 'dc.date.issued', 'dcterms.created', 'dcterms.issued', 'sailthru.date', 'parsely-pub-date', 'article.published', 'og:published_time']) {
    for (const value of meta.get(key) ?? []) published.push(candidate('meta', key, value))
  }
  const canonicalTag = [...page.matchAll(/<link\b[^>]*>/gi)].map((match) => attributes(match[0])).find((attrs) => (attrs.rel ?? '').toLowerCase().split(/\s+/).includes('canonical'))
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(page)?.[1]
  const paragraphs = mainLines(page).filter((line) => line.length >= lines.minParagraphChars)
  const snippets: { n: number; text: string }[] = []
  let used = 0
  for (const paragraph of paragraphs) {
    for (const piece of cut(paragraph, lines.snippetChars)) {
      if (used + piece.length > lines.maxTextChars) break
      snippets.push({ n: snippets.length + 1, text: piece })
      used += piece.length
    }
    if (used >= lines.maxTextChars) break
  }
  return {
    version: ARTICLE_EXTRACT_VERSION,
    title: (article !== null ? textOf(article.headline) : null) ?? first('og:title', 'twitter:title') ?? (title === undefined ? null : textOf(title)),
    description: first('og:description', 'description', 'twitter:description'),
    siteName: first('og:site_name', 'application-name'),
    canonical: canonicalTag?.href?.trim() || first('og:url'),
    author: (article !== null ? authorOf(article.author) : null) ?? first('author', 'article:author', 'parsely-author', 'sailthru.author'),
    published,
    modified,
    text: snippets.map((snippet) => snippet.text).join('\n'),
    snippets
  }
}
