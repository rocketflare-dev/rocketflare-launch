/**
 * WCAG AA over the design tokens (`config` project, no DOM). Reads `src/ui/index.css` itself —
 * both `@plugin "daisyui/theme"` blocks and both `[data-theme]` token blocks — so a colour change
 * that breaks a floor fails here, not in somebody's eyes. The floors are the ones the file's header
 * comment promises: text ≥ 4.5:1 on the surfaces it sits on, control borders and the focus ring
 * ≥ 3:1 on the panel, and every semantic colour good for BOTH jobs DaisyUI gives it (text on the
 * panel, and a fill carrying its `-content` ink).
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(path.resolve(__dirname, '../../src/ui/index.css'), 'utf8')
const THEMES = ['launch-light', 'launch-dark'] as const

function declarations(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1] as string] = (m[2] as string).trim()
  }
  return out
}

/** The theme's full token map: the DaisyUI block merged with the `[data-theme]` block. */
function tokens(theme: string): Record<string, string> {
  const daisy = css.match(
    new RegExp(`@plugin "daisyui/theme" \\{\\s*name: "${theme}";([\\s\\S]*?)\\n\\}`)
  )
  const semantic = css.match(new RegExp(`\\[data-theme="${theme}"\\] \\{([\\s\\S]*?)\\n\\}`))
  if (!daisy || !semantic) throw new Error(`theme ${theme} not found in index.css`)
  return { ...declarations(daisy[1] as string), ...declarations(semantic[1] as string) }
}

type Rgb = [number, number, number]

function hex(value: string): Rgb {
  const h = value.replace('#', '')
  return [0, 2, 4].map(i => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb
}

/** A token as sRGB: a hex, a `var()`, or the `color-mix(in srgb, <a> N%, <b>)` form the file uses. */
function resolve(map: Record<string, string>, name: string): Rgb {
  const value = map[name]
  if (!value) throw new Error(`token ${name} is not defined`)
  if (value.startsWith('#')) return hex(value)
  const ref = value.match(/^var\((--[\w-]+)\)$/)
  if (ref) return resolve(map, ref[1] as string)
  const mix = value.match(/^color-mix\(in srgb, (#\w{6}) (\d+)%, (#\w{6})\)$/)
  if (mix) {
    const a = hex(mix[1] as string)
    const b = hex(mix[3] as string)
    const p = Number(mix[2]) / 100
    return a.map((c, i) => Math.round(c * p + (b[i] as number) * (1 - p))) as Rgb
  }
  throw new Error(`token ${name} = ${value} is not a colour this test can resolve`)
}

function luminance([r, g, b]: Rgb) {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: Rgb, b: Rgb) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** [foreground, background, floor] */
const PAIRS: [string, string, number][] = [
  // Text ramp on every surface it is used on
  ...[
    '--surface-app',
    '--surface-panel',
    '--surface-raised',
    '--surface-inset',
    '--surface-hover',
  ].flatMap(bg =>
    ['--text-primary', '--text-secondary', '--text-muted'].map(
      fg => [fg, bg, 4.5] as [string, string, number]
    )
  ),
  ['--text-primary', '--surface-active', 4.5],
  // Boundaries that identify a control (WCAG 1.4.11)
  ['--border-control', '--surface-panel', 3],
  ['--focus-ring', '--surface-panel', 3],
  ['--focus-ring', '--surface-app', 3],
  // The accents: text on the panel, and a fill carrying their ink
  ['--color-primary', '--surface-panel', 4.5],
  ['--color-primary-content', '--color-primary', 4.5],
  ['--color-primary', '--tone-primary-surface', 4.5],
  ['--color-accent', '--surface-panel', 4.5],
  ['--color-accent-content', '--color-accent', 4.5],
  ['--color-accent', '--tone-accent-surface', 4.5],
  ['--color-secondary-content', '--color-secondary', 4.5],
  ['--color-neutral-content', '--color-neutral', 4.5],
  ['--highlight-content', '--highlight', 4.5],
  // Semantic colours: both jobs, plus the status-badge well
  ...(['info', 'success', 'warning', 'error'] as const).flatMap(
    s =>
      [
        [`--color-${s}`, '--surface-panel', 4.5],
        [`--color-${s}-content`, `--color-${s}`, 4.5],
        [`--color-${s}`, `--tone-${s}-surface`, 4.5],
      ] as [string, string, number][]
  ),
  // The flame CTA: its ink on BOTH gradient stops
  ['--flame-content', '--flame-from', 4.5],
  ['--flame-content', '--flame-to', 4.5],
]

describe.each(THEMES)('%s contrast', theme => {
  const map = tokens(theme)

  it('keeps --color-secondary equal to --text-secondary (the utility/class collision)', () => {
    expect(map['--color-secondary']).toBe(map['--text-secondary'])
  })

  it.each(PAIRS)('%s on %s ≥ %s:1', (fg, bg, floor) => {
    const ratio = contrast(resolve(map, fg), resolve(map, bg))
    expect(ratio, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(floor)
  })
})

describe('theme-color', () => {
  it('index.html names each theme canvas as the browser chrome colour for its scheme', () => {
    const html = readFileSync(path.resolve(__dirname, '../../src/ui/index.html'), 'utf8')
    const light = tokens('launch-light')['--surface-app']
    const dark = tokens('launch-dark')['--surface-app']
    expect(html).toContain(
      `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${light}" />`
    )
    expect(html).toContain(
      `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${dark}" />`
    )
  })
})

/**
 * The sign-in page's night sky is the one surface that is dark in BOTH themes, so its colours live
 * in a theme-free `:root` block — never in a `[data-theme]` block, where they would flip. Text set
 * straight on it (AuthCard's footer) and the stars hold the text floor at both ends of the
 * gradient; the rocket's light body clears the 3:1 graphics floor; and its outline is darker than
 * any point of the sky, so the ink line reads as a line.
 */
describe('night sky', () => {
  const block = css.match(/:root \{([^}]*--night-sky-top[^}]*)\}/)
  const map = declarations(block?.[1] ?? '')

  it('is declared once, outside both themes', () => {
    expect(block).not.toBeNull()
    for (const theme of THEMES) expect(tokens(theme)['--night-sky-top']).toBeUndefined()
  })

  it.each([
    ['--night-sky-ink', 4.5],
    ['--night-star', 4.5],
    ['--rocket-body', 3],
  ] as const)('%s on both ends of the sky ≥ %s:1', (fg, floor) => {
    for (const bg of ['--night-sky-top', '--night-sky-bottom']) {
      const ratio = contrast(resolve(map, fg), resolve(map, bg))
      expect(ratio, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(floor)
    }
  })

  it('outlines the rocket in an ink darker than the sky', () => {
    const outline = luminance(resolve(map, '--rocket-outline'))
    expect(outline).toBeLessThan(luminance(resolve(map, '--night-sky-top')))
    expect(
      contrast(resolve(map, '--rocket-outline'), resolve(map, '--rocket-body'))
    ).toBeGreaterThan(7)
  })
})
