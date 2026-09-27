/**
 * `checkpoint()` (Launch P3 slice 3d, plan §1.8): commit what Claude changed as Launch with the
 * person as co-author, push `session/<short>`, copy the transcript to R2, and record the head — run
 * against a scripted `FakeSandbox` and the test env's in-memory `FILES`.
 */
import { sessionBranchName } from '@launch/shared/launch-sessions'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  CheckpointError,
  checkpoint,
  claudeProjectDir,
  commitMessage,
  SESSION_REPO_DIR,
} from '@/api/services/sessions/checkpoint'
import { createR2Storage } from '@/api/services/storage'
import { loadConfig } from '@/config'
import { sessions } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { FakeSandbox } from '../helpers/fake-sandbox'
import { insertSession, seedSessionApp } from '../helpers/sessions'
import { createTestEnv, stubs } from '../mocks/bindings'

const db = setupTestDatabase()
const HEAD = 'c'.repeat(40)
const CLAUDE_ID = '5f0c7d2e-1111-4222-8333-944455556666'

async function setup(opts: { changes?: boolean; headSha?: string | null } = {}) {
  const env = createTestEnv()
  const cfg = loadConfig(env)
  const f = await seedSessionApp(db, createFakeCloud())
  const row = await insertSession(db, f, {
    status: 'working',
    turnCount: 3,
    claudeSessionId: CLAUDE_ID,
    headSha: opts.headSha ?? null,
  })
  const sandbox = new FakeSandbox({ name: row.id })
    .onExec('git diff --cached --quiet', { exitCode: opts.changes === false ? 0 : 1 })
    .onExec('git rev-parse HEAD', { stdout: `${HEAD}\n` })
  await sandbox.writeFile(
    `/root/.claude/projects/${claudeProjectDir(SESSION_REPO_DIR)}/${CLAUDE_ID}.jsonl`,
    '{"type":"user"}\n{"type":"assistant"}\n'
  )
  const deps = { cfg, sandbox, storage: createR2Storage(env.FILES) }
  return { env, cfg, f, row, sandbox, deps, ref: { tenantId: f.tenant.id, sessionId: row.id } }
}

describe('checkpoint', () => {
  it('commits as Launch with the person as co-author, pushes the session branch and stores the transcript', async () => {
    const { env, f, row, sandbox, deps, ref } = await setup()
    const result = await checkpoint(db, deps, ref)
    expect(result).toEqual({
      committed: true,
      pushed: true,
      headSha: HEAD,
      transcriptKey: `sessions/${row.id}/claude.jsonl`,
    })

    const commands = sandbox.execs.map(e => e.command)
    expect(commands).toEqual([
      'git add -A',
      'git diff --cached --quiet',
      'git commit --no-verify --quiet -F /tmp/launch-commit-message.txt',
      'git rev-parse HEAD',
      `git push --quiet origin HEAD:refs/heads/${sessionBranchName(row.shortId)}`,
    ])
    for (const e of sandbox.execs) expect(e.opts?.cwd).toBe(SESSION_REPO_DIR)
    const commit = sandbox.execs[2]
    expect(commit?.opts?.env).toMatchObject({
      GIT_AUTHOR_NAME: 'Launch',
      GIT_AUTHOR_EMAIL: 'launch@localhost',
      GIT_COMMITTER_NAME: 'Launch',
    })
    const message = sandbox.files.get('/tmp/launch-commit-message.txt') ?? ''
    expect(message).toContain(`Launch session ${row.shortId}: turn 3`)
    expect(message).toMatch(new RegExp(`Co-Authored-By: .+ <${f.user.email}>`))

    const stored = stubs(env).files.objects.get(`sessions/${row.id}/claude.jsonl`)
    expect(new TextDecoder().decode(stored?.body)).toBe('{"type":"user"}\n{"type":"assistant"}\n')

    const [after] = await db.select().from(sessions).where(eq(sessions.id, row.id))
    expect(after?.headSha).toBe(HEAD)
    expect(after?.transcriptKey).toBe(`sessions/${row.id}/claude.jsonl`)
    expect(after?.status).toBe('working') // the caller owns the transition
  })

  it('nothing changed and the head is already pushed → no commit, no push', async () => {
    const { sandbox, deps, ref } = await setup({ changes: false, headSha: HEAD })
    const result = await checkpoint(db, { ...deps, storage: null }, ref)
    expect(result).toMatchObject({ committed: false, pushed: false, transcriptKey: null })
    expect(sandbox.execs.map(e => e.command)).not.toContain(expect.stringContaining('git push'))
    expect(sandbox.execs.some(e => e.command.startsWith('git commit'))).toBe(false)
  })

  it('nothing staged but an unpushed head (a retried checkpoint) → push only', async () => {
    const { sandbox, deps, ref } = await setup({ changes: false, headSha: 'd'.repeat(40) })
    const result = await checkpoint(db, deps, ref)
    expect(result).toMatchObject({ committed: false, pushed: true, headSha: HEAD })
    expect(sandbox.execs.some(e => e.command.startsWith('git push'))).toBe(true)
  })

  it('a refused push throws CheckpointError and leaves the row’s head alone', async () => {
    const { row, sandbox, deps, ref } = await setup()
    sandbox.onExec('git push', { exitCode: 1, stderr: 'remote: refused' })
    const err = await checkpoint(db, deps, ref).catch(e => e)
    expect(err).toBeInstanceOf(CheckpointError)
    expect(err.step).toBe('push')
    expect(err.output).toContain('remote: refused')
    const [after] = await db.select().from(sessions).where(eq(sessions.id, row.id))
    expect(after?.headSha).toBeNull()
  })

  it('another tenant’s session is not found', async () => {
    const { deps, row } = await setup()
    const err = await checkpoint(db, deps, {
      tenantId: crypto.randomUUID(),
      sessionId: row.id,
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })

  it('the message and the transcript path', () => {
    expect(claudeProjectDir('/workspace/app')).toBe('-workspace-app')
    expect(
      commitMessage(
        'Add  a\nheading',
        { shortId: 'abcdefghijkl' },
        { name: 'Ada <x>', email: 'ada@example.com' }
      )
    ).toBe(
      'Add a heading\n\nLaunch session abcdefghijkl\n\nCo-Authored-By: Ada x <ada@example.com>\n'
    )
    expect(commitMessage('T', { shortId: 'abcdefghijkl' }, null)).toBe(
      'T\n\nLaunch session abcdefghijkl\n'
    )
  })
})
