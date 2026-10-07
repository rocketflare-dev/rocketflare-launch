/**
 * A kit upgrade session takes no PERSON's input (its push token carries `workflows: write`, so
 * nobody may steer it): every route that adds one — a message (`/turns`, queued or interrupting),
 * withdrawing what waits, an image, a preview screenshot for one — answers 403
 * `upgrade_session_read_only` with the shared sentence, and writes nothing. An ordinary session's
 * same calls go through. Launch's own input (`requestTurn` with no sender: the upgrade prompt, a
 * ship's fix turns) still lands, and Ship / End / Cancel stay the owner's to use.
 */
import {
  UPGRADE_SESSION_READ_ONLY_CODE,
  UPGRADE_SESSION_READ_ONLY_MESSAGE,
} from '@launch/shared/launch-sessions'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { requestTurn } from '@/api/services/sessions/chat'
import { type SessionRow, sessions } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { json, request } from '../helpers/request'
import { insertSession, seedSessionApp } from '../helpers/sessions'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9])
const BROWSER = { fetch: async () => new Response(null, { status: 501 }) }

function env(): TestEnv {
  return createTestEnv({
    SESSION_PREVIEW_URL: 'http://{label}.localhost:3001',
    BROWSER,
  } as never)
}

const post = (path: string, cookie: Record<string, string>, e: TestEnv, body?: unknown) =>
  request(path, { method: 'POST', headers: cookie }, { env: e, json: body ?? {} })

function upload(sessionId: string, cookie: Record<string, string>, e: TestEnv) {
  const form = new FormData()
  form.append('file', new File([PNG], 'shot.png', { type: 'image/png' }))
  return request(
    `/api/sessions/${sessionId}/attachments`,
    { method: 'POST', headers: cookie, body: form },
    { env: e }
  )
}

async function reload(row: SessionRow): Promise<SessionRow> {
  const [latest] = await db.select().from(sessions).where(eq(sessions.id, row.id))
  if (!latest) throw new Error('gone')
  return latest
}

async function setup(kind: 'session' | 'upgrade', overrides: Partial<SessionRow> = {}) {
  const f = await seedSessionApp(db, createFakeCloud(), { role: 'owner' })
  const row = await insertSession(db, f, { status: 'ready', kind, ...overrides })
  const e = env()
  await stubs(e).sessionWorkflow?.create({ id: row.instanceId ?? row.id })
  return { f, row, e }
}

/** Each route that carries a person's input, called on `row`. */
const INPUT_ROUTES: [
  string,
  (row: SessionRow, cookie: Record<string, string>, e: TestEnv) => Promise<Response>,
][] = [
  [
    'POST /turns',
    (row, cookie, e) =>
      post(`/api/sessions/${row.id}/turns`, cookie, e, { message: 'Skip the notes' }),
  ],
  [
    'POST /turns (interrupt)',
    (row, cookie, e) =>
      post(`/api/sessions/${row.id}/turns`, cookie, e, {
        message: 'Stop and do X',
        mode: 'interrupt',
      }),
  ],
  ['POST /attachments', (row, cookie, e) => upload(row.id, cookie, e)],
]

describe('a kit upgrade session refuses a person’s input', () => {
  for (const [name, call] of INPUT_ROUTES) {
    it(`${name}: 403 upgrade_session_read_only, nothing written`, async () => {
      const { f, row, e } = await setup('upgrade')
      const res = await call(row, f.cookie, e)
      expect(res.status).toBe(403)
      expect(await json(res)).toMatchObject({
        error: UPGRADE_SESSION_READ_ONLY_MESSAGE,
        statusCode: 403,
        code: UPGRADE_SESSION_READ_ONLY_CODE,
      })
      const after = await reload(row)
      expect(after.pendingMessage).toBeNull()
      expect(after.cancelRequestedAt).toBeNull()
      expect(stubs(e).queue.messages).toEqual([])
      expect(stubs(e).files.objects.size).toBe(0)
      expect(stubs(e).sessionWorkflow?.events ?? []).toEqual([])
    })

    it(`${name}: an ordinary session goes through`, async () => {
      const { f, row, e } = await setup('session')
      const res = await call(row, f.cookie, e)
      expect(res.status, await res.clone().text()).toBeLessThan(300)
    })
  }

  it('POST /queued/withdraw: Launch’s waiting prompt cannot be taken back (403); an ordinary one can', async () => {
    const upgrade = await setup('upgrade', { status: 'working', pendingMessage: 'Upgrade the kit' })
    const refused = await post(
      `/api/sessions/${upgrade.row.id}/queued/withdraw`,
      upgrade.f.cookie,
      upgrade.e
    )
    expect(refused.status).toBe(403)
    expect(await json(refused)).toMatchObject({ code: UPGRADE_SESSION_READ_ONLY_CODE })
    expect((await reload(upgrade.row)).pendingMessage).toBe('Upgrade the kit')

    const ordinary = await setup('session', { status: 'working', pendingMessage: 'Later' })
    const ok = await post(
      `/api/sessions/${ordinary.row.id}/queued/withdraw`,
      ordinary.f.cookie,
      ordinary.e
    )
    expect(ok.status).toBe(200)
    expect((await reload(ordinary.row)).pendingMessage).toBeNull()
  })

  it('Launch’s own input still lands (no sender), and Ship stays the owner’s', async () => {
    const { f, row, e } = await setup('upgrade')
    const queued = await requestTurn(db, row, { message: 'Fix the gate', attachments: [] })
    expect(queued.pendingMessage).toBe('Fix the gate')
    await db.update(sessions).set({ pendingMessage: null }).where(eq(sessions.id, row.id))

    const ship = await post(`/api/sessions/${row.id}/ship`, f.cookie, e)
    expect(ship.status).toBe(202)
  })
})
