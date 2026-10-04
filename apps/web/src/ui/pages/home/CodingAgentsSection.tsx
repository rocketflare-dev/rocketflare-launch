/**
 * Home: the person's own coding-agent accounts (§18.22) — a key step of onboarding, so it is where
 * people land rather than in Profile. Driven by `agentOnboarding` (`agent-accounts/agentAccountsModel`):
 *
 * - **Nothing usable connected** → `CodingAgentsOnboarding`, at the TOP of Home: "Connect your coding
 *   agent", one row per account the organisation allows (what it gives you, and Connect). The
 *   sentence above the rows says whether connecting is the only way to start a session or an
 *   alternative to the organisation's key.
 * - **One connected** → `CodingAgentsLine`, one quiet line, still first on Home: each account's
 *   state, Reconnect where it needs it, Connect for the other, Disconnect.
 * - **Not offered** (the default deployment: no runtime lets a person pay) → nothing at all.
 *
 * Home reads the one `useAgentAccounts` query and places whichever applies.
 */
import type { AgentAccountsResponse } from '@launch/shared/launch-agents'
import { AGENT_ICONS } from '@/ui/components/icons/AgentIcons'
import { showToast } from '@/ui/components/shared'
import { useDisconnectAgentAccount } from '@/ui/hooks/useAgentAccounts'
import {
  AGENT_ACCOUNT_PITCH,
  type AgentAccountRow,
  type AgentOnboarding,
} from '../agent-accounts/agentAccountsModel'
import { useAgentConnect } from '../agent-accounts/useAgentConnect'
import { HomeSection } from './HomeSection'

function StartError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p className="text-sm text-warning px-5 pb-4" role="status">
      {message}
    </p>
  )
}

/** Nothing usable connected: lead the page with it. */
export function CodingAgentsOnboarding({
  data,
  onboarding,
}: {
  data: AgentAccountsResponse
  onboarding: Extract<AgentOnboarding, { state: 'connect' }>
}) {
  const { connect, inFlight, starting, startError, modal } = useAgentConnect(data)
  const several = onboarding.rows.length > 1
  return (
    <HomeSection id="home-coding-agents" title="Connect your coding agent">
      <div className="surface-panel p-0 overflow-hidden">
        <p className="px-5 pt-4 pb-3 text-sm text-secondary">
          {onboarding.required
            ? `Coding sessions run on your own AI subscription. Connect ${several ? 'one' : 'it'} to start building.`
            : `Your coding sessions can run on your own AI subscription instead of the organisation’s key.`}
        </p>
        <ul className="divide-y divide-[color:var(--border-subtle)] border-t border-[color:var(--border-subtle)]">
          {onboarding.rows.map(row => {
            const Icon = AGENT_ICONS[row.option.runtime]
            return (
              <li
                key={row.option.runtime}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4"
              >
                <Icon className="w-8 h-8 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{row.option.label}</div>
                  <div className="text-sm text-muted">
                    {row.reconnect ? (
                      <span className="text-warning">
                        Your {row.option.accountLabel}: {row.status.text.toLowerCase()}.
                      </span>
                    ) : (
                      AGENT_ACCOUNT_PITCH[row.option.runtime]
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={starting}
                  onClick={() => connect(row.option.runtime)}
                >
                  {inFlight(row.option.runtime)
                    ? 'Continue sign-in'
                    : `${row.reconnect ? 'Reconnect' : 'Connect'} ${row.option.accountLabel}`}
                </button>
              </li>
            )
          })}
        </ul>
        <StartError message={startError} />
      </div>
      {modal}
    </HomeSection>
  )
}

function AccountItem({
  row,
  onConnect,
  connectLabel,
  starting,
}: {
  row: AgentAccountRow
  onConnect: () => void
  connectLabel: string
  starting: boolean
}) {
  const disconnect = useDisconnectAgentAccount()
  const { option, credential, status } = row
  const Icon = AGENT_ICONS[option.runtime]
  if (!credential) {
    return (
      <button
        type="button"
        className="link link-hover text-sm inline-flex items-center gap-1.5"
        disabled={starting}
        onClick={onConnect}
      >
        <Icon className="w-4 h-4" />
        {connectLabel}
      </button>
    )
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 text-sm">
      <Icon className="w-4 h-4" />
      <span>
        {option.accountLabel}
        <span className={status.tone === 'warning' ? 'text-warning' : 'text-muted'}>
          {' '}
          · {status.text}
        </span>
      </span>
      {row.reconnect && (
        <button type="button" className="link text-sm" disabled={starting} onClick={onConnect}>
          Reconnect
        </button>
      )}
      <button
        type="button"
        className="link link-hover text-sm text-muted"
        disabled={disconnect.isPending}
        onClick={() =>
          disconnect.mutate(option.runtime, {
            onSuccess: () => showToast(`${option.accountLabel} disconnected`, 'success'),
          })
        }
      >
        Disconnect
      </button>
    </span>
  )
}

/** Something usable connected: one quiet line. */
export function CodingAgentsLine({
  data,
  onboarding,
}: {
  data: AgentAccountsResponse
  onboarding: Extract<AgentOnboarding, { state: 'connected' }>
}) {
  const { connect, inFlight, starting, startError, modal } = useAgentConnect(data)
  return (
    <section
      aria-label="Your coding agent accounts"
      className="surface-panel py-3.5 flex flex-wrap items-center gap-x-6 gap-y-2"
      data-testid="home-coding-agents-line"
    >
      <span className="text-sm text-muted">Your AI accounts</span>
      {onboarding.rows.map(row => (
        <AccountItem
          key={row.option.runtime}
          row={row}
          starting={starting}
          onConnect={() => connect(row.option.runtime)}
          connectLabel={
            inFlight(row.option.runtime)
              ? `Continue connecting your ${row.option.accountLabel}`
              : `Connect your ${row.option.accountLabel}`
          }
        />
      ))}
      {startError && (
        <span className="text-sm text-warning" role="status">
          {startError}
        </span>
      )}
      {modal}
    </section>
  )
}
