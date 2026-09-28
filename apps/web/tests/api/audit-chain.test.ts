/**
 * The audit hash chain (Launch P4, plan §4e): the canonical form is a wire format (golden
 * vectors), sealing is deterministic across batches and idempotent, concurrent seals do not fork,
 * verify finds a row altered with the append-only trigger disabled (as the table owner, inside a
 * transaction that is rolled back), and the export streams, filters, isolates tenants and
 * round-trips through the standalone verifier.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type AuditEvent,
  type AuditExportRow,
  auditExportRowSchema,
  auditVerifySchema,
} from '@launch/shared/launch-audit'
import { asc, eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { recordAudit, SYSTEM_ACTOR, toAuditEvent } from '@/api/services/launch/audit'
import {
  auditSeal,
  canonicalAuditJson,
  chainHash,
  runAuditSeal,
  sealTenant,
  verifyChain,
} from '@/api/services/launch/audit-chain'
import { CSV_HEADER, toCsvLine, toJsonLine } from '@/api/services/launch/audit-export'
import type { Database } from '@/db/client'
import { auditChain, auditEvents } from '@/db/schema'
import {
  bearerHeader,
  createTestApiKey,
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'

const db = setupTestDatabase()
const REPO_ROOT = path.resolve(__dirname, '../../../..')
const VERIFIER = path.join(REPO_ROOT, 'scripts/verify-audit-export.mjs')

async function owner() {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  return { user, tenant, cookie }
}

async function record(tenantId: string, n: number, action = 'test.step') {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push(
      await recordAudit(db, {
        tenantId,
        ...SYSTEM_ACTOR,
        action: `${action}_${i}`,
        summary: { after: { i, z: 'last', a: { y: 1, b: [2, 1] } } },
      })
    )
  }
  return out
}

/** The chain an independent reader would build: the events in `(at, id)` order, folded. */
async function expectedChain(tenantId: string) {
  const events = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.tenantId, tenantId))
    .orderBy(asc(auditEvents.at), asc(auditEvents.id))
  let prev = ''
  const out: { eventId: string; hash: string }[] = []
  for (const e of events) {
    prev = createHash('sha256')
      .update(prev + canonicalAuditJson(toAuditEvent(e)))
      .digest('hex')
    out.push({ eventId: e.id, hash: prev })
  }
  return out
}

async function chainOf(tenantId: string) {
  return db
    .select()
    .from(auditChain)
    .where(eq(auditChain.tenantId, tenantId))
    .orderBy(asc(auditChain.seq))
}

class Rollback extends Error {}

