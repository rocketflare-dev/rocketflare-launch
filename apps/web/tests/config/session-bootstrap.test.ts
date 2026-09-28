/**
 * How a session brings a Rocketflare checkout up (Launch P3, slice 3b) — pure pieces, no database:
 *
 * - **Never port 3000.** Inside every sandbox it is the Sandbox SDK's own control server (S7
 *   finding 3): not in a command, an environment, the dev vars or the image's `EXPOSE`.
 * - The image and the code agree on the image version, the kit tag and the SDK line.
 * - The checkout script, the allow-list, the SDK adapter's log-stream parser and error mapping.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_TEMPLATE_PIN } from '@launch/shared/launch-setup'
import { describe, expect, it } from 'vitest'
import { sessionDbEgressHosts } from '@/api/services/sessions/db/neon-session-db'
import {
  SandboxInterruptedError,
  SESSION_BASE_ALLOWED_HOSTS,
  sessionAllowedHosts,
} from '@/api/services/sessions/ports'
import {
  BOOTSTRAP_COMMAND,
  claudeSettingsLocal,
  DEV_COMMAND,
  INSTALL_COMMAND,
  previewHostSuffix,
  SESSION_API_PORT,
  SESSION_IMAGE_VERSION,
  SESSION_KIT_TAG,
  SESSION_UI_PORT,
  sessionBootstrap,
  sessionDevVars,
  sessionProcessEnv,
} from '@/api/services/sessions/rocketflare-dev'
import {
  inSubshell,
  mapSandboxError,
  parseLogStream,
  shellQuote,
} from '@/api/services/sessions/sandbox/cloudflare-sandbox'
import { checkoutScript, devEnvFor } from '@/api/services/sessions/steps'
import type { AppConfig } from '@/config'
import { FakeSandbox } from '../helpers/fake-sandbox'

const WEB = path.resolve(__dirname, '../..')
const dockerfile = readFileSync(path.join(WEB, 'containers/session/Dockerfile'), 'utf8')

const cloud = {
  APP_ENV: 'production',
  SESSION_BACKEND: 'cloud',
  SESSION_PREVIEW_URL: 'https://{label}.clewro.com',
} as AppConfig
const local = {
  APP_ENV: 'development',
  SESSION_BACKEND: 'local',
  SESSION_PREVIEW_URL: 'http://{label}.localhost:3001',
} as AppConfig
/** Launch under `wrangler dev` on the CLOUD backend — the user's first real session (hola-world). */
const devCloud = { ...cloud, APP_ENV: 'development' } as AppConfig
const session = { shortId: 'abcdefghijkl', previewToken: '0123456789' }

describe('never port 3000', () => {
  it('the ports are 5173 (Vite) and 8787 (wrangler dev)', () => {
    expect(SESSION_UI_PORT).toBe(5173)
    expect(SESSION_API_PORT).toBe(8787)
  })

  it('no command, environment or dev var names it', () => {
    for (const cfg of [cloud, local]) {
      const dev = devEnvFor(cfg, session)
      const everything = JSON.stringify({
        commands: [INSTALL_COMMAND, BOOTSTRAP_COMMAND, DEV_COMMAND],
        env: sessionProcessEnv(dev),
        vars: sessionDevVars(dev),
      })
      expect(everything).not.toMatch(/(^|[^0-9])3000([^0-9]|$)/)
      expect(sessionDevVars(dev)).toMatchObject({ DEV_UI_PORT: '5173', DEV_API_PORT: '8787' })
    }
  })

  it('the image exposes 5173 and 8787 only', () => {
    const exposed = dockerfile
      .split('\n')
      .filter(line => /^EXPOSE\b/.test(line))
      .flatMap(line => line.replace('EXPOSE', '').trim().split(/\s+/))
    expect(exposed.sort()).toEqual(['5173', '8787'])
  })
})

