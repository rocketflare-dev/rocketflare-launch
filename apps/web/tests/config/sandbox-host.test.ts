/**
 * The remote sandbox host — the configuration half (no database):
 *
 * - the sandbox host Worker's toml: no public URL, the SAME image, instance type and
 *   compatibility date as Launch's `SessionSandbox`, and exactly the binding `SandboxHostEnv` names;
 * - the dev config `pnpm dev` generates: `wrangler.toml` untouched plus the remote binding — so the
 *   two deployed tomls never carry it — and the plan that keeps BOTH hosts available whenever it
 *   can (Docker down, not logged in, host not deployed);
 * - the retired `SESSION_SANDBOX_HOST` var is no longer config (it is a platform setting);
 * - `defaultSessionPorts` picks `RemoteSandbox` + the `host` egress mode only when asked, and a
 *   missing binding fails by name;
 * - the host Worker's own outbound handlers, and nothing credential-shaped written into a container
 *   (no credential file, no git credential helper);
 * - the `host` mode's turn meter and the transcript's scrubbing of GitHub tokens.
 */
import fs from 'node:fs'
import path from 'node:path'
import TOML from '@iarna/toml'
import { DEFAULT_CLAUDE_CODE_MODEL, DEFAULT_CODEX_MODEL } from '@launch/shared/launch-sessions'
import { describe, expect, it } from 'vitest'
import type { ClaudeLineMapping } from '@/api/services/sessions/claude-stream'
import { createClaudeStreamParser } from '@/api/services/sessions/claude-stream'
import { HostEgress } from '@/api/services/sessions/egress/host'
import { redactModelKeyText } from '@/api/services/sessions/model-key'
import {
  defaultSessionPorts,
  egressFor,
  PROXIED_EGRESS,
  sandboxHostOf,
} from '@/api/services/sessions/ports'
import { createCodexStreamParser } from '@/api/services/sessions/runtimes/codex/stream'
import { CloudflareSandbox } from '@/api/services/sessions/sandbox/cloudflare-sandbox'
import { RemoteSandbox } from '@/api/services/sessions/sandbox/remote-sandbox'
import { createTurnMeter } from '@/api/services/sessions/turn-meter'
import type { AppBindings } from '@/api/types'
import { loadConfig } from '@/config'
import type { Database } from '@/db/client'
import { HostedSessionSandbox } from '@/sandbox-host/hosted-session-sandbox'
import {
  devSandboxPlan,
  legacyRemoteRequested,
  REMOTE_DEV_CONFIG,
  remoteDevConfigText,
  SANDBOX_HOST_SERVICE,
  whoamiLoggedIn,
} from '../../../../scripts/lib/dev-remote-sandbox.mjs'
import { claudeStreamJsonLines } from '../helpers/fake-anthropic'
import { createTestEnv } from '../mocks/bindings'

type Toml = Record<string, unknown>
type Row = Record<string, unknown>

const WEB_DIR = path.resolve(__dirname, '../..')
const text = (file: string) => fs.readFileSync(path.join(WEB_DIR, file), 'utf8')
const launch = TOML.parse(text('wrangler.toml')) as Toml
const host = TOML.parse(text('wrangler.sandbox-host.toml')) as Toml
const rows = (t: Toml, key: string) => (t[key] as Row[] | undefined) ?? []
const doBindings = (t: Toml) =>
  ((t.durable_objects as { bindings?: Row[] } | undefined)?.bindings ?? []) as Row[]

describe('wrangler.sandbox-host.toml', () => {
  it('has no public URL: only a service binding in the account reaches it', () => {
    expect(host.name).toBe(SANDBOX_HOST_SERVICE)
    expect(host.workers_dev).toBe(false)
    expect(host.preview_urls).toBe(false)
    expect(host.routes).toBeUndefined()
    expect(host.route).toBeUndefined()
  })

  it('runs the same image, instance type and runtime as Launch’s own sessions', () => {
    const [ours] = rows(launch, 'containers')
    const [theirs] = rows(host, 'containers')
    expect(theirs?.image).toBe(ours?.image)
    expect(theirs?.instance_type).toBe(ours?.instance_type)
    expect(host.compatibility_date).toBe(launch.compatibility_date)
    expect(host.compatibility_flags).toEqual(launch.compatibility_flags)
  })

  it('declares exactly SESSION_SANDBOX → HostedSessionSandbox, SQLite-backed', () => {
    expect(rows(host, 'containers').map(c => c.class_name)).toEqual(['HostedSessionSandbox'])
    expect(doBindings(host)).toEqual([
      { name: 'SESSION_SANDBOX', class_name: 'HostedSessionSandbox' },
    ])
    expect(rows(host, 'migrations')).toEqual([
      { tag: 'v1', new_sqlite_classes: ['HostedSessionSandbox'] },
    ])
    for (const key of ['services', 'kv_namespaces', 'r2_buckets', 'workflows']) {
      expect(host[key], key).toBeUndefined()
    }
    // One var, the egress switch — the same value as Launch's own tomls.
    expect(host.vars).toEqual({ SESSION_EGRESS: 'open' })
    expect((launch.vars as Record<string, unknown>).SESSION_EGRESS).toBe('open')
  })

  it('the deployed tomls never carry the dev binding', () => {
    for (const file of ['wrangler.toml', 'wrangler.staging.toml']) {
      expect(text(file)).not.toContain('SANDBOX_HOST')
    }
  })
})

