/**
 * Settings → Kits (D36 K1, K3, K5): the catalogue at `/settings/kit` — one row per kit with its
 * version, status and apps; Check and a ⋯ menu (Run the scaffold check, Re-pin…, Make default,
 * Remove…) per row; Add a kit in a dialog — and one kit's page at `/settings/kit/:slug`, which
 * took over the Kit version card: the pin editor (Follow latest, a release tag, a commit) for any
 * kit, Check now on any kit that follows latest, Reset to Launch's default for the default kit,
 * the checks and what the manifest declares.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_TEMPLATE_PIN } from '@launch/shared/launch-setup'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KITS_POLL_MS, kitsPollInterval } from '@/ui/hooks/useKits'
import Kit from '@/ui/pages/platform/Kit'
import { cleanupText, kitStatus, kitVersion } from '@/ui/pages/platform/kit/kitBits'
import {
  makeSession,
  makeUser,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'
import { setupOverview as overview } from './helpers/setup'

/** The built-in default (verified, its scaffold check passed) and a failing kit. */
const ROCKETFLARE = {
  id: '11111111-2222-4333-8444-555555555555',
  slug: 'rocketflare',
  name: 'Rocketflare',
  description: null,
  repo: 'rocketflare-dev/rocketflare',
  pin: DEFAULT_TEMPLATE_PIN,
  pinIsCodeDefault: true,
  isDefault: true,
  status: 'verified',
  problems: [] as string[],
  contractVersion: '1',
  manifestSource: 'fallback',
  checkedAt: '2026-10-01T00:00:00.000Z',
  latestCheck: null as unknown,
  // D36 K3: the last scaffold (dynamic) check passed, and its test repo is gone.
  dynamicCheck: {
    id: '33333333-4444-4555-8666-777777777777',
    status: 'passed',
    commit: DEFAULT_TEMPLATE_PIN.commit,
    repo: 'acme-apps/launch-kit-check-rocketflare-33333333',
    runUrl: 'https://github.com/acme-apps/launch-kit-check-rocketflare-33333333/actions/runs/1',
    problems: [] as string[],
    cleanup: 'deleted',
    startedAt: '2026-10-01T00:00:00.000Z',
    finishedAt: '2026-10-01T00:06:00.000Z',
  } as Record<string, unknown> | null,
  appCount: 3,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}

const ACME = {
  ...ROCKETFLARE,
  id: '22222222-3333-4444-8555-666666666666',
  slug: 'acme-kit',
  name: 'Acme kit',
  repo: 'acme/acme-kit',
  pin: { repo: 'acme/acme-kit', tag: '1.0.0', commit: 'a'.repeat(40) },
  pinIsCodeDefault: false,
  isDefault: false,
  status: 'failed',
  problems: ['.github/workflows/deploy.yml is missing'],
  manifestSource: 'repo',
  dynamicCheck: null,
  appCount: 0,
}

const KITS = [ROCKETFLARE, ACME]

/** What the page shows a kit declares — the meta-kit's own manifest (upgrades, no plugins). */
const LAUNCH_KIT_MANIFEST = JSON.parse(
  readFileSync(path.join(__dirname, '../fixtures/launch-kit-0.1/launch.kit.json'), 'utf8')
)

/** `/settings/kit/*`, as `SettingsLayout` mounts it. */
function KitSection() {
  return (
    <Routes>
      <Route path="/settings/kit/*" element={<Kit />} />
    </Routes>
  )
}

