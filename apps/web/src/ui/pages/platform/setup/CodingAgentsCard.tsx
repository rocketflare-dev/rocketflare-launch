/**
 * The coding agents sessions may run (§18.22) — `launch_settings.session_policy.runtimes`, the ONE
 * place these switches live. The first panel of Settings → Platform → Coding agents
 * (`pages/platform/CodingAgents.tsx`), above Launch's keys for the agents.
 *
 * A table, one row per agent: on/off, its model (only priced ones — a session's budget is money),
 * who pays, and one status line. Choosing an option that lets people bill their OWN account asks first, in one sentence, about
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

const KEY_SECRET: Record<SessionAgentStatus['platformKey']['kind'], string> = {
  anthropic_api_key: 'ANTHROPIC_API_KEY',
  openai_api_key: 'OPENAI_API_KEY',
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

/** The agent's state in one line (the blocking reason first), plus a quieter detail line. */
function AgentStatus({ agent, draft }: { agent: SessionAgentStatus; draft: Draft }) {
  const usesLaunchKey = draft.credentialMode !== 'user'
  const kind = agent.platformKey.kind
  const keyMissing = usesLaunchKey && agent.platformKey.source === null

  let headline: ReactNode
  let tone = 'text-success'
  if (!draft.enabled) {
    headline = 'Off'
    tone = 'text-muted'
  } else if (keyMissing) {
    headline = (
      <>
        Needs {KEY_LABEL[kind]}{' '}
        <a className="link" href={`#${KEY_ANCHOR[kind]}`}>
          Set it
        </a>
      </>
    )
    tone = 'text-warning'
  } else {
    headline = 'Ready'
  }

  const details: string[] = []
  if (usesLaunchKey && agent.platformKey.source === 'secret') {
    details.push(`Launch pays with the ${KEY_SECRET[kind]} secret`)
  } else if (usesLaunchKey && agent.platformKey.source === 'credential') {
    details.push('Launch pays with the saved key')
  }
  if (allowsPersonal(draft.credentialMode) || agent.connectedAccounts > 0) {
    const n = agent.connectedAccounts
    details.push(
      n === 0
        ? `No one has connected a ${agent.accountLabel} yet`
        : `${n} ${n === 1 ? 'person has' : 'people have'} connected a ${agent.accountLabel}`
    )
  }

  return (
    <div className="text-sm leading-5">
      <div className={tone}>{headline}</div>
      {details.length > 0 && <div className="text-xs text-muted">{details.join(' · ')}</div>}
    </div>
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
  // The server's own rule (`runtimeOffer`): nothing on, nobody can start a session.
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
      className="surface-panel p-0 overflow-hidden scroll-mt-6"
    >
      <header className="px-5 pt-5 pb-3 min-w-0">
        <h2 id={HEADING_ID} className="text-base font-semibold leading-6">
          Coding agents
        </h2>
        <p className="text-sm text-secondary mt-0.5">
          Which agents people can run in a coding session, the model each one uses, and who pays.
        </p>
      </header>

      <form onSubmit={onSubmit}>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-48">Agent</th>
                <th className="w-64">Model</th>
                <th className="w-64">Who pays</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {agents.map(agent => {
                const draft = drafts[agent.runtime]
                const id = `coding-agent-${agent.runtime}`
                return (
                  <tr key={agent.runtime}>
                    <td className="py-3">
                      <label className="flex items-center gap-3 font-medium" htmlFor={id}>
                        <input
                          id={id}
                          type="checkbox"
                          className="toggle toggle-sm"
                          checked={draft.enabled}
                          onChange={e => set(agent.runtime, { enabled: e.target.checked })}
                        />
                        {agent.label}
                      </label>
                    </td>
                    <td className="py-3">
                      <label htmlFor={`${id}-model`} className="sr-only">
                        Model
                      </label>
                      <select
                        id={`${id}-model`}
                        className="select select-sm w-full font-mono"
                        value={draft.model}
                        onChange={e => set(agent.runtime, { model: e.target.value })}
                      >
                        {agent.models.map(m => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3">
                      <label htmlFor={`${id}-pays`} className="sr-only">
                        Who pays
                      </label>
                      <select
                        id={`${id}-pays`}
                        className="select select-sm w-full"
                        value={draft.credentialMode}
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
                    </td>
                    <td className="py-3">
                      <AgentStatus agent={agent} draft={draft} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <p className="text-xs text-muted">
            Changes apply to new sessions. Sessions already running keep what they started with.
          </p>
          <div className="flex items-center gap-2">
            {noneEnabled && (
              <span className="text-sm text-warning" role="status">
                Keep at least one agent on, or nobody can start a session.
              </span>
            )}
            {update.error && (
              <span className="text-sm text-error" role="alert">
                {update.error.message}
              </span>
            )}
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
            <button
              type="submit"
              className="btn btn-sm btn-primary"
              disabled={!dirty || noneEnabled || update.isPending}
            >
              Save
            </button>
          </div>
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
