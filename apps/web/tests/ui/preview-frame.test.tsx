/**
 * The preview pane's half of the preview bridge (plan §4): `PreviewFrame` keeps the page its frame
 * is on from the bridge's `postMessage`s — only those from ITS iframe's window and the preview's
 * origin — shows it in the address pill, hands it to `onPathChange`, and mints every reload's grant
 * with it so the reload stays on that page.
 */

import {
  PREVIEW_CAPTURE_REQUEST,
  PREVIEW_CAPTURE_RESULT,
  PREVIEW_LOCATION_MESSAGE,
} from '@launch/shared/launch-sessions'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  capturePreview,
  PREVIEW_CAPTURE_TIMEOUT_MS,
  PREVIEW_LOAD_DEADLINE_MS,
  PreviewFrame,
} from '@/ui/pages/sessions/components/PreviewFrame'
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

describe('capturePreview — the camera, in the browser', () => {
  const frameAt = () => {
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    const target = frame.contentWindow as Window
    const sent: { data: { type: string; id: string }; origin: string }[] = []
    vi.spyOn(target, 'postMessage').mockImplementation(((data: never, origin: string) => {
      sent.push({ data, origin })
    }) as never)
    const reply = (data: unknown, opts: { origin?: string; source?: Window | null } = {}) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          data,
          origin: opts.origin ?? ORIGIN,
          source: opts.source === undefined ? target : opts.source,
        })
      )
    return { frame, sent, reply }
  }

  it('asks the frame at the preview’s origin and resolves to the PNG its bridge answers with', async () => {
    const { frame, sent, reply } = frameAt()
    const shot = capturePreview(frame, ORIGIN)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.origin).toBe(ORIGIN)
    expect(sent[0]?.data.type).toBe(PREVIEW_CAPTURE_REQUEST)
    const id = sent[0]?.data.id as string
    const png = new Blob(['png'], { type: 'image/png' })
    // Another window, another origin, another id: not the answer.
    reply({ type: PREVIEW_CAPTURE_RESULT, id, image: new Blob(['x']) }, { source: window })
    reply(
      { type: PREVIEW_CAPTURE_RESULT, id, image: new Blob(['x']) },
      { origin: 'https://evil.test' }
    )
    reply({ type: PREVIEW_CAPTURE_RESULT, id: 'another', image: new Blob(['x']) })
    reply({ type: PREVIEW_CAPTURE_RESULT, id, image: png })
    await expect(shot).resolves.toBe(png)
    frame.remove()
  })

  it('rejects with the bridge’s reason, or when the frame never answers', async () => {
    const { frame, sent, reply } = frameAt()
    const refused = capturePreview(frame, ORIGIN)
    reply({ type: PREVIEW_CAPTURE_RESULT, id: sent[0]?.data.id, error: 'The page blocked it' })
    await expect(refused).rejects.toThrow('The page blocked it')

    vi.useFakeTimers()
    const silent = capturePreview(frame, ORIGIN)
    vi.advanceTimersByTime(PREVIEW_CAPTURE_TIMEOUT_MS + 1)
    await expect(silent).rejects.toThrow('The preview did not answer')
    vi.useRealTimers()
    frame.remove()
  })
})

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

describe('PreviewFrame’s load deadline', () => {
  it('a frame that has not loaded after 30 s stops spinning and offers Reload; a load clears it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderFrame()
      const frame = await screen.findByTitle('App preview')
      expect(screen.getByText('Loading the preview…')).toBeInTheDocument()
      expect(screen.queryByText("The preview isn't answering")).toBeNull()

      act(() => {
        vi.advanceTimersByTime(PREVIEW_LOAD_DEADLINE_MS - 1000)
      })
      expect(screen.getByText('Loading the preview…')).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(screen.getByText("The preview isn't answering")).toBeInTheDocument()
      expect(screen.queryByText('Loading the preview…')).toBeNull()
      // The frame stays underneath, so a late answer still shows.
      expect(frame).toBeInTheDocument()

      // Reload asks for a fresh grant and starts the deadline again.
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
      await waitFor(() =>
        expect(screen.getByTitle('App preview').getAttribute('src')).toMatch(/g=2$/)
      )
      expect(screen.getByText('Loading the preview…')).toBeInTheDocument()
      expect(screen.queryByText("The preview isn't answering")).toBeNull()

      // A load that lands before the deadline: no spinner, and no stall after it.
      fireEvent.load(screen.getByTitle('App preview'))
      act(() => {
        vi.advanceTimersByTime(PREVIEW_LOAD_DEADLINE_MS * 2)
      })
      expect(screen.queryByText('Loading the preview…')).toBeNull()
      expect(screen.queryByText("The preview isn't answering")).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the camera', () => {
  it('shows once the bridge has reported a page — the bridge is what captures — and hands over a capture', async () => {
    stubFetch({
      [`POST ${BASE}/preview-grant`]: () => ({
        url: `${ORIGIN}/__launch/grant?g=1`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    })
    const onScreenshot = vi.fn()
    const session = sessionRow() as unknown as Parameters<typeof PreviewFrame>[0]['session']
    renderWithProviders(
      <PreviewFrame
        session={session}
        steps={[]}
        canManage
        onResume={() => {}}
        resuming={false}
        changeSeq={1}
        onScreenshot={onScreenshot}
      />
    )
    await waitFor(() => expect(screen.getByTitle('App preview')).toBeInTheDocument())
    const camera = () =>
      screen.queryByRole('button', { name: 'Screenshot the preview into the next message' })
    expect(camera()).toBeNull()
    post({ type: PREVIEW_LOCATION_MESSAGE, path: '/login' })
    fireEvent.click(await waitFor(() => camera() as HTMLElement))
    expect(onScreenshot).toHaveBeenCalledWith(expect.any(Function), '/login')
  })
})
