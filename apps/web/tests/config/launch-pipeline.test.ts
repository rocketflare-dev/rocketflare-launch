/**
 * Launch P2's pure contracts (`@launch/shared/launch-pipeline`, P2 settings in `launch-setup`):
 * the Workflow event types Cloudflare will accept, step lists with distinct keys, the create
 * request and the `launch-` slug rule, and the deployer protocol bodies.
 */
import {
  APP_LAUNCH_STEPS,
  APP_LAUNCH_VIEW_STEPS,
  APP_TEARDOWN_STEPS,
  APP_TEARDOWN_VIEW_STEPS,
  createAppRequestSchema,
  DEPLOY_FINISHED_EVENT,
  DEPLOYER_PROTOCOL_VERSIONS,
  deployStartSchema,
  deployUploadSchema,
  mergePipelineParts,
  newAppSlugProblem,
  type PipelineStep,
  SCAFFOLD_FINISHED_EVENT,
  teardownRequestSchema,
} from '@launch/shared/launch-pipeline'
import {
  DEFAULT_APP_CREATE_ROLE,
  DEFAULT_TEMPLATE_PIN,
  LAUNCH_SETTING_KEYS,
  SETUP_SETTING_KEYS,
  templatePinSchema,
} from '@launch/shared/launch-setup'
import { describe, expect, it } from 'vitest'

describe('Workflow event types', () => {
  // Golden: Cloudflare rejects anything else with `workflow.invalid_event_type` at RUNTIME — a `.`
  // is the classic mistake — and no fake binding would ever notice.
  it.each([SCAFFOLD_FINISHED_EVENT, DEPLOY_FINISHED_EVENT])('%s is a valid event type', type => {
    expect(type).toMatch(/^[A-Za-z0-9_-]{1,100}$/)
  })

  it('are pinned', () => {
    expect(SCAFFOLD_FINISHED_EVENT).toBe('scaffold_finished')
    expect(DEPLOY_FINISHED_EVENT).toBe('deploy_finished')
  })
})

describe('pipeline steps', () => {
  it.each([
    ['launch', APP_LAUNCH_STEPS],
    ['teardown', APP_TEARDOWN_STEPS],
  ] as const)('%s steps have distinct keys and labels', (_kind, steps) => {
    const keys = steps.map(s => s.step)
    expect(new Set(keys).size).toBe(keys.length)
    for (const s of steps) expect(s.label.length).toBeGreaterThan(0)
  })

  it('the launch runs in the plan’s order', () => {
    expect(APP_LAUNCH_STEPS.map(s => s.step)).toEqual([
      'reserve',
      'repo',
      'scaffold.start',
      'scaffold.wait',
      'scaffold.verify',
      'neon',
      'cloudflare',
      'oidc_client',
      'write_config',
      'placeholders',
      'github_env',
      'worker_secrets',
      'email',
      'deploy_staging.start',
      'deploy_staging.wait',
      'deploy_staging.check',
      'health',
      'production',
      'live',
    ])
  })
})

describe('the pipeline view’s rows', () => {
  it('reads each CI job’s start / wait / check as one row, every other step as its own', () => {
    expect(APP_LAUNCH_VIEW_STEPS.map(s => [s.step, s.label])).toEqual([
      ['reserve', 'Reserve the name'],
      ['repo', 'Create the repository'],
      ['scaffold', 'Scaffold from the template'],
      ['neon', 'Create the database'],
      ['cloudflare', 'Create storage, queue and KV'],
      ['oidc_client', 'Register sign-in'],
      ['write_config', 'Write the configuration'],
      ['placeholders', 'Create the Workers'],
      ['github_env', 'Set up GitHub environments'],
      ['worker_secrets', 'Set the Worker secrets'],
      ['email', 'Create the email key'],
      ['deploy_staging', 'Deploy staging'],
      ['health', 'Wait for staging to answer'],
      ['production', 'Production'],
      ['live', 'Live'],
    ])
    expect(APP_LAUNCH_VIEW_STEPS.find(s => s.step === 'scaffold')?.parts).toEqual([
      'scaffold.start',
      'scaffold.wait',
      'scaffold.verify',
    ])
    expect(APP_LAUNCH_VIEW_STEPS.find(s => s.step === 'deploy_staging')?.parts).toEqual([
      'deploy_staging.start',
      'deploy_staging.wait',
      'deploy_staging.check',
    ])
    // Every Workflow step is covered by exactly one row, in run order.
    expect(APP_LAUNCH_VIEW_STEPS.flatMap(s => s.parts)).toEqual(APP_LAUNCH_STEPS.map(s => s.step))
    // The teardown has no job: one row per step.
    expect(APP_TEARDOWN_VIEW_STEPS.map(s => s.step)).toEqual(APP_TEARDOWN_STEPS.map(s => s.step))
  })
})

