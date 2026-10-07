/**
 * Personal AI accounts (§18.22) — what the UI SAYS about them, pure, in one place: a credential's
 * status line, the runtimes a person may connect, and Home's onboarding decision — a prominent
 * "Connect your coding agent" section while nothing usable is connected, one quiet line once
 * something is (`tests/ui/agent-accounts.test.tsx`).
 */
import {
  AGENT_CREDENTIAL_EXPIRY_WARNING_DAYS,
  type AgentAccountsResponse,
  type AgentCredential,
  type AgentRuntimeId,
  type AgentRuntimeOption,
} from '@launch/shared/launch-agents'
import { formatDate } from '@/ui/lib/format'

const DAY_MS = 24 * 60 * 60 * 1000

/** What a connected credential is doing, in a few words. Pure. */
export function credentialStatusText(
  credential: AgentCredential | undefined,
  now: Date = new Date()
): { text: string; tone: 'muted' | 'warning' } {
  if (!credential) return { text: 'Not connected', tone: 'muted' }
  if (credential.status === 'needs_login') return { text: 'Needs reconnecting', tone: 'warning' }
  if (credential.expiresAt) {
    const left = credential.expiresAt.getTime() - now.getTime()
    if (left <= 0) return { text: 'Expired — reconnect it', tone: 'warning' }
    if (left < AGENT_CREDENTIAL_EXPIRY_WARNING_DAYS * DAY_MS) {
      return { text: `Expires ${formatDate(credential.expiresAt)}`, tone: 'warning' }
    }
  }
  return { text: credential.inUse ? 'Connected · in use' : 'Connected', tone: 'muted' }
}

/** A credential a session can spend now: active and not past its expiry. Pure. */
export function isUsableCredential(credential: AgentCredential | undefined, now = new Date()) {
  if (!credential || credential.status !== 'active') return false
  return !credential.expiresAt || credential.expiresAt.getTime() > now.getTime()
}

/** The runtimes a person may connect an account for. Pure. */
export function connectableRuntimes(runtimes: readonly AgentRuntimeOption[]) {
  return runtimes.filter(r => r.enabled && r.userCredentials)
}

/** One line on what connecting each account gives you; null: no personal account (Pi). */
export const AGENT_ACCOUNT_PITCH: Record<AgentRuntimeId, string | null> = {
  claude_code: 'Run Claude Code sessions on your Claude Pro or Max subscription.',
  codex: 'Run Codex sessions on your ChatGPT Plus, Pro or Business plan.',
  pi: null,
}

export interface AgentAccountRow {
  option: AgentRuntimeOption
  credential: AgentCredential | undefined
  status: { text: string; tone: 'muted' | 'warning' }
  usable: boolean
  /** Connected, but the provider refused it or it ran out: Reconnect. */
  reconnect: boolean
}

export type AgentOnboarding =
  /** Nobody may connect an account here (the default deployment), or it has not loaded. */
  | { state: 'hidden' }
  /**
   * Nothing usable connected: Home leads with it. `required` — no session can run on the
   * organisation's key, so connecting is the only way to start one.
   */
  | { state: 'connect'; rows: AgentAccountRow[]; required: boolean }
  /** At least one usable account: one quiet line. */
  | { state: 'connected'; rows: AgentAccountRow[] }

/** Home's onboarding decision. Pure. */
export function agentOnboarding(
  data: AgentAccountsResponse | undefined,
  now: Date = new Date()
): AgentOnboarding {
  if (!data) return { state: 'hidden' }
  const offered = connectableRuntimes(data.runtimes)
  if (offered.length === 0) return { state: 'hidden' }
  const rows = offered.map((option): AgentAccountRow => {
    const credential = data.credentials.find(c => c.runtime === option.runtime)
    const status = credentialStatusText(credential, now)
    return {
      option,
      credential,
      status,
      usable: isUsableCredential(credential, now),
      reconnect: Boolean(credential) && !isUsableCredential(credential, now),
    }
  })
  if (rows.some(r => r.usable)) return { state: 'connected', rows }
  const required = !data.runtimes.some(r => r.enabled && r.credentialMode !== 'user')
  return { state: 'connect', rows, required }
}
