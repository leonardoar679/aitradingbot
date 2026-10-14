import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import type { Exchange, SymbolInfo } from '../../shared/ipc'
import { describeError } from '../utils/ipcError'
import { useI18n } from '../i18n'

interface SymbolSearchProps {
  exchange: Exchange
  symbol: string
  onSelect: (pair: SymbolInfo) => void
}

const MAX_RESULTS = 30

export function SymbolSearch({ exchange, symbol, onSelect }: SymbolSearchProps): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [symbols, setSymbols] = useState<SymbolInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Symbol list is exchange-specific — drop the cached list whenever the exchange changes.
  useEffect(() => {
    setSymbols([])
  }, [exchange])

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    if (symbols.length > 0) return

    let cancelled = false
    setLoading(true)
    setLoadError(null)
    window.api.market
      .listSymbols(exchange)
      .then((list) => {
        if (!cancelled) setSymbols(list)
      })
      .catch((error) => {
        console.error('Failed to load symbol list:', error)
        // A failed fetch leaves `symbols` empty, which rendered as "No matches" — reporting an
        // unreachable exchange as an exchange with nothing to trade. Reopening the dropdown
        // retries, so saying so is also actionable.
        if (!cancelled) setLoadError(describeError(error))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return (): void => {
      cancelled = true
    }
  }, [open, exchange, symbols.length])

  useEffect(() => {
    function handleClickOutside(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return (): void => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const results = useMemo(() => {
    const q = query.trim().toUpperCase()
    if (!q) return symbols.slice(0, MAX_RESULTS)
    return symbols
      .filter((s) => s.baseAsset.toUpperCase().includes(q) || s.symbol.toUpperCase().includes(q))
      .sort((a, b) => {
        const aExact = a.baseAsset.toUpperCase() === q ? 0 : 1
        const bExact = b.baseAsset.toUpperCase() === q ? 0 : 1
        if (aExact !== bExact) return aExact - bExact
        return a.symbol.length - b.symbol.length
      })
      .slice(0, MAX_RESULTS)
  }, [symbols, query])

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="select-trigger"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          padding: '0.4rem 0.6rem',
          color: 'var(--text-primary)',
          cursor: 'pointer',
          fontWeight: 700,
          fontSize: '0.95rem'
        }}
      >
        {symbol}
        <ChevronDown size={14} color="var(--text-secondary)" />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 0.4rem)',
            insetInlineStart: 0,
            width: 260,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: '0 12px 28px rgba(0,0,0,0.5)',
            zIndex: 30,
            overflow: 'hidden'
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.6rem',
              borderBottom: '1px solid var(--border)'
            }}
          >
            <Search size={14} color="var(--text-secondary)" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('Search BTC, ETH, SOL...')}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'var(--text-primary)',
                fontSize: '0.85rem'
              }}
            />
          </div>
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {loading && <StatusRow text={t('Loading pairs...')} />}
            {!loading && loadError !== null && <StatusRow text={t("Couldn't load pairs ({error}) — close and reopen to retry.", { error: loadError })} />}
            {!loading && loadError === null && results.length === 0 && <StatusRow text={t('No matches')} />}
            {!loading &&
              results.map((s) => (
                <button
                  key={s.symbol}
                  // A pair reads as written, BTC then /USDT, in a right-to-left window too.
                  dir="ltr"
                  onClick={() => {
                    onSelect(s)
                    setOpen(false)
                    setQuery('')
                  }}
                  className="dropdown-item"
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: '0.3rem',
                    width: '100%',
                    padding: '0.55rem 0.75rem',
                    border: 'none',
                    background: s.symbol === symbol ? 'var(--accent-soft)' : 'transparent',
                    color: s.symbol === symbol ? 'var(--accent)' : 'var(--text-primary)',
                    cursor: 'pointer',
                    fontSize: '0.85rem',
                    textAlign: 'start'
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{s.baseAsset}</span>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>/{s.quoteAsset}</span>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}

function StatusRow({ text }: { text: string }): React.JSX.Element {
  return (
    <div style={{ padding: '0.75rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{text}</div>
  )
}
