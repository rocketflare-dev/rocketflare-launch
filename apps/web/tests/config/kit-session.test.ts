/**
 * D36 K4: a coding session driven by its app's kit manifest — `kit-dev.ts` (`SessionKit`), the
 * ship gate's plan and test variables (`gate.ts` `GateKit`), the session database's roles
 * (`neon-session-db.ts` `sessionDatabaseKitOf`) and the upgrade answer's marker — with a kit that is
 * NOT Rocketflare: the meta-kit `rocketflare-dev/launch-kit` 0.1 (`tests/fixtures/launch-kit-0.1/`),
 * and a variant of it whose every name differs from Rocketflare's, so nothing here passes by
 * coincidence. Rocketflare's own sessions are pinned by `session-bootstrap.test.ts`,
 * `ship-gate-contract.test.ts` and the workflow suites; here only that its fallback still resolves
 * to the legacy constants.
 */
import { readFileSync } from 'node:fs'
import { type KitManifest, parseKitManifest } from '@launch/shared/kit-manifest'
import { upgradeResultOf } from '@launch/shared/launch-upgrades'
import { describe, expect, it } from 'vitest'
import { rocketflareFallbackManifest } from '@/api/services/launch/kits/rocketflare-fallback'
import { autoShipVerdict, upgradeFollowUpDue } from '@/api/services/launch/upgrades'
import {
  devIsCurrent,
  ROCKETFLARE_SESSION_DATABASE,
  SESSION_DEV_ROLE_VERSION,
  sessionAppRoleFor,
  sessionDatabaseKitOf,
} from '@/api/services/sessions/db/neon-session-db'
import {
  GATE_LIST_COMMAND,
  gateKitOf,
  gateListUnreadableMessage,
  gateTestEnv,
  planGateFromList,
  ROCKETFLARE_GATE_KIT,
  SHIP_GATE_COMMANDS,
} from '@/api/services/sessions/gate'
import {
  BOOTSTRAP_COMMAND,
  DEV_GRACEFUL_STOP_COMMAND,
  DEV_LOG_FILE,
  DEV_PID_FILE,
  DEV_START_COMMAND,
  DEV_STOP_COMMAND,
  devReadyProbeFor,
  devStartCommandFor,
  devStopCommandFor,
  genericBootstrapInvocation,
  INSTALL_COMMAND,
  NOT_ROOT_PRELOAD,
  ROCKETFLARE_SESSION_KIT,
  SESSION_API_PORT,
  SESSION_UI_PORT,
  SESSION_WORKSPACE,
  type SessionDevEnv,
  sessionBootstrap,
  sessionDevVars,
  sessionKitOf,
  sessionProcessEnv,
  startDevServer,
} from '@/api/services/sessions/kit-dev'
import type { GateBranch } from '@/api/services/sessions/ports'
import { FakeSandbox } from '../helpers/fake-sandbox'

const kitText = readFileSync(
  new URL('../fixtures/launch-kit-0.1/launch.kit.json', import.meta.url),
  'utf8'
)
const launchKit: KitManifest = parseKitManifest(kitText)

/** The meta-kit with every name a session reads changed — nothing Rocketflare's by accident. */
function oddKit(): KitManifest {
  const doc = JSON.parse(kitText)
  doc.kit.id = 'odd-kit'
  doc.launchProvides.appUrl = 'PUBLIC_ORIGIN'
  doc.launchProvides.databaseUrl = 'PG_URL'
  delete doc.launchProvides.databaseDriver
  doc.health.live = '/healthz'
  doc.session = {
    install: 'npm ci --no-audit',
    bootstrap: 'node tools/setup.mjs --database {dbUrl} --headless',
    devStart: "npm run dev -- --host '0.0.0.0'",
    ports: { ui: 'WEB_PORT', api: 'WORKER_PORT', allowedHosts: 'PREVIEW_HOSTS' },
    writes: ['web/.dev.vars', 'web/wrangler.local.toml'],
    env: { skip: 'SETUP_SKIP', allowRoot: 'SETUP_AS_ROOT' },
  }
  doc.ci = {
    requiredCheck: 'ci-ok',
    gateList: 'npm run --silent gate -- list',
    gateRun: 'npm run --silent gate -- run {step}',
    testEnv: { branch: 'NEON_TEST_BRANCH' },
  }
  doc.database = {
    migrate: 'npm run migrate',
    rlsRole: 'rls_{slug_snake}',
    roles: { migrator: 'owner_m', app: 'web' },
    extensions: ['pg_trgm'],
  }
  doc.upgrade.doneMarker = 'KIT-UPGRADE-RESULT:'
  return parseKitManifest(JSON.stringify(doc))
}

