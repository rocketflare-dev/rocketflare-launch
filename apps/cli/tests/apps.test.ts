/**
 * `apps show|upgrade` (P6 6c), in-process against a fake server: `show` names the kit against the
 * template pin ("Requires upgrade → 0.16.1", or the upgrade in flight); `upgrade` resolves the slug,
 * posts `/upgrade` and prints the session; a refusal is the server's sentence (exit 1) and a 403
 * exits 3; `--json` is the raw body.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { kitLine, runAppsShow, runAppsUpgrade } from '../src/commands/apps'
import { EXIT_ERROR, EXIT_FORBIDDEN, exitCodeFor } from '../src/errors'
import { captureError, jsonResponse, mockFetch, testContext } from './helpers'
import { APP_ID, appDetail, at, loggedInStore } from './p4-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})
const store = () => loggedInStore(cleanups)

const UPGRADE_ID = '77777777-7777-4777-8777-777777777777'
const SESSION_ID = '66666666-6666-4666-8666-666666666666'

const kit = (overrides: Record<string, unknown> = {}) => ({
  current: '0.16.0',
  target: '0.16.1',
  behind: true,
  openUpgrade: null,
  notesUrl: null,
  ...overrides,
})

const upgrade = (overrides: Record<string, unknown> = {}) => ({
  id: UPGRADE_ID,
  appId: APP_ID,
  targetKind: 'kit',
  pluginId: null,
  fromVersion: '0.16.0',
  toVersion: '0.16.1',
  status: 'running',
  sessionId: SESSION_ID,
  prNumber: null,
  prUrl: null,
  error: null,
  requestedByUserId: null,
  createdAt: at,
  updatedAt: at,
  ...overrides,
})

const behind = { ...appDetail, templateVersion: '0.16.0', kit: kit() }

describe('apps show', () => {
  it('says Requires upgrade and how to start it; --json is the raw detail', async () => {
    const { fetch } = mockFetch({ '/api/apps/expenses': () => jsonResponse(behind) })
    const human = await testContext({ store: await store(), fetch })
    await runAppsShow(human.ctx, 'expenses')
    expect(human.out.content()).toContain('kit 0.16.0 · Requires upgrade → 0.16.1')
    expect(human.out.content()).toContain('launch apps upgrade expenses')

    const json = await testContext({ store: await store(), fetch, json: true })
    await runAppsShow(json.ctx, 'expenses')
    expect(JSON.parse(json.out.content()).kit).toMatchObject({ behind: true, target: '0.16.1' })
  })

  it('names an upgrade in flight, and an app on the pin as current', () => {
    expect(
      kitLine({
        templateVersion: '0.16.0',
        kit: kit({
          openUpgrade: upgrade({ status: 'pr_open', prUrl: 'https://github.com/a/b/pull/3' }),
        }) as never,
      })
    ).toBe('kit 0.16.0 · upgrade to 0.16.1: pull request open (https://github.com/a/b/pull/3)')
    expect(
      kitLine({
        templateVersion: '0.16.1',
        kit: kit({ current: '0.16.1', behind: false }) as never,
      })
    ).toBe('kit 0.16.1 · current (pin 0.16.1)')
    expect(kitLine({ templateVersion: null, kit: null })).toBe('kit unknown')
  })
})

describe('apps upgrade', () => {
  it('resolves the slug, posts /upgrade and prints the session', async () => {
    const { fetch, calls } = mockFetch({
      '/api/apps/expenses': () => jsonResponse(behind),
      [`/api/apps/${APP_ID}/upgrade`]: () =>
        jsonResponse({ upgradeId: UPGRADE_ID, sessionId: SESSION_ID, upgrade: upgrade() }, 202),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runAppsUpgrade(ctx, 'expenses')
    expect(calls[1]?.init.method).toBe('POST')
    expect(out.content()).toContain("Upgrading expenses's kit 0.16.0 → 0.16.1")
    expect(out.content()).toContain(`/apps/expenses/sessions/${SESSION_ID}`)
  })

  it('a refusal is the server’s sentence and exits 1; a 403 exits 3', async () => {
    const refused = mockFetch({
      '/api/apps/expenses': () => jsonResponse(behind),
      [`/api/apps/${APP_ID}/upgrade`]: () =>
        jsonResponse(
          {
            error: 'This app already has an upgrade to 0.16.1 in progress',
            statusCode: 409,
            code: 'upgrade_open',
          },
          409
        ),
    })
    const a = await testContext({ store: await store(), fetch: refused.fetch })
    const err = await captureError(runAppsUpgrade(a.ctx, 'expenses'))
    expect(exitCodeFor(err)).toBe(EXIT_ERROR)
    expect(String(err.message)).toContain('already has an upgrade')

    const forbidden = mockFetch({
      '/api/apps/expenses': () => jsonResponse(behind),
      [`/api/apps/${APP_ID}/upgrade`]: () =>
        jsonResponse({ error: 'Forbidden', statusCode: 403, code: 'forbidden' }, 403),
    })
    const b = await testContext({ store: await store(), fetch: forbidden.fetch })
    expect(exitCodeFor(await captureError(runAppsUpgrade(b.ctx, 'expenses')))).toBe(EXIT_FORBIDDEN)
  })
})