describe('the image and the code agree', () => {
  it('on the image version, the kit tag and the Sandbox SDK line', () => {
    expect(dockerfile).toContain(
      `LABEL dev.rocketflare.launch.session-image="${SESSION_IMAGE_VERSION}"`
    )
    expect(dockerfile).toContain(`ARG KIT_TAG=${SESSION_KIT_TAG}`)
    const pkg = JSON.parse(readFileSync(path.join(WEB, 'package.json'), 'utf8'))
    expect(dockerfile).toContain(
      `FROM docker.io/cloudflare/sandbox:${pkg.dependencies['@cloudflare/sandbox']}`
    )
  })

  it('warms the pnpm store for the kit a new app is cut from (DEFAULT_TEMPLATE_PIN)', () => {
    // A drifted store makes `pnpm install --prefer-offline` fall back to the registry for every
    // dependency the pinned kit changed: bump `ARG KIT_TAG` and `SESSION_KIT_TAG` with the pin.
    expect(SESSION_KIT_TAG).toBe(DEFAULT_TEMPLATE_PIN.tag)
    expect(dockerfile).toContain(`ARG KIT_TAG=${DEFAULT_TEMPLATE_PIN.tag}`)
  })

  it('puts Node 24 first on PATH and pins Claude Code; holds no credential', () => {
    expect(dockerfile).toMatch(/setup_24\.x/)
    expect(dockerfile).toMatch(/ln -sf \/usr\/bin\/node \/usr\/local\/bin\/node/)
    expect(dockerfile).toMatch(/ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+/)
    expect(dockerfile).not.toMatch(/ANTHROPIC_API_KEY=|GITHUB_TOKEN|sk-ant-/)
  })
})

describe('the bootstrap command', () => {
  it('is the kit bootstrap on a database it does not own, neon driver, no plugins, never interactive', () => {
    expect(BOOTSTRAP_COMMAND).toBe(
      'node --import /workspace/.launch/bootstrap-in-sandbox.mjs scripts/bootstrap.mjs --db-url "$LAUNCH_DB_URL" --driver neon --offline --no-dev --no-open --no-plugins --yes'
    )
    expect(INSTALL_COMMAND).toMatch(/--frozen-lockfile --prefer-offline/)
  })

  it('keeps esbuild alive whenever the container runs on a laptop — whatever SESSION_BACKEND says', () => {
    // The hola-world failure: Launch under `wrangler dev` with SESSION_BACKEND unset (cloud) ran
    // the amd64 image under QEMU without GOGC=off, and tsx's esbuild died in its GC every attempt.
    expect(sessionProcessEnv(devEnvFor(devCloud, session))).toMatchObject({ GOGC: 'off' })
    expect(sessionProcessEnv(devEnvFor(local, session))).toMatchObject({ GOGC: 'off' })
    expect(sessionProcessEnv(devEnvFor(cloud, session))).not.toHaveProperty('GOGC')
  })

  it('uses the neon driver straight to the branch, on a laptop too — never a proxy', () => {
    for (const cfg of [cloud, local, devCloud]) {
      const dev = devEnvFor(cfg, session)
      expect(sessionProcessEnv(dev)).toMatchObject({ DATABASE_DRIVER: 'neon' })
      expect(sessionProcessEnv(dev)).not.toHaveProperty('NEON_LOCAL_PROXY')
      expect(sessionDevVars(dev)).toMatchObject({ DATABASE_DRIVER: 'neon', NEON_LOCAL_PROXY: '' })
    }
  })

  it('serves the preview origin', () => {
    expect(sessionDevVars(devEnvFor(cloud, session))).toEqual({
      DATABASE_DRIVER: 'neon',
      NEON_LOCAL_PROXY: '',
      DEV_UI_PORT: '5173',
      DEV_API_PORT: '8787',
      APP_URL: 'https://5173-abcdefghijkl-0123456789.clewro.com',
      DEV_ALLOWED_HOSTS: '.clewro.com',
    })
    expect(sessionDevVars(devEnvFor(local, session))).toEqual({
      DATABASE_DRIVER: 'neon',
      NEON_LOCAL_PROXY: '',
      DEV_UI_PORT: '5173',
      DEV_API_PORT: '8787',
      APP_URL: 'http://5173-abcdefghijkl-0123456789.localhost:3001',
      DEV_ALLOWED_HOSTS: '.localhost',
    })
    expect(previewHostSuffix(undefined)).toBeNull()
    expect(
      sessionDevVars(devEnvFor({ SESSION_BACKEND: 'cloud' } as AppConfig, session)).APP_URL
    ).toBe('http://localhost:5173')
  })

  it('pre-approves safe commands and denies pushing', () => {
    const settings = JSON.parse(claudeSettingsLocal())
    expect(settings.permissions.deny).toContain('Bash(git push:*)')
    expect(settings.permissions.allow).toContain('Bash(pnpm:*)')
  })
})

