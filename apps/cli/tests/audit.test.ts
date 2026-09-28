/**
 * `launch audit verify|export` (Launch P4, plan §4e), in-process: verify prints the chain's state
 * and exits 1 at a broken link; export forwards its filters, writes the body byte for byte to a
 * 0600 file (a one-line JSON Lines body included, which `api.ts` hands back parsed), refuses to
 * overwrite without `--force`, and maps 401/403 to exits 2/3.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditVerifySchema } from '@launch/shared/launch-audit'
import { Command } from 'commander'
import { afterEach, describe, expect, it } from 'vitest'
import { registerAuditCommands, runAuditExport, runAuditVerify } from '../src/commands/audit'
import { EXIT_ERROR, EXIT_FORBIDDEN, EXIT_NOT_LOGGED_IN, exitCodeFor } from '../src/errors'
import {
  captureError,
  jsonResponse,
  mockFetch,
  TENANT_ID,
  TEST_KEY,
  tempStore,
  testContext,
} from './helpers'

const SERVER = 'http://server.test'
const EVENT = '0f0e0d0c-0b0a-4908-8706-050403020100'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

async function loggedInStore() {
  const t = await tempStore()
  cleanups.push(t.cleanup)
  await t.store.save({ serverUrl: SERVER, apiKey: TEST_KEY, tenantId: TENANT_ID, tenantName: 'A' })
  return t.store
}

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'launch-audit-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const verified = (over: Record<string, unknown> = {}) => ({
  ok: true,
  checked: 12,
  sealedThrough: 12,
  unsealed: 3,
  firstBrokenSeq: null,
  firstBrokenEventId: null,
  verifiedAt: '2026-09-28T10:00:00.000Z',
  ...over,
})

function textResponse(body: string, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': contentType } })
}

describe('audit verify', () => {
  it('prints an intact chain and exits 0; --json prints the verify result', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({ '/api/audit/verify': () => jsonResponse(verified()) })
    const { ctx, out } = await testContext({ store, fetch })
    await runAuditVerify(ctx)
    expect(calls[0]?.url.pathname).toBe('/api/audit/verify')
    expect(out.content()).toContain('12 sealed event(s) verified, through seq 12')
    expect(out.content()).toContain('3 event(s) not sealed yet')

    const json = await testContext({ store, fetch, json: true })
    await runAuditVerify(json.ctx)
    expect(auditVerifySchema.parse(JSON.parse(json.out.content()))).toMatchObject({
      ok: true,
      checked: 12,
    })
  })

  it('a broken chain prints the first broken link and exits 1', async () => {
    const store = await loggedInStore()
    const broken = verified({ ok: false, checked: 5, firstBrokenSeq: 5, firstBrokenEventId: EVENT })
    const { fetch } = mockFetch({ '/api/audit/verify': () => jsonResponse(broken) })
    const { ctx, out } = await testContext({ store, fetch })
    const error = await captureError(runAuditVerify(ctx))
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.message).toContain('seq 5')
    expect(out.content()).toContain(`BROKEN at seq 5 (event ${EVENT})`)
  })

  it('403 → exit 3; no key → exit 2', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({
      '/api/audit/verify': () =>
        jsonResponse({ error: 'Forbidden', statusCode: 403, code: 'forbidden' }, 403),
    })
    const { ctx } = await testContext({ store, fetch })
    expect(exitCodeFor(await captureError(runAuditVerify(ctx)))).toBe(EXIT_FORBIDDEN)

    const empty = await tempStore()
    cleanups.push(empty.cleanup)
    const anon = await testContext({ store: empty.store })
    expect(exitCodeFor(await captureError(runAuditVerify(anon.ctx)))).toBe(EXIT_NOT_LOGGED_IN)
  })
})

const LINE_1 = `{"seq":1,"hash":"${'a'.repeat(64)}","id":"${EVENT}","action":"app.imported"}`
const LINE_2 = `{"seq":null,"hash":null,"id":"${EVENT}","action":"audit.exported"}`

describe('audit export', () => {
  it('forwards the filters and writes the JSON Lines body verbatim, 0600', async () => {
    const store = await loggedInStore()
    const body = `${LINE_1}\n${LINE_2}\n`
    const { fetch, calls } = mockFetch({
      '/api/audit/export': () => textResponse(body, 'application/x-ndjson'),
    })
    const out = join(await tempDir(), 'audit.jsonl')
    const { ctx, out: output } = await testContext({ store, fetch })
    await runAuditExport(ctx, {
      out,
      format: 'json',
      app: EVENT,
      action: 'deploy',
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
    })
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      format: 'json',
      appId: EVENT,
      action: 'deploy',
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
    })
    expect(await readFile(out, 'utf8')).toBe(body)
    expect((await stat(out)).mode & 0o777).toBe(0o600)
    expect(output.content()).toContain('Wrote 2 audit event(s)')
    expect(output.content()).toContain('verify-audit-export.mjs')
  })

  it('a one-line export (parsed as JSON by the client) is written back byte for byte', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({
      '/api/audit/export': () => textResponse(`${LINE_1}\n`, 'application/x-ndjson'),
    })
    const out = join(await tempDir(), 'one.jsonl')
    const { ctx } = await testContext({ store, fetch, json: true })
    await runAuditExport(ctx, { out })
    expect(await readFile(out, 'utf8')).toBe(`${LINE_1}\n`)
  })

  it('CSV: counts rows under the header; --json prints the summary', async () => {
    const store = await loggedInStore()
    const csv = 'seq,hash,id\r\n1,abc,x\r\n2,def,y\r\n'
    const { fetch, calls } = mockFetch({
      '/api/audit/export': () => textResponse(csv, 'text/csv'),
    })
    const out = join(await tempDir(), 'audit.csv')
    const { ctx, out: output } = await testContext({ store, fetch, json: true })
    await runAuditExport(ctx, { out, format: 'csv' })
    expect(calls[0]?.url.searchParams.get('format')).toBe('csv')
    expect(await readFile(out, 'utf8')).toBe(csv)
    expect(JSON.parse(output.content())).toEqual({
      file: out,
      format: 'csv',
      rows: 2,
      bytes: csv.length,
    })
  })

  it('streams: counts lines across chunk boundaries and hints --filtered for a filtered export', async () => {
    const store = await loggedInStore()
    const encoder = new TextEncoder()
    // Split mid-line and between the \r and \n of a CSV record end.
    const parts = ['seq,hash,id\r', '\n1,abc,"a\nb"\r\n2,d', 'ef,y\r\n']
    const stream = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const part of parts) controller.enqueue(encoder.encode(part))
            controller.close()
          },
        }),
        { headers: { 'content-type': 'text/csv' } }
      )
    const { fetch } = mockFetch({ '/api/audit/export': stream })
    const dir = await tempDir()
    const { ctx, out: output } = await testContext({ store, fetch, json: true })
    await runAuditExport(ctx, { out: join(dir, 'a.csv'), format: 'csv' })
    expect(await readFile(join(dir, 'a.csv'), 'utf8')).toBe(parts.join(''))
    expect(JSON.parse(output.content())).toMatchObject({ rows: 2, bytes: parts.join('').length })

    const json = mockFetch({
      '/api/audit/export': () => textResponse(`${LINE_1}\n${LINE_2}`, 'application/x-ndjson'),
    })
    const plain = await testContext({ store, fetch: json.fetch })
    await runAuditExport(plain.ctx, { out: join(dir, 'd.jsonl'), action: 'deploy' })
    expect(plain.out.content()).toContain('Wrote 2 audit event(s)')
    expect(plain.out.content()).toContain('verify-audit-export.mjs --filtered ')
  })

  it('a download cut off mid-body leaves no file behind', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({
      '/api/audit/export': () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`${LINE_1}\n`))
              controller.error(new Error('socket hang up'))
            },
          })
        ),
    })
    const out = join(await tempDir(), 'cut.jsonl')
    const { ctx } = await testContext({ store, fetch })
    const error = await captureError(runAuditExport(ctx, { out }))
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.message).toContain('cut off')
    await expect(stat(out)).rejects.toThrow()
  })

  it('refuses to overwrite without --force', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({
      '/api/audit/export': () => textResponse(`${LINE_1}\n${LINE_2}\n`, 'application/x-ndjson'),
    })
    const out = join(await tempDir(), 'audit.jsonl')
    await writeFile(out, 'keep me')
    const { ctx } = await testContext({ store, fetch })
    const error = await captureError(runAuditExport(ctx, { out }))
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.message).toContain('already exists')
    expect(await readFile(out, 'utf8')).toBe('keep me')

    await runAuditExport(ctx, { out, force: true })
    expect(await readFile(out, 'utf8')).toBe(`${LINE_1}\n${LINE_2}\n`)
  })

  it('403 → exit 3 and nothing is written', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({
      '/api/audit/export': () =>
        jsonResponse({ error: 'Forbidden', statusCode: 403, code: 'forbidden' }, 403),
    })
    const out = join(await tempDir(), 'audit.jsonl')
    const { ctx } = await testContext({ store, fetch })
    expect(exitCodeFor(await captureError(runAuditExport(ctx, { out })))).toBe(EXIT_FORBIDDEN)
    await expect(stat(out)).rejects.toThrow()
  })
})

describe('registerAuditCommands', () => {
  it('adds `audit verify` and `audit export` (with a required --out and a checked --format)', () => {
    const program = new Command()
    registerAuditCommands(program, handler => async () => handler as never)
    const audit = program.commands.find(c => c.name() === 'audit')
    expect(audit?.commands.map(c => c.name()).sort()).toEqual(['export', 'verify'])
    const exportCmd = audit?.commands.find(c => c.name() === 'export')
    const out = exportCmd?.options.find(o => o.long === '--out')
    expect(out?.mandatory).toBe(true)
    const format = exportCmd?.options.find(o => o.long === '--format')
    expect(format?.defaultValue).toBe('json')
    expect(() => format?.parseArg?.('xml', undefined)).toThrow(/--format must be one of/)
  })
})
