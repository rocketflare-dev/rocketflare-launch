/**
 * The coding agents sessions may run (§18.22) — `launch_settings.session_policy.runtimes`, the ONE
 * place these switches live. Not a setup STEP (Claude Code on Launch's key works with nothing set),
 * so it sits after the stepper's cards with no status dot, like the Kit version card.
 *
 * One row per agent: on/off, its model (only priced ones — a session's budget is money), and who
 * pays. Choosing an option that lets people bill their OWN account asks first, in one sentence, about
 * the vendor's terms: the admin is accepting that responsibility. Readiness comes from the server
 * (`sessionAgentStatusSchema`): whether Launch's key for the agent is set, how many people have
 * connected an account, and the image it needs. Saving sends every row; the server merges them into
 * the policy and keeps its budgets. The page keys the card by the stored settings
 * (`codingAgentsKey`), so a save — or another admin's change — starts the drafts afresh, and a
 * background refetch of the same settings does not wipe an edit in progress.
 */
import {
  AGENT_RUNTIMES,
  type AgentRuntimeId,
  type SessionCredentialMode,
} from '@launch/shared/launch-agents'
import type { SessionAgentStatus, SessionAgentsStatus } from '@launch/shared/launch-setup'
import { type FormEvent, type ReactNode, useState } from 'react'
import { ConfirmModal } from '@/ui/components/shared'
import { useUpdateSessionAgents } from '@/ui/hooks/useSetup'
import { stepAnchor } from './StepCard'

const HEADING_ID = 'setup-coding-agents-title'

const WHO_PAYS: Record<SessionCredentialMode, string> = {
  platform: 'Launch',
  user: "The person's own account",
  user_or_platform: 'Either',
}

/** One plain sentence on each vendor's terms for personal accounts in a hosted service. */
export const PERSONAL_ACCOUNT_TERMS: Record<AgentRuntimeId, string> = {
  claude_code:
    "Anthropic's terms restrict storing Claude subscription tokens for use by another service, so letting people connect theirs is your organisation's decision and responsibility.",
  codex:
    "OpenAI requires approval before ChatGPT plans are used through a hosted service like Launch, so letting people connect theirs is your organisation's decision and responsibility.",
}

const KEY_LABEL: Record<SessionAgentStatus['platformKey']['kind'], string> = {
  anthropic_api_key: 'an Anthropic key',
  openai_api_key: 'an OpenAI key',
}

const KEY_ANCHOR: Record<SessionAgentStatus['platformKey']['kind'], string> = {
  anthropic_api_key: stepAnchor('anthropic'),
  openai_api_key: stepAnchor('openai'),
}

interface Draft {
  enabled: boolean
  model: string
  credentialMode: SessionCredentialMode
}

function draftsOf(status: SessionAgentsStatus): Record<AgentRuntimeId, Draft> {
  return Object.fromEntries(
    status.runtimes.map(r => [
      r.runtime,
      { enabled: r.enabled, model: r.model, credentialMode: r.credentialMode },
    ])
  ) as Record<AgentRuntimeId, Draft>
}

const allowsPersonal = (mode: SessionCredentialMode) => mode !== 'platform'

/** The card's React key: the stored settings, so it remounts only when they change. */
export function codingAgentsKey(status: SessionAgentsStatus): string {
  return status.runtimes
    .map(r => `${r.runtime}:${r.enabled}:${r.model}:${r.credentialMode}`)
    .join('|')
}

/** What stands between this agent and a working session — plain lines, the blocking one first. */
function Readiness({ agent, draft }: { agent: SessionAgentStatus; draft: Draft }) {
  const lines: { text: ReactNode; warn?: boolean }[] = []
  if (agent.unavailableOnHost) {
    lines.push({ text: "Cannot run on this deployment's sandbox host.", warn: true })
  }
  if (draft.credentialMode !== 'user') {
    const kind = agent.platformKey.kind
    if (agent.platformKey.source === null) {
      lines.push({
        warn: draft.enabled,
        text: (
          <>
            Needs {KEY_LABEL[kind]} to run on Launch's account.{' '}
            <a className="link" href={`#${KEY_ANCHOR[kind]}`}>
              Set it
            </a>
          </>
        ),
      })
    } else if (agent.platformKey.source === 'secret') {
      lines.push({ text: "Launch's account: the Worker secret." })
    } else {
      lines.push({ text: "Launch's account: key set." })
    }
  }
  if (allowsPersonal(draft.credentialMode) || agent.connectedAccounts > 0) {
    const n = agent.connectedAccounts
    lines.push({
      text:
        n === 0
          ? `Nobody has connected a ${agent.accountLabel} yet (Profile → AI accounts).`
          : `${n} ${n === 1 ? 'person has' : 'people have'} connected a ${agent.accountLabel}.`,
    })
  }
  if (agent.minImage) {
    lines.push({ text: `Needs the ${agent.minImage} session image or later.` })
  }
  if (lines.length === 0) return null
  return (
    <ul className="text-xs space-y-0.5">
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, ordered list rebuilt each render
        <li key={i} className={line.warn ? 'text-warning' : 'text-muted'}>
          {line.text}
        </li>
      ))}
    </ul>
  )
}

