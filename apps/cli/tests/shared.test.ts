/**
 * `shared ls|show|set|rotate|pushes` (Launch P5), in-process against a fake server. What matters
 * most: a value goes IN (from a hidden prompt or stdin, never argv) and never comes back OUT — not
 * on stdout, not in a log line, not in an error; a blank keeps what is set; `rotate` follows the
 * push and exits 1 naming the apps it failed on.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseValuesInput,
  runSharedList,
  runSharedPushes,
  runSharedSet,
  runSharedShow,
} from '../src/commands/shared'
import { EXIT_ERROR, exitCodeFor } from '../src/errors'
import { captureError, jsonResponse, mockFetch, testContext } from './helpers'
import { loggedInStore } from './p4-fixtures'
import {
  PUSH_ID,
  push,
  pushSummary,
  RESOURCE_ID,
  resource,
  resourceDetail,
  SENTINEL,
  target,
  VERSION_ID,
} from './p5-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})
const store = () => loggedInStore(cleanups)
const noSleep = async () => {}
const detailPath = `/api/shared-resources/${RESOURCE_ID}`
const valuesPath = (env: string) => `${detailPath}/values/${env}`
const pushPath = `${detailPath}/pushes/${PUSH_ID}`

function server(extra: Record<string, Parameters<typeof mockFetch>[0][string]> = {}) {
  return mockFetch({
    '/api/shared-resources': () => jsonResponse({ items: [resource()] }),
    [detailPath]: () => jsonResponse(resourceDetail()),
    ...extra,
  })
}

/** Everything the command wrote anywhere. */
const everything = (t: Awaited<ReturnType<typeof testContext>>) =>
  `${t.out.content()}\n${t.log.lines.join('\n')}`

