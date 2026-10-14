// THE KEYS IN THE CODE (V6 Stage 14): every text the app translates, read from its source -- each call
// of t or msg with a string literal, the only two ways a key is written. The tests hold every
// catalog to this list (tests/i18n.test.ts), and scripts/i18n-keys.mjs lists what a catalog lacks.
// Pure text work: it is handed the sources and reads nothing itself.

const CALL = /(?<![\w$])(?:t|msg)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.)*)`)/g

/** A string literal's text, its escapes read as JavaScript reads them. */
function unescape(body: string): string {
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, code: string) => {
    if (code.startsWith('u{')) return String.fromCodePoint(parseInt(code.slice(2, -1), 16))
    if (code.startsWith('u') && code.length === 5) return String.fromCharCode(parseInt(code.slice(1), 16))
    if (code.startsWith('x') && code.length === 3) return String.fromCharCode(parseInt(code.slice(1), 16))
    if (code === 'n') return '\n'
    if (code === 't') return '\t'
    return code
  })
}

/** The keys a source file writes, in the order it writes them. */
export function keysIn(source: string): string[] {
  const keys: string[] = []
  for (const match of source.matchAll(CALL)) {
    const body = match[1] ?? match[2] ?? match[3]
    if (body !== undefined) keys.push(unescape(body))
  }
  return keys
}
