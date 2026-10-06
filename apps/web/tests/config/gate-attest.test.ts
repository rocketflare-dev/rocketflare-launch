/**
 * Issue #9, the pure halves of the gate attestation:
 *
 * - `worktreeTreeScript` under a REAL bash and git: the tree it prints is exactly the tree the
 *   checkpoint's commit then has (same exclude file, same big-file pathspec), any change to the
 *   working tree changes it, and the checkout's own index is never touched;
 * - `requiredCheckState`: the landing decides on `Gate`, not on the fold of every check, and
 *   Launch's own `launch/gate` is never CI;
 * - `launchGateCheckRun`: the `launch/gate` payload the kit's CI is written against.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  LAUNCH_GATE_CHECK,
  type PrChecks,
  requiredCheckState,
} from '@launch/shared/launch-sessions'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CHECKPOINT_ADD_COMMAND,
  checkpointScanScript,
  HEAD_TREE_COMMAND,
  worktreeTreeScript,
} from '@/api/services/sessions/checkpoint'
import { formatGateDuration, launchGateCheckRun } from '@/api/services/sessions/gate-attest'
import { foldChecks } from '@/api/services/sessions/repo/github-repo-host'

const hasGit = spawnSync('git', ['--version']).status === 0

describe.skipIf(!hasGit)('worktreeTreeScript under bash and git', () => {
  let dir = ''
  let scratch = ''
  // The scripts' fixed `/tmp` pathspec file is the container's alone; tests running in parallel
  // (`session-checkpoint-scan.test.ts`) would share it, so each test gets its own.
  const sh = (script: string) => {
    const own = script.replaceAll('/tmp/launch-checkpoint-pathspec', path.join(scratch, 'pathspec'))
    const result = spawnSync('bash', ['-c', own], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Launch',
        GIT_AUTHOR_EMAIL: 'launch@example.com',
        GIT_COMMITTER_NAME: 'Launch',
        GIT_COMMITTER_EMAIL: 'launch@example.com',
        GIT_CONFIG_NOSYSTEM: '1',
        HOME: dir,
      },
    })
    expect(result.status, result.stderr).toBe(0)
    return result.stdout
  }
  const tree = (maxBytes?: number) => {
    const match = /^tree=([0-9a-f]{40})$/m.exec(sh(worktreeTreeScript(maxBytes)))
    expect(match).not.toBeNull()
    return match?.[1] ?? ''
  }
  /** What the checkpoint does: the scan, `git add` over its pathspec, a commit. */
  const checkpoint = (maxBytes?: number) => {
    sh(checkpointScanScript(maxBytes))
    sh(CHECKPOINT_ADD_COMMAND)
    sh('git diff --cached --quiet || git commit --no-verify --quiet -m checkpoint')
    return sh(HEAD_TREE_COMMAND).trim()
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'launch-tree-'))
    scratch = mkdtempSync(path.join(tmpdir(), 'launch-tree-scratch-'))
    sh('git init --quiet -b main .')
    writeFileSync(path.join(dir, 'a.txt'), 'one\n')
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n')
    sh('git add -A && git commit --quiet -m base')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  })

  it('a clean checkout reads its HEAD tree', () => {
    expect(tree()).toBe(sh(HEAD_TREE_COMMAND).trim())
  })

  it('reads the tree the checkpoint then commits — edits, new files, deletions, never ignored ones', () => {
    writeFileSync(path.join(dir, 'a.txt'), 'two\n')
    writeFileSync(path.join(dir, 'b.txt'), 'new\n')
    sh('mkdir -p node_modules && echo x > node_modules/x.js')
    const before = sh('git status --porcelain')
    const gated = tree()
    // The checkout's own index is untouched: the changes are still unstaged.
    expect(sh('git status --porcelain')).toBe(before)
    expect(gated).not.toBe(sh(HEAD_TREE_COMMAND).trim())
    expect(checkpoint()).toBe(gated)
    // And after the commit the workspace reads the same tree again (a retried `ship.commit`).
    expect(tree()).toBe(gated)
  })

  it('a same-size edit in the same second as the last index write is still seen (racy git)', () => {
    // `one\n` → `two\n`: equal size, and written right after the base commit's index.
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, 'a.txt'), i % 2 === 0 ? 'two\n' : 'one\n')
      expect(tree()).toBe(checkpoint())
    }
  })

  it('any change after the read is a different tree', () => {
    writeFileSync(path.join(dir, 'a.txt'), 'two\n')
    const gated = tree()
    writeFileSync(path.join(dir, 'a.txt'), 'three\n')
    expect(tree()).not.toBe(gated)
    rmSync(path.join(dir, 'a.txt'))
    expect(tree()).not.toBe(gated)
  })

  it('leaves out what the checkpoint leaves out: a file over the size cap', () => {
    writeFileSync(path.join(dir, 'big.bin'), 'x'.repeat(2000))
    writeFileSync(path.join(dir, 'a.txt'), 'two\n')
    const gated = tree(1000)
    expect(checkpoint(1000)).toBe(gated)
  })
})