describe('mergePipelineParts', () => {
  const row = { step: 'scaffold', label: 'Scaffold from the template' }
  const at = (s: number) => new Date(Date.UTC(2026, 8, 28, 10, 0, s))
  const part = (
    step: string,
    status: PipelineStep['status'],
    extra: Partial<PipelineStep> = {}
  ): PipelineStep => ({
    step,
    label: step,
    status,
    attempt: status === 'pending' ? 0 : 1,
    error: null,
    url: null,
    startedAt: null,
    finishedAt: null,
    ...extra,
  })
  const url = 'https://github.com/acme/shop/actions/runs/42'

  it('is pending before any part starts, and keeps the row’s own key and label', () => {
    const merged = mergePipelineParts(row, [part('s', 'pending'), part('w', 'pending')])
    expect(merged).toMatchObject({ step: 'scaffold', label: row.label, status: 'pending' })
    expect(merged).toMatchObject({ attempt: 0, error: null, url: null, startedAt: null })
  })

  it('is running while a part runs, with the wait’s run URL and the earliest start', () => {
    const merged = mergePipelineParts(row, [
      part('s', 'succeeded', { startedAt: at(0), finishedAt: at(2) }),
      part('w', 'running', { startedAt: at(3), url }),
      part('v', 'pending'),
    ])
    expect(merged).toMatchObject({ status: 'running', url, startedAt: at(0), finishedAt: null })
  })

  it('is running BETWEEN parts: one done, the next not started yet', () => {
    const merged = mergePipelineParts(row, [
      part('s', 'succeeded', { startedAt: at(0), finishedAt: at(2) }),
      part('w', 'pending'),
      part('v', 'pending'),
    ])
    expect(merged.status).toBe('running')
    expect(merged.finishedAt).toBeNull()
  })

  it('fails with the failed part’s error, its URL and the highest attempt', () => {
    const merged = mergePipelineParts(row, [
      part('s', 'succeeded', { attempt: 2, startedAt: at(0), finishedAt: at(2) }),
      part('w', 'failed', {
        attempt: 1,
        error: 'the GitHub Actions run ended “failure”',
        url,
        startedAt: at(3),
        finishedAt: at(9),
      }),
      part('v', 'pending'),
    ])
    expect(merged).toMatchObject({
      status: 'failed',
      error: 'the GitHub Actions run ended “failure”',
      url,
      attempt: 2,
      startedAt: at(0),
      finishedAt: at(9),
    })
  })

  it('takes the LATEST failure when more than one part failed', () => {
    const merged = mergePipelineParts(row, [
      part('s', 'failed', { error: 'older', finishedAt: at(2) }),
      part('w', 'failed', { error: 'newer', finishedAt: at(8) }),
    ])
    expect(merged.error).toBe('newer')
  })

  it('succeeds once every part has, finishing with the last part', () => {
    const merged = mergePipelineParts(row, [
      part('s', 'succeeded', { startedAt: at(0), finishedAt: at(2) }),
      part('w', 'succeeded', { startedAt: at(3), finishedAt: at(40), url }),
      part('v', 'succeeded', { startedAt: at(41), finishedAt: at(43) }),
    ])
    expect(merged).toMatchObject({
      status: 'succeeded',
      url,
      startedAt: at(0),
      finishedAt: at(43),
      error: null,
    })
  })

  it('is skipped when every part was', () => {
    const skipped = [part('s', 'skipped'), part('w', 'skipped'), part('v', 'skipped')]
    expect(mergePipelineParts(row, skipped).status).toBe('skipped')
  })
})

describe('creating an app', () => {
  it('forbids the launch- prefix on top of the registry’s slug rules', () => {
    expect(newAppSlugProblem('shop')).toBeNull()
    expect(newAppSlugProblem('launch-shop')).toMatch(/launch-/)
    expect(newAppSlugProblem('launch')).toMatch(/reserved/)
    expect(newAppSlugProblem('Shop')).toMatch(/lower-case/)
    expect(newAppSlugProblem('shop-staging')).toMatch(/staging/)
  })

  it('parses a request with defaults, and refuses a bad slug', () => {
    expect(createAppRequestSchema.parse({ slug: 'shop', displayName: ' Shop ' })).toEqual({
      slug: 'shop',
      displayName: 'Shop',
      options: { deployStaging: true },
    })
    expect(createAppRequestSchema.safeParse({ slug: 'launch-x', displayName: 'X' }).success).toBe(
      false
    )
    expect(teardownRequestSchema.parse({ confirmSlug: 'shop' })).toEqual({
      confirmSlug: 'shop',
      deleteRepo: false,
    })
  })
})

describe('the deployer protocol (DEPLOYER.md v1)', () => {
  it('speaks protocol 1, and start accepts any integer so the route can answer `supported`', () => {
    expect(DEPLOYER_PROTOCOL_VERSIONS).toEqual([1])
    expect(deployStartSchema.parse({ protocol: 2 })).toEqual({ protocol: 2 })
  })

  it('an upload body defaults assets to {}', () => {
    expect(
      deployUploadSchema.parse({
        protocol: 1,
        version: '1.0.0',
        main: 'worker.js',
        toml: 'name = "x"',
        modules: { 'worker.js': 'ZXhwb3J0' },
      }).assets
    ).toEqual({})
  })
})

describe('P2 settings', () => {
  it('the wizard edits only its own string keys; the P2 keys have code defaults', () => {
    // …then P3's two, both with code defaults too (`@launch/shared/launch-sessions`).
    expect(LAUNCH_SETTING_KEYS).toEqual([
      ...SETUP_SETTING_KEYS,
      'template_pin',
      'app_create_role',
      'session_policy',
      'sessions_paused',
      // Written by Launch itself: the cached public-URL check (`services/launch/public-url.ts`).
      'public_url_check',
    ])
    expect(templatePinSchema.parse(DEFAULT_TEMPLATE_PIN)).toEqual({
      repo: 'rocketflare-dev/rocketflare',
      tag: '0.15.1',
      commit: 'dcd47c298b08ab20d778ca81ad0b0dc64fda8ed7',
    })
    expect(DEFAULT_APP_CREATE_ROLE).toBe('admin')
  })
})