const preview: SessionDevEnv = {
  previewOrigin: 'https://5173-abcdefghijkl-0123456789.clewro.com',
  previewHostSuffix: '.clewro.com',
}
const dbUri = 'postgresql://session_owner:pw@ep-kit-000001.us-east-2.aws.neon.tech/session_app'

describe('kit-dev: the session block of a non-Rocketflare kit', () => {
  it('reads the meta-kit’s commands, its port names and the .dev.vars it lets Launch write', () => {
    const kit = sessionKitOf(launchKit)
    expect(kit).toEqual({
      id: 'launch-kit',
      legacy: false,
      install: 'pnpm install --frozen-lockfile --prefer-offline',
      bootstrap:
        'node scripts/bootstrap.mjs --db-url "$LAUNCH_DB_URL" --driver neon --no-install --no-dev --yes',
      devStart: 'node scripts/dev.mjs start',
      devStop: 'node scripts/dev.mjs stop',
      ports: { ui: 'DEV_UI_PORT', api: 'DEV_API_PORT', allowedHosts: 'DEV_ALLOWED_HOSTS' },
      devVarsFile: 'apps/web/.dev.vars',
      appUrlVar: 'APP_URL',
      driver: { name: 'DATABASE_DRIVER', value: 'neon' },
      skipEnv: 'KIT_BOOTSTRAP_SKIP',
      allowRootEnv: 'KIT_ALLOW_ROOT',
      healthPath: '/api/health',
    })
    // The URL is never in the command: only the shell reference.
    expect(kit.bootstrap).not.toContain('postgres')
  })

  it('puts Launch’s ports under the kit’s own names — and no Rocketflare switch', () => {
    const dev = { ...preview, kit: sessionKitOf(oddKit()) }
    const env = sessionProcessEnv(dev)
    expect(env).toMatchObject({
      WEB_PORT: String(SESSION_UI_PORT),
      WORKER_PORT: String(SESSION_API_PORT),
      PREVIEW_HOSTS: '.clewro.com',
      CI: '1',
    })
    for (const name of ['DEV_UI_PORT', 'DEV_API_PORT', 'DEV_ALLOWED_HOSTS', 'DATABASE_DRIVER']) {
      expect(env).not.toHaveProperty(name)
    }
    expect(sessionDevVars(dev)).toEqual({
      WEB_PORT: '5173',
      WORKER_PORT: '8787',
      PUBLIC_ORIGIN: preview.previewOrigin,
      PREVIEW_HOSTS: '.clewro.com',
    })
    // The meta-kit has the driver var; Rocketflare's NEON_LOCAL_PROXY is never written for it.
    const meta = sessionDevVars({ ...preview, kit: sessionKitOf(launchKit) })
    expect(meta).toMatchObject({ DATABASE_DRIVER: 'neon', APP_URL: preview.previewOrigin })
    expect(meta).not.toHaveProperty('NEON_LOCAL_PROXY')
  })

  it('tells the kit’s bootstrap what to leave out in Launch’s step names, and lets it run as root', () => {
    const kit = sessionKitOf(launchKit)
    expect(genericBootstrapInvocation(kit)).toEqual({
      command: kit.bootstrap,
      env: { KIT_ALLOW_ROOT: '1', KIT_BOOTSTRAP_SKIP: 'install' },
      kitFlags: true,
    })
    // A resume on a prepared database: no database check, and no `seed` (no such contract step).
    expect(genericBootstrapInvocation(kit, ['seed', 'db-check']).env).toEqual({
      KIT_ALLOW_ROOT: '1',
      KIT_BOOTSTRAP_SKIP: 'install,database',
    })
    // A kit with neither variable is told nothing.
    const bare = { ...kit, skipEnv: null, allowRootEnv: null }
    expect(genericBootstrapInvocation(bare, ['db-check']).env).toEqual({})
  })

  it('sessionBootstrap runs the kit’s install and bootstrap — no preload, the URL only in env', async () => {
    const kit = sessionKitOf(oddKit())
    const sandbox = new FakeSandbox({ name: 'odd' })
    await sandbox.start()
    await sessionBootstrap({ sandbox, dbUri, dev: { ...preview, kit }, skip: ['seed', 'db-check'] })
    const install = sandbox.backgroundRuns.find(r => r.name === 'install')
    const bootstrap = sandbox.backgroundRuns.find(r => r.name === 'bootstrap')
    expect(install?.command).toContain('npm ci --no-audit')
    expect(bootstrap?.command).toContain(
      'node tools/setup.mjs --database "$LAUNCH_DB_URL" --headless'
    )
    expect(bootstrap?.command).not.toContain(NOT_ROOT_PRELOAD)
    expect(bootstrap?.command).not.toContain('ep-kit-000001')
    expect(bootstrap?.opts?.env).toMatchObject({
      LAUNCH_DB_URL: dbUri,
      SETUP_AS_ROOT: '1',
      SETUP_SKIP: 'install,database',
      WEB_PORT: '5173',
    })
    for (const name of [
      'LAUNCH_BOOTSTRAP_KEEP',
      'LAUNCH_BOOTSTRAP_SKIP',
      'ROCKETFLARE_ALLOW_ROOT',
    ]) {
      expect(bootstrap?.opts?.env).not.toHaveProperty(name)
    }
    expect(sandbox.files.has(NOT_ROOT_PRELOAD)).toBe(false)
    // The dev-server keys go into the `.dev.vars` the kit's `session.writes` names.
    const write = sandbox.execs.find(e => /dev-vars\.mjs/.test(e.command))
    expect(write?.command).toContain(`${SESSION_WORKSPACE}/web/.dev.vars`)
    expect(JSON.parse(write?.opts?.env?.LAUNCH_DEV_VARS ?? '{}')).toEqual({
      WEB_PORT: '5173',
      WORKER_PORT: '8787',
      PUBLIC_ORIGIN: preview.previewOrigin,
      PREVIEW_HOSTS: '.clewro.com',
    })
    expect(JSON.stringify(sandbox.execs)).not.toContain('pw@')
  })

  it('writes no dev vars where the kit lets Launch write none', async () => {
    const kit = { ...sessionKitOf(launchKit), devVarsFile: null }
    const sandbox = new FakeSandbox({ name: 'none' })
    await sandbox.start()
    await sessionBootstrap({ sandbox, dbUri, dev: { ...preview, kit } })
    expect(sandbox.execs.some(e => /dev-vars\.mjs/.test(e.command))).toBe(false)
  })

  it('starts the kit’s dev server under its pid file and waits on its own health path', async () => {
    const kit = sessionKitOf(oddKit())
    const start = devStartCommandFor(kit)
    expect(start).toBe(
      `mkdir -p /workspace/.launch && echo $$ > ${DEV_PID_FILE} && exec sh -c 'npm run dev -- --host '\\''0.0.0.0'\\''' > ${DEV_LOG_FILE} 2>&1`
    )
    expect(devReadyProbeFor(kit)).toMatchObject({ port: SESSION_API_PORT, path: '/healthz' })
    // No session.devStop: the dev server is stopped by its pid. The meta-kit's own stop otherwise.
    expect(devStopCommandFor(kit)).toBe(DEV_GRACEFUL_STOP_COMMAND)
    expect(devStopCommandFor(sessionKitOf(launchKit))).toBe('node scripts/dev.mjs stop')

    const sandbox = new FakeSandbox({ name: 'dev' })
    sandbox.onProcess(/npm run dev/, { lines: ['ready'], ports: [5173, 8787], hang: true })
    await sandbox.start()
    await startDevServer(sandbox, { ...preview, kit })
    expect(sandbox.processes[0]?.command).toBe(start)
    expect(sandbox.portWaits[0]).toMatchObject({ port: 8787, opts: { path: '/healthz' } })
    // Rocketflare's session wrangler config is its own legacy: never written for another kit.
    expect([...sandbox.files.keys()].some(f => f.includes('session-wrangler'))).toBe(false)
  })

  it('the Rocketflare fallback still resolves to the legacy commands', () => {
    const kit = ROCKETFLARE_SESSION_KIT
    expect(kit.legacy).toBe(true)
    expect(kit.install).toBe(INSTALL_COMMAND)
    // The legacy bootstrap is the fallback's, run under the root preload.
    expect(BOOTSTRAP_COMMAND).toBe(
      kit.bootstrap.replace(/^node /, `node --import ${NOT_ROOT_PRELOAD} `)
    )
    expect(devStartCommandFor(kit)).toBe(DEV_START_COMMAND)
    expect(devStopCommandFor(kit)).toBe(DEV_STOP_COMMAND)
    expect(sessionKitOf(rocketflareFallbackManifest())).toEqual(kit)
  })
})

