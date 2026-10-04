/**
 * Codex's sign-in body (§18.22-B): OpenAI's device-code flow. The person opens OpenAI's device page
 * in a new tab, signs in there and types the one-time code shown here — nothing comes back through
 * Launch (no paste-back), and the modal moves on by itself when Codex has finished.
 *
 * Two facts people trip over, said plainly: the code expires in 15 minutes, and device-code sign-in
 * can be switched off — in the person's ChatGPT security settings, or by a workspace admin.
 */
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { agentLoginStatusText } from './GenericLogin'
import type { AgentLoginBodyProps } from './registry'

/** The device page Codex prints; shown when the row has not got one yet. */
export const CODEX_DEVICE_PAGE = 'https://auth.openai.com/codex/device'

export function CodexLogin({ login }: AgentLoginBodyProps) {
  const [copied, setCopied] = useState(false)
  const waiting = login.status === 'awaiting_user'
  const url = login.verificationUrl ?? CODEX_DEVICE_PAGE

  const copy = async () => {
    if (!login.userCode) return
    try {
      await navigator.clipboard.writeText(login.userCode)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  if (!waiting) {
    return (
      <p role="status" className="text-sm">
        {agentLoginStatusText(login, 'OpenAI')}
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <p role="status" className="sr-only">
        {agentLoginStatusText(login, 'OpenAI')}
      </p>
      <ol className="list-decimal pl-5 space-y-4 text-sm">
        <li className="space-y-2">
          <p>Open OpenAI’s device page and sign in to your ChatGPT account.</p>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary btn-sm gap-1.5"
          >
            Open OpenAI sign-in
            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
          </a>
          <p className="text-xs text-muted break-all">{url}</p>
        </li>
        <li className="space-y-2">
          <p>Enter this one-time code there. It expires in 15 minutes.</p>
          {login.userCode ? (
            <div className="flex items-center gap-3">
              <span className="font-mono text-lg tracking-widest select-all">{login.userCode}</span>
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          ) : (
            <p className="text-muted">Waiting for the code…</p>
          )}
        </li>
      </ol>
      <p className="text-xs text-muted">
        This window updates on its own once you have signed in. If OpenAI says device-code sign-in
        is not allowed, turn it on in your ChatGPT security settings, or ask your workspace admin to
        enable it.
      </p>
    </div>
  )
}
