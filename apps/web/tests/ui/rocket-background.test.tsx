/**
 * The sign-in page's night sky (`RocketBackground` behind `AuthCard`): decorative and out of the
 * accessibility tree, always the night sky whatever the theme, and still — no flight, no twinkle,
 * no pointer listeners — under `prefers-reduced-motion`. jsdom has no canvas, so the drawing is a
 * fake 2D context; what is asserted is what the component ASKS for (frames, listeners, stars).
 */
import { render, screen } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RocketBackground } from '@/ui/components/RocketBackground'
import Login from '@/ui/pages/Login'
import MagicLinkSent from '@/ui/pages/MagicLinkSent'
import { renderWithProviders, stubFetch } from './helpers/renderWithProviders'

function fakeContext() {
  const noop = () => {}
  return {
    setTransform: vi.fn(noop),
    clearRect: vi.fn(noop),
    beginPath: vi.fn(noop),
    arc: vi.fn(noop),
    fill: vi.fn(noop),
    stroke: vi.fn(noop),
    moveTo: vi.fn(noop),
    lineTo: vi.fn(noop),
    quadraticCurveTo: vi.fn(noop),
    bezierCurveTo: vi.fn(noop),
    closePath: vi.fn(noop),
    fillRect: vi.fn(noop),
    clip: vi.fn(noop),
    save: vi.fn(noop),
    restore: vi.fn(noop),
    translate: vi.fn(noop),
    rotate: vi.fn(noop),
    scale: vi.fn(noop),
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
  }
}

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduce && query.includes('prefers-reduced-motion: reduce'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  )
}

function renderLogin() {
  stubFetch({ '/auth/methods': { magicLink: true, providers: [], devLogin: false } })
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<Login />} />
    </Routes>,
    { route: '/login', session: null }
  )
}

describe('RocketBackground on the sign-in page', () => {
  let ctx: ReturnType<typeof fakeContext>
  let raf: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ctx = fakeContext()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D
    )
    // jsdom lays nothing out; give the canvas a size so the star field is not empty.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    raf = vi.fn(() => 1)
    vi.stubGlobal('requestAnimationFrame', raf)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.documentElement.removeAttribute('data-theme')
  })

  it('paints a decorative night sky behind the card: aria-hidden, nothing focusable, no pointer', async () => {
    stubReducedMotion(false)
    const { container } = renderLogin()
    await screen.findByRole('button', { name: 'Email me a sign-in link' })

    const sky = container.querySelector('[data-night-sky]') as HTMLElement
    expect(sky).not.toBeNull()
    expect(sky.closest('[aria-hidden="true"]')).not.toBeNull()
    expect(sky).toHaveClass('night-sky', 'pointer-events-none')
    const canvas = sky.querySelector('canvas') as HTMLCanvasElement
    expect(canvas).not.toBeNull()
    expect(canvas.hasAttribute('tabindex')).toBe(false)
    expect(sky.querySelectorAll('a, button, input, [tabindex]')).toHaveLength(0)

    // The card is what the rocket steers around, and it is not inside the hidden layer.
    const card = container.querySelector('[data-rocket-ignore]') as HTMLElement
    expect(card).toContainElement(screen.getByRole('heading', { name: 'Sign in' }))
    expect(card.closest('[aria-hidden="true"]')).toBeNull()
    // The sky replaces the dark-only starfield rather than stacking on it.
    expect(container.querySelector('.starfield')).toBeNull()
  })

  it('is the night sky in the light theme too: the layer has no theme dependence', async () => {
    document.documentElement.setAttribute('data-theme', 'launch-light')
    stubReducedMotion(false)
    const { container } = renderLogin()
    await screen.findByRole('button', { name: 'Email me a sign-in link' })
    expect(container.querySelector('[data-night-sky]')).toHaveClass('night-sky')
  })

  it('flies and twinkles: animation frames and pointer listeners, removed on unmount', () => {
    stubReducedMotion(false)
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(<RocketBackground />)

    expect(raf).toHaveBeenCalledTimes(1)
    const events = add.mock.calls.map(([type]) => type)
    expect(events).toEqual(expect.arrayContaining(['resize', 'pointermove', 'pointerdown']))

    // One frame: stars, then the rocket with its dark outline stroked.
    const frame = raf.mock.calls[0]?.[0] as FrameRequestCallback
    frame(1000)
    expect(ctx.arc).toHaveBeenCalled()
    expect(ctx.stroke).toHaveBeenCalled()
    expect(raf).toHaveBeenCalledTimes(2)

    unmount()
    const removed = remove.mock.calls.map(([type]) => type)
    expect(removed).toEqual(expect.arrayContaining(['resize', 'pointermove', 'pointerdown']))
    expect(cancelAnimationFrame).toHaveBeenCalled()
  })

  it('prefers-reduced-motion: one static sky — no frames, no rocket, no pointer listeners', () => {
    stubReducedMotion(true)
    const add = vi.spyOn(window, 'addEventListener')
    const { unmount } = render(<RocketBackground />)

    expect(raf).not.toHaveBeenCalled()
    // The stars are painted once, at rest; nothing is stroked because no rocket is drawn.
    expect(ctx.arc.mock.calls.length).toBeGreaterThan(0)
    expect(ctx.stroke).not.toHaveBeenCalled()
    const events = add.mock.calls.map(([type]) => type)
    expect(events).toContain('resize')
    expect(events).not.toContain('pointermove')
    expect(events).not.toContain('pointerdown')
    unmount()
  })

  it('renders nothing but the sky layer when the browser has no 2D canvas', () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
    stubReducedMotion(false)
    const { container } = render(<RocketBackground />)
    expect(container.querySelector('[data-night-sky]')).not.toBeNull()
    expect(raf).not.toHaveBeenCalled()
  })

  it('/magic-link/sent keeps the same sky: one sign-in flow, one backdrop', () => {
    stubReducedMotion(true)
    const { container } = renderWithProviders(
      <Routes>
        <Route path="/magic-link/sent" element={<MagicLinkSent />} />
      </Routes>,
      { route: '/magic-link/sent?email=a%40b.test', session: null }
    )
    expect(screen.getByRole('heading', { name: 'Check your email' })).toBeInTheDocument()
    const sky = container.querySelector('[data-night-sky]')
    expect(sky).not.toBeNull()
    expect(sky?.closest('[aria-hidden="true"]')).not.toBeNull()
  })
})
