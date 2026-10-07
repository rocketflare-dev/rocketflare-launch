/**
 * `restorePreviewScheme` (preview gateway): local `wrangler dev` behind a tunnel rewrites a
 * same-host `Origin: https://…` to `http://…`, and the app's CSRF check then refused every POST
 * from the preview. The gateway puts the public scheme back — on THIS host's headers only.
 */
import { describe, expect, it } from 'vitest'
import { restorePreviewScheme } from '@/api/preview/gateway'
import type { AppConfig } from '@/config'

const cfg = { SESSION_PREVIEW_URL: 'https://{label}.clewro.com' } as AppConfig
const HOST = '5173-abc123-tok.clewro.com'
const URL_IN = `http://${HOST}/auth/logout`

function run(init: Record<string, string>, config: AppConfig = cfg): Headers {
  const headers = new Headers(init)
  restorePreviewScheme(headers, URL_IN, config)
  return headers
}

describe('restorePreviewScheme', () => {
  it('puts https back on an Origin and a Referer naming the preview host', () => {
    const h = run({ Origin: `http://${HOST}`, Referer: `http://${HOST}/settings?tab=a` })
    expect(h.get('Origin')).toBe(`https://${HOST}`)
    expect(h.get('Referer')).toBe(`https://${HOST}/settings?tab=a`)
  })

  it('leaves another host, an already-right scheme and a garbled value alone', () => {
    expect(run({ Origin: 'http://localhost:3000' }).get('Origin')).toBe('http://localhost:3000')
    expect(run({ Origin: 'http://other.clewro.com' }).get('Origin')).toBe('http://other.clewro.com')
    expect(run({ Origin: `https://${HOST}` }).get('Origin')).toBe(`https://${HOST}`)
    expect(run({ Origin: 'null' }).get('Origin')).toBe('null')
  })

  it('follows the template: an http preview domain stays http', () => {
    const local = { SESSION_PREVIEW_URL: 'http://{label}.localhost:3001' } as AppConfig
    const headers = new Headers({ Origin: 'http://5173-a-b.localhost:3001' })
    restorePreviewScheme(headers, 'http://5173-a-b.localhost:3001/x', local)
    expect(headers.get('Origin')).toBe('http://5173-a-b.localhost:3001')
  })
})