describe('shared ls / show', () => {
  it('lists each resource with its versions per environment; --json is the raw body', async () => {
    const { fetch } = server()
    const human = await testContext({ store: await store(), fetch })
    await runSharedList(human.ctx)
    expect(human.out.content()).toContain('m365')
    expect(human.out.content()).toContain('v3 · 2 apps')
    expect(human.out.content()).toContain('IT Identity')
    const json = await testContext({ store: await store(), fetch, json: true })
    await runSharedList(json.ctx)
    expect(JSON.parse(json.out.content()).items[0].slug).toBe('m365')
  })

  it('shows a resource by slug: the version line, the var values and holders it was sent', async () => {
    const { fetch } = server({
      [detailPath]: () =>
        jsonResponse(
          resourceDetail({
            environments: [
              { ...resource().environments[0], vars: { M365_TENANT_ID: 'tenant-abc' } },
              resource().environments[1],
            ],
            holders: [
              {
                grantId: '9a000000-0000-4000-8000-000000000001',
                app: {
                  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                  slug: 'expenses',
                  displayName: 'Expenses',
                },
                environment: 'staging',
                status: 'active',
                pushedVersion: 3,
                pushedAt: '2026-09-28T10:00:00.000Z',
                pushError: null,
                expiresAt: null,
              },
            ],
          })
        ),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runSharedShow(ctx, 'm365')
    const text = out.content()
    expect(text).toContain('set — version 3')
    expect(text).toContain('by Carol')
    expect(text).toContain('M365_TENANT_ID=tenant-abc')
    expect(text).toContain('Holders:')
    expect(text).toContain('expenses')
    expect(text).toContain(`/shared-config/${RESOURCE_ID}`)
  })

  it('a member sees no holders section', async () => {
    const { fetch } = server()
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runSharedShow(ctx, 'm365')
    expect(out.content()).not.toContain('Holders:')
  })

  it('an unknown slug is a sentence and exit 1', async () => {
    const { fetch } = server()
    const { ctx } = await testContext({ store: await store(), fetch })
    const error = await captureError(runSharedShow(ctx, 'nope'))
    expect(error.message).toContain('No shared config "nope"')
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
  })
})

describe('shared set — values in, never out', () => {
  it('reads KEY=value lines from stdin, drops blanks, and never echoes a value', async () => {
    const { fetch, calls } = server({
      [valuesPath('production')]: () =>
        jsonResponse({ versionId: VERSION_ID, version: 4, pushId: PUSH_ID }, 202),
    })
    const t = await testContext({ store: await store(), fetch })
    await runSharedSet(t.ctx, 'm365', {
      env: 'production',
      isTTY: false,
      readStdin: async () =>
        `# rotated today\nM365_CLIENT_SECRET="${SENTINEL}"\nexport M365_CLIENT_ID=\n\n`,
    })
    const put = calls.find(c => c.init.method === 'PUT')
    expect(put?.url.pathname).toBe(valuesPath('production'))
    expect(JSON.parse(String(put?.init.body))).toEqual({
      values: { M365_CLIENT_SECRET: SENTINEL },
    })
    expect(everything(t)).toContain('Version 4')
    expect(everything(t)).toContain('M365_CLIENT_SECRET')
    expect(everything(t)).not.toContain(SENTINEL)
  })

  it('asks for each item on a hidden prompt; Enter keeps what is set', async () => {
    const { fetch, calls } = server({
      [valuesPath('staging')]: () =>
        jsonResponse({ versionId: VERSION_ID, version: 4, pushId: null }, 200),
    })
    const asked: string[] = []
    const t = await testContext({ store: await store(), fetch })
    await runSharedSet(t.ctx, 'm365', {
      env: 'staging',
      isTTY: true,
      promptHidden: async question => {
        asked.push(question)
        return question.startsWith('M365_CLIENT_SECRET') ? SENTINEL : ''
      },
    })
    expect(asked).toHaveLength(3)
    expect(asked[2]).toContain('set — Enter keeps it')
    const put = calls.find(c => c.init.method === 'PUT')
    expect(JSON.parse(String(put?.init.body))).toEqual({
      values: { M365_CLIENT_SECRET: SENTINEL },
    })
    expect(everything(t)).toContain('nothing was pushed')
    expect(everything(t)).not.toContain(SENTINEL)
  })

  it('refuses a key the resource does not have — without printing its value', async () => {
    const { fetch, calls } = server()
    const t = await testContext({ store: await store(), fetch })
    const error = await captureError(
      runSharedSet(t.ctx, 'm365', {
        env: 'staging',
        isTTY: false,
        readStdin: async () => `OTHER_KEY=${SENTINEL}`,
      })
    )
    expect(error.message).toContain('OTHER_KEY')
    expect(String(error.message) + String(error.hint)).not.toContain(SENTINEL)
    expect(calls.some(c => c.init.method === 'PUT')).toBe(false)
  })

  it('refuses to send nothing', async () => {
    const { fetch, calls } = server()
    const t = await testContext({ store: await store(), fetch })
    const error = await captureError(
      runSharedSet(t.ctx, 'm365', { env: 'staging', isTTY: true, promptHidden: async () => '' })
    )
    expect(error.message).toContain('No values given')
    expect(calls.some(c => c.init.method === 'PUT')).toBe(false)
  })

  it('--wait (rotate) follows the push and exits 1 naming the apps it failed on', async () => {
    let reads = 0
    const { fetch } = server({
      [valuesPath('production')]: () =>
        jsonResponse({ versionId: VERSION_ID, version: 4, pushId: PUSH_ID }, 202),
      [pushPath]: () =>
        jsonResponse(
          ++reads < 2
            ? push()
            : push({
                status: 'partial',
                succeeded: 1,
                failed: 1,
                targets: [
                  target('expenses'),
                  target('crm', { status: 'failed', error: 'app_has_no_worker' }),
                ],
              })
        ),
    })
    const t = await testContext({ store: await store(), fetch })
    const error = await captureError(
      runSharedSet(t.ctx, 'm365', {
        env: 'production',
        wait: true,
        isTTY: false,
        readStdin: async () => `M365_CLIENT_SECRET=${SENTINEL}`,
        sleep: noSleep,
      })
    )
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.message).toContain('partly failed')
    expect(t.out.content()).toContain('crm — app_has_no_worker')
    expect(everything(t)).not.toContain(SENTINEL)
  })

  it('--wait with --json prints ONE document once the push is done', async () => {
    const { fetch } = server({
      [valuesPath('production')]: () =>
        jsonResponse({ versionId: VERSION_ID, version: 4, pushId: PUSH_ID }, 202),
      [pushPath]: () =>
        jsonResponse(push({ status: 'succeeded', succeeded: 2, targets: [target('expenses')] })),
    })
    const t = await testContext({ store: await store(), fetch, json: true })
    await runSharedSet(t.ctx, 'm365', {
      env: 'production',
      wait: true,
      isTTY: false,
      readStdin: async () => `M365_CLIENT_SECRET=${SENTINEL}`,
      sleep: noSleep,
    })
    const doc = JSON.parse(t.out.content())
    expect(doc.values.version).toBe(4)
    expect(doc.push.status).toBe('succeeded')
    expect(t.out.content()).not.toContain(SENTINEL)
  })
})

describe('shared pushes', () => {
  it('lists the history; --wait follows the running push to success', async () => {
    const { fetch } = server({
      [`${detailPath}/pushes`]: () => jsonResponse({ items: [pushSummary()] }),
      [pushPath]: () => jsonResponse(push({ status: 'succeeded', succeeded: 2 })),
    })
    const list = await testContext({ store: await store(), fetch })
    await runSharedPushes(list.ctx, 'm365')
    expect(list.out.content()).toContain('pushing')
    expect(list.out.content()).toContain('1 of 2 apps updated')
    const wait = await testContext({ store: await store(), fetch })
    await runSharedPushes(wait.ctx, 'm365', { wait: true, sleep: noSleep })
    expect(wait.out.content()).toContain('Pushed: 2 of 2 apps updated')
  })
})

describe('parseValuesInput', () => {
  const keys = ['A_KEY', 'B_KEY']
  it('reads a JSON object and KEY=value lines alike', () => {
    expect(parseValuesInput('{"A_KEY":"x","B_KEY":""}', keys)).toEqual({ A_KEY: 'x' })
    expect(parseValuesInput("A_KEY='a=b'\nB_KEY=c", keys)).toEqual({ A_KEY: 'a=b', B_KEY: 'c' })
  })
  it('rejects a line that is not KEY=value', () => {
    expect(() => parseValuesInput('just-a-value', keys)).toThrow('Line 1')
  })
})
