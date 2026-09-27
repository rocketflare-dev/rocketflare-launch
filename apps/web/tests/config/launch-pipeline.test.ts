/**
 * Launch P2's pure contracts (`@launch/shared/launch-pipeline`, P2 settings in `launch-setup`):
 * the Workflow event types Cloudflare will accept, step lists with distinct keys, the create
 * request and the `launch-` slug rule, and the deployer protocol bodies.
 */
import {
  APP_LAUNCH_STEPS,
  APP_TEARDOWN_STEPS,
  createAppRequestSchema,
  DEPLOY_FINISHED_EVENT,
  DEPLOYER_PROTOCOL_VERSIONS,
  deployStartSchema,
  deployUploadSchema,
  newAppSlugProblem,
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
    expect(LAUNCH_SETTING_KEYS).toEqual([...SETUP_SETTING_KEYS, 'template_pin', 'app_create_role'])
    expect(templatePinSchema.parse(DEFAULT_TEMPLATE_PIN)).toEqual({
      repo: 'rocketflare-dev/rocketflare',
      tag: '0.15.0',
      commit: 'c7fd5dfbf9cfbc197c60f1993f18d524ec28bd66',
    })
    expect(DEFAULT_APP_CREATE_ROLE).toBe('admin')
  })
})
