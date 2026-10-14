// Lists the translation keys in the code and what each catalog lacks (V6 Stage 14).
//   node scripts/i18n-keys.mjs              a count per catalog
//   node scripts/i18n-keys.mjs --missing ja the keys ja.json lacks, as JSON, in the order the code writes them
//   node scripts/i18n-keys.mjs --unused     keys a catalog holds that the code no longer writes
// It reads the sources and the catalogs and writes nothing.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LANGUAGES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'vi', 'th', 'id', 'hi', 'ar']
const CALL = /(?<![\w$])(?:t|msg)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.)*)`)/g

function unescape(body) {
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, code) => {
    if (code.startsWith('u{')) return String.fromCodePoint(parseInt(code.slice(2, -1), 16))
    if (code.startsWith('u') && code.length === 5) return String.fromCharCode(parseInt(code.slice(1), 16))
    if (code.startsWith('x') && code.length === 3) return String.fromCharCode(parseInt(code.slice(1), 16))
    if (code === 'n') return '\n'
    if (code === 't') return '\t'
    return code
  })
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [full] : []
  })
}

const keys = []
const seen = new Set()
for (const dir of ['src', 'shared', 'electron']) {
  for (const file of walk(path.join(ROOT, dir))) {
    for (const match of fs.readFileSync(file, 'utf-8').matchAll(CALL)) {
      const body = match[1] ?? match[2] ?? match[3]
      if (body === undefined) continue
      const key = unescape(body)
      if (!seen.has(key)) {
        seen.add(key)
        keys.push(key)
      }
    }
  }
}

const catalog = (language) => JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'i18n', 'locales', `${language}.json`), 'utf-8'))
const args = process.argv.slice(2)
if (args[0] === '--missing') {
  const own = catalog(args[1])
  console.log(JSON.stringify(keys.filter((key) => !(key in own)), null, 1))
} else if (args[0] === '--unused') {
  for (const language of LANGUAGES) {
    const extra = Object.keys(catalog(language)).filter((key) => !seen.has(key))
    if (extra.length > 0) console.log(language, JSON.stringify(extra, null, 1))
  }
} else if (args[0] === '--counts') {
  console.log(JSON.stringify(keys.filter((key) => key.includes('{count}')), null, 1))
} else {
  console.log(`${keys.length} keys in the code`)
  for (const language of LANGUAGES.slice(1)) {
    const own = catalog(language)
    console.log(`${language.padEnd(6)} ${keys.filter((key) => key in own).length} of ${keys.length}`)
  }
}
