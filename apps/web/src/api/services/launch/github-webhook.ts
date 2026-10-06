/**
 * The GitHub App webhook's front half (issue #19): what `POST /api/github/webhook` does before it
 * enqueues. The back half — mapping a delivery to the landings and releases waiting on it, and
 * waking them — is the `github.event` job (`services/sessions/github-events.ts`).
 *
 * - **`verifyGitHubSignature`**: `X-Hub-Signature-256` is `sha256=<hex HMAC-SHA256 of the raw body
 *   under the webhook secret>`. Checked with WebCrypto's `subtle.verify('HMAC', …)`, which compares
 *   in constant time — never a string `===` on the hex. Anything malformed is simply "not valid".
 * - **`toGitHubEventPayload`**: the delivery reduced to its subject (`githubEventPayloadSchema`),
 *   or null for an event or action no wait reads — those are answered and dropped, never queued.
 *   Kept: a check run or workflow run that COMPLETED (a landing's CI, the merge commit's `Gate`, the
 *   tag's deploy run); a PR closed, reopened or pushed to; a push that is not a branch delete; any
 *   release action but a delete.
 * - **`claimGitHubDelivery`**: the dedupe — one `github_webhook_deliveries` row per
 *   `X-GitHub-Delivery`, by `INSERT … ON CONFLICT DO NOTHING RETURNING`; `releaseGitHubDelivery`
 *   gives it back when the enqueue failed, so GitHub's retry is not mistaken for a duplicate.
 */
import {
  GITHUB_WEBHOOK_EVENTS,
  type GitHubEventPayload,
  type GitHubWebhookEvent,
  githubEventPayloadSchema,
} from '@launch/shared/launch-github'
import { eq, lt } from 'drizzle-orm'
import { affected, type Database } from '../../../db/client'
import { GITHUB_DELIVERY_RETENTION_DAYS, githubWebhookDeliveries } from '../../../db/schema'

const SIGNATURE_PREFIX = 'sha256='
const encoder = new TextEncoder()

/** `hex` as bytes, or null when it is not an even-length run of hex digits. Pure. */
function hexBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Whether `signature` (the `X-Hub-Signature-256` header) is the HMAC-SHA256 of `body` under
 * `secret`. Constant-time (`crypto.subtle.verify`); false for a missing, malformed or wrong one.
 */
export async function verifyGitHubSignature(
  secret: string,
  body: BufferSource,
  signature: string | null | undefined
): Promise<boolean> {
  if (!secret || !signature?.startsWith(SIGNATURE_PREFIX)) return false
  const mac = hexBytes(signature.slice(SIGNATURE_PREFIX.length))
  // SHA-256 is 32 bytes; anything else cannot match and is not worth a verify.
  if (!mac || mac.length !== 32) return false
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  return crypto.subtle.verify('HMAC', key, mac, body)
}

/** `X-Hub-Signature-256` for `body` under `secret` — what GitHub sends (tests, local tooling). */
export async function signGitHubPayload(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)))
  return `${SIGNATURE_PREFIX}${Array.from(mac, b => b.toString(16).padStart(2, '0')).join('')}`
}

export function isGitHubWebhookEvent(event: string): event is GitHubWebhookEvent {
  return (GITHUB_WEBHOOK_EVENTS as readonly string[]).includes(event)
}

// ---- reducing a delivery to its subject --------------------------------------------------------

type Json = Record<string, unknown>

const obj = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null)

/** The numbers of a `pull_requests` array (a check run's, a workflow run's). Pure. */
function prNumbersOf(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  const out: number[] = []
  for (const pr of v) {
    const n = int(obj(pr)?.number)
    if (n !== null && n > 0 && !out.includes(n)) out.push(n)
  }
  return out.slice(0, 50)
}

/** `refs/heads/x` → branch `x`, `refs/tags/v1` → tag `v1`, anything else → null. Pure. */
function splitRef(ref: string | null): { ref: string; refKind: 'branch' | 'tag' } | null {
  if (ref?.startsWith('refs/heads/')) return { ref: ref.slice(11), refKind: 'branch' }
  if (ref?.startsWith('refs/tags/')) return { ref: ref.slice(10), refKind: 'tag' }
  return null
}

