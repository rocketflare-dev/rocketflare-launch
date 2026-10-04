/**
 * The body of the sign-in modal for any runtime (§18.22): where the login stands, the provider's
 * page to open (a new tab — Launch never sees the password), the device code to type there, or a
 * field to paste the provider's code back. Each runtime's own component (`ClaudeLogin`,
 * `CodexLogin`) wraps this with its copy; streams A and B replace those, not this.
 */
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import { submitAgentLoginCodeRequestSchema } from '@launch/shared/launch-agents'
import { useState } from 'react'
import { FieldError } from '@/ui/components/shared'
import type { AgentLoginBodyProps } from './registry'

/** What the person reads for each status. Pure. */
export function agentLoginStatusText(
  login: AgentLoginBodyProps['login'],
  providerName: string
): string {
  switch (login.status) {
    case 'starting':
      return `Starting ${providerName}’s sign-in…`
    case 'awaiting_user':
      return login.needsCode
        ? `Sign in on ${providerName}’s page, then paste the code it shows you below.`
        : `Sign in on ${providerName}’s page and enter the code shown here.`
    case 'submitting':
      return 'Sending your code…'
    case 'finishing':
      return 'Finishing…'
    case 'succeeded':
      return 'Connected.'
    case 'cancelled':
      return 'Cancelled.'
    case 'expired':
    case 'failed':
      return login.error ?? 'The sign-in did not finish. Start it again.'
  }
}

export function GenericLogin({
  login,
  providerName,
  onSubmitCode,
  submitting,
  submitError,
  note,
}: AgentLoginBodyProps & { providerName: string; note?: string }) {
  const [code, setCode] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const waiting = login.status === 'awaiting_user'

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const parsed = submitAgentLoginCodeRequestSchema.safeParse({ code })
    if (!parsed.success) {
      setProblem('Paste the code the sign-in page showed you')
      return
    }
    setProblem(null)
    onSubmitCode(parsed.data.code)
  }

  return (
    <div className="space-y-4">
      <p role="status" className="text-sm">
        {agentLoginStatusText(login, providerName)}
      </p>
      {waiting && login.verificationUrl && (
        <a
          href={login.verificationUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-primary btn-sm gap-1.5"
        >
          Open {providerName} sign-in
          <ArrowTopRightOnSquareIcon className="h-4 w-4" />
        </a>
      )}
      {waiting && login.userCode && (
        <div>
          <div className="text-xs text-muted">Your code</div>
          <div className="font-mono text-lg tracking-widest select-all">{login.userCode}</div>
        </div>
      )}
      {waiting && login.needsCode && (
        <form onSubmit={submit} className="space-y-2" noValidate>
          <label htmlFor="agent-login-code" className="label text-sm">
            Code from {providerName}
          </label>
          <div className="flex gap-2">
            <input
              id="agent-login-code"
              className="input input-sm w-full font-mono"
              autoComplete="off"
              spellCheck={false}
              value={code}
              onChange={e => setCode(e.target.value)}
            />
            <button type="submit" className="btn btn-sm" disabled={submitting}>
              {submitting ? <span className="loading loading-spinner loading-xs" /> : 'Send code'}
            </button>
          </div>
          <FieldError message={problem ?? submitError ?? undefined} />
        </form>
      )}
      {note && <p className="text-xs text-muted">{note}</p>}
    </div>
  )
}
