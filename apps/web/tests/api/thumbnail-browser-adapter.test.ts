// @vitest-isolate
// Mocks `@cloudflare/puppeteer`, so this file needs its own module registry.
/**
 * The real `ScreenshotPort` adapter (`services/launch/thumbnails/screenshot.ts`) over a fake
 * puppeteer: it launches on the binding, sets the 1280×800 viewport, waits for `load` within the
 * budget, treats a network that never goes idle as fine, takes ONE WebP, and closes the browser
 * whatever happened — including when navigation fails.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => {
  const state = {
    gotoError: null as Error | null,
    idleError: null as Error | null,
    calls: [] as Array<[string, ...unknown[]]>,
    closed: 0,
  }
  const page = {
    setViewport: async (v: unknown) => void state.calls.push(['setViewport', v]),
    goto: async (url: string, opts: unknown) => {
      state.calls.push(['goto', url, opts])
      if (state.gotoError) throw state.gotoError
    },
    waitForNetworkIdle: async (opts: unknown) => {
      state.calls.push(['waitForNetworkIdle', opts])
      if (state.idleError) throw state.idleError
    },
    screenshot: async (opts: unknown) => {
      state.calls.push(['screenshot', opts])
      return new Uint8Array([1, 2, 3])
    },
    url: () => 'https://expenses.example.com/login',
  }
  const browser = {
    newPage: async () => page,
    close: async () => {
      state.closed += 1
    },
  }
  const launch = vi.fn(async (_binding: unknown) => browser)
  return { state, launch }
})

vi.mock('@cloudflare/puppeteer', () => ({ default: { launch: fake.launch } }))

import {
  browserRenderingScreenshots,
  defaultScreenshotPort,
} from '@/api/services/launch/thumbnails/screenshot'

const binding = { fetch: async () => new Response('') }
const request = {
  url: 'https://expenses.example.com/',
  viewport: { width: 1280, height: 800 },
  timeoutMs: 15_000,
}

afterEach(() => {
  fake.state.calls.length = 0
  fake.state.closed = 0
  fake.state.gotoError = null
  fake.state.idleError = null
  fake.launch.mockClear()
})

describe('browserRenderingScreenshots', () => {
  it('launches on the binding, renders at 1280×800, takes one WebP and closes', async () => {
    const shot = await browserRenderingScreenshots(binding).capture(request)
    expect(fake.launch).toHaveBeenCalledWith(binding)
    expect(fake.state.calls.map(c => c[0])).toEqual([
      'setViewport',
      'goto',
      'waitForNetworkIdle',
      'screenshot',
    ])
    expect(fake.state.calls[0]?.[1]).toEqual({ width: 1280, height: 800 })
    expect(fake.state.calls[1]?.slice(1)).toEqual([
      'https://expenses.example.com/',
      { waitUntil: 'load', timeout: 15_000 },
    ])
    expect(fake.state.calls[3]?.[1]).toEqual({ type: 'webp', quality: 70 })
    expect(shot).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/webp',
      finalUrl: 'https://expenses.example.com/login',
    })
    expect(fake.state.closed).toBe(1)
  })

  it('pictures a page whose network never goes quiet', async () => {
    fake.state.idleError = new Error('Timed out after waiting 14000ms')
    const shot = await browserRenderingScreenshots(binding).capture(request)
    expect(shot.bytes.byteLength).toBe(3)
    expect(fake.state.closed).toBe(1)
  })

  it('throws a navigation failure — the job retries — and still closes the browser', async () => {
    fake.state.gotoError = new Error('net::ERR_NAME_NOT_RESOLVED')
    await expect(browserRenderingScreenshots(binding).capture(request)).rejects.toThrow(
      'ERR_NAME_NOT_RESOLVED'
    )
    expect(fake.state.calls.map(c => c[0])).not.toContain('screenshot')
    expect(fake.state.closed).toBe(1)
  })
})

describe('defaultScreenshotPort', () => {
  it('is null without a BROWSER binding — the feature is simply absent', () => {
    expect(defaultScreenshotPort({} as never)).toBeNull()
    expect(defaultScreenshotPort({ BROWSER: binding } as never)).not.toBeNull()
  })
})
