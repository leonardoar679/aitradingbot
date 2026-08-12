import { createContext, useContext, useEffect, useState, type PropsWithChildren } from 'react'
import type { Theme } from './palette'

interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [theme, setThemeState] = useState<Theme>('dark')

  useEffect(() => {
    let cancelled = false
    window.api.settings.get().then((settings) => {
      if (!cancelled) setThemeState(settings.theme)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  function setTheme(next: Theme): void {
    setThemeState(next)
    void window.api.settings.set({ theme: next })
  }

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}
