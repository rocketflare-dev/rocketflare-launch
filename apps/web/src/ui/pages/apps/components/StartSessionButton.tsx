/**
 * The app page's start-a-session button (§18.22) — the header's Build it and the Sessions tab's
 * Start session are both this one component, so they offer the same agents and act on the same
 * remembered choice.
 *
 * - With no choice to make (`agentPickerVisible` false, or the offer not loaded) it is a plain
 *   button and starts exactly the P3 session, `{}`.
 * - Otherwise it is a SPLIT button: the main part starts a session on the current choice in one
 *   click (named for it — "Build it with Pi"); the caret ("Choose coding agent") opens a menu of
 *   every enabled agent with who pays for it, and picking one starts the session on it and
 *   remembers it — per person, in localStorage — for both buttons. What the choice IS lives in
 *   the pure `agentChoice.ts`.
 *
 * The caller owns the start (`useWarmStartSession`) and says what a refusal means; this component
 * only decides the request body.
 */
import { CheckIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import { AGENT_RUNTIME_LABELS } from '@launch/shared/launch-agents'
import type { CreateSessionRequest } from '@launch/shared/launch-sessions'
import { type ComponentType, type SVGProps, useCallback, useRef } from 'react'
import { useAgentAccounts } from '@/ui/hooks/useAgentAccounts'
import { useAuth } from '@/ui/hooks/useAuth'
import { useLocalStoragePreference } from '@/ui/hooks/useLocalStoragePreference'
import {
  type AgentChoice,
  agentChoiceOptions,
  agentChoiceStorageKey,
  formatAgentChoice,
  parseAgentChoice,
  resolveAgentChoice,
  sameChoice,
  startRequestFor,
} from './agentChoice'

const identity = (value: string) => value

/**
 * The offer, the current choice and how to change it — shared by every start button through one
 * localStorage key per person.
 */
export function useAgentChoice(enabled: boolean) {
  const accounts = useAgentAccounts(enabled)
  const { user } = useAuth()
  const [raw, setRaw] = useLocalStoragePreference<string>(
    agentChoiceStorageKey(user?.id ?? 'anonymous'),
    '',
    identity,
    identity
  )
  const data = accounts.data
  const choice = resolveAgentChoice(data, parseAgentChoice(raw))
  const remember = useCallback((next: AgentChoice) => setRaw(formatAgentChoice(next)), [setRaw])
  return {
    choice,
    options: choice && data ? agentChoiceOptions(data) : [],
    remember,
    requestFor: (picked: AgentChoice | null) => startRequestFor(data, picked),
  }
}

export function StartSessionButton({
  label,
  icon: Icon,
  hero = false,
  size = 'md',
  enabled = true,
  pending,
  onStart,
}: {
  /** What the button does ("Build it", "Start session"); the agent is added to its name. */
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  /** The view's one `.btn-flame` (docs/DESIGN.md). */
  hero?: boolean
  size?: 'sm' | 'md'
  /** Load the offer at all (the caller may start sessions). */
  enabled?: boolean
  pending: boolean
  onStart: (request: CreateSessionRequest) => void
}) {
  const { choice, options, remember, requestFor } = useAgentChoice(enabled)
  const ref = useRef<HTMLDetailsElement>(null)
  const tone = hero ? 'btn-primary btn-flame' : ''
  const sizeClass = size === 'sm' ? 'btn-sm' : ''
  const current = options.find(o => sameChoice(choice, o.choice))
  const name = choice ? `${label} with ${AGENT_RUNTIME_LABELS[choice.runtime]}` : label

  const main = (
    <button
      type="button"
      className={`btn ${sizeClass} gap-1.5 ${tone} ${choice ? 'rounded-r-none' : ''}`}
      disabled={pending}
      aria-label={name}
      title={current ? `${current.label} — ${current.billing}` : undefined}
      onClick={() => onStart(requestFor(choice))}
    >
      {pending ? (
        <span className="loading loading-spinner loading-xs" />
      ) : (
        <Icon className="w-4 h-4" aria-hidden="true" />
      )}
      {label}
    </button>
  )
  if (!choice) return main

  const pick = (picked: AgentChoice) => {
    ref.current?.removeAttribute('open')
    remember(picked)
    onStart(requestFor(picked))
  }

  return (
    // One control in two parts: the group carries what the main part does.
    <div role="group" aria-label={name} className="inline-flex">
      {main}
      <details ref={ref} className="dropdown dropdown-end">
        <summary
          className={`btn ${sizeClass} ${tone} list-none rounded-l-none border-l-base-content/20 px-2 ${pending ? 'btn-disabled' : ''}`}
          aria-label="Choose coding agent"
        >
          <ChevronDownIcon className="w-4 h-4" aria-hidden="true" />
        </summary>
        <ul className="dropdown-content popover-surface z-50 mt-1 w-72 p-1.5 space-y-0.5">
          {options.map(option => {
            const selected = sameChoice(choice, option.choice)
            return (
              <li key={formatAgentChoice(option.choice)}>
                <button
                  type="button"
                  className="flex w-full items-start gap-2 rounded px-2.5 py-1.5 text-left text-sm hover:bg-base-200"
                  aria-label={`${option.label} — ${option.billing}`}
                  aria-current={selected ? 'true' : undefined}
                  disabled={pending}
                  onClick={() => pick(option.choice)}
                >
                  <CheckIcon
                    className={`mt-0.5 h-4 w-4 shrink-0 ${selected ? '' : 'invisible'}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{option.label}</span>
                    <span className="block text-xs text-muted">{option.billing}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </details>
    </div>
  )
}
