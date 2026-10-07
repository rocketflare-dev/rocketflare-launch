import chalk from 'chalk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bannerEnv } from '../src/config'
import {
  BANNER_HEIGHT,
  bannerFrame,
  bannerMode,
  commandHeader,
  isBareInvocation,
  isLocalServer,
  isRootHelp,
  staticBanner,
} from '../src/utils/banner'

const TTY = { stdoutIsTTY: true, stderrIsTTY: true, json: false }
const ENV = { ci: false, noColor: false }

describe('bannerMode — humans on a terminal only', () => {
  it('animates on a terminal by default', () => {
    expect(bannerMode(ENV, TTY)).toBe('animate')
  })

  it('is off for --json, a pipe on either stream, NO_COLOR and LAUNCH_BANNER=off', () => {
    expect(bannerMode(ENV, { ...TTY, json: true })).toBe('off')
    expect(bannerMode(ENV, { ...TTY, stdoutIsTTY: false })).toBe('off')
    expect(bannerMode(ENV, { ...TTY, stderrIsTTY: false })).toBe('off')
    expect(bannerMode({ ...ENV, noColor: true }, TTY)).toBe('off')
    expect(bannerMode({ ...ENV, banner: 'off' }, TTY)).toBe('off')
  })

  it('stays still in CI and with LAUNCH_BANNER=static', () => {
    expect(bannerMode({ ...ENV, ci: true }, TTY)).toBe('static')
    expect(bannerMode({ ...ENV, banner: 'static' }, TTY)).toBe('static')
  })

  it('reads its environment in config.ts', () => {
    expect(bannerEnv({ LAUNCH_BANNER: 'static', CI: '1', NO_COLOR: '' })).toEqual({
      banner: 'static',
      ci: true,
      noColor: false,
    })
  })
})

describe('isRootHelp', () => {
  it('is the bare command or --help, global server options aside', () => {
    expect(isRootHelp([])).toBe(true)
    expect(isRootHelp(['--help'])).toBe(true)
    expect(isRootHelp(['--server', 'prod', '-h'])).toBe(true)
    expect(isRootHelp(['sessions', '--help'])).toBe(false)
    expect(isRootHelp(['whoami'])).toBe(false)
  })

  it('tells a bare `launch` (help, exit 0) from an explicit --help', () => {
    expect(isBareInvocation([])).toBe(true)
    expect(isBareInvocation(['--server', 'prod'])).toBe(true)
    expect(isBareInvocation(['--help'])).toBe(false)
    expect(isBareInvocation(['whoami'])).toBe(false)
  })
})

describe('the header', () => {
  let level: typeof chalk.level
  beforeAll(() => {
    level = chalk.level
    chalk.level = 0
  })
  afterAll(() => {
    chalk.level = level
  })

  it('tells local dev from a real server', () => {
    expect(isLocalServer('http://localhost:3001')).toBe(true)
    expect(isLocalServer('http://127.0.0.1:3001')).toBe(true)
    expect(isLocalServer('https://launch.example.com')).toBe(false)
  })

  it('names the server a command is about to talk to', () => {
    expect(
      commandHeader({ version: '1.0.0', serverUrl: 'https://launch.example.com', profile: 'prod' })
    ).toBe('▲ Rocketflare Launch · prod → https://launch.example.com')
  })

  it('draws every frame at the same height, with the words once settled', () => {
    const info = { version: '1.0.0', serverUrl: 'http://localhost:3001' }
    expect(bannerFrame(info, 0, 0, false)).toHaveLength(BANNER_HEIGHT)
    expect(bannerFrame(info, 0, 0, false).join('\n')).not.toContain('Launch')
    const settled = staticBanner(info)
    expect(settled).toContain('Rocketflare Launch — the control plane')
    expect(settled).toContain('v1.0.0')
    expect(settled).toContain('http://localhost:3001')
  })
})
