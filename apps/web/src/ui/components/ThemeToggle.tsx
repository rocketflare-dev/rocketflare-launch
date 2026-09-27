import { MoonIcon, SunIcon } from '@heroicons/react/24/outline'
import { useEffect, useState } from 'react'

export const THEMES = ['launch-light', 'launch-dark'] as const
export type Theme = (typeof THEMES)[number]

/**
 * Normalise whatever is stored to a valid theme so state never starts out of sync with the
 * DOM (an invalid stored value made the first click a visual no-op). Mirrors index.html.
 */
export function getInitialTheme(): Theme {
  const saved = localStorage.getItem('theme')
  if (saved === 'launch-dark' || saved === 'launch-light') return saved
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'launch-dark'
    : 'launch-light'
}

/**
 * Point the browser chrome (`<meta name="theme-color">`, one per OS scheme in index.html) at the
 * theme actually showing, so a manual toggle against the OS preference does not leave a cream
 * address bar over the night canvas. Reads `--surface-app` from the live theme rather than
 * repeating a hex here — index.css stays the only place a colour is written down.
 */
function syncThemeColor() {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--surface-app').trim()
  if (!color) return
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = color
  }
}

/** Light/dark switch. The `data-theme` attribute IS the state; localStorage remembers it. */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
    syncThemeColor()
  }, [theme])

  const isLight = theme === 'launch-light'

  return (
    <button
      type="button"
      onClick={() => setTheme(isLight ? 'launch-dark' : 'launch-light')}
      className="btn btn-ghost btn-sm btn-circle"
      title={`Switch to ${isLight ? 'dark' : 'light'} mode`}
      aria-label={`Switch to ${isLight ? 'dark' : 'light'} mode`}
    >
      {isLight ? <MoonIcon className="w-5 h-5" /> : <SunIcon className="w-5 h-5" />}
    </button>
  )
}
