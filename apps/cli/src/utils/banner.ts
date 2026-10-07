/**
 * The Rocketflare header: a rocket and a flame-to-violet `launch` wordmark on the root help (a short
 * lift-off on a real terminal), a one-line header on a subcommand's help, and one dim line on
 * stderr before a command naming the server it is about to talk to — orange when it is not this
 * machine, so production never looks like local dev.
 *
 * Humans only. It never shows with `--json`, when either stream is not a terminal (an agent, a
 * pipe), in CI, or with `NO_COLOR`; `LAUNCH_BANNER=off|static` turns it off or keeps it still
 * (`bannerEnv()` in config.ts). The renderers are pure; only `animateBanner` writes.
 */
import chalk from 'chalk'

/** The UI's palette (DaisyUI theme): flame orange → violet. */
export const PALETTE = {
  flame: '#ff7a45',
  ember: '#c2410c',
  spark: '#ffb347',
  glow: '#ffd27a',
  violet: '#a78bfa',
  deepViolet: '#7c3aed',
  hull: '#d6d1e6',
} as const

export type BannerMode = 'animate' | 'static' | 'off'

export interface BannerEnv {
  /** `LAUNCH_BANNER`: `off` | `static` | anything else = default. */
  banner?: string
  ci: boolean
  noColor: boolean
}

/** What the header may do here. Pure. */
export function bannerMode(
  env: BannerEnv,
  io: { stdoutIsTTY: boolean; stderrIsTTY: boolean; json: boolean }
): BannerMode {
  if (io.json || !io.stdoutIsTTY || !io.stderrIsTTY || env.noColor) return 'off'
  const choice = env.banner?.toLowerCase()
  if (choice === 'off' || choice === '0' || choice === 'false') return 'off'
  if (choice === 'static' || env.ci) return 'static'
  return 'animate'
}

/** True when `argv` (after the node + script entries) asks for the ROOT help only. Pure. */
export function isRootHelp(args: readonly string[]): boolean {
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--server' || a === '--profile') i++
    else if (!a.startsWith('--server=') && !a.startsWith('--profile=')) rest.push(a)
  }
  return (
    rest.length === 0 || (rest.length === 1 && ['--help', '-h', 'help'].includes(rest[0] as string))
  )
}

/** `launch` with each letter a step from flame to violet. Pure (given chalk's level). */
export function wordmark(text = 'Launch'): string {
  const from = hex(PALETTE.flame)
  const to = hex(PALETTE.violet)
  return [...text]
    .map((ch, i) => {
      const t = text.length === 1 ? 0 : i / (text.length - 1)
      const [r, g, b] = from.map((c, k) => Math.round(c + ((to[k] as number) - c) * t))
      return chalk.bold.rgb(r as number, g as number, b as number)(ch)
    })
    .join('')
}

