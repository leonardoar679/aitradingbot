import type { Language } from './languages'
import en from './locales/en.json'
import zhCN from './locales/zh-CN.json'
import zhTW from './locales/zh-TW.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import vi from './locales/vi.json'
import th from './locales/th.json'
import id from './locales/id.json'
import hi from './locales/hi.json'
import ar from './locales/ar.json'

/** A count's forms, by Intl's plural categories; `other` is every count a language has no form for. */
export interface PluralForms {
  zero?: string
  one?: string
  two?: string
  few?: string
  many?: string
  other: string
}

export type Entry = string | PluralForms
export type Catalog = Readonly<Record<string, Entry>>

/** Each language's catalog: its text for each English key. English's holds only the plural forms its
 * keys cannot show by themselves. */
export const CATALOGS: Readonly<Record<Language, Catalog>> = {
  en: en as Catalog,
  'zh-CN': zhCN as Catalog,
  'zh-TW': zhTW as Catalog,
  ja: ja as Catalog,
  ko: ko as Catalog,
  vi: vi as Catalog,
  th: th as Catalog,
  id: id as Catalog,
  hi: hi as Catalog,
  ar: ar as Catalog
}
