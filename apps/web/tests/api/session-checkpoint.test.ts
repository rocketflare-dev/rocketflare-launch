/**
 * `checkpoint()` (Launch P3 slice 3d, plan §1.8): commit what Claude changed as Launch with the
 * person as co-author, push `session/<short>`, copy the transcript to R2, and record the head — run
 * against a scripted `FakeSandbox` and the test env's in-memory `FILES`.
 */
import { sessionBranchName } from '@launch/shared/launch-sessions'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  CHECKPOINT_ADD_COMMAND,
  CHECKPOINT_MAX_FILE_BYTES,
  CheckpointError,
  checkpoint,
  checkpointScanScript,
  claudeProjectDir,
  commitMessage,
  DEV_SETUP_GUARD_SCRIPT,
  PUSH_RETRY_DELAY_MS,
  SESSION_REPO_DIR,
  workflowsGuardScript,
} from '@/api/services/sessions/checkpoint'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import { SESSION_HOME } from '@/api/services/sessions/rocketflare-dev'
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

const BASE = 'b'.repeat(40)

async function setup(
  opts: { changes?: boolean; headSha?: string | null; kind?: 'session' | 'upgrade' } = {}
) {
  const env = createTestEnv()
  const cfg = loadConfig(env)
  const f = await seedSessionApp(db, createFakeCloud())
  const row = await insertSession(db, f, {
    status: 'working',
    turnCount: 3,
    claudeSessionId: CLAUDE_ID,
    headSha: opts.headSha ?? null,
    baseSha: BASE,
    kind: opts.kind ?? 'session',
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
      skipped: [],
    })

    const commands = sandbox.execs.map(e => e.command)
    expect(commands).toEqual([
      checkpointScanScript(),
      CHECKPOINT_ADD_COMMAND,
      DEV_SETUP_GUARD_SCRIPT,
      workflowsGuardScript(BASE),
      'git diff --cached --quiet',
      'git commit --no-verify --quiet -F /tmp/launch-commit-message.txt',
      'git rev-parse HEAD',
      `git push --quiet origin HEAD:refs/heads/${sessionBranchName(row.shortId)}`,
    ])
    for (const e of sandbox.execs) expect(e.opts?.cwd).toBe(SESSION_REPO_DIR)
    const commit = sandbox.execs[5]
    expect(commit?.opts?.env).toMatchObject({
      GIT_AUTHOR_NAME: 'Launch',
      GIT_AUTHOR_EMAIL: 'launch@localhost',
      GIT_COMMITTER_NAME: 'Launch',
      HOME: SESSION_HOME,
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

  it('a transient push failure ("Repository not found") is retried once after a pause', async () => {
    const { row, sandbox, deps, ref } = await setup()
    let pushes = 0
    sandbox.onExec('git push', () => {
      pushes += 1
      return pushes === 1
        ? {
            exitCode: 128,
            stderr:
              "remote: Repository not found.\nfatal: repository 'https://github.com/acme/app.git/' not found",
          }
        : { exitCode: 0 }
    })
    const delays: number[] = []
    const result = await checkpoint(db, { ...deps, sleep: async ms => void delays.push(ms) }, ref)
    expect(result.pushed).toBe(true)
    expect(pushes).toBe(2)
    expect(delays).toEqual([PUSH_RETRY_DELAY_MS])
    const [after] = await db.select().from(sessions).where(eq(sessions.id, row.id))
    expect(after?.headSha).toBe(HEAD)
  })

  it('a rejected push is not retried; a transient one that fails twice throws', async () => {
    const rejected = await setup()
    let pushes = 0
    rejected.sandbox.onExec('git push', () => {
      pushes += 1
      return { exitCode: 1, stderr: ' ! [rejected] HEAD -> session/abc (non-fast-forward)' }
    })
    const sleeps: number[] = []
    const sleep = async (ms: number) => void sleeps.push(ms)
    const err = await checkpoint(db, { ...rejected.deps, sleep }, rejected.ref).catch(e => e)
    expect(err).toBeInstanceOf(CheckpointError)
    expect(pushes).toBe(1)
    expect(sleeps).toEqual([])

    const down = await setup()
    down.sandbox.onExec('git push', {
      exitCode: 128,
      stderr: 'fatal: unable to access: The requested URL returned error: 502',
    })
    const err2 = await checkpoint(db, { ...down.deps, sleep }, down.ref).catch(e => e)
    expect(err2).toBeInstanceOf(CheckpointError)
    expect(err2.step).toBe('push')
    expect(down.sandbox.execs.filter(e => e.command.startsWith('git push'))).toHaveLength(2)
  })

  it('the offline [ai] toggle in the staged tomls fails the checkpoint loudly: no commit, no push', async () => {
    const { row, sandbox, deps, ref } = await setup()
    sandbox.onExec(DEV_SETUP_GUARD_SCRIPT, {
      stdout: 'ai-off\tapps/web/wrangler.toml\nai-off\tapps/web/wrangler.staging.toml\n',
    })
    const err = await checkpoint(db, deps, ref).catch(e => e)
    expect(err).toBeInstanceOf(CheckpointError)
    expect(err.step).toBe('guard')
    expect(err.output).toContain('apps/web/wrangler.toml, apps/web/wrangler.staging.toml')
    expect(err.output).toContain('Workers AI')
    const commands = sandbox.execs.map(e => e.command)
    expect(commands.some(c => c.startsWith('git commit'))).toBe(false)
    expect(commands.some(c => c.startsWith('git push'))).toBe(false)
    const [after] = await db.select().from(sessions).where(eq(sessions.id, row.id))
    expect(after?.headSha).toBeNull()
  })

  it('an ordinary session changing .github/workflows is refused before the commit, in words, and never pushes', async () => {
    const { row, sandbox, deps, ref } = await setup({ headSha: HEAD })
    sandbox.onExec(workflowsGuardScript(HEAD), { stdout: 'workflow\t.github/workflows/ci.yml\n' })
    const err = await checkpoint(db, deps, ref).catch(e => e)
    expect(err).toBeInstanceOf(CheckpointError)
    expect(err.step).toBe('workflows')
    // The message is the sentence alone (no "Checkpoint failed at …"): the person reads it.
    expect(err.message).toBe(
      "This change edits the app's CI workflows (.github/workflows/ci.yml). Coding sessions can't push workflow changes — an owner has to make that change, or run a kit upgrade. Nothing was saved: undo the change to that file (or ask Claude to), then the session saves again."
    )
    const commands = sandbox.execs.map(e => e.command)
    expect(commands.some(c => c.startsWith('git commit'))).toBe(false)
    expect(commands.some(c => c.startsWith('git push'))).toBe(false)
    const [after] = await db.select().from(sessions).where(eq(sessions.id, row.id))
    expect(after?.headSha).toBe(HEAD)
  })

  it('a kit upgrade session is not guarded: its workflow change commits and pushes', async () => {
    const { sandbox, deps, ref } = await setup({ kind: 'upgrade' })
    sandbox.onExec('.github/workflows', { stdout: 'workflow\t.github/workflows/ci.yml\n' })
    const result = await checkpoint(db, deps, ref)
    expect(result).toMatchObject({ committed: true, pushed: true })
    const commands = sandbox.execs.map(e => e.command)
    expect(commands.some(c => c.includes('.github/workflows'))).toBe(false)
    expect(commands.some(c => c.startsWith('git push'))).toBe(true)
  })

  it("GitHub's own workflows refusal (a change the guard did not see) is told in the same words", async () => {
    const { sandbox, deps, ref } = await setup()
    let pushes = 0
    sandbox.onExec('git push', () => {
      pushes += 1
      return {
        exitCode: 1,
        stderr:
          ' ! [remote rejected] HEAD -> session/waq6tezmnnf7 (refusing to allow a GitHub App to create or update workflow `.github/workflows/deploy.yml` without `workflows` permission)',
      }
    })
    const err = await checkpoint(db, { ...deps, sleep: async () => {} }, ref).catch(e => e)
    expect(err).toBeInstanceOf(CheckpointError)
    expect(err.step).toBe('workflows')
    expect(err.message).toMatch(
      /^This change edits the app's CI workflows \(\.github\/workflows\/deploy\.yml\)/
    )
    expect(pushes).toBe(1)
  })

  it('a file over the size limit is not staged: the save goes on and an error event names it', async () => {
    const { row, sandbox, deps, ref } = await setup()
    sandbox.onExec('git ls-files', {
      stdout: 'large\t6227020800\tcore\nlarge\t6120000000\tqemu_claude_20260928-101500_77.core\n',
    })
    const result = await checkpoint(db, deps, ref)
    expect(result).toMatchObject({ committed: true, pushed: true })
    expect(result.skipped).toEqual([
      { path: 'core', bytes: 6227020800 },
      { path: 'qemu_claude_20260928-101500_77.core', bytes: 6120000000 },
    ])
    // The scan ran first, and what was staged is the scan's pathspec (its exclusions).
    const commands = sandbox.execs.map(e => e.command)
    expect(commands.indexOf(CHECKPOINT_ADD_COMMAND)).toBe(1)
    const events = await listSessionEvents(db, row.tenantId, row.id)
    const error = events.find(e => e.type === 'error')
    const data = error?.data as { message: string; details: { maxFileBytes: number } }
    expect(data.message).toContain('Saved, but left out 2 files over 50 MB')
    expect(data.message).toContain('core (5.8 GB)')
    expect(data.message).toContain('qemu_claude_20260928-101500_77.core (5.7 GB)')
    expect(data.details.maxFileBytes).toBe(CHECKPOINT_MAX_FILE_BYTES)
  })

  it('no large file → no event', async () => {
    const { row, deps, ref } = await setup()
    await checkpoint(db, deps, ref)
    expect(await listSessionEvents(db, row.tenantId, row.id)).toEqual([])
  })

  it('a git command that times out throws a CheckpointError naming the step and the limit', async () => {
    const { row, sandbox, deps, ref } = await setup()
    sandbox.onExec(CHECKPOINT_ADD_COMMAND, () => {
      throw new Error('Command timed out after 120000ms')
    })
    const err = await checkpoint(db, deps, ref).catch(e => e)
    expect(err).toBeInstanceOf(CheckpointError)
    expect(err.step).toBe('add')
    expect(err.message).toBe(
      `Checkpoint failed at add: \`${CHECKPOINT_ADD_COMMAND}\` did not finish within 120 s (Command timed out after 120000ms)`
    )
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