function render(kits: readonly unknown[] = KITS, route = '/settings/kit') {
  const fetchMock = stubFetch({
    '/api/platform/setup': overview,
    'DELETE /api/platform/setup/template-pin': overview,
    '/api/platform/setup/template-pin/tags': {
      repo: 'rocketflare-dev/rocketflare',
      tags: [
        { name: '0.17.1', commit: 'd'.repeat(40) },
        { name: '0.16.0', commit: DEFAULT_TEMPLATE_PIN.commit },
        { name: '0.15.5', commit: 'c'.repeat(40) },
      ],
      latest: '0.17.1',
    },
    '/api/platform/kits': { kits },
    'POST /api/platform/kits': { ...ACME, manifest: null },
    [`/api/platform/kits/${ROCKETFLARE.id}`]: { ...ROCKETFLARE, manifest: null },
    [`PUT /api/platform/kits/${ROCKETFLARE.id}/pin`]: { ...ROCKETFLARE, manifest: null },
    [`POST /api/platform/kits/${ROCKETFLARE.id}/latest`]: { ...ROCKETFLARE, manifest: null },
    [`POST /api/platform/kits/${ACME.id}/latest`]: { ...ACME, manifest: null },
    [`POST /api/platform/kits/${ACME.id}/check`]: { ...ACME, manifest: null },
    [`/api/platform/kits/${ACME.id}`]: { ...ACME, manifest: LAUNCH_KIT_MANIFEST },
    [`PUT /api/platform/kits/${ACME.id}/pin`]: { ...ACME, manifest: LAUNCH_KIT_MANIFEST },
    [`DELETE /api/platform/kits/${ACME.id}`]: { removed: true },
    [`PUT /api/platform/kits/${ACME.id}/default`]: { ...ACME, isDefault: true, manifest: null },
  })
  renderWithProviders(<KitSection />, {
    route,
    session: makeSession({ user: makeUser({ isGlobalAdmin: true }) }),
  })
  return fetchMock
}

const calls = (fetchMock: ReturnType<typeof render>) =>
  fetchMock.mock.calls.map(([input, init]) => {
    const url = new URL(String(input), 'http://x')
    return `${init?.method ?? 'GET'} ${url.pathname}${url.search}`
  })

const rowOf = async (name: string) => {
  const list = await screen.findByRole('list', { name: 'Kits' })
  return within(list).findByRole('listitem', { name })
}