describe('the checkout', () => {
  it('fetches the base, then checks out the session branch from the remote or fresh', () => {
    const script = checkoutScript({
      url: 'https://github.com/acme/app.git',
      baseRef: 'main',
      branch: 'session/abcdefghijkl',
    })
    expect(script).toContain("git remote add origin 'https://github.com/acme/app.git'")
    expect(script).toContain("git fetch -q --depth 50 origin 'main'")
    expect(script).toContain("'refs/heads/session/abcdefghijkl'")
    expect(script).toContain('git checkout -q -B \'session/abcdefghijkl\' "$base"')
    expect(script).toContain('.git/info/exclude')
    const prepare = checkoutScript({ url: 'u', baseRef: 'v1.0.0', branch: null })
    expect(prepare).toContain('git checkout -q --detach "$base"')
  })

  it('quotes so no ref can break out of the shell', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(inSubshell('exit 3')).toBe(`bash -c 'exit 3'`)
  })
})

describe('the egress allow-list', () => {
  it('is the base list — with no laptop host, local or not', () => {
    expect(sessionAllowedHosts()).toEqual([...SESSION_BASE_ALLOWED_HOSTS])
    expect(sessionAllowedHosts()).not.toContain('host.docker.internal')
    expect(sessionAllowedHosts(['a.example'])).toEqual([...SESSION_BASE_ALLOWED_HOSTS, 'a.example'])
  })

  it('widens by exactly the database’s Neon endpoint and its region’s HTTP SQL host', () => {
    const uri =
      'postgresql://session_owner:pw@ep-empty-mountain-b1o0rozj.c-5.eu-central-1.aws.neon.tech/session_app?sslmode=require'
    expect(sessionDbEgressHosts(uri)).toEqual([
      'ep-empty-mountain-b1o0rozj.c-5.eu-central-1.aws.neon.tech',
      'api.c-5.eu-central-1.aws.neon.tech',
    ])
    const pooled = 'postgresql://u:p@ep-x-123-pooler.us-east-2.aws.neon.tech/db'
    expect(sessionDbEgressHosts(pooled)).toEqual([
      'ep-x-123-pooler.us-east-2.aws.neon.tech',
      'api.us-east-2.aws.neon.tech',
    ])
    for (const host of sessionDbEgressHosts(uri)) expect(host).not.toContain('*')
  })

  it('sessionBootstrap applies it before the bootstrap runs, replacing an earlier database’s', async () => {
    const sandbox = new FakeSandbox({ name: 's1' })
    let listAtBootstrap: string[] = []
    sandbox.onExec(/scripts\/bootstrap\.mjs/, () => {
      listAtBootstrap = [...sandbox.allowedHosts]
      return {}
    })
    await sandbox.start()
    const dev = devEnvFor(devCloud, session)
    // A prepare run on `dev`, then the session's own branch in the same container.
    const devUri = 'postgresql://session_owner:pw@ep-dev-000001.us-east-2.aws.neon.tech/session_app'
    const branchUri =
      'postgresql://session_owner:pw2@ep-sess-000002.us-east-2.aws.neon.tech/session_app'
    await sessionBootstrap({ sandbox, dbUri: devUri, dev })
    expect(listAtBootstrap).toEqual([
      ...SESSION_BASE_ALLOWED_HOSTS,
      'ep-dev-000001.us-east-2.aws.neon.tech',
      'api.us-east-2.aws.neon.tech',
    ])
    await sessionBootstrap({ sandbox, dbUri: branchUri, dev })
    expect(sandbox.allowedHosts).toEqual([
      ...SESSION_BASE_ALLOWED_HOSTS,
      'ep-sess-000002.us-east-2.aws.neon.tech',
      'api.us-east-2.aws.neon.tech',
    ])
    // The URI travels only in the bootstrap's environment, never on a command line.
    const boot = sandbox.execs.filter(e => /bootstrap\.mjs/.test(e.command))
    expect(boot.at(-1)?.opts?.env).toMatchObject({
      LAUNCH_DB_URL: branchUri,
      DATABASE_DRIVER: 'neon',
      GOGC: 'off',
    })
    for (const e of sandbox.execs) expect(e.command).not.toContain('pw2@')
  })

  it('sessionBootstrap refuses a non-Neon database before running anything', async () => {
    const sandbox = new FakeSandbox({ name: 's2' })
    await expect(
      sessionBootstrap({
        sandbox,
        dbUri: 'postgresql://u:p@host.docker.internal:5432/app',
        dev: devEnvFor(local, session),
      })
    ).rejects.toThrow(/not a Neon endpoint/)
    expect(sandbox.execs).toHaveLength(0)
    expect(sandbox.allowedHosts).toEqual([...SESSION_BASE_ALLOWED_HOSTS])
  })

  it('refuses a URI that is not a Neon endpoint — no other host can ride in on it', () => {
    for (const uri of [
      'postgresql://u:p@localhost:5432/db',
      'postgresql://u:p@host.docker.internal:5432/db',
      'postgresql://u:p@launch-local.neon.tech/db',
      'postgresql://u:p@api.us-east-2.aws.neon.tech/db',
      'postgresql://u:p@ep-x.neon.tech.evil.example/db',
      'postgresql://u:p@ep-x.evil-neon.tech/db',
      'postgresql://u:p@example.com/db',
      'not a uri',
    ]) {
      expect(() => sessionDbEgressHosts(uri)).toThrow()
    }
  })
})