describe('the ship gate, from a kit’s ci block', () => {
  const list = {
    schema: 1 as const,
    steps: [
      { id: 'lint', command: 'biome', database: false },
      { id: 'typecheck', command: 'tsc', database: false },
      { id: 'test', command: 'vitest', database: true },
      { id: 'build', command: 'build', database: false },
    ],
  }

  it('lists with ci.gateList and runs each step with ci.gateRun', () => {
    const meta = gateKitOf(launchKit)
    expect(meta.legacy).toBe(false)
    expect(meta.listCommand).toBe('pnpm gate --list --json')
    const odd = gateKitOf(oddKit())
    expect(odd.listCommand).toBe('npm run --silent gate -- list')
    const plan = planGateFromList(list, odd)
    expect(plan).toEqual({
      ok: true,
      commands: [
        {
          step: 'lint',
          command: 'npm run --silent gate -- run lint',
          timeoutMs: 300_000,
          database: false,
        },
        {
          step: 'typecheck',
          command: 'npm run --silent gate -- run typecheck',
          timeoutMs: 600_000,
          database: false,
        },
        {
          step: 'test',
          command: 'npm run --silent gate -- run test',
          timeoutMs: 1_500_000,
          database: true,
        },
      ],
    })
    expect(gateListUnreadableMessage(odd)).toContain('`npm run --silent gate -- list`')
  })

  it('Rocketflare keeps its `--silent` list and its pnpm gate commands', () => {
    expect(ROCKETFLARE_GATE_KIT.legacy).toBe(true)
    expect(ROCKETFLARE_GATE_KIT.listCommand).toBe(GATE_LIST_COMMAND)
    const plan = planGateFromList(list)
    expect(plan.ok && plan.commands).toEqual([
      SHIP_GATE_COMMANDS.lint,
      SHIP_GATE_COMMANDS.typecheck,
      SHIP_GATE_COMMANDS.test,
    ])
    expect(gateKitOf(rocketflareFallbackManifest()).testEnv).toEqual({
      url: 'DATABASE_URL',
      branch: 'TEST_DATABASE_BRANCH',
      endpoint: 'TEST_DATABASE_ENDPOINT',
    })
  })

  it('hands the test step the branch under the kit’s variable names, and only those', () => {
    const branch: GateBranch = {
      name: 'gate-abcdefghijkl-1',
      branchId: 'br-1',
      endpointId: 'ep-gate-000001',
      host: 'ep-gate-000001.us-east-2.aws.neon.tech',
    }
    const uri = 'postgresql://session_owner:pw@ep-gate-000001.us-east-2.aws.neon.tech/session_app'
    expect(gateTestEnv({}, branch, uri, gateKitOf(oddKit()).testEnv)).toEqual({
      CI: '1',
      WRANGLER_SEND_METRICS: 'false',
      PG_URL: uri,
      NEON_TEST_BRANCH: 'gate-abcdefghijkl-1',
    })
    expect(gateTestEnv({}, branch, uri, gateKitOf(launchKit).testEnv)).toMatchObject({
      DATABASE_URL: uri,
      TEST_DATABASE_BRANCH: 'gate-abcdefghijkl-1',
      TEST_DATABASE_ENDPOINT: 'ep-gate-000001',
    })
  })
})

