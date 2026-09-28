/**
 * The audit page's integrity panel (Launch P4, spec/08): Verify runs only when pressed and says in
 * words whether the hash chain holds (unsealed events are not a failure); Export is a plain
 * download link carrying the page's action filter.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Audit from '@/ui/pages/Audit'
import { makeSession, renderWithProviders, stubFetch } from './helpers/renderWithProviders'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const verified = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  checked: 1204,
  sealedThrough: 1204,
  unsealed: 3,
  firstBrokenSeq: null,
  firstBrokenEventId: null,
  verifiedAt: new Date().toISOString(),
  ...overrides,
})

function renderAudit(verify: unknown) {
  const fetchMock = stubFetch({
    '/api/audit': { items: [], nextCursor: null },
    '/api/audit/verify': verify,
  })
  renderWithProviders(<Audit />, { session: makeSession() })
  return fetchMock
}

describe('Audit — integrity', () => {
  it('verifies only when asked, and says the chain holds', async () => {
    const fetchMock = renderAudit(verified())
    await screen.findByText('No audit events yet')
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/verify'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    expect(
      await screen.findByText(/The chain holds: 1,204 sealed events checked/)
    ).toBeInTheDocument()
    expect(screen.getByText(/3 newer ones not sealed yet/)).toBeInTheDocument()
  })

  it('says where a broken chain breaks', async () => {
    renderAudit(
      verified({
        ok: false,
        firstBrokenSeq: 88,
        firstBrokenEventId: '12345678-0000-4000-8000-000000000000',
      })
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Verify' }))
    expect(
      await screen.findByText(/The chain breaks at #88 \(event 12345678\)/)
    ).toBeInTheDocument()
  })

  it('offers CSV and JSON Lines downloads', async () => {
    renderAudit(verified())
    expect(await screen.findByRole('link', { name: 'CSV' })).toHaveAttribute(
      'href',
      '/api/audit/export?format=csv'
    )
    expect(screen.getByRole('link', { name: 'JSON Lines' })).toHaveAttribute(
      'href',
      '/api/audit/export?format=json'
    )
  })
})