describe('the dev config pnpm dev generates', () => {
  const generated = remoteDevConfigText(text('wrangler.toml'))
  const parsed = TOML.parse(generated) as Toml

  it('is wrangler.toml plus the remote service binding, and nothing else', () => {
    expect(generated).toContain(text('wrangler.toml').trimEnd())
    expect(parsed.services).toEqual([
      { binding: 'SANDBOX_HOST', service: SANDBOX_HOST_SERVICE, remote: true },
    ])
    const { services: _services, ...rest } = parsed
    expect(rest).toEqual(TOML.parse(text('wrangler.toml')))
  })

  it('is git-ignored', () => {
    const ignore = fs.readFileSync(path.join(WEB_DIR, '../../.gitignore'), 'utf8')
    expect(ignore).toContain(`apps/web/${REMOTE_DEV_CONFIG}`)
  })
})

describe('pnpm dev makes both sandbox hosts available whenever it can', () => {
  it('both available: the generated config (the remote binding) AND local containers', () => {
    const plan = devSandboxPlan({ docker: true, remote: 'ok' })
    expect(plan.writeRemoteConfig).toBe(true)
    expect(plan.args).toEqual([
      '-c',
      REMOTE_DEV_CONFIG,
      '--var',
      'DEV_LOCAL_CONTAINERS:on',
      '--var',
      'DEV_SANDBOX_HOST_STATUS:ok',
    ])
    expect(plan.args).not.toContain('--enable-containers=false')
    expect(plan.lines.join('\n')).toMatch(/containers \(local Docker\) available/)
    expect(plan.lines.join('\n')).toMatch(/remote sandbox host \(launch-sandbox-dev\) available/)
  })

  it('Docker not running: starts without local containers, and tells the Worker and the developer', () => {
    const plan = devSandboxPlan({ docker: false, remote: 'ok' })
    expect(plan.args).toContain('--enable-containers=false')
    expect(plan.args).toContain('DEV_LOCAL_CONTAINERS:off')
    expect(plan.writeRemoteConfig).toBe(true)
    expect(plan.lines[0]).toMatch(/Docker is not running/)
  })

  it('the remote binding cannot be declared: starts on wrangler.toml without it, saying why', () => {
    for (const [remote, why] of [
      ['not_logged_in', /wrangler login/],
      ['not_deployed', /not deployed/],
      ['off', /DEV_REMOTE_SANDBOX=0/],
    ] as const) {
      const plan = devSandboxPlan({ docker: true, remote })
      expect(plan.writeRemoteConfig).toBe(false)
      expect(plan.args).not.toContain('-c')
      expect(plan.args).toContain(`DEV_SANDBOX_HOST_STATUS:${remote}`)
      expect(plan.args).toContain('DEV_LOCAL_CONTAINERS:on')
      expect(plan.lines[1]).toMatch(why)
    }
    // Neither: still starts, with nothing to run a session on — and says both.
    const neither = devSandboxPlan({ docker: false, remote: 'not_logged_in' })
    expect(neither.args).toEqual([
      '--enable-containers=false',
      '--var',
      'DEV_LOCAL_CONTAINERS:off',
      '--var',
      'DEV_SANDBOX_HOST_STATUS:not_logged_in',
    ])
    // An unknown probe answer reads as not deployed rather than a bad var.
    expect(devSandboxPlan({ docker: true, remote: 'weird' }).status).toBe('not_deployed')
  })

  it('reads wrangler whoami, and notices the retired .dev.vars line', () => {
    expect(whoamiLoggedIn('👋 You are logged in with an OAuth Token, associated with…')).toBe(true)
    expect(whoamiLoggedIn('You are not authenticated. Please run `wrangler login`.')).toBe(false)
    expect(whoamiLoggedIn('')).toBe(false)
    expect(legacyRemoteRequested({ SESSION_SANDBOX_HOST: ' remote ' })).toBe(true)
    expect(legacyRemoteRequested({ SESSION_SANDBOX_HOST: 'local' })).toBe(false)
    expect(legacyRemoteRequested({})).toBe(false)
  })
})