describe('the session database, from a kit’s database block', () => {
  it('the meta-kit has no RLS role and no extension; another kit’s role is its own rule', () => {
    const meta = sessionDatabaseKitOf(launchKit)
    expect(meta).toEqual({ rlsRole: null, migratorRole: 'migrator', extensions: [] })
    expect(sessionAppRoleFor({ slug: 'acme-crm', database: meta })).toBeNull()
    const odd = sessionDatabaseKitOf(oddKit())
    expect(sessionAppRoleFor({ slug: 'acme-crm', database: odd })).toBe('rls_acme_crm')
    expect(odd).toMatchObject({ migratorRole: 'owner_m', extensions: ['pg_trgm'] })
    // Rocketflare's: `<snake>_app`, `migrator`, `vector` — the role every existing app has.
    expect(ROCKETFLARE_SESSION_DATABASE).toEqual({
      rlsRole: '{slug_snake}_app',
      migratorRole: 'migrator',
      extensions: ['vector'],
    })
    expect(sessionAppRoleFor({ slug: 'acme-crm' })).toBe('acme_crm_app')
  })

  it('a prepared dev with no role recorded is current for a kit without one', () => {
    const sessionDb = {
      status: 'ready' as const,
      database: 'session_app',
      devBranchId: 'br-dev',
      preparedCommit: null,
      preparedAt: null,
      devSource: 'staging' as const,
      roleVersion: SESSION_DEV_ROLE_VERSION,
    }
    const meta = sessionDatabaseKitOf(launchKit)
    expect(devIsCurrent({ slug: 'acme', sessionDb, database: meta })).toBe(true)
    // The Rocketflare fallback wants its role recorded.
    expect(devIsCurrent({ slug: 'acme', sessionDb })).toBe(false)
    expect(devIsCurrent({ slug: 'acme', sessionDb: { ...sessionDb, appRole: 'acme_app' } })).toBe(
      true
    )
  })
})