describe('the SDK adapter', () => {
  const streamOf = (frames: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        // Split mid-frame, as a network would.
        const text = frames.join('')
        controller.enqueue(enc.encode(text.slice(0, 17)))
        controller.enqueue(enc.encode(text.slice(17)))
        controller.close()
      },
    })

  it('parses the process-log SSE into chunks and ONE exit', async () => {
    const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
    const events = []
    for await (const e of parseLogStream(
      streamOf([
        frame({ type: 'stdout', data: '{"type":"system"}\n{"ty' }),
        frame({ type: 'stderr', data: 'warn' }),
        frame({ type: 'stdout', data: 'pe":"result"}\n' }),
        frame({ type: 'exit', exitCode: 0 }),
        frame({ type: 'exit', exitCode: 0 }),
      ])
    )) {
      events.push(e)
    }
    expect(events).toEqual([
      { type: 'stdout', data: '{"type":"system"}\n{"ty' },
      { type: 'stderr', data: 'warn' },
      { type: 'stdout', data: 'pe":"result"}\n' },
      { type: 'exit', exitCode: 0 },
    ])
  })

  it('maps the SDK’s "the container went away" errors to SandboxInterruptedError', () => {
    const named = Object.assign(new Error('x'), { name: 'OperationInterruptedError' })
    expect(mapSandboxError(named)).toBeInstanceOf(SandboxInterruptedError)
    expect(
      mapSandboxError(new Error('interrupted while the platform was updating the sandbox runtime'))
    ).toBeInstanceOf(SandboxInterruptedError)
    const other = new Error('ENOENT')
    expect(mapSandboxError(other)).toBe(other)
  })
})
