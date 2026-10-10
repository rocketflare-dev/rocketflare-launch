/**
 * D36 K1: `launch kits ls|show|add|check|pin|default|rm`, in-process against a fake server. Bodies
 * are validated with the shared schema before any request; a kit that fails conformance prints
 * its problems and exits 1; `rm` asks first; `--json` prints the body as sent.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  runKitsAdd,
  runKitsCheck,
  runKitsDefault,
  runKitsList,
  runKitsPin,
  runKitsRemove,
  runKitsShow,
} from '../src/commands/kits'
import { EXIT_ERROR, exitCodeFor } from '../src/errors'
import type { Route } from './helpers'
import { jsonResponse, mockFetch, testContext } from './helpers'
import { at, loggedInStore } from './p4-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

async function run(
  fn: (ctx: Awaited<ReturnType<typeof testContext>>['ctx']) => Promise<void>,
  routes: Record<string, Route>,
  json = false
) {
  const { fetch, calls } = mockFetch(routes)
  const t = await testContext({ store: await loggedInStore(cleanups), fetch, json })
  // biome-ignore lint/suspicious/noExplicitAny: the test reads CliError fields
  const error: any = await fn(t.ctx).then(
    () => null,
    (e: unknown) => e
  )
  const bodies = calls.map(c => (c.init.body ? JSON.parse(String(c.init.body)) : undefined))
  return { ...t, calls, bodies, error }
}

const ID = '55555555-6666-4777-8888-999999999999'
const SHA = 'a'.repeat(40)
const kit = {
  id: ID,
  slug: 'acme-kit',
  name: 'Acme kit',
  description: 'Our internal tools',
  repo: 'acme/acme-kit',
  pin: { repo: 'acme/acme-kit', tag: '1.0.0', commit: SHA },
  pinIsCodeDefault: false,
  isDefault: false,
  status: 'verified',
  problems: [],
  contractVersion: '1',
  manifestSource: 'repo',
  checkedAt: at,
  latestCheck: null,
  appCount: 2,
  createdAt: at,
  updatedAt: at,
}
const builtIn = {
  ...kit,
  id: '66666666-7777-4888-8999-aaaaaaaaaaaa',
  slug: 'rocketflare',
  name: 'Rocketflare',
  repo: 'rocketflare-dev/rocketflare',
  pin: { repo: 'rocketflare-dev/rocketflare', tag: '0.16.0', commit: SHA },
  pinIsCodeDefault: true,
  isDefault: true,
  status: 'unchecked',
  manifestSource: null,
  checkedAt: null,
  appCount: 5,
}
const detail = { ...kit, manifest: null }

describe('kits ls / show', () => {
  it('lists every kit with its pin, status and apps; --json prints the body', async () => {
    const body = { kits: [builtIn, kit] }
    const r = await run(c => runKitsList(c), { '/api/platform/kits': () => jsonResponse(body) })
    expect(r.error).toBeNull()
    const text = r.out.content()
    expect(text).toContain("rocketflare-dev/rocketflare@0.16.0 (Launch's default)")
    expect(text).toContain('acme/acme-kit@1.0.0')
    expect(text).toContain('verified')

    const asJson = await run(
      c => runKitsList(c),
      { '/api/platform/kits': () => jsonResponse(body) },
      true
    )
    expect(JSON.parse(asJson.out.content())).toEqual(body)
  })

  it('shows one kit by slug, with its problems', async () => {
    const failed = {
      ...detail,
      status: 'failed',
      problems: ['.github/workflows/ci.yml is missing'],
    }
    const r = await run(c => runKitsShow(c, 'acme-kit'), {
      '/api/platform/kits/acme-kit': () => jsonResponse(failed),
    })
    expect(r.error).toBeNull()
    expect(r.out.content()).toContain('! .github/workflows/ci.yml is missing')
    expect(r.out.content()).toContain('launch.kit.json (schema 1)')
  })
})

describe('kits add / check / pin', () => {
  it('add sends repo + the pin; exactly one of --tag/--commit/--latest', async () => {
    const r = await run(c => runKitsAdd(c, 'acme/acme-kit', { latest: true, slug: 'acme-kit' }), {
      '/api/platform/kits': () => jsonResponse(detail, 201),
    })
    expect(r.error).toBeNull()
    expect(r.bodies[0]).toEqual({
      repo: 'acme/acme-kit',
      pin: { kind: 'latest' },
      slug: 'acme-kit',
    })
    expect(r.out.content()).toContain('Registered')

    const none = await run(c => runKitsAdd(c, 'acme/acme-kit', {}), {})
    expect(exitCodeFor(none.error)).toBe(EXIT_ERROR)
    const badRepo = await run(c => runKitsAdd(c, 'not a repo', { tag: '1.0.0' }), {})
    expect(exitCodeFor(badRepo.error)).toBe(EXIT_ERROR)
    expect(none.calls).toHaveLength(0)
    expect(badRepo.calls).toHaveLength(0)
  })

  it('a kit that fails the check prints its problems and exits 1', async () => {
    const failed = { ...detail, status: 'failed', problems: ['deploy.yml is missing'] }
    const r = await run(c => runKitsCheck(c, 'acme-kit'), {
      '/api/platform/kits/acme-kit/check': () => jsonResponse(failed),
    })
    expect(exitCodeFor(r.error)).toBe(EXIT_ERROR)
    expect(r.out.content()).toContain('! deploy.yml is missing')
  })

  it('--dynamic asks the server to run the kit too, and says where the result will be (D36 K3)', async () => {
    const checking = {
      ...detail,
      status: 'checking',
      dynamicCheck: {
        id: '00000000-0000-4000-8000-0000000000d1',
        status: 'queued',
        commit: 'a'.repeat(40),
        repo: null,
        runUrl: null,
        problems: [],
        cleanup: null,
        startedAt: at,
        finishedAt: null,
      },
    }
    const r = await run(c => runKitsCheck(c, 'acme-kit', { dynamic: true }), {
      '/api/platform/kits/acme-kit/check': () => jsonResponse(checking),
    })
    expect(r.error).toBeNull()
    expect(String(r.calls[0]?.url)).toContain('/api/platform/kits/acme-kit/check?dynamic=1')
    expect(r.out.content()).toContain('checking')
    expect(r.out.content()).toContain('Dynamic   queued at aaaaaaa')
    expect(r.out.content()).toContain('launch kits show acme-kit')

    const plain = await run(c => runKitsCheck(c, 'acme-kit'), {
      '/api/platform/kits/acme-kit/check': () => jsonResponse(detail),
    })
    expect(String(plain.calls[0]?.url)).not.toContain('dynamic')
  })

  it('pin sends the discriminated body; the server’s 422 is exit 1 with its sentence', async () => {
    const r = await run(c => runKitsPin(c, 'acme-kit', { commit: 'main' }), {
      '/api/platform/kits/acme-kit/pin': () => jsonResponse(detail),
    })
    expect(r.error).toBeNull()
    expect(r.bodies[0]).toEqual({ kind: 'commit', ref: 'main' })

    const missing = await run(c => runKitsPin(c, 'acme-kit', { tag: '9.9.9' }), {
      '/api/platform/kits/acme-kit/pin': () =>
        jsonResponse(
          { error: 'acme/acme-kit has no tag 9.9.9', statusCode: 422, code: 'kit_ref_not_found' },
          422
        ),
    })
    expect(exitCodeFor(missing.error)).toBe(EXIT_ERROR)
    expect(missing.error.message).toContain('has no tag 9.9.9')
  })
})

describe('kits default / rm', () => {
  it('default names the kit new apps are cut from', async () => {
    const r = await run(c => runKitsDefault(c, 'acme-kit'), {
      '/api/platform/kits/acme-kit/default': () => jsonResponse({ ...detail, isDefault: true }),
    })
    expect(r.error).toBeNull()
    expect(r.out.content()).toContain('New apps are cut from Acme kit')
  })

  it('rm asks first (refused without a terminal), and the server’s 409 is exit 1', async () => {
    const asked = await run(c => runKitsRemove(c, 'acme-kit'), {})
    expect(asked.calls).toHaveLength(0)

    const ok = await run(c => runKitsRemove(c, 'acme-kit', { yes: true }), {
      '/api/platform/kits/acme-kit': () => jsonResponse({ removed: true }),
    })
    expect(ok.error).toBeNull()
    expect(ok.calls[0]?.init.method).toBe('DELETE')

    const used = await run(c => runKitsRemove(c, 'acme-kit', { yes: true }), {
      '/api/platform/kits/acme-kit': () =>
        jsonResponse(
          { error: '2 apps were created from Acme kit', statusCode: 409, code: 'kit_has_apps' },
          409
        ),
    })
    expect(exitCodeFor(used.error)).toBe(EXIT_ERROR)
  })
})