describe('an upgrade answer, by the kit’s done marker', () => {
  const marker = oddKit().upgrade?.doneMarker ?? ''

  it('reads the kit’s marker, and only it', () => {
    expect(marker).toBe('KIT-UPGRADE-RESULT:')
    expect(upgradeResultOf('Done.\nKIT-UPGRADE-RESULT: DONE', marker)).toBe('DONE')
    expect(upgradeResultOf('**KIT-UPGRADE-RESULT: STOPPED**', marker)).toBe('STOPPED')
    expect(upgradeResultOf('LAUNCH-UPGRADE: DONE', marker)).toBeNull()
    expect(upgradeResultOf('KIT-UPGRADE-RESULT: DONE')).toBeNull()
    // A marker with regex characters is matched literally.
    expect(upgradeResultOf('a.b DONE', 'a.b')).toBe('DONE')
    expect(upgradeResultOf('axb DONE', 'a.b')).toBeNull()
  })

  it('decides auto-ship and the follow-up on it', () => {
    const evidence = {
      status: 'completed' as const,
      result: {
        subtype: 'success',
        isError: false,
        tail: 'All applied.\nKIT-UPGRADE-RESULT: DONE',
      },
      changed: true,
      askedQuestion: false,
      manifestVersion: '0.2.0',
    }
    expect(autoShipVerdict(evidence, '0.2.0', marker)).toEqual({ ship: true })
    expect(autoShipVerdict(evidence, '0.2.0').ship).toBe(false)
    const silent = { ...evidence, changed: false, result: { ...evidence.result, tail: 'Hi.' } }
    expect(upgradeFollowUpDue(silent, false, marker)).toBe(true)
    expect(upgradeFollowUpDue({ ...silent, result: evidence.result }, false, marker)).toBe(false)
  })
})
