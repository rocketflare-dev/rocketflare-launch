/**
 * The preview pane's half of the preview bridge (plan §4): `PreviewFrame` keeps the page its frame
 * is on from the bridge's `postMessage`s — only those from ITS iframe's window and the preview's
 * origin — shows it in the address pill, hands it to `onPathChange`, and mints every reload's grant
 * with it so the reload stays on that page.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PreviewFrame } from '@/ui/pages/sessions/components/PreviewFrame'
import { renderWithProviders, stubFetch } from './helpers/renderWithProviders'
import { SESSION_ID, sessionRow } from './helpers/sessions'

const BASE = `/api/sessions/${SESSION_ID}`
const ORIGIN = 'http://5173-abcdefghijkl-t0k3n00000.localhost:3001'
const HOST = '5173-abcdefghijkl-t0k3n00000.localhost:3001'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderFrame(changeSeq = 1) {
  let grants = 0
  const bodies: unknown[] = []
  const fetchMock = stubFetch({
    [`POST ${BASE}/preview-grant`]: (init: RequestInit | undefined) => {
      grants += 1
      bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined)
      return {
        url: `${ORIGIN}/__launch/grant?g=${grants}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }
    },
  })
  const onPathChange = vi.fn()
  const session = sessionRow() as unknown as Parameters<typeof PreviewFrame>[0]['session']
  const props = {
    session,
    steps: [],
    canManage: true,
    onResume: () => {},
    resuming: false,
    onPathChange,
  }
  const view = renderWithProviders(<PreviewFrame {...props} changeSeq={changeSeq} />)
  const rerender = (seq: number) => view.rerender(<PreviewFrame {...props} changeSeq={seq} />)
  return { fetchMock, bodies, onPathChange, rerender }
}

const frameWindow = () =>
  (screen.getByTitle('App preview') as HTMLIFrameElement).contentWindow as Window

function post(data: unknown, { origin = ORIGIN, source = frameWindow() as Window | null } = {}) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source }))
  })
}

const address = () => screen.getByTestId('preview-address')

describe('PreviewFrame and the preview bridge', () => {
  it('follows its own frame’s reports; ignores another window, another origin and bad paths', async () => {
    const { onPathChange } = renderFrame()
    await screen.findByTitle('App preview')
    expect(address()).toHaveTextContent(HOST)
    expect(address().textContent).toBe(HOST)

    post({ type: 'launch.preview.location', path: '/orders?tab=open' })
    expect(address().textContent).toBe(`${HOST}/orders?tab=open`)
    expect(onPathChange).toHaveBeenLastCalledWith('/orders?tab=open')

    // Another window (any other frame, or Launch's own) — refused even with the right origin.
    post({ type: 'launch.preview.location', path: '/elsewhere' }, { source: window })
    post({ type: 'launch.preview.location', path: '/elsewhere' }, { source: null })
    // The right window, the wrong origin (the frame navigated off the preview).
    post(
      { type: 'launch.preview.location', path: '/elsewhere' },
      { origin: 'http://evil.localhost:3001' }
    )
    post(
      { type: 'launch.preview.location', path: '/elsewhere' },
      { origin: 'http://8787-abcdefghijkl-t0k3n00000.localhost:3001' }
    )
    // Not the bridge's message, or a path that is not a page on the preview.
    post({ type: 'something.else', path: '/elsewhere' })
    post({ type: 'launch.preview.location', path: '//evil.example/x' })
    post({ type: 'launch.preview.location', path: 'https://evil.example/' })
    post('launch.preview.location /elsewhere')
    expect(address().textContent).toBe(`${HOST}/orders?tab=open`)
    expect(onPathChange).not.toHaveBeenCalledWith('/elsewhere')

    post({ type: 'launch.preview.location', path: '/orders/42#notes' })
    expect(address().textContent).toBe(`${HOST}/orders/42#notes`)
    expect(onPathChange).toHaveBeenLastCalledWith('/orders/42#notes')
  })

  it('the first grant has no path; a reload (button or a dev server coming back) keeps the page', async () => {
    const { bodies, rerender } = renderFrame(1)
    await screen.findByTitle('App preview')
    expect(bodies).toEqual([{}])

    post({ type: 'launch.preview.location', path: '/orders?tab=open' })
    fireEvent.click(screen.getByRole('button', { name: 'Reload preview' }))
    await waitFor(() =>
      expect(screen.getByTitle('App preview').getAttribute('src')).toMatch(/g=2$/)
    )
    expect(bodies[1]).toEqual({ path: '/orders?tab=open' })

    // The new frame reports its own page; a dev server restart (`changeSeq`) reloads onto it.
    post({ type: 'launch.preview.location', path: '/settings' })
    rerender(2)
    await waitFor(() =>
      expect(screen.getByTitle('App preview').getAttribute('src')).toMatch(/g=3$/)
    )
    expect(bodies[2]).toEqual({ path: '/settings' })
    expect(address().textContent).toBe(`${HOST}/settings`)
  })
})