describe('Settings → Kits: the list', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists each kit with its version, status, apps, and the problems of a failed check', async () => {
    render()
    const rocketflare = await rowOf('Rocketflare')
    expect(within(rocketflare).getByText('Default')).toBeInTheDocument()
    expect(within(rocketflare).getByText('rocketflare-dev/rocketflare')).toBeInTheDocument()
    expect(within(rocketflare).getByText(DEFAULT_TEMPLATE_PIN.tag as string)).toBeInTheDocument()
    expect(within(rocketflare).getByText("Launch's default")).toBeInTheDocument()
    expect(within(rocketflare).getByText('Verified')).toBeInTheDocument()
    expect(within(rocketflare).getByText('3')).toBeInTheDocument()

    const acme = await rowOf('Acme kit')
    expect(within(acme).queryByText('Default')).toBeNull()
    expect(within(acme).getByText('Failed')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Problems with Acme kit' }).textContent).toContain(
      '.github/workflows/deploy.yml is missing'
    )
    // The name opens the kit's page.
    expect(within(acme).getByRole('link', { name: 'Acme kit' })).toHaveAttribute(
      'href',
      '/settings/kit/acme-kit'
    )
    // The default kit cannot be made default again; the other can.
    expect(within(rocketflare).queryByRole('button', { name: 'Make default' })).toBeNull()
    expect(within(acme).getByRole('button', { name: 'Make default' })).toBeInTheDocument()
  })

  it('checks a kit and makes it the default', async () => {
    const fetchMock = render()
    const acme = await rowOf('Acme kit')
    fireEvent.click(within(acme).getByRole('button', { name: 'Check' }))
    fireEvent.click(within(acme).getByLabelText('More actions for Acme kit'))
    fireEvent.click(within(acme).getByRole('button', { name: 'Make default' }))
    await waitFor(() => {
      expect(calls(fetchMock)).toContain(`POST /api/platform/kits/${ACME.id}/check`)
      expect(calls(fetchMock)).toContain(`PUT /api/platform/kits/${ACME.id}/default`)
    })
  })

  it('adds a kit in a dialog: Follow latest by default, a tag when asked, a bad repo never leaves', async () => {
    const fetchMock = render()
    fireEvent.click(await screen.findByRole('button', { name: 'Add a kit' }))
    const form = await screen.findByRole('form', { name: 'Add a kit' })
    const repo = within(form).getByRole('textbox', { name: 'Kit repository' })
    // Nothing is wrong with a field nobody has typed in yet.
    fireEvent.blur(repo)
    expect(within(form).queryByRole('alert')).toBeNull()

    fireEvent.change(repo, { target: { value: 'not a repo' } })
    fireEvent.blur(repo)
    expect(await within(form).findByText('owner/name or a GitHub URL')).toBeInTheDocument()
    fireEvent.click(within(form).getByRole('button', { name: 'Add kit' }))
    expect(requestBody(fetchMock, 'POST /api/platform/kits')).toBeUndefined()

    // A pasted GitHub URL is the repo.
    fireEvent.change(repo, { target: { value: 'https://github.com/acme/acme-kit' } })
    fireEvent.click(within(form).getByRole('radio', { name: 'A release tag' }))
    fireEvent.change(within(form).getByRole('combobox', { name: 'Release tag' }), {
      target: { value: '1.0.0' },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Add kit' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, 'POST /api/platform/kits')).toEqual({
        repo: 'acme/acme-kit',
        pin: { kind: 'tag', tag: '1.0.0' },
      })
    )
  })

  it('re-pins a kit to a release tag from the row, checked by the server', async () => {
    const fetchMock = render()
    const acme = await rowOf('Acme kit')
    fireEvent.click(within(acme).getByLabelText('More actions for Acme kit'))
    fireEvent.click(within(acme).getByRole('button', { name: 'Re-pin…' }))
    const form = await screen.findByRole('form', { name: 'Re-pin Acme kit' })
    expect(within(form).getByLabelText('A release tag')).toBeChecked()
    fireEvent.change(within(form).getByRole('combobox', { name: 'Release tag' }), {
      target: { value: '1.1.0' },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Pin tag' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, `PUT /api/platform/kits/${ACME.id}/pin`)).toEqual({
        kind: 'tag',
        tag: '1.1.0',
      })
    )
  })

  it('runs the scaffold check, from the row and from Re-pin (?dynamic=1)', async () => {
    const fetchMock = render()
    const acme = await rowOf('Acme kit')
    fireEvent.click(within(acme).getByLabelText('More actions for Acme kit'))
    fireEvent.click(within(acme).getByRole('button', { name: 'Run the scaffold check' }))
    await waitFor(() =>
      expect(calls(fetchMock)).toContain(`POST /api/platform/kits/${ACME.id}/check?dynamic=1`)
    )
    fireEvent.click(within(acme).getByLabelText('More actions for Acme kit'))
    fireEvent.click(within(acme).getByRole('button', { name: 'Re-pin…' }))
    const form = await screen.findByRole('form', { name: 'Re-pin Acme kit' })
    fireEvent.change(within(form).getByRole('combobox', { name: 'Release tag' }), {
      target: { value: '1.1.0' },
    })
    fireEvent.click(within(form).getByRole('checkbox', { name: /Also run the scaffold check/ }))
    fireEvent.click(within(form).getByRole('button', { name: 'Pin tag' }))
    await waitFor(() =>
      expect(calls(fetchMock)).toContain(`PUT /api/platform/kits/${ACME.id}/pin?dynamic=1`)
    )
  })

  it('a kit whose scaffold check runs says so, and cannot start another', async () => {
    const checking = {
      ...ACME,
      status: 'checking',
      problems: [],
      dynamicCheck: {
        ...ROCKETFLARE.dynamicCheck,
        status: 'running',
        commit: ACME.pin.commit,
        repo: 'acme-apps/launch-kit-check-acme-kit-44444444',
        runUrl: null,
        cleanup: null,
        finishedAt: null,
      },
    }
    render([ROCKETFLARE, checking])
    const acme = await rowOf('Acme kit')
    expect(within(acme).getByText('Scaffold check running')).toBeInTheDocument()
    const run = within(acme).getByRole('button', { name: 'Run the scaffold check' })
    expect(run).toBeDisabled()
    expect(run).toHaveAccessibleDescription('A scaffold check is running.')
    // The list re-reads while it runs, and stops once it settles.
    expect(kitsPollInterval([ROCKETFLARE, checking] as never)).toBe(KITS_POLL_MS)
    expect(kitsPollInterval(KITS as never)).toBe(false)
  })

  it('removes a kit after asking; never the default, and says why', async () => {
    const fetchMock = render()
    const rocketflare = await rowOf('Rocketflare')
    const defaultRemove = within(rocketflare).getByRole('button', { name: 'Remove…' })
    expect(defaultRemove).toBeDisabled()
    expect(defaultRemove).toHaveAccessibleDescription(/make another kit the default first/)
    const acme = await rowOf('Acme kit')
    const acmeRemove = within(acme).getByRole('button', { name: 'Remove…' })
    expect(acmeRemove).toBeEnabled()
    expect(acmeRemove.className).toContain('text-error')
    fireEvent.click(within(acme).getByLabelText('More actions for Acme kit'))
    fireEvent.click(acmeRemove)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove kit' }))
    await waitFor(() => expect(calls(fetchMock)).toContain(`DELETE /api/platform/kits/${ACME.id}`))
  })

  it('names the states, the version and the test repo in words', () => {
    expect(kitStatus({ status: 'checking', dynamicCheck: null }).label).toBe('Checking')
    expect(kitStatus({ status: 'unchecked', dynamicCheck: null }).label).toBe('Not checked')
    expect(kitStatus({ status: 'verified', dynamicCheck: null })).toEqual({
      label: 'Verified',
      tone: 'success',
    })
    expect(kitStatus({ status: 'failed', dynamicCheck: null }).tone).toBe('error')
    expect(
      kitVersion({
        pin: { repo: 'o/r', tag: '2.0.0', commit: 'f'.repeat(40), follow: 'latest' },
        pinIsCodeDefault: false,
      })
    ).toEqual({ version: '2.0.0', note: 'Follows latest', unreleased: false })
    expect(
      kitVersion({
        pin: { repo: 'o/r', commit: 'abcdef1'.padEnd(40, '0') },
        pinIsCodeDefault: false,
      })
    ).toEqual({ version: 'abcdef1', note: 'Unreleased commit', unreleased: true })
    expect(cleanupText({ status: 'failed', repo: 'o/r', cleanup: 'archived' })).toMatch(
      /o\/r was archived: the GitHub App may not delete/
    )
    expect(cleanupText({ status: 'passed', repo: 'o/r', cleanup: 'failed' })).toMatch(
      /could not be removed: delete it by hand/
    )
    expect(cleanupText({ status: 'failed', repo: null, cleanup: null })).toBeNull()
  })
})

