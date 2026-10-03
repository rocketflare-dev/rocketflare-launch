/**
 * Codex's sign-in body (§18.22-B): OpenAI's device page in a new tab, the one-time code with its
 * 15-minute expiry, the hint about device-code sign-in being switched off — and no field to paste
 * anything back.
 */
import type { AgentLogin } from '@launch/shared/launch-agents'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CodexLogin } from '@/ui/pages/profile/agent-logins/CodexLogin'

const login = (overrides: Partial<AgentLogin> = {}): AgentLogin => ({
  id: '1091a000-0000-4000-8000-000000000002',
  runtime: 'codex',
  status: 'awaiting_user',
  verificationUrl: 'https://auth.openai.com/codex/device',
  userCode: 'K7QX-M2PD',
  needsCode: false,
  error: null,
  expiresAt: new Date('2030-01-01T00:00:00Z'),
  createdAt: new Date('2029-12-31T23:45:00Z'),
  finishedAt: null,
  ...overrides,
})

const props = (l: AgentLogin) => ({
  login: l,
  onSubmitCode: () => {},
  submitting: false,
  submitError: null,
})

describe('CodexLogin', () => {
  it('shows OpenAI’s device page (new tab), the code, the expiry and the device-code hint; no paste field', () => {
    render(<CodexLogin {...props(login())} />)
    const link = screen.getByRole('link', { name: /Open OpenAI sign-in/ })
    expect(link).toHaveAttribute('href', 'https://auth.openai.com/codex/device')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(screen.getByText('K7QX-M2PD')).toBeInTheDocument()
    expect(screen.getByText(/expires in 15 minutes/)).toBeInTheDocument()
    expect(
      screen.getByText(/ChatGPT security settings, or ask your workspace admin/)
    ).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('before the prompt and after the end it is one status line', () => {
    const { rerender } = render(
      <CodexLogin
        {...props(login({ status: 'starting', verificationUrl: null, userCode: null }))}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('Starting OpenAI’s sign-in')
    expect(screen.queryByRole('link')).toBeNull()
    rerender(
      <CodexLogin
        {...props(login({ status: 'failed', error: 'Device-code sign-in is not enabled.' }))}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('Device-code sign-in is not enabled.')
  })
})