function hex(value: string): [number, number, number] {
  const n = Number.parseInt(value.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Is this URL this machine? Local dev is violet; anything else is flame (look twice). */
export function isLocalServer(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')
  } catch {
    return false
  }
}

export interface BannerInfo {
  version: string
  serverUrl?: string
  profile?: string
}

function serverText(info: BannerInfo): string {
  if (!info.serverUrl) return ''
  const name = info.profile ? `${info.profile} ` : ''
  const paint = isLocalServer(info.serverUrl)
    ? chalk.hex(PALETTE.violet)
    : chalk.bold.hex(PALETTE.flame)
  return `${paint(`${name}`)}${chalk.dim('→')} ${paint(info.serverUrl)}`
}

/** `Rocketflare Launch` — the kit's name in hull grey, the tool's in the flame-to-violet gradient. */
export function brand(): string {
  return `${chalk.bold.hex(PALETTE.hull)('Rocketflare')} ${wordmark('Launch')}`
}

/** What Launch is, after the name. */
export const TAGLINE = 'the control plane'

/** The one line before a command's output (stderr): `▲ Rocketflare Launch · prod → https://…`. Pure. */
export function commandHeader(info: BannerInfo): string {
  const server = serverText(info)
  return `${chalk.hex(PALETTE.flame)('▲')} ${brand()}${server ? chalk.dim(' · ') + server : ''}`
}

/** A subcommand's help: the same line plus the version. Pure. */
export function helpHeader(info: BannerInfo): string {
  return `${commandHeader(info)} ${chalk.dim(`v${info.version}`)}\n`
}

// ---- the rocket ----------------------------------------------------------------------------

const ROCKET = ['   ▲   ', '  ▟█▙  ', '  █●█  ', ' ▟███▙ ', ' ▀ ▀ ▀ ']
const FLAMES = [
  ['  ▓█▓  ', '   ▒   '],
  ['  ▒▓▒  ', '  ░▒░  '],
  ['  ▓▒▓  ', '   ░   '],
  ['  █▓█  ', '  ▒ ▒  '],
]
/** Rows the rocket climbs during lift-off. */
const LIFT = 2
/** Canvas height: rocket + flame + the rows it climbs. */
export const BANNER_HEIGHT = ROCKET.length + 2 + LIFT

function paintRocket(line: string): string {
  return [...line]
    .map(ch => {
      if (ch === '▲') return chalk.hex(PALETTE.violet)(ch)
      if (ch === '●') return chalk.hex(PALETTE.flame)(ch)
      if (ch === '▀') return chalk.hex(PALETTE.deepViolet)(ch)
      if (ch === ' ') return ch
      return chalk.hex(PALETTE.hull)(ch)
    })
    .join('')
}

function paintFlame(line: string): string {
  const colour: Record<string, string> = {
    '█': PALETTE.flame,
    '▓': PALETTE.flame,
    '▒': PALETTE.spark,
    '░': PALETTE.glow,
    '·': PALETTE.ember,
  }
  return [...line].map(ch => (colour[ch] ? chalk.hex(colour[ch] as string)(ch) : ch)).join('')
}

/**
 * One frame of the canvas: the rocket `lift` rows up from the ground, flame frame `flicker`
 * beneath it, a fading trail under that, and — once `text` is set — the wordmark block beside it.
 * Pure; `BANNER_HEIGHT` lines.
 */
export function bannerFrame(
  info: BannerInfo,
  lift: number,
  flicker: number,
  text: boolean
): string[] {
  const top = LIFT - lift
  const flame = FLAMES[flicker % FLAMES.length] as string[]
  const rows: string[] = []
  for (let row = 0; row < BANNER_HEIGHT; row++) {
    const r = row - top
    if (r >= 0 && r < ROCKET.length) rows.push(paintRocket(ROCKET[r] as string))
    else if (r >= ROCKET.length && r < ROCKET.length + 2)
      rows.push(paintFlame(flame[r - ROCKET.length] as string))
    else if (r >= ROCKET.length + 2) rows.push(paintFlame(r % 2 === 0 ? '   ·   ' : '       '))
    else rows.push('       ')
  }
  if (text) {
    const lines = [
      `${brand()} ${chalk.dim('—')} ${chalk.hex(PALETTE.hull)(TAGLINE)}`,
      chalk.dim(`v${info.version} · for your company’s apps`),
      serverText(info),
      chalk.dim('agents: launch commands --json · launch api ls <word>'),
    ]
    lines.forEach((line, i) => {
      rows[i + 1] = `${rows[i + 1]}   ${line}`
    })
  }
  return rows
}

/** The settled header: the rocket up, the flame lit, the words beside it. Pure. */
export function staticBanner(info: BannerInfo): string {
  return `\n${bannerFrame(info, LIFT, 0, true)
    .slice(0, ROCKET.length + 2)
    .join('\n')}\n`
}

/**
 * Lift-off on `stream` (about half a second), ending on the settled header. Hides the cursor
 * while it runs and always shows it again, even on Ctrl-C.
 */
export async function animateBanner(
  info: BannerInfo,
  stream: NodeJS.WriteStream,
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))
): Promise<void> {
  const show = () => stream.write('\x1b[?25h')
  process.once('exit', show)
  stream.write('\n\x1b[?25l')
  const frames: Array<[number, number, boolean]> = [
    [0, 0, false],
    [0, 1, false],
    [0, 2, false],
    [1, 3, false],
    [1, 0, false],
    [2, 1, false],
    [2, 2, true],
    [2, 3, true],
    [2, 0, true],
  ]
  try {
    for (let i = 0; i < frames.length; i++) {
      const [lift, flicker, text] = frames[i] as [number, number, boolean]
      if (i > 0) stream.write(`\x1b[${BANNER_HEIGHT}A`)
      stream.write(
        `${bannerFrame(info, lift, flicker, text)
          .map(l => `\x1b[2K${l}`)
          .join('\n')}\n`
      )
      await sleep(i < 4 ? 70 : 55)
    }
  } finally {
    show()
    process.removeListener('exit', show)
  }
}