export function CodingAgentsCard({ sessionAgents }: { sessionAgents: SessionAgentsStatus }) {
  const update = useUpdateSessionAgents()
  const [drafts, setDrafts] = useState(() => draftsOf(sessionAgents))
  const [confirm, setConfirm] = useState<{
    runtime: AgentRuntimeId
    mode: SessionCredentialMode
  } | null>(null)

  const agents = AGENT_RUNTIMES.map(id =>
    sessionAgents.runtimes.find(r => r.runtime === id)
  ).filter((r): r is SessionAgentStatus => Boolean(r))
  const dirty = agents.some(a => {
    const d = drafts[a.runtime]
    return d.enabled !== a.enabled || d.model !== a.model || d.credentialMode !== a.credentialMode
  })
  const noneEnabled = agents.every(a => !drafts[a.runtime].enabled)

  function set(runtime: AgentRuntimeId, patch: Partial<Draft>) {
    setDrafts(prev => ({ ...prev, [runtime]: { ...prev[runtime], ...patch } }))
  }

  function chooseMode(runtime: AgentRuntimeId, mode: SessionCredentialMode) {
    // Opening personal accounts up is the one choice that asks first.
    if (allowsPersonal(mode) && !allowsPersonal(drafts[runtime].credentialMode)) {
      setConfirm({ runtime, mode })
      return
    }
    set(runtime, { credentialMode: mode })
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (noneEnabled) return
    update.mutate({
      runtimes: Object.fromEntries(agents.map(a => [a.runtime, drafts[a.runtime]])),
    })
  }

  const confirming = confirm ? agents.find(a => a.runtime === confirm.runtime) : undefined

  return (
    <section
      id={stepAnchor('coding-agents')}
      aria-labelledby={HEADING_ID}
      className="surface-panel p-5 space-y-4 scroll-mt-6"
    >
      <header className="min-w-0">
        <h2 id={HEADING_ID} className="text-base font-semibold leading-6">
          Coding agents
        </h2>
        <div className="text-sm text-secondary mt-0.5">
          The agents people can run in a coding session, the model each one uses, and whose account
          pays for it. Changes apply to new sessions; sessions already running keep what they
          started with.
        </div>
      </header>

      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="divide-y divide-base-300">
          {agents.map(agent => {
            const draft = drafts[agent.runtime]
            const id = `coding-agent-${agent.runtime}`
            return (
              <div
                key={agent.runtime}
                className="grid gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[10rem_1fr_1fr] sm:items-start"
              >
                <label className="flex items-center gap-2 text-sm font-medium" htmlFor={id}>
                  <input
                    id={id}
                    type="checkbox"
                    className="toggle toggle-sm"
                    checked={draft.enabled}
                    onChange={e => set(agent.runtime, { enabled: e.target.checked })}
                  />
                  {agent.label}
                </label>
                <div className="space-y-1">
                  <label htmlFor={`${id}-model`} className="block text-xs text-muted">
                    Model
                  </label>
                  <select
                    id={`${id}-model`}
                    className="select select-bordered select-sm w-full font-mono"
                    value={draft.model}
                    disabled={!draft.enabled}
                    onChange={e => set(agent.runtime, { model: e.target.value })}
                  >
                    {agent.models.map(m => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label htmlFor={`${id}-pays`} className="block text-xs text-muted">
                    Who pays
                  </label>
                  <select
                    id={`${id}-pays`}
                    className="select select-bordered select-sm w-full"
                    value={draft.credentialMode}
                    disabled={!draft.enabled}
                    onChange={e =>
                      chooseMode(agent.runtime, e.target.value as SessionCredentialMode)
                    }
                  >
                    {(['platform', 'user', 'user_or_platform'] as const).map(mode => (
                      <option key={mode} value={mode}>
                        {WHO_PAYS[mode]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sm:col-start-2 sm:col-span-2">
                  <Readiness agent={agent} draft={draft} />
                </div>
              </div>
            )
          })}
        </div>

        {noneEnabled && (
          <p className="text-sm text-warning" role="status">
            Keep at least one agent on, or nobody can start a session.
          </p>
        )}
        {update.error && (
          <p className="text-sm text-error" role="alert">
            {update.error.message}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            className="btn btn-sm btn-primary"
            disabled={!dirty || noneEnabled || update.isPending}
          >
            Save
          </button>
          {dirty && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={update.isPending}
              onClick={() => setDrafts(draftsOf(sessionAgents))}
            >
              Discard changes
            </button>
          )}
        </div>
      </form>

      <ConfirmModal
        isOpen={confirm !== null}
        title={
          confirming ? `Let people use their own ${confirming.accountLabel}?` : 'Personal accounts'
        }
        message={confirm ? PERSONAL_ACCOUNT_TERMS[confirm.runtime] : ''}
        confirmText="Accept and allow"
        confirmButtonClass="btn-warning"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm) set(confirm.runtime, { credentialMode: confirm.mode })
          setConfirm(null)
        }}
      />
    </section>
  )
}