const KEPT_PR_ACTIONS = new Set(['closed', 'reopened', 'synchronize'])

/**
 * One delivery as the `github.event` job's payload, or null when no wait reads this event or
 * action (or the payload names no repository). Pure.
 */
export function toGitHubEventPayload(
  event: string,
  deliveryId: string,
  body: unknown
): GitHubEventPayload | null {
  if (!isGitHubWebhookEvent(event)) return null
  const root = obj(body)
  const repo = obj(root?.repository)
  const owner = str(obj(repo?.owner)?.login)
  const name = str(repo?.name)
  const repoId = int(repo?.id)
  if (!root || !owner || !name || repoId === null) return null
  const action = str(root.action)
  let headSha: string | null = null
  let ref: { ref: string; refKind: 'branch' | 'tag' | null } | null = null
  let prNumbers: number[] = []

  switch (event) {
    case 'check_run': {
      if (action !== 'completed') return null
      const run = obj(root.check_run)
      headSha = str(run?.head_sha)
      const branch = str(obj(run?.check_suite)?.head_branch)
      // A tag push's suite names the TAG here: GitHub does not say which it is.
      ref = branch ? { ref: branch, refKind: null } : null
      prNumbers = prNumbersOf(run?.pull_requests)
      break
    }
    case 'workflow_run': {
      if (action !== 'completed') return null
      const run = obj(root.workflow_run)
      headSha = str(run?.head_sha)
      const branch = str(run?.head_branch)
      ref = branch ? { ref: branch, refKind: null } : null
      prNumbers = prNumbersOf(run?.pull_requests)
      break
    }
    case 'pull_request': {
      if (!action || !KEPT_PR_ACTIONS.has(action)) return null
      const pr = obj(root.pull_request)
      const number = int(root.number) ?? int(pr?.number)
      if (number === null || number <= 0) return null
      headSha = str(obj(pr?.head)?.sha)
      prNumbers = [number]
      break
    }
    case 'push': {
      if (root.deleted === true) return null
      ref = splitRef(str(root.ref))
      headSha = str(root.after)
      break
    }
    case 'release': {
      if (action === 'deleted') return null
      const tag = str(obj(root.release)?.tag_name)
      ref = tag ? { ref: tag, refKind: 'tag' } : null
      break
    }
  }

  const parsed = githubEventPayloadSchema.safeParse({
    deliveryId,
    event,
    action,
    installationId: int(obj(root.installation)?.id),
    repository: { id: String(repoId), owner, name },
    headSha,
    ref: ref?.ref ?? null,
    refKind: ref?.refKind ?? null,
    prNumbers,
  })
  return parsed.success ? parsed.data : null
}

// ---- the delivery claim ------------------------------------------------------------------------

/** Claim `deliveryId`: true for the first caller, false for every redelivery of it. */
export async function claimGitHubDelivery(
  db: Database,
  deliveryId: string,
  event: string
): Promise<boolean> {
  const claimed = await db
    .insert(githubWebhookDeliveries)
    .values({ deliveryId, event })
    .onConflictDoNothing()
    .returning({ deliveryId: githubWebhookDeliveries.deliveryId })
  return claimed.length > 0
}

/** Give a claim back (the enqueue failed): GitHub's retry may then claim it again. */
export async function releaseGitHubDelivery(db: Database, deliveryId: string): Promise<void> {
  await db.delete(githubWebhookDeliveries).where(eq(githubWebhookDeliveries.deliveryId, deliveryId))
}

/** The nightly prune: delivery ids past {@link GITHUB_DELIVERY_RETENTION_DAYS}. */
export async function pruneGitHubDeliveries(db: Database, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - GITHUB_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  return affected(
    await db.delete(githubWebhookDeliveries).where(lt(githubWebhookDeliveries.receivedAt, cutoff))
  )
}
