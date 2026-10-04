/**
 * Worker secrets through wrangler, against the instance's rendered config. `wrangler secret put
 * NAME` reads the value from STDIN when stdin is not a TTY (wrangler source,
 * packages/wrangler/src/secret/index.ts: `isInteractive ? await prompt(...) : await
 * readFromStdin()`), so a value never appears in an argument list or a shell history. `wrangler
 * secret list` prints JSON by default (`--format json`, verified with `wrangler secret list
 * --help`, wrangler 4.127). `wrangler secret bulk` is deliberately NOT used.
 *
 * `planSecrets` is the pure half of the `secrets` phase — what would be put, generated, skipped or
 * refused — so `secrets --dry-run` and the test print exactly the same plan, NAMES only.
 */
import { randomBytes } from 'node:crypto'
import { ProvisionError, wrangler, wranglerConfigArgs } from './config'

export const OAUTH_KEY_HEX_LENGTH = 64

/** 32 random bytes as 64 hex — the shape `optionalSecret(32)` in src/config.ts validates. */
export const generateHexKey = (): string => randomBytes(OAUTH_KEY_HEX_LENGTH / 2).toString('hex')

export async function listWorkerSecrets(): Promise<string[]> {
  const r = await wrangler(['secret', 'list', '--format', 'json', ...wranglerConfigArgs()], {
    echo: false,
    allowFailure: true,
  })
  if (r.status !== 0) {
    // A Worker that has never been deployed has no secrets to list; wrangler reports an error.
    if (/not found|does not exist|10007/i.test(r.stderr + r.stdout)) return []
    throw new ProvisionError(`wrangler secret list failed: ${(r.stderr || r.stdout).trim()}`)
  }
  const start = r.stdout.indexOf('[')
  if (start < 0) return []
  try {
    const arr = JSON.parse(r.stdout.slice(start)) as { name: string }[]
    return arr.map(s => s.name)
  } catch {
    return []
  }
}

export async function putWorkerSecret(name: string, value: string): Promise<void> {
  if (!value) throw new ProvisionError(`refusing to set empty secret ${name}`)
  await wrangler(['secret', 'put', name, ...wranglerConfigArgs()], { stdin: value, echo: false })
}

// ---- the plan (pure) ----------------------------------------------------------------------

export interface SecretPlanInput {
  /** Names the instance file (or the environment) holds a value for — never the values. */
  available: ReadonlySet<string>
  /** Names already on the Worker (`wrangler secret list`). */
  existing: readonly string[]
  /** Optional secrets to copy when set, in order. */
  optional: readonly string[]
  /** Plugin vars marked secret (D31), offered the same way. */
  pluginSecrets?: readonly string[]
  rotate: boolean
  /** D35 `neon`: the Worker also needs DATABASE_URL (the pooled Neon URI). */
  needsDatabaseUrl: boolean
}

export type SecretAction =
  /** Put the value the file holds. */
  | { name: string; action: 'put'; source: 'file' }
  /** Generate a fresh value, write it back to the file FIRST, then put it. */
  | { name: string; action: 'generate' }
  /** Derived by the phase itself (DATABASE_URL from Neon, BOOTSTRAP_ADMIN_EMAILS from the answers). */
  | { name: string; action: 'put'; source: 'derived' }
  | { name: string; action: 'skip'; reason: string }

export interface SecretPlan {
  actions: SecretAction[]
  /** Set when the phase must stop before putting anything — a sentence, no value. */
  refuse?: string
}

/**
 * The OAuth key decides everything else: it seals every Setup credential and OAuth token, so the
 * file is its ONE source of truth. In the file → put it (always: a secret's value cannot be read
 * back, so re-putting is how the Worker is known to match). Not in the file and not on the Worker
 * → generate, write back, put. On the Worker but NOT in the file → refuse: generating would
 * orphan everything the Worker already sealed, so it takes `--rotate` (or restoring the file from
 * its backup). `--rotate` with a key in the file generates a new one too.
 */
export function planSecrets(input: SecretPlanInput): SecretPlan {
  const actions: SecretAction[] = []
  const hasFileKey = input.available.has('OAUTH_ENCRYPTION_KEY')
  const onWorker = input.existing.includes('OAUTH_ENCRYPTION_KEY')
  let refuse: string | undefined
  if (input.rotate) actions.push({ name: 'OAUTH_ENCRYPTION_KEY', action: 'generate' })
  else if (hasFileKey) actions.push({ name: 'OAUTH_ENCRYPTION_KEY', action: 'put', source: 'file' })
  else if (onWorker) {
    refuse =
      'the Worker already holds OAUTH_ENCRYPTION_KEY but the instance file has none. It seals every Setup credential and OAuth token: restore OAUTH_ENCRYPTION_KEY from your backup of the file, or pass --rotate to generate a new one (everything sealed with the old key must then be re-entered — rerun `pnpm provision setup`)'
  } else actions.push({ name: 'OAUTH_ENCRYPTION_KEY', action: 'generate' })

  actions.push({ name: 'BOOTSTRAP_ADMIN_EMAILS', action: 'put', source: 'derived' })
  if (input.needsDatabaseUrl) {
    actions.push(
      input.existing.includes('DATABASE_URL') && !input.rotate
        ? {
            name: 'DATABASE_URL',
            action: 'skip',
            reason: 'already on the Worker (--rotate re-puts)',
          }
        : { name: 'DATABASE_URL', action: 'put', source: 'derived' }
    )
  }
  const seen = new Set(actions.map(a => a.name))
  for (const name of [...input.optional, ...(input.pluginSecrets ?? [])]) {
    if (seen.has(name)) continue
    seen.add(name)
    actions.push(
      input.available.has(name)
        ? { name, action: 'put', source: 'file' }
        : { name, action: 'skip', reason: 'not set' }
    )
  }
  return { actions, ...(refuse ? { refuse } : {}) }
}

/** The plan as lines of NAMES — what `secrets --dry-run` prints. */
export function describeSecretPlan(plan: SecretPlan, existing: readonly string[]): string[] {
  const lines: string[] = []
  const label = (a: SecretAction) =>
    a.action === 'generate'
      ? 'generate → write back to the instance file → put'
      : a.action === 'put'
        ? a.source === 'file'
          ? 'put (from the instance file)'
          : 'put (derived)'
        : `skip (${a.reason})`
  for (const a of plan.actions)
    lines.push(
      `  ${a.name.padEnd(28)} ${label(a)}${existing.includes(a.name) ? ' · on the Worker' : ''}`
    )
  const others = existing.filter(n => !plan.actions.some(a => a.name === n))
  if (others.length) lines.push(`  also on the Worker (left alone): ${others.sort().join(', ')}`)
  if (plan.refuse) lines.push(`  REFUSED: ${plan.refuse}`)
  return lines
}
