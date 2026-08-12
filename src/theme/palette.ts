import type { AppSettings } from '../../shared/ipc'

export type Theme = AppSettings['theme']

export interface ChartPalette {
  background: string
  text: string
  grid: string
  border: string
  up: string
  down: string
  accent: string
  gold: string
}

// lightweight-charts renders to canvas, not the DOM, so it can't pick up the CSS custom
// properties in index.css — this is the parallel source of truth for chart colors per theme.
export const CHART_PALETTE: Record<Theme, ChartPalette> = {
  dark: {
    background: 'transparent',
    text: '#c7cad1',
    grid: 'rgba(120,120,130,0.15)',
    border: '#22262c',
    up: '#26a69a',
    down: '#ef5350',
    accent: '#3b82f6',
    gold: '#d4a94a'
  },
  light: {
    background: 'transparent',
    text: '#3c4450',
    grid: 'rgba(60,68,80,0.12)',
    border: '#e1e4e9',
    up: '#0f9d78',
    down: '#d64545',
    accent: '#2563eb',
    gold: '#b8862f'
  },
  colorblind: {
    background: 'transparent',
    text: '#c7cad1',
    grid: 'rgba(120,120,130,0.15)',
    border: '#22262c',
    up: '#3b82f6',
    down: '#f59e0b',
    accent: '#818cf8',
    gold: '#d4a94a'
  }
}