const check = (
  name: string,
  state: 'success' | 'failure' | 'pending',
  source: 'check_run' | 'status' = 'check_run'
): PrChecks['checks'][number] => ({ name, state, source, url: null })

describe('requiredCheckState', () => {
  it('a green Gate with a red optional check (evals) is success; the fold would say failure', () => {
    expect(requiredCheckState([check('Gate', 'success'), check('evals', 'failure')])).toBe(
      'success'
    )
  })

  it('a red Gate fails; a running one is pending', () => {
    expect(requiredCheckState([check('Gate', 'failure'), check('lint', 'success')])).toBe('failure')
    expect(requiredCheckState([check('Gate', 'pending')])).toBe('pending')
  })

  it('no Gate at all falls back to the fold over the other checks; nothing at all is none', () => {
    expect(requiredCheckState([check('lint', 'success'), check('test', 'success')])).toBe('success')
    expect(requiredCheckState([check('lint', 'success'), check('test', 'failure')])).toBe('failure')
    expect(requiredCheckState([check('lint', 'success'), check('test', 'pending')])).toBe('pending')
    expect(requiredCheckState([])).toBe('none')
  })

  it('Launch’s own launch/gate is never CI: not Gate, and not "something reported"', () => {
    expect(requiredCheckState([check(LAUNCH_GATE_CHECK, 'success')])).toBe('none')
    // Beside a red other check, launch/gate's success does not make the fold green.
    expect(
      requiredCheckState([check(LAUNCH_GATE_CHECK, 'success'), check('lint', 'failure')])
    ).toBe('failure')
    expect(
      requiredCheckState([check(LAUNCH_GATE_CHECK, 'success'), check('lint', 'pending')])
    ).toBe('pending')
  })

  it('a commit status named Gate counts like a check run', () => {
    expect(requiredCheckState([check('Gate', 'success', 'status')])).toBe('success')
  })
})

describe('foldChecks (the PR panel’s fold)', () => {
  const run = (name: string, conclusion = 'success') => ({
    id: 1,
    name,
    status: 'completed',
    conclusion,
    html_url: null,
  })
  const NOW = new Date('2026-10-06T00:00:00Z')

  it('leaves Launch’s own launch/gate out: a repo with no CI is none, not "1 passed"', () => {
    const alone = foldChecks([run(LAUNCH_GATE_CHECK)], null, 'abc', NOW)
    expect(alone).toMatchObject({ state: 'none', total: 0, passed: 0, checks: [] })
    const beside = foldChecks([run(LAUNCH_GATE_CHECK), run('Gate', 'failure')], null, 'abc', NOW)
    expect(beside).toMatchObject({ state: 'failure', total: 1, passed: 0, failed: 1 })
    expect(beside.checks.map(c => c.name)).toEqual(['Gate'])
  })
})

describe('launchGateCheckRun', () => {
  const TREE = 'c0ffee0123456789abcdef0123456789abcdef01'
  const run = launchGateCheckRun({
    tree: TREE,
    headSha: 'f'.repeat(40),
    sessionId: '7b0c5f0e-6a9d-4d41-9f5b-0a4f2f6f9e11',
    shortId: 'k3x9q2',
    attempt: 2,
    steps: [
      { step: 'lint', command: 'pnpm gate lint', durationMs: 12_345 },
      { step: 'typecheck', command: 'pnpm gate typecheck', durationMs: 61_000 },
      { step: 'test', command: 'pnpm gate test | tee x', durationMs: 245_400 },
    ],
  })

  it('is launch/gate, completed success, keyed by the tree', () => {
    expect(run).toMatchObject({
      name: 'launch/gate',
      headSha: 'f'.repeat(40),
      externalId: `tree:${TREE}`,
      conclusion: 'success',
    })
    expect(run.output.title).toBe('Launch gate passed: lint, typecheck, tests')
  })

  it('carries the steps as a markdown table and as JSON', () => {
    expect(run.output.summary).toContain('| Step | Command | Duration |')
    expect(run.output.summary).toContain('| lint | `pnpm gate lint` | 12.3 s |')
    expect(run.output.summary).toContain('| typecheck | `pnpm gate typecheck` | 1 min 01 s |')
    // A pipe in a command does not end its cell.
    expect(run.output.summary).toContain('`pnpm gate test \\| tee x`')
    expect(JSON.parse(run.output.text)).toEqual({
      tree: TREE,
      sessionId: '7b0c5f0e-6a9d-4d41-9f5b-0a4f2f6f9e11',
      attempt: 2,
      steps: [
        { step: 'lint', command: 'pnpm gate lint', durationMs: 12_345 },
        { step: 'typecheck', command: 'pnpm gate typecheck', durationMs: 61_000 },
        { step: 'test', command: 'pnpm gate test | tee x', durationMs: 245_400 },
      ],
    })
  })

  it('formats durations', () => {
    expect(formatGateDuration(0)).toBe('0.0 s')
    expect(formatGateDuration(59_940)).toBe('59.9 s')
    expect(formatGateDuration(600_000)).toBe('10 min 00 s')
  })
})
