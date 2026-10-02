/**
 * The `kit-ai` flag (D30): the kit's AI surfaces — Chat, Agents (and its badge), Knowledge and
 * Search — are hidden until a deployment lists the key in `FEATURES_ENABLED`. The REAL navigation
 * and the real `useNavGuard` here (the `sidenav` suite mocks the guard), so this proves the items
 * carry the flag; and the route guards are the same consts (`lib/feature-guards.ts`), so a hidden
 * link never points at a page that would let the reader in.
 */
import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RequireGuard } from '@/ui/components/RequireGuard'
import SideNav from '@/ui/components/SideNav'
import { AGENTS_GUARD, CHAT_GUARD, KIT_AI_FEATURE, KNOWLEDGE_GUARD } from '@/ui/lib/feature-guards'
import { makeSession, renderWithProviders, stubFetch } from './helpers/renderWithProviders'

afterEach(() => vi.unstubAllGlobals())

const AI_ITEMS = [/^Chat/, /^Agents/, /^Knowledge/, /^Search/]

function stub() {
  return stubFetch({
    '/api/health': { status: 'ok', version: '1.2.3', env: 'staging' },
    '/api/agents/interrupts': {
      items: [],
      pagination: { page: 1, pageSize: 1, total: 0, totalPages: 0 },
    },
  })
}

describe('kit-ai', () => {
  it('hides Chat, Agents, Knowledge and Search — and asks for no agents badge — while it is off', async () => {
    const fetchMock = stub()
    renderWithProviders(<SideNav />, { session: makeSession({ features: [] }) })
    expect(await screen.findByRole('link', { name: /^Apps/ })).toBeInTheDocument()
    for (const name of AI_ITEMS) {
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument()
    }
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/agents/'))).toBe(false)
  })

  it('shows them again once the deployment ships the flag', async () => {
    stub()
    renderWithProviders(<SideNav />, { session: makeSession({ features: ['kit-ai'] as never }) })
    for (const name of AI_ITEMS) {
      expect(await screen.findByRole('link', { name })).toBeInTheDocument()
    }
  })

  it('gates each route with the same guard as its nav item', () => {
    for (const guard of [CHAT_GUARD, AGENTS_GUARD, KNOWLEDGE_GUARD]) {
      expect(guard).toEqual([KIT_AI_FEATURE, expect.objectContaining({ action: 'read' })])
    }
    renderWithProviders(
      <RequireGuard guard={CHAT_GUARD}>
        <p>the chat page</p>
      </RequireGuard>,
      { session: makeSession({ features: [] }) }
    )
    expect(screen.queryByText('the chat page')).not.toBeInTheDocument()
  })
})