/** Run `fn` as the table owner with the append-only triggers off, then roll everything back. */
async function tampered<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
  let result: T | undefined
  try {
    await db.transaction(async tx => {
      await tx.execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`)
      await tx.execute(sql`ALTER TABLE audit_chain DISABLE TRIGGER audit_chain_append_only`)
      result = await fn(tx)
      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }
  return result as T
}

// ---- canonical form ---------------------------------------------------------------------------

const GOLDEN_EVENT: AuditEvent = {
  id: '0f0e0d0c-0b0a-4908-8706-050403020100',
  tenantId: '11111111-2222-4333-8444-555555555555',
  at: new Date('2026-09-28T10:00:00.123Z'),
  actorType: 'user',
  actorUserId: '99999999-8888-4777-8666-555555555555',
  actorEmail: 'ada@example.test',
  action: 'deploy.started',
  targetType: 'DeployTicket',
  targetId: 't-1',
  appId: null,
  summary: { after: { z: 1, a: 'é "q"', n: null, list: [{ b: 2, a: 1 }] }, before: {} },
  requestId: null,
  approvalId: null,
  ip: '203.0.113.9',
  userAgent: 'curl/8',
}

const GOLDEN_CANONICAL =
  '{"action":"deploy.started","actorEmail":"ada@example.test","actorType":"user",' +
  '"actorUserId":"99999999-8888-4777-8666-555555555555","appId":null,"approvalId":null,' +
  '"at":"2026-09-28T10:00:00.123Z","id":"0f0e0d0c-0b0a-4908-8706-050403020100",' +
  '"ip":"203.0.113.9","requestId":null,' +
  '"summary":{"after":{"a":"é \\"q\\"","list":[{"a":1,"b":2}],"n":null,"z":1},"before":{}},' +
  '"targetId":"t-1","targetType":"DeployTicket",' +
  '"tenantId":"11111111-2222-4333-8444-555555555555","userAgent":"curl/8"}'

describe('canonicalAuditJson', () => {
  it('is the documented form: sorted keys, nulls kept, ISO milliseconds, sorted summary', () => {
    expect(canonicalAuditJson(GOLDEN_EVENT)).toBe(GOLDEN_CANONICAL)
  })

  it('does not depend on key order, on Date vs ISO string, or on a column outside v1', async () => {
    const shuffled = Object.fromEntries(Object.entries(GOLDEN_EVENT).reverse()) as AuditEvent
    const asExported = { ...shuffled, at: '2026-09-28T10:00:00.123Z', seq: 4, hash: 'x' }
    expect(canonicalAuditJson(asExported)).toBe(GOLDEN_CANONICAL)
    expect(await chainHash('', asExported)).toBe(await chainHash('', GOLDEN_EVENT))
  })

  it('hash = sha256(prevHash + canonical), lower-case hex — a pinned vector', async () => {
    const expected = createHash('sha256')
      .update(`${'a'.repeat(64)}${GOLDEN_CANONICAL}`)
      .digest('hex')
    expect(await chainHash('a'.repeat(64), GOLDEN_EVENT)).toBe(expected)
    expect(await chainHash('', GOLDEN_EVENT)).toBe(
      '74e051590dc46f1da5dd92c409328fe28e926da6ef84f767dd89b0dbb5cc3ab5'
    )
  })

  it('the standalone verifier canonicalises byte for byte the same', async () => {
    const script = await import(VERIFIER)
    expect(script.canonicalAuditJson(JSON.parse(JSON.stringify(GOLDEN_EVENT)))).toBe(
      GOLDEN_CANONICAL
    )
  })
})

// ---- sealing ----------------------------------------------------------------------------------

describe('sealTenant', () => {
  it('is deterministic across batches: 7 events in batches of 3 = the independent fold', async () => {
    const { tenant } = await owner()
    await record(tenant.id, 7)
    expect(await sealTenant(db, tenant.id, { batch: 3 })).toEqual({ sealed: 3, through: 3 })
    expect(await sealTenant(db, tenant.id, { batch: 3 })).toEqual({ sealed: 3, through: 6 })
    expect(await sealTenant(db, tenant.id, { batch: 3 })).toEqual({ sealed: 1, through: 7 })

    const chain = await chainOf(tenant.id)
    const expected = await expectedChain(tenant.id)
    expect(chain.map(c => c.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(chain.map(c => ({ eventId: c.auditEventId, hash: c.hash }))).toEqual(expected)
    expect(chain[0]?.prevHash).toBe('')
    for (let i = 1; i < chain.length; i++) expect(chain[i]?.prevHash).toBe(chain[i - 1]?.hash)
  })

  it('is idempotent: a second run seals nothing and changes nothing', async () => {
    const { tenant } = await owner()
    await record(tenant.id, 3)
    await sealTenant(db, tenant.id)
    const before = await chainOf(tenant.id)
    expect(await sealTenant(db, tenant.id)).toEqual({ sealed: 0, through: 3 })
    expect(await chainOf(tenant.id)).toEqual(before)

    // New events continue the same chain.
    await record(tenant.id, 2, 'later')
    expect(await sealTenant(db, tenant.id)).toEqual({ sealed: 2, through: 5 })
    const after = await chainOf(tenant.id)
    expect(after[3]?.prevHash).toBe(before[2]?.hash)
    expect((await verifyChain(db, tenant.id)).ok).toBe(true)
  })

  it('concurrent seals do not fork: one chain, every event once, no gap', async () => {
    const { tenant } = await owner()
    await record(tenant.id, 25)
    const results = await Promise.all(
      Array.from({ length: 5 }, () => sealTenant(db, tenant.id, { batch: 10 }))
    )
    const sealed = results.reduce((n, r) => n + r.sealed, 0)
    expect(sealed).toBe(25)
    const chain = await chainOf(tenant.id)
    expect(chain.map(c => c.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    expect(new Set(chain.map(c => c.auditEventId)).size).toBe(25)
    expect(await verifyChain(db, tenant.id)).toMatchObject({ ok: true, checked: 25, unsealed: 0 })
  })

  it('keeps tenants apart: each tenant has its own chain from seq 1', async () => {
    const a = await owner()
    const b = await owner()
    await record(a.tenant.id, 2)
    await record(b.tenant.id, 3)
    await sealTenant(db, a.tenant.id)
    expect(await sealTenant(db, b.tenant.id)).toEqual({ sealed: 3, through: 3 })
    expect((await chainOf(a.tenant.id)).map(c => c.seq)).toEqual([1, 2])
    expect((await chainOf(b.tenant.id))[0]?.prevHash).toBe('')
  })

  it('the audit.seal task seals every tenant with unsealed events', async () => {
    const a = await owner()
    const b = await owner()
    await record(a.tenant.id, 2)
    await record(b.tenant.id, 1)
    const logs: unknown[] = []
    const logger = { info: (o: object) => logs.push(o), warn: (o: object) => logs.push(o) }
    const result = await runAuditSeal(db, logger)
    expect(result.failed).toBe(0)
    expect(result.sealed).toBeGreaterThanOrEqual(3)
    expect(await verifyChain(db, a.tenant.id)).toMatchObject({ ok: true, sealedThrough: 2 })
    expect(await verifyChain(db, b.tenant.id)).toMatchObject({ ok: true, sealedThrough: 1 })
    expect(auditSeal.name).toBe('audit.seal')
  })
})

// ---- verify -----------------------------------------------------------------------------------

describe('verifyChain', () => {
  it('before any seal: ok, nothing checked, everything unsealed', async () => {
    const { tenant } = await owner()
    await record(tenant.id, 2)
    expect(auditVerifySchema.parse(await verifyChain(db, tenant.id))).toMatchObject({
      ok: true,
      checked: 0,
      sealedThrough: null,
      unsealed: 2,
      firstBrokenSeq: null,
      firstBrokenEventId: null,
    })
  })

  it('counts events newer than the last seal as unsealed, not as a failure', async () => {
    const { tenant } = await owner()
    await record(tenant.id, 3)
    await sealTenant(db, tenant.id)
    await record(tenant.id, 1, 'fresh')
    expect(await verifyChain(db, tenant.id)).toMatchObject({
      ok: true,
      checked: 3,
      sealedThrough: 3,
      unsealed: 1,
    })
  })

  it('finds an event edited with the trigger disabled, at that seq', async () => {
    const { tenant } = await owner()
    const events = await record(tenant.id, 5)
    await sealTenant(db, tenant.id)
    const third = (await chainOf(tenant.id))[2]
    const result = await tampered(async tx => {
      await tx
        .update(auditEvents)
        .set({ summary: { after: { i: 99 } } })
        .where(eq(auditEvents.id, third?.auditEventId ?? ''))
      return verifyChain(tx, tenant.id)
    })
    expect(result).toMatchObject({
      ok: false,
      checked: 3,
      sealedThrough: 5,
      firstBrokenSeq: 3,
      firstBrokenEventId: third?.auditEventId,
    })
    // Rolled back: the real log is intact again.
    expect((await verifyChain(db, tenant.id)).ok).toBe(true)
    expect(events).toHaveLength(5)
  })

  it('finds a deleted event (its chain row cascades away — a gap) at the next seq', async () => {
    const { tenant } = await owner()
    await record(tenant.id, 4)
    await sealTenant(db, tenant.id)
    const chain = await chainOf(tenant.id)
    const result = await tampered(async tx => {
      await tx.delete(auditEvents).where(eq(auditEvents.id, chain[1]?.auditEventId ?? ''))
      return verifyChain(tx, tenant.id)
    })
    expect(result).toMatchObject({
      ok: false,
      firstBrokenSeq: 3,
      firstBrokenEventId: chain[2]?.auditEventId,
    })
  })

  it('finds a chain row whose hash was rewritten', async () => {
    const { tenant } = await owner()
    await record(tenant.id, 3)
    await sealTenant(db, tenant.id)
    const result = await tampered(async tx => {
      await tx
        .update(auditChain)
        .set({ hash: '0'.repeat(64) })
        .where(sql`${auditChain.tenantId} = ${tenant.id} AND ${auditChain.seq} = 2`)
      return verifyChain(tx, tenant.id)
    })
    expect(result).toMatchObject({ ok: false, firstBrokenSeq: 2 })
  })

  it("another tenant's tampering never shows in ours", async () => {
    const a = await owner()
    const b = await owner()
    await record(a.tenant.id, 2)
    await record(b.tenant.id, 2)
    await sealTenant(db, a.tenant.id)
    await sealTenant(db, b.tenant.id)
    const [aFirst] = await chainOf(a.tenant.id)
    const ours = await tampered(async tx => {
      await tx
        .update(auditEvents)
        .set({ action: 'forged' })
        .where(eq(auditEvents.id, aFirst?.auditEventId ?? ''))
      return [await verifyChain(tx, a.tenant.id), await verifyChain(tx, b.tenant.id)]
    })
    expect(ours[0]).toMatchObject({ ok: false, firstBrokenSeq: 1 })
    expect(ours[1]).toMatchObject({ ok: true, checked: 2 })
  })
})

// ---- export formats (golden) ------------------------------------------------------------------

const GOLDEN_ROW: AuditExportRow = {
  seq: 7,
  prevHash: 'cd'.repeat(32),
  hash: 'ab'.repeat(32),
  ...GOLDEN_EVENT,
}

describe('export formats', () => {
  it('JSON Lines: one object per line, the documented column order', () => {
    expect(toJsonLine(GOLDEN_ROW)).toBe(
      `{"seq":7,"prevHash":"${'cd'.repeat(32)}","hash":"${'ab'.repeat(32)}","id":"0f0e0d0c-0b0a-4908-8706-050403020100",` +
        '"tenantId":"11111111-2222-4333-8444-555555555555","at":"2026-09-28T10:00:00.123Z",' +
        '"actorType":"user","actorUserId":"99999999-8888-4777-8666-555555555555",' +
        '"actorEmail":"ada@example.test","action":"deploy.started","targetType":"DeployTicket",' +
        '"targetId":"t-1","appId":null,' +
        '"summary":{"after":{"z":1,"a":"é \\"q\\"","n":null,"list":[{"b":2,"a":1}]},"before":{}},' +
        '"requestId":null,"approvalId":null,"ip":"203.0.113.9","userAgent":"curl/8"}\n'
    )
    // …and it parses back to the contract.
    expect(auditExportRowSchema.parse(JSON.parse(toJsonLine(GOLDEN_ROW)))).toEqual(GOLDEN_ROW)
  })

  it('CSV: RFC 4180 quoting, nulls empty, summary as sorted JSON, formulas defused', () => {
    expect(CSV_HEADER).toBe(
      'seq,prevHash,hash,id,tenantId,at,actorType,actorUserId,actorEmail,action,targetType,targetId,' +
        'appId,summary,requestId,approvalId,ip,userAgent\r\n'
    )
    expect(toCsvLine(GOLDEN_ROW)).toBe(
      `7,${'cd'.repeat(32)},${'ab'.repeat(32)},0f0e0d0c-0b0a-4908-8706-050403020100,` +
        '11111111-2222-4333-8444-555555555555,2026-09-28T10:00:00.123Z,user,' +
        '99999999-8888-4777-8666-555555555555,ada@example.test,deploy.started,DeployTicket,t-1,,' +
        '"{""after"":{""a"":""é \\""q\\"""",""list"":[{""a"":1,""b"":2}],""n"":null,""z"":1},""before"":{}}",' +
        ',,203.0.113.9,curl/8\r\n'
    )
    const hostile = toCsvLine({
      ...GOLDEN_ROW,
      seq: null,
      prevHash: null,
      hash: null,
      actorEmail: '=HYPERLINK("http://x")',
      userAgent: 'a,b\nc',
    })
    expect(hostile.startsWith(',,,')).toBe(true)
    expect(hostile).toContain(`"'=HYPERLINK(""http://x"")"`)
    expect(hostile).toContain('"a,b\nc"')
  })
})

// ---- routes -----------------------------------------------------------------------------------

function parseLines(text: string): AuditExportRow[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => auditExportRowSchema.parse(JSON.parse(line)))
}

describe('GET /api/audit/verify', () => {
  it('owner: the verify result; member 403; anonymous 401', async () => {
    const { tenant, cookie } = await owner()
    await record(tenant.id, 2)
    await sealTenant(db, tenant.id)
    const res = await request('/api/audit/verify', { headers: cookie })
    expect(res.status).toBe(200)
    expect(auditVerifySchema.parse(await json(res))).toMatchObject({
      ok: true,
      checked: 2,
      sealedThrough: 2,
      unsealed: 0,
    })

    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, tenant.id, 'member')
    const forbidden = await request('/api/audit/verify', {
      headers: sessionCookieHeader(await createTestSession(db, member.id, tenant.id)),
    })
    expect(forbidden.status).toBe(403)
    expect(await json(forbidden)).toMatchObject({ statusCode: 403, code: 'forbidden' })
    expect((await request('/api/audit/verify')).status).toBe(401)
  })

  it('an API key (the CLI) reads it too', async () => {
    const { user, tenant } = await owner()
    const { key } = await createTestApiKey(db, tenant.id, user.id)
    const res = await request('/api/audit/verify', { headers: bearerHeader(key) })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ ok: true, checked: 0 })
  })
})

describe('GET /api/audit/export', () => {
  it('JSON Lines: sealed rows by seq with their hash, then unsealed with nulls; audited', async () => {
    const { user, tenant, cookie } = await owner()
    await record(tenant.id, 3)
    await sealTenant(db, tenant.id)
    await record(tenant.id, 1, 'unsealed')

    const res = await request('/api/audit/export', { headers: cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="audit-.+\.jsonl"/)
    const rows = parseLines(await res.text())
    // 3 sealed + 1 unsealed + the `audit.exported` row this very export recorded.
    expect(rows.map(r => r.seq)).toEqual([1, 2, 3, null, null])
    expect(rows.slice(0, 3).map(r => r.hash)).toEqual((await chainOf(tenant.id)).map(c => c.hash))
    expect(rows.slice(0, 3).map(r => r.prevHash)).toEqual(
      (await chainOf(tenant.id)).map(c => c.prevHash)
    )
    expect(rows[0]?.prevHash).toBe('')
    expect(rows[3]).toMatchObject({ action: 'unsealed_0', prevHash: null, hash: null })
    expect(rows[4]).toMatchObject({
      action: 'audit.exported',
      actorUserId: user.id,
      summary: { after: { format: 'json', appId: null, action: null, from: null, to: null } },
    })
  })

  it('round-trips: the export re-derives every hash, in-process and through the script', async () => {
    const { tenant, cookie } = await owner()
    await record(tenant.id, 6)
    await sealTenant(db, tenant.id)
    const text = await (await request('/api/audit/export', { headers: cookie })).text()
    const rows = parseLines(text)
    let prev = ''
    for (const row of rows.filter(r => r.seq !== null)) {
      expect(await chainHash(prev, row)).toBe(row.hash)
      prev = row.hash ?? ''
    }

    const dir = mkdtempSync(path.join(tmpdir(), 'audit-export-'))
    try {
      const file = path.join(dir, 'audit.jsonl')
      writeFileSync(file, text)
      expect(execFileSync(process.execPath, [VERIFIER, file], { encoding: 'utf8' })).toMatch(
        /^ok: 6 sealed row\(s\) verified through seq 6 .*; 1 unsealed/
      )
      // A tampered line fails with exit 1 at that seq.
      const lines = text.split('\n')
      lines[2] = (lines[2] ?? '').replace('test.step_2', 'test.step_X')
      writeFileSync(file, lines.join('\n'))
      let failure: { status?: number; stdout?: string } = {}
      try {
        execFileSync(process.execPath, [VERIFIER, file], { encoding: 'utf8' })
      } catch (error) {
        failure = error as typeof failure
      }
      expect(failure.status).toBe(1)
      expect(failure.stdout).toMatch(/^BROKEN at seq 3 /)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a filtered export verifies row by row from each prevHash (--filtered)', async () => {
    const { tenant, cookie } = await owner()
    for (const action of ['deploy.started', 'app.imported', 'deploy.finished', 'app.renamed']) {
      await recordAudit(db, { tenantId: tenant.id, ...SYSTEM_ACTOR, action })
    }
    await sealTenant(db, tenant.id)
    const text = await (
      await request('/api/audit/export?action=deploy', { headers: cookie })
    ).text()
    expect(parseLines(text).map(r => r.seq)).toEqual([1, 3])

    const run = (args: string[]) => {
      try {
        return {
          status: 0,
          stdout: execFileSync(process.execPath, [VERIFIER, ...args], { encoding: 'utf8' }),
        }
      } catch (error) {
        return error as { status: number; stdout: string }
      }
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'audit-filtered-'))
    try {
      const file = path.join(dir, 'deploys.jsonl')
      writeFileSync(file, text)
      // Strict by default: a gap is what a deleted row looks like.
      const strict = run([file])
      expect(strict.status).toBe(1)
      expect(strict.stdout).toMatch(/expected seq 2, found 3 .*pass --filtered/)
      // --filtered: each sealed row re-derives from its own prevHash.
      const filtered = run(['--filtered', file])
      expect(filtered.status).toBe(0)
      expect(filtered.stdout).toMatch(/^ok: 2 sealed row\(s\) verified one by one/)
      // A tampered row still fails, gap or no gap.
      writeFileSync(file, text.replace('deploy.finished', 'deploy.forged'))
      expect(run(['--filtered', file]).stdout).toMatch(/^BROKEN at seq 3 .*hash does not match/)
      // So does a forged prevHash on a row that follows its neighbour.
      const whole = await (await request('/api/audit/export', { headers: cookie })).text()
      const lines = whole.split('\n')
      const second = JSON.parse(lines[1] ?? '{}')
      lines[1] = JSON.stringify({ ...second, prevHash: 'f'.repeat(64) })
      writeFileSync(file, lines.join('\n'))
      expect(run([file]).stdout).toMatch(/^BROKEN at seq 2 .*prevHash is not seq 1's hash/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('CSV, and filters: appId, action prefix, from/to', async () => {
    const { tenant, cookie } = await owner()
    const appId = crypto.randomUUID()
    await recordAudit(db, { tenantId: tenant.id, ...SYSTEM_ACTOR, action: 'deploy.started', appId })
    await recordAudit(db, { tenantId: tenant.id, ...SYSTEM_ACTOR, action: 'deploy.finished' })
    await recordAudit(db, { tenantId: tenant.id, ...SYSTEM_ACTOR, action: 'deployx.other' })
    await sealTenant(db, tenant.id)

    const csv = await request('/api/audit/export?format=csv&action=deploy', { headers: cookie })
    expect(csv.headers.get('content-type')).toContain('text/csv')
    const lines = (await csv.text()).split('\r\n').filter(Boolean)
    expect(lines[0]).toBe(CSV_HEADER.trimEnd())
    expect(lines.slice(1).map(l => l.split(',')[9])).toEqual(['deploy.started', 'deploy.finished'])
    expect(lines.slice(1).map(l => l.split(',')[0])).toEqual(['1', '2'])

    const byApp = parseLines(
      await (await request(`/api/audit/export?appId=${appId}`, { headers: cookie })).text()
    )
    expect(byApp.map(r => r.action)).toEqual(['deploy.started'])

    const future = new Date(Date.now() + 60_000).toISOString()
    const none = parseLines(
      await (
        await request(`/api/audit/export?from=${encodeURIComponent(future)}`, { headers: cookie })
      ).text()
    )
    expect(none).toEqual([])
    const past = new Date(Date.now() - 60_000).toISOString()
    const before = parseLines(
      await (
        await request(`/api/audit/export?to=${encodeURIComponent(past)}`, { headers: cookie })
      ).text()
    )
    expect(before).toEqual([])
  })

  it('streams a log larger than one page, every row once and in order', async () => {
    const { tenant, cookie } = await owner()
    const values = Array.from({ length: 1203 }, (_, i) => ({
      tenantId: tenant.id,
      actorType: 'system' as const,
      action: `bulk.row_${i}`,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)),
    }))
    await db.insert(auditEvents).values(values)
    await sealTenant(db, tenant.id, { batch: 700 })
    const rows = parseLines(await (await request('/api/audit/export', { headers: cookie })).text())
    // 1203 bulk rows (700 sealed, 503 not) + the export's own audit row.
    expect(rows).toHaveLength(1204)
    expect(rows.slice(0, 700).map(r => r.seq)).toEqual(Array.from({ length: 700 }, (_, i) => i + 1))
    expect(new Set(rows.map(r => r.id)).size).toBe(1204)
    expect(rows.slice(700, 1203).map(r => r.action)).toEqual(
      Array.from({ length: 503 }, (_, i) => `bulk.row_${i + 700}`)
    )
  })

  it('isolates tenants, validates the query, and is admin+ only', async () => {
    const a = await owner()
    const b = await owner()
    await record(a.tenant.id, 2)
    await sealTenant(db, a.tenant.id)
    const theirs = parseLines(
      await (await request('/api/audit/export', { headers: b.cookie })).text()
    )
    expect(theirs.every(r => r.tenantId === b.tenant.id)).toBe(true)
    expect(theirs.map(r => r.action)).toEqual(['audit.exported'])

    const bad = await request('/api/audit/export?format=xml', { headers: a.cookie })
    expect(bad.status).toBe(400)
    expect(await json(bad)).toMatchObject({ statusCode: 400, code: 'validation_failed' })

    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, a.tenant.id, 'member')
    const forbidden = await request('/api/audit/export', {
      headers: sessionCookieHeader(await createTestSession(db, member.id, a.tenant.id)),
    })
    expect(forbidden.status).toBe(403)
    expect((await request('/api/audit/export')).status).toBe(401)
    // Neither refusal wrote an `audit.exported` row.
    const exported = await db
      .select()
      .from(auditEvents)
      .where(
        sql`${auditEvents.tenantId} = ${a.tenant.id} AND ${auditEvents.action} = 'audit.exported'`
      )
    expect(exported).toEqual([])
  })
})
