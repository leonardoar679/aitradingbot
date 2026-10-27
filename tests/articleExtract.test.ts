import { describe, expect, it } from 'vitest'
import { EXTRACT_LINES, extractArticle, readTime, stripInvisible } from '../shared/articleExtract'
import { runTask } from '../shared/tasks'

// AN ARTICLE READ FROM ITS PAGE (shared/articleExtract.ts; V8 Stage 4): the title, every time the page says it was
// published and changed with where it was read, the canonical address, the author and the main text in numbered
// snippets -- direction controls and zero-width characters dropped, scripts and menus left out, no script run.

const PAGE = `<!doctype html><html><head>
<title>Fallback title | Outlet</title>
<meta property="og:title" content="OG title">
<meta property="og:description" content="What happened, in a line.">
<meta property="og:site_name" content="The Outlet">
<meta property="article:published_time" content="2026-10-26T14:05:00+00:00">
<meta property="article:modified_time" content="2026-10-26T15:00:00Z">
<meta name="pubdate" content="2026-10-26 14:05">
<meta name="author" content="Meta Author">
<link rel="canonical" href="https://outlet.example/news/the-story">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"x"},{"@type":["NewsArticle"],"headline":"The &amp; headline","datePublished":"2026-10-26T14:04:30Z","dateModified":"2026-10-26T15:00:00Z","author":[{"@type":"Person","name":"Ada Writer"},{"@type":"Person","name":"Bo Editor"}]}]}</script>
<script type="application/ld+json">{ not json }</script>
<script>document.write('<p>This script text must never be read as the article body, it is long enough.</p>')</script>
<style>p { color: red }</style>
</head><body>
<nav><p>Home · Markets · A menu line long enough to count as a paragraph if it were read here.</p></nav>
<article>
<header><h1>The headline</h1><time datetime="2026-10-26T14:05:00Z">26 Oct</time></header>
<p>Binance said on Monday it will delist the ABC token, citing a review of its projects; trading ends on 2 November.</p>
<p>Short.</p>
<script>var injected = '<p>Injected script text that is long enough to be read as a paragraph if scripts were read.</p>'</script>
<figure><figcaption>A caption that is long enough to count but sits inside a figure block.</figcaption></figure>
<p>The token fell 12% in the hour after the announcement, with volume several times its usual for the time of day.</p>
<p>A hidden\u202Ereversed\u202C and\u200B zero\u200Dwidth sentence that is long enough to be kept as text here.</p>
</article>
<footer><p>Copyright notice long enough to be a paragraph if footers were read as text.</p></footer>
</body></html>`

describe('a page read', () => {
  const read = extractArticle(PAGE)
  it('takes the title from the structured data first, the description, the site and the canonical address', () => {
    expect(read.title).toBe('The & headline')
    expect(read.description).toBe('What happened, in a line.')
    expect(read.siteName).toBe('The Outlet')
    expect(read.canonical).toBe('https://outlet.example/news/the-story')
    expect(read.author).toBe('Ada Writer, Bo Editor')
  })
  it('keeps every time the page says it was published or changed, with where it was read', () => {
    expect(read.published.map((time) => [time.source, time.field, time.sec])).toEqual([
      ['jsonld', 'datePublished', Date.parse('2026-10-26T14:04:30Z') / 1000],
      ['og', 'article:published_time', Date.parse('2026-10-26T14:05:00Z') / 1000],
      ['byline', 'time', Date.parse('2026-10-26T14:05:00Z') / 1000],
      // A moment with no zone is kept, unread.
      ['meta', 'pubdate', null]
    ])
    expect(read.modified.map((time) => [time.source, time.sec])).toEqual([
      ['jsonld', Date.parse('2026-10-26T15:00:00Z') / 1000],
      ['og', Date.parse('2026-10-26T15:00:00Z') / 1000]
    ])
  })
  it('reads the article as text in numbered snippets, leaving out scripts, menus, captions, footers and short lines', () => {
    expect(read.snippets.map((snippet) => snippet.n)).toEqual([1, 2, 3])
    expect(read.snippets[0].text).toBe('Binance said on Monday it will delist the ABC token, citing a review of its projects; trading ends on 2 November.')
    expect(read.snippets[1].text).toMatch(/^The token fell 12%/)
    expect(read.snippets[2].text).toBe('A hiddenreversed and zerowidth sentence that is long enough to be kept as text here.')
    expect(read.text).not.toMatch(/document\.write|Injected script|menu line|Copyright|caption|color: red/)
    expect(read.text).not.toMatch(/[\u202A-\u202E\u200B-\u200F]/)
  })
})