describe("Settings → Kits: a kit's page (the Kit version card's successor)", () => {
  afterEach(() => vi.unstubAllGlobals())

  const commitPinned = {
    ...ROCKETFLARE,
    pin: { repo: 'rocketflare-dev/rocketflare', commit: 'abcdef1'.padEnd(40, '0') },
    pinIsCodeDefault: false,
  }

  const followCommit = 'e'.repeat(40)
  const following = (latestCheck: unknown) => ({
    ...ROCKETFLARE,
    pin: {
      repo: 'rocketflare-dev/rocketflare',
      tag: '0.17.1',
      commit: followCommit,
      follow: 'latest',
    },
    pinIsCodeDefault: false,
    latestCheck,
  })

  const versionOf = async () =>
    (await screen.findByRole('heading', { name: 'Version' })).closest('section') as HTMLElement

  it("shows the default kit's release pin: repo, tag and short SHA, and no reset or warning", async () => {
    render(KITS, '/settings/kit/rocketflare')
    expect(await screen.findByRole('heading', { name: 'Rocketflare' })).toBeInTheDocument()
    const card = await versionOf()
    expect(within(card).getByText('rocketflare-dev/rocketflare')).toBeInTheDocument()
    expect(
      within(card).getByText(`Release ${DEFAULT_TEMPLATE_PIN.tag}, Launch's default`)
    ).toBeInTheDocument()
    expect(within(card).getByText(DEFAULT_TEMPLATE_PIN.commit.slice(0, 7))).toBeInTheDocument()
    expect(within(card).queryByText(/Unreleased commit, for development/)).toBeNull()
    expect(within(card).queryByRole('button', { name: "Reset to Launch's default" })).toBeNull()
    expect(within(card).getByLabelText('A release tag')).toBeChecked()
  })

  it('pins a release tag typed into the combobox, even one the list does not have', async () => {
    const fetchMock = render(KITS, '/settings/kit/rocketflare')
    const card = await versionOf()
    fireEvent.change(within(card).getByRole('combobox', { name: 'Release tag' }), {
      target: { value: '0.15.6' },
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Pin tag' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, `PUT /api/platform/kits/${ROCKETFLARE.id}/pin`)).toEqual({
        kind: 'tag',
        tag: '0.15.6',
      })
    )
  })

  it('loads the tags only when the combobox opens, newest first, and pins the one picked', async () => {
    const fetchMock = render(KITS, '/settings/kit/rocketflare')
    const card = await versionOf()
    const tagCalls = () =>
      fetchMock.mock.calls.filter(([input]) => String(input).includes('/template-pin/tags'))
    expect(tagCalls()).toHaveLength(0)
    const input = within(card).getByRole('combobox', { name: 'Release tag' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const listbox = await within(card).findByRole('listbox')
    await waitFor(() =>
      expect(
        within(listbox)
          .getAllByRole('option')
          .map(o => o.textContent)
      ).toEqual([
        '0.17.1latest',
        `0.16.0${DEFAULT_TEMPLATE_PIN.commit.slice(0, 7)}`,
        '0.15.5ccccccc',
      ])
    )
    expect(tagCalls()).toHaveLength(1)
    fireEvent.click(within(listbox).getByRole('option', { name: /0\.16\.0/ }))
    expect(input).toHaveValue('0.16.0')
    fireEvent.click(within(card).getByRole('button', { name: 'Pin tag' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, `PUT /api/platform/kits/${ROCKETFLARE.id}/pin`)).toEqual({
        kind: 'tag',
        tag: '0.16.0',
      })
    )
  })

  it('pins a commit — pasted, or the latest main — and refuses a malformed one before any request', async () => {
    const fetchMock = render(KITS, '/settings/kit/rocketflare')
    const card = await versionOf()
    fireEvent.click(within(card).getByLabelText('A commit (unreleased)'))
    fireEvent.change(within(card).getByLabelText('Commit or branch'), {
      target: { value: 'not a sha!' },
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Pin commit' }))
    expect(
      await within(card).findByText('A tag, a commit SHA or a branch name')
    ).toBeInTheDocument()
    expect(requestBody(fetchMock, `PUT /api/platform/kits/${ROCKETFLARE.id}/pin`)).toBeUndefined()

    fireEvent.click(within(card).getByRole('button', { name: 'Pin latest main' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, `PUT /api/platform/kits/${ROCKETFLARE.id}/pin`)).toEqual({
        kind: 'commit',
        ref: 'main',
      })
    )
  })

  it('warns that a commit pin is for development, and resets the built-in kit to its default', async () => {
    const fetchMock = render([commitPinned, ACME], '/settings/kit/rocketflare')
    const card = await versionOf()
    expect(within(card).getByText('Unreleased commit')).toBeInTheDocument()
    expect(within(card).getByText('abcdef1')).toBeInTheDocument()
    expect(within(card).getByText(/Unreleased commit, for development/)).toBeInTheDocument()
    expect(within(card).getByLabelText('A commit (unreleased)')).toBeChecked()
    fireEvent.click(within(card).getByRole('button', { name: "Reset to Launch's default" }))
    await waitFor(() =>
      expect(calls(fetchMock)).toContain('DELETE /api/platform/setup/template-pin')
    )
  })

  it('switches to Follow latest with one request the server resolves', async () => {
    const fetchMock = render(KITS, '/settings/kit/rocketflare')
    const card = await versionOf()
    fireEvent.click(within(card).getByLabelText('Follow latest'))
    expect(within(card).queryByRole('button', { name: 'Check now' })).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'Follow latest' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, `PUT /api/platform/kits/${ROCKETFLARE.id}/pin`)).toEqual({
        kind: 'latest',
      })
    )
  })

  it('shows a Follow latest pin with when it was checked and what is latest, and checks now', async () => {
    const checkedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const fetchMock = render(
      [
        following({
          repo: 'rocketflare-dev/rocketflare',
          checkedAt,
          latest: '0.17.1',
          error: null,
        }),
        ACME,
      ],
      '/settings/kit/rocketflare'
    )
    const card = await versionOf()
    expect(within(card).getByLabelText('Follow latest')).toBeChecked()
    expect(within(card).getByText('Latest release, now 0.17.1')).toBeInTheDocument()
    expect(within(card).getByText('5 minutes ago')).toBeInTheDocument()
    expect(within(card).getByText('Latest').nextElementSibling).toHaveTextContent('0.17.1')
    fireEvent.click(within(card).getByRole('button', { name: 'Check now' }))
    await waitFor(() =>
      expect(calls(fetchMock)).toContain(`POST /api/platform/kits/${ROCKETFLARE.id}/latest`)
    )
  })

  it('offers Check now on any kit that follows latest, not only the default', async () => {
    const acmeFollowing = {
      ...ACME,
      pin: { repo: 'acme/acme-kit', tag: '1.2.0', commit: 'b'.repeat(40), follow: 'latest' },
    }
    const fetchMock = render([ROCKETFLARE, acmeFollowing], '/settings/kit/acme-kit')
    const card = await versionOf()
    expect(within(card).getByLabelText('Follow latest')).toBeChecked()
    expect(within(card).queryByRole('button', { name: "Reset to Launch's default" })).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'Check now' }))
    await waitFor(() =>
      expect(calls(fetchMock)).toContain(`POST /api/platform/kits/${ACME.id}/latest`)
    )
  })

  it('says when the last Follow latest check failed', async () => {
    render(
      [
        following({
          repo: 'rocketflare-dev/rocketflare',
          checkedAt: new Date().toISOString(),
          latest: '0.17.1',
          error: 'GitHub could not answer: Server Error',
        }),
        ACME,
      ],
      '/settings/kit/rocketflare'
    )
    const card = await versionOf()
    expect(
      within(card).getByText(/The last check failed: GitHub could not answer: Server Error/)
    ).toBeInTheDocument()
  })

  it('shows what a kit declares: init, release workflow, check, upgrades, plugins', async () => {
    render(KITS, '/settings/kit/acme-kit')
    const list = await screen.findByLabelText('What Acme kit declares')
    expect(list).toHaveTextContent('launch.kit.json, contract 1')
    expect(list).toHaveTextContent(LAUNCH_KIT_MANIFEST.scaffold.init)
    expect(list).toHaveTextContent(`.github/workflows/${LAUNCH_KIT_MANIFEST.release.workflow}`)
    expect(list).toHaveTextContent(LAUNCH_KIT_MANIFEST.ci.requiredCheck)
    expect(list).toHaveTextContent(
      LAUNCH_KIT_MANIFEST.upgrade ? 'Supported' : 'Not declared: its apps are never shown as behind'
    )
    expect(screen.getByRole('list', { name: 'Problems with Acme kit' })).toHaveTextContent(
      '.github/workflows/deploy.yml is missing'
    )
  })

  it('shows the last scaffold check: result, commit, its run and its test repo (D36 K3)', async () => {
    render(KITS, '/settings/kit/rocketflare')
    const line = await screen.findByRole('group', { name: 'Last scaffold check' })
    expect(line).toHaveTextContent('Scaffold check passed')
    expect(line).toHaveTextContent(DEFAULT_TEMPLATE_PIN.commit.slice(0, 7))
    expect(within(line).getByRole('link', { name: 'View run' })).toHaveAttribute(
      'href',
      ROCKETFLARE.dynamicCheck?.runUrl as string
    )
    expect(line).toHaveTextContent('Its test repo was deleted.')
  })

  it('a running scaffold check names its test repo', async () => {
    const checking = {
      ...ACME,
      status: 'checking',
      problems: [],
      dynamicCheck: {
        ...ROCKETFLARE.dynamicCheck,
        status: 'running',
        repo: 'acme-apps/launch-kit-check-acme-kit-44444444',
        runUrl: null,
        cleanup: null,
        finishedAt: null,
      },
    }
    render([ROCKETFLARE, checking], '/settings/kit/acme-kit')
    const line = await screen.findByRole('group', { name: 'Last scaffold check' })
    expect(line).toHaveTextContent('Scaffold check running')
    expect(line).toHaveTextContent(/Running in acme-apps\/launch-kit-check-acme-kit-44444444/)
  })

  it('says so for a kit the catalogue does not have', async () => {
    render(KITS, '/settings/kit/nope')
    expect(await screen.findByText('There is no kit called nope.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Kits' })).toHaveAttribute('href', '/settings/kit')
  })
})
