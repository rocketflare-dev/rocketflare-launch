/**
 * Claude's sign-in body (§18.22-A): Anthropic's own page in a new tab, then the code it shows
 * pasted back here. The code is `<code>#<state>` — checked before it is sent (the server's driver
 * checks it again), so a half-copied code is caught here rather than after a round trip.
 *
 * Launch runs Claude Code's own `claude setup-token` in a throwaway sandbox; the person signs in
 * with Anthropic, never with Launch, and what comes back is a token Launch stores encrypted.
 */
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import { submitAgentLoginCodeRequestSchema } from '@launch/shared/launch-agents'
import { useState } from 'react'
import { FieldError } from '@/ui/components/shared'
import { agentLoginStatusText } from './GenericLogin'
import type { AgentLoginBodyProps } from './registry'

/** What Anthropic's code page shows: `<code>#<state>`, no spaces. Pure. */
export function isClaudeLoginCode(code: string): boolean {
  return /^[^\s#]+#[^\s#]+$/.test(code.trim())
}

/** Why a paste is refused, or null when it may be sent. Pure. */
export function claudeCodeProblem(code: string): string | null {
  const parsed = submitAgentLoginCodeRequestSchema.safeParse({ code })
  if (!parsed.success) return 'Paste the code Anthropic showed you.'
  if (!isClaudeLoginCode(parsed.data.code)) {
    return 'That looks incomplete. Copy the whole code from Anthropic’s page — it has a # in the middle.'
  }
  return null
}

export const CLAUDE_LOGIN_NOTE =
  'You sign in with Anthropic, on Anthropic’s page. Launch stores the resulting token encrypted and uses it only for your own coding sessions.'

export function ClaudeLogin({ login, onSubmitCode, submitting, submitError }: AgentLoginBodyProps) {
  const [code, setCode] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const waiting = login.status === 'awaiting_user'
  const busy =
    login.status === 'starting' || login.status === 'submitting' || login.status === 'finishing'
  const ended = login.status === 'failed' || login.status === 'expired'

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const why = claudeCodeProblem(code)
    setProblem(why)
    if (!why) onSubmitCode(code.trim())
  }

  return (
    <div className="space-y-4">
      <p role="status" className={`text-sm flex items-center gap-2 ${ended ? 'text-error' : ''}`}>
        {busy && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
        {agentLoginStatusText(login, 'Anthropic')}
      </p>

      {waiting && login.verificationUrl && (
        <ol className="space-y-4 text-sm list-decimal pl-5">
          <li className="space-y-2">
            <div>Sign in to your Claude account and approve access.</div>
            <a
              href={login.verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary btn-sm gap-1.5"
            >
              Open Anthropic sign-in
              <ArrowTopRightOnSquareIcon className="h-4 w-4" />
            </a>
          </li>
          <li>
            <form onSubmit={submit} className="space-y-2" noValidate>
              <label htmlFor="claude-login-code" className="block">
                Code from Anthropic
              </label>
              <div className="flex gap-2">
                <input
                  id="claude-login-code"
                  className="input input-sm w-full font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste the code here"
                  aria-invalid={Boolean(problem ?? submitError)}
                  value={code}
                  onChange={e => setCode(e.target.value)}
                />
                <button type="submit" className="btn btn-sm" disabled={submitting}>
                  {submitting ? (
                    <span className="loading loading-spinner loading-xs" />
                  ) : (
                    'Send code'
                  )}
                </button>
              </div>
              <FieldError message={problem ?? submitError ?? undefined} />
            </form>
          </li>
        </ol>
      )}

      <p className="text-xs text-muted">{CLAUDE_LOGIN_NOTE}</p>
    </div>
  )
}