describe('the pieces', () => {
  it('read a time only where it names its zone, a date alone as its UTC midnight', () => {
    expect(readTime('2026-10-26T14:05:00Z')).toEqual({ sec: Date.parse('2026-10-26T14:05:00Z') / 1000, dateOnly: false })
    expect(readTime('2026-10-26T16:05:00+0200')).toEqual({ sec: Date.parse('2026-10-26T14:05:00Z') / 1000, dateOnly: false })
    expect(readTime('2026-10-26 14:05:00-05:00')).toEqual({ sec: Date.parse('2026-10-26T19:05:00Z') / 1000, dateOnly: false })
    expect(readTime('2026-10-26')).toEqual({ sec: Date.parse('2026-10-26T00:00:00Z') / 1000, dateOnly: true })
    expect(readTime('Mon, 26 Oct 2026 14:05:00 GMT')).toEqual({ sec: Date.parse('2026-10-26T14:05:00Z') / 1000, dateOnly: false })
    expect(readTime('2026-10-26T14:05:00')).toEqual({ sec: null, dateOnly: false })
    expect(readTime('yesterday')).toEqual({ sec: null, dateOnly: false })
  })
  it('drop the characters that reorder or hide text', () => {
    expect(stripInvisible('a\u202Eb\u2066c\u200Bd\uFEFFe\u061Cf')).toBe('abcdef')
  })
  it('cut a long paragraph at its sentences, and keep the text within its lines', () => {
    const sentence = 'This sentence is about sixty characters long, more or less ok. '
    const long = `<article><p>${sentence.repeat(20)}</p></article>`
    const read = extractArticle(long)
    expect(read.snippets.length).toBeGreaterThan(2)
    for (const snippet of read.snippets) expect(snippet.text.length).toBeLessThanOrEqual(EXTRACT_LINES.snippetChars)
    expect(read.snippets[0].text.endsWith('.')).toBe(true)
    const huge = extractArticle(`<article>${`<p>${sentence.repeat(6)}</p>`.repeat(60)}</article>`)
    expect(huge.text.length).toBeLessThanOrEqual(EXTRACT_LINES.maxTextChars + huge.snippets.length)
  })
  it('read a page with no article, no head and no times as what it has', () => {
    const read = extractArticle('<p>Only a paragraph that is long enough to be read as the text of a page.</p>')
    expect(read).toMatchObject({ title: null, canonical: null, author: null, published: [], modified: [] })
    expect(read.snippets).toEqual([{ n: 1, text: 'Only a paragraph that is long enough to be read as the text of a page.' }])
  })
  it('run in the worker as a named task', () => {
    const reply = runTask({ id: 9, task: 'extractArticle', payload: PAGE })
    expect(reply.ok).toBe(true)
    expect((reply.result as { title: string }).title).toBe('The & headline')
    expect((runTask({ id: 10, task: 'extractArticle', payload: 42 }).result as { snippets: unknown[] }).snippets).toEqual([])
  })
})

describe('a page whose <article> elements are cards of other stories (V8 Stage 5, article-extract-v2)', () => {
  // As Cointelegraph's page was at Stage 5's check: the story in plain blocks, a price ticker above it, and the other
  // stories' cards, each an <article>, below it. The largest card, another story's teaser, was read as the article.
  const CARDS = `<html><head><title>Ripple wins final US approval</title></head><body>
<div class="ticker"><p>BTC 80,000 0.31% ETH 2,326 0.16% XRP 1.30 1.18% and the rest of a price ticker line.</p></div>
<div class="post">
<h1>Ripple wins final US approval for national trust bank</h1>
<p>Ripple announced Monday that its national trust bank has secured final approval from the Office of the Comptroller.</p>
<p>The approval completes the chartering process for Ripple National Trust Bank, which received conditional approval earlier.</p>
<p>The federally supervised trust bank is authorized to manage reserves backing Ripple USD and to act as a custodian.</p>
</div>
<section class="related">
<article class="card"><a href="/x"><p>XRP 30-day exchange inflows pass 6B tokens as whales move to the sidelines</p></a></article>
<article class="card"><a href="/y"><p>Another story's teaser, long enough to be read as a paragraph of text on its own.</p></a></article>
<article class="promo"><p>Subscribe to the daily brief before markets open.</p></article>
</section>
</body></html>`
  it("reads the story's own paragraphs, and none of the other stories' cards", () => {
    const read = extractArticle(CARDS)
    expect(read.version).toBe('article-extract-v2')
    expect(read.text).toMatch(/Ripple announced Monday that its national trust bank/)
    expect(read.text).toMatch(/The federally supervised trust bank/)
    expect(read.text).not.toMatch(/XRP 30-day exchange inflows|Another story's teaser/)
    // A box with no link holding a small share of the paragraphs is left out too.
    expect(read.text).not.toMatch(/Subscribe to the daily brief/)
  })
  it('still reads an <article> holding the story where it holds half the paragraphs or more, cards and all around it', () => {
    const read = extractArticle(CARDS.replace('<div class="post">', '<article class="story">').replace('</div>\n<section', '</article>\n<section'))
    expect(read.text).toMatch(/^Ripple wins final US approval for national trust bank/)
    expect(read.text).not.toMatch(/price ticker|XRP 30-day/)
    // The story's <article> is the one with the most paragraphs, not the one with the most markup.
    const heavy = CARDS.replace('<div class="post">', '<article class="story">')
      .replace('</div>\n<section', '</article>\n<section')
      .replace('<article class="card">', `<article class="card"><div data-tracking="${'x'.repeat(5000)}"></div>`)
    expect(extractArticle(heavy).text).toMatch(/^Ripple wins final US approval for national trust bank/)
  })
  it('keeps an <article> holding a fair share of the paragraphs where the story is split, and reads a page with no paragraph as before', () => {
    const split = CARDS.replace('<p>The approval completes', '<article class="part"><p>The approval completes').replace('act as a custodian.</p>', 'act as a custodian.</p></article>')
    expect(extractArticle(split).text).toMatch(/The approval completes[\s\S]*The federally supervised/)
    const bare = '<html><body><article><div>A story told in blocks rather than paragraphs, long enough to be read as text.</div></article><div>Elsewhere on the page, a line long enough to be read as text too.</div></body></html>'
    expect(extractArticle(bare).text).toBe('A story told in blocks rather than paragraphs, long enough to be read as text.')
  })
})
