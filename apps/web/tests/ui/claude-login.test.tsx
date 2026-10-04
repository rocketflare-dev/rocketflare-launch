/**
 * Claude's sign-in body (§18.22-A, `ui/pages/agent-accounts/logins/ClaudeLogin.tsx`): Anthropic's page
 * in a new tab (`noopener`), a paste field that refuses anything but `<code>#<state>` before it is
 * sent, each status in a sentence, and the one-line note about where the sign-in happens.
 */
import type { AgentLogin } from '@launch/shared/launch-agents'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_LOGIN_NOTE,
  ClaudeLogin,
  claudeCodeProblem,
  isClaudeLoginCode,
} from '@/ui/pages/agent-accounts/logins/ClaudeLogin'

afterEach(cleanup)

const URL = 'https://claude.com/cai/oauth/authorize?code=true&state=abc'

const login = (overrides: Partial<AgentLogin> = {}): AgentLogin => ({
  id: '1091a000-0000-4000-8000-000000000002',
  runtime: 'claude_code',
  status: 'awaiting_user',
  verificationUrl: URL,
  userCode: null,
  needsCode: true,
  error: null,
  expiresAt: new Date('2030-01-01T00:00:00Z'),
  createdAt: new Date('2029-12-31T23:45:00Z'),
  finishedAt: null,
  ...overrides,
})

function renderBody(overrides: Partial<AgentLogin> = {}, props: { submitError?: string } = {}) {
  const onSubmitCode = vi.fn()
  render(
    <ClaudeLogin
      login={login(overrides)}
      onSubmitCode={onSubmitCode}
      submitting={false}
      submitError={props.submitError ?? null}
    />
  )
  return { onSubmitCode }
}

describe('the code check', () => {
  it('accepts code#state and nothing else', () => {
    expect(isClaudeLoginCode('abc_1-2#St4te-x')).toBe(true)
    expect(claudeCodeProblem('  abc#def ')).toBeNull()
    expect(claudeCodeProblem('')).toMatch(/Paste the code/)
    expect(claudeCodeProblem('abc')).toMatch(/# in the middle/)
    expect(claudeCodeProblem('a b#c')).toMatch(/# in the middle/)
  })
})

describe('ClaudeLogin', () => {
  it('waiting: a new-tab link to Anthropic, the paste field and the note', () => {
    renderBody()
    const link = screen.getByRole('link', { name: /Open Anthropic sign-in/ })
    expect(link).toHaveAttribute('href', URL)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(screen.getByLabelText('Code from Anthropic')).toBeInTheDocument()
    expect(screen.getByText(CLAUDE_LOGIN_NOTE)).toBeInTheDocument()
    expect(CLAUDE_LOGIN_NOTE).toMatch(/Anthropic/)
    expect(CLAUDE_LOGIN_NOTE).toMatch(/encrypted/)
  })

  it('a half-copied code is refused in place and never sent; a whole one is sent trimmed', () => {
    const { onSubmitCode } = renderBody()
    const input = screen.getByLabelText('Code from Anthropic')
    fireEvent.change(input, { target: { value: 'only-the-first-half' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/# in the middle/)
    expect(onSubmitCode).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '  theCode#theState  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    expect(onSubmitCode).toHaveBeenCalledWith('theCode#theState')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('the server’s refusal of a paste is shown under the field', () => {
    renderBody({}, { submitError: 'This sign-in is not waiting for a code' })
    expect(screen.getByRole('alert')).toHaveTextContent('This sign-in is not waiting for a code')
  })

  it('starting and finishing: a sentence, no link and no field', () => {
    for (const status of ['starting', 'submitting', 'finishing'] as const) {
      renderBody({ status, verificationUrl: status === 'starting' ? null : URL })
      expect(screen.getByRole('status')).toHaveTextContent(/\S/)
      expect(screen.queryByRole('link')).toBeNull()
      expect(screen.queryByLabelText('Code from Anthropic')).toBeNull()
      cleanup()
    }
  })

  it('failed: the server’s sentence, and the note still says where the sign-in happens', () => {
    renderBody({ status: 'failed', error: 'Anthropic did not accept that code. Start again.' })
    expect(screen.getByRole('status')).toHaveTextContent('Anthropic did not accept that code.')
    expect(screen.queryByLabelText('Code from Anthropic')).toBeNull()
    expect(screen.getByText(CLAUDE_LOGIN_NOTE)).toBeInTheDocument()
  })
})