describe('the sandbox host is no longer a var', () => {
  it('loadConfig neither reads nor refuses SESSION_SANDBOX_HOST, anywhere', () => {
    for (const APP_ENV of ['development', 'staging', 'production']) {
      const cfg = loadConfig(createTestEnv({ APP_ENV, SESSION_SANDBOX_HOST: 'remote' }))
      expect(cfg as Record<string, unknown>).not.toHaveProperty('SESSION_SANDBOX_HOST')
    }
    const example = text('.dev.vars.example')
    expect(example).not.toMatch(/^SESSION_SANDBOX_HOST=/m)
  })
})

describe('defaultSessionPorts', () => {
  const db = {} as Database

  it('local (the default): the in-process sandbox behind the proxies', () => {
    const env = createTestEnv({ APP_ENV: 'development' })
    for (const ports of [
      defaultSessionPorts(env, loadConfig(env)),
      defaultSessionPorts(env, loadConfig(env), 'local'),
    ]) {
      expect(ports.sandbox('s-1')).toBeInstanceOf(CloudflareSandbox)
      expect(egressFor(ports, db)).toBe(PROXIED_EGRESS)
    }
  })

  it('remote: RemoteSandbox over SANDBOX_HOST, and the host egress mode', () => {
    const env = {
      ...createTestEnv({ APP_ENV: 'development' }),
      SANDBOX_HOST: { fetch: async () => new Response('ok') },
    } as unknown as AppBindings
    const ports = defaultSessionPorts(env, loadConfig(env), 'remote')
    const sandbox = ports.sandbox('s-1')
    expect(sandbox).toBeInstanceOf(RemoteSandbox)
    expect(sandbox.id).toBe('remote:s-1')
    expect(egressFor(ports, db)).toBeInstanceOf(HostEgress)
    expect(egressFor(ports, db).mode).toBe('host')
  })

  it('remote without the binding fails by name when a sandbox is asked for', () => {
    const env = createTestEnv({ APP_ENV: 'development' })
    const ports = defaultSessionPorts(env, loadConfig(env), 'remote')
    expect(() => ports.sandbox('s-1')).toThrow(/no SANDBOX_HOST binding.*pnpm dev/)
  })

  it('a row’s frozen host picks its ports', () => {
    expect(sandboxHostOf({ sandboxHost: 'remote' })).toBe('remote')
    expect(sandboxHostOf({ sandboxHost: 'local' })).toBe('local')
  })
})

describe('the host mode’s turn meter', () => {
  const mappingsOf = (lines: string[]): ClaudeLineMapping[] => {
    const parser = createClaudeStreamParser(1)
    return [...parser.push(`${lines.join('\n')}\n`), ...parser.end()]
  }
  const usageLine = (id: string, input: number, output: number) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        id,
        model: 'claude-sonnet-4-5-20250929',
        content: [{ type: 'text', text: 'x' }],
        usage: { input_tokens: input, output_tokens: output },
      },
    })

  it('counts a response once, however many content lines repeat its usage', () => {
    const meter = createTurnMeter('claude-sonnet-4-5')
    for (const m of mappingsOf([usageLine('msg_1', 100, 10), usageLine('msg_1', 100, 20)])) {
      meter.observe(m)
    }
    expect(meter.entries()).toEqual([
      {
        model: 'claude-sonnet-4-5-20250929',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ])
    // $3 / $15 per million: 100 in + 20 out.
    expect(meter.runningCostMicrocents()).toBe(100 * 300 + 20 * 1500)
  })

  it('records the result line’s modelUsage (background calls included) over what it saw', () => {
    const meter = createTurnMeter('claude-sonnet-4-5')
    const result = JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 's',
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {
        'claude-sonnet-4-5-20250929': {
          inputTokens: 900,
          outputTokens: 90,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 7,
        },
      },
    })
    for (const m of mappingsOf([usageLine('msg_1', 100, 10), result])) meter.observe(m)
    expect(meter.entries()).toEqual([
      {
        model: 'claude-sonnet-4-5-20250929',
        usage: { inputTokens: 900, outputTokens: 90, cacheReadTokens: 5, cacheWriteTokens: 7 },
      },
    ])
  })

  it('falls back to the result’s plain usage under the policy’s model', () => {
    const meter = createTurnMeter('claude-sonnet-4-5')
    for (const m of mappingsOf(claudeStreamJsonLines({ usage: { input: 10, output: 5 } }))) {
      meter.observe(m)
    }
    expect(meter.entries()).toEqual([
      {
        model: 'claude-sonnet-4-5',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ])
  })

  it('no model pinned: plain usage is priced as each agent’s own default, so the budget counts it', () => {
    const claude = createTurnMeter(null)
    for (const m of mappingsOf(claudeStreamJsonLines({ usage: { input: 10, output: 5 } }))) {
      claude.observe(m)
    }
    expect(claude.entries().map(e => e.model)).toEqual([DEFAULT_CLAUDE_CODE_MODEL])
    expect(claude.runningCostMicrocents()).toBeGreaterThan(0)
  })
})

describe('the host mode’s turn meter for Codex and personal accounts', () => {
  const codexMappings = (usage: { input: number; cached: number; output: number }) => {
    const parser = createCodexStreamParser(1)
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't-1' }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: usage.input,
          cached_input_tokens: usage.cached,
          output_tokens: usage.output,
        },
      }),
    ]
    return [...parser.push(`${lines.join('\n')}\n`), ...parser.end()]
  }

  it('Codex’s turn.completed feeds the meter: one entry under the policy model, priced as OpenAI', () => {
    const meter = createTurnMeter('gpt-6.1-sol', { provider: 'openai' })
    for (const m of codexMappings({ input: 1000, cached: 400, output: 50 })) meter.observe(m)
    expect(meter.entries()).toEqual([
      {
        model: 'gpt-6.1-sol',
        usage: { inputTokens: 600, outputTokens: 50, cacheReadTokens: 400, cacheWriteTokens: 0 },
      },
    ])
    expect(meter.provider).toBe('openai')
    // Codex says nothing per response: there is no running cost to cut a turn short with.
    expect(meter.runningCostMicrocents()).toBe(0)
    // No model pinned: Codex's lines never name one, so the turn is priced as Codex's own default.
    const unpinned = createTurnMeter(null, { provider: 'openai' })
    for (const m of codexMappings({ input: 1000, cached: 400, output: 50 })) unpinned.observe(m)
    expect(unpinned.entries().map(e => e.model)).toEqual([DEFAULT_CODEX_MODEL])
  })

  it('a personal account is recorded as a subscription and costs nothing to the budget', () => {
    const meter = createTurnMeter('claude-sonnet-4-5', { billing: 'subscription' })
    const parser = createClaudeStreamParser(1)
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'x' }],
        usage: { input_tokens: 100_000, output_tokens: 10_000 },
      },
    })
    for (const m of [...parser.push(`${line}\n`), ...parser.end()]) meter.observe(m)
    expect(meter.billing).toBe('subscription')
    expect(meter.runningCostMicrocents()).toBe(0)
    expect(meter.entries()).toHaveLength(1)
  })
})

describe('the transcript scrubs key and token shapes', () => {
  it('redacts GitHub tokens as well as Anthropic keys', () => {
    const token = `ghs_${'a'.repeat(36)}`
    const line = `https://x-access-token:${token}@github.com and sk-ant-api03-abcdefgh and github_pat_${'b'.repeat(40)}`
    const out = redactModelKeyText(line)
    expect(out).not.toContain(token)
    expect(out).not.toContain('sk-ant-api03')
    expect(out).not.toContain('github_pat_')
  })
})

describe('the host mode puts no credential in the container', () => {
  // The first design wrote the token to a file for git's `store` helper, which erases the file on
  // a fresh token's 401 — the clone then failed "could not read Username". The token and the key
  // now live only in the host Durable Object's grant, injected by its outbound handlers.
  it('the host class declares its own handlers for the model, sign-in and git hosts, and none for the database', () => {
    expect(Object.keys(HostedSessionSandbox.outboundByHost ?? {}).sort()).toEqual([
      'api.anthropic.com',
      'api.openai.com',
      'auth.openai.com',
      'github.com',
      'platform.claude.com',
    ])
  })

  it('no session source writes a git credential file or configures a credential helper', () => {
    const dirs = ['src/api/services/sessions', 'src/sandbox-host']
    const files = dirs.flatMap(dir =>
      fs
        .readdirSync(path.join(WEB_DIR, dir), { recursive: true, encoding: 'utf8' })
        .filter(f => f.endsWith('.ts'))
        .map(f => path.join(WEB_DIR, dir, f))
    )
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/credential\.helper|credential\.https|git-credentials/)
      expect(source, file).not.toMatch(/helper '?store/)
    }
  })
})
