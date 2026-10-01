/**
 * What the approver needs to decide, per kind — the request's `context` (snapshotted when it
 * opened), rendered with an exhaustive `switch` over the shared union, so a new kind is a type
 * error until it has a branch.
 *
 * - `app.create`: the name, address and team of the app somebody wants.
 * - `app.access`: who, which app, and what they wrote on the request-access page.
 * - `deploy.production`: the version, the commit, what staging is running and how healthy it is,
 *   the pull requests in it with their CI, and — for a job-originated ticket — the GitHub run that
 *   is waiting. The release's whole audit chain sits below it on the page (`ReleaseChain`).
 * - `session.budget`: the session, what it has spent against its cap, and the extra asked for.
 * - `grant.request` (P5): which shared config, for which app and environment, the item NAMES and
 *   kinds the app would receive (never a value), which of its plugins declared the need, when the
 *   grant would lapse, and the owner team that decides (read from the resource, which every member
 *   may; while it loads, or if it cannot be read, the sentence describes the team instead).
 *
 * - `session.merge` (issue #5): the pull request (title, link), the session it came from (a link to
 *   its page — an eligible approver may read it, chat and preview included), the commit CI passed
 *   on, the ship summary and the diff stat.
 *
 * User-written text (the access message, the reason, a ship summary) renders verbatim with
 * `whitespace-pre-wrap` — never as markdown, which this chunk does not carry.
 */
import { ArrowTopRightOnSquareIcon, CodeBracketIcon } from '@heroicons/react/24/outline'
import type { ApprovalContextOf, ApprovalDetail } from '@launch/shared/launch-approvals'
import { KIT_CONFIG_PLUGIN_ID, sharedResourcePath } from '@launch/shared/launch-grants'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { SectionPanel } from '@/ui/components/shared'
import { useSharedResource } from '@/ui/hooks/useSharedResources'
import { formatDateTime } from '@/ui/lib/format'
import { HEALTH_LABEL, HealthDot } from '@/ui/pages/apps/components/HealthDot'
import { extraApprovers } from '../approvalModel'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 py-1.5 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>
}

function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="link link-hover inline-flex items-center gap-1"
    >
      {children}
      <ArrowTopRightOnSquareIcon className="w-3 h-3" />
    </a>
  )
}

function AppLink({ detail }: { detail: ApprovalDetail }) {
  if (!detail.app) return <span className="text-muted">—</span>
  return (
    <Link to={`/apps/${detail.app.slug}`} className="link link-hover">
      {detail.app.displayName}
    </Link>
  )
}

const CHECKS: Record<'passing' | 'failing' | 'pending' | 'none', { tone: string; label: string }> =
  {
    passing: { tone: 'completed', label: 'CI passing' },
    failing: { tone: 'failed', label: 'CI failing' },
    pending: { tone: 'running', label: 'CI running' },
    none: { tone: 'draft', label: 'no CI' },
  }

function PullRequests({ prs }: { prs: ApprovalContextOf<'deploy.production'>['prs'] }) {
  if (prs.length === 0) {
    return <p className="text-sm text-muted">No pull requests were recorded in this release.</p>
  }
  return (
    <ul className="divide-y divide-[color:var(--border-subtle)]" aria-label="Pull requests">
      {prs.map(pr => {
        const checks = pr.checks ? CHECKS[pr.checks] : null
        return (
          <li key={pr.number} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
            <span className="font-mono text-xs text-muted">#{pr.number}</span>
            <span className="min-w-0 flex-1 truncate">
              {pr.url ? <External href={pr.url}>{pr.title}</External> : pr.title}
            </span>
            {pr.author && <span className="text-xs text-muted">{pr.author}</span>}
            {pr.sessionId && (
              <span className="status-badge no-dot tone-accent" title="Shipped from a session">
                session
              </span>
            )}
            {checks && (
              <span className="status-badge" data-status={checks.tone}>
                {checks.label}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function DeployContext({
  detail,
  context,
}: {
  detail: ApprovalDetail
  context: ApprovalContextOf<'deploy.production'>
}) {
  const shortSha = context.sha?.slice(0, 7) ?? null
  const failing = context.prs.filter(pr => pr.checks === 'failing').length
  const drift =
    context.stagingVersion && context.version && context.stagingVersion !== context.version
  return (
    <SectionPanel title="What would go to production">
      <dl>
        <Row label="App">
          <AppLink detail={detail} />
        </Row>
        <Row label="Version">
          {context.version ? <Mono>{context.version}</Mono> : <span className="text-muted">—</span>}
          {context.tag && context.tag !== context.version && (
            <span className="text-muted">
              {' '}
              (tag <Mono>{context.tag}</Mono>)
            </span>
          )}
        </Row>
        <Row label="Commit">
          {shortSha ? <Mono>{shortSha}</Mono> : <span className="text-muted">—</span>}
          {context.ref && (
            <span className="text-muted">
              {' '}
              from <Mono>{context.ref.replace(/^refs\/(heads|tags)\//, '')}</Mono>
            </span>
          )}
        </Row>
        {context.compareUrl && (
          <Row label="Changes">
            <External href={context.compareUrl}>Compare with the last release</External>
          </Row>
        )}
        <Row label="Staging">
          {context.stagingHealth ? (
            <span className="inline-flex items-center gap-1.5">
              <HealthDot status={context.stagingHealth} />
              {HEALTH_LABEL[context.stagingHealth]}
            </span>
          ) : (
            <span className="text-muted">No health recorded</span>
          )}
          {context.stagingVersion && (
            <span className="text-muted">
              {' '}
              · running <Mono>{context.stagingVersion}</Mono>
            </span>
          )}
        </Row>
        {context.runUrl && (
          <Row label="Waiting run">
            <External href={context.runUrl}>The GitHub run</External>
            {context.actor && <span className="text-muted"> started by {context.actor}</span>}
          </Row>
        )}
      </dl>
      {drift && (
        <div className="alert alert-warning alert-soft text-sm mt-3" role="status">
          <span>
            Staging is running {context.stagingVersion}, not {context.version}. What you approve is{' '}
            {context.version}.
          </span>
        </div>
      )}
      {failing > 0 && (
        <div className="alert alert-warning alert-soft text-sm mt-3" role="status">
          <span>
            {failing === 1 ? 'One pull request' : `${failing} pull requests`} in this release had
            failing CI when it was promoted.
          </span>
        </div>
      )}
      <h3 className="text-sm font-semibold mt-4 mb-1 inline-flex items-center gap-1.5">
        <CodeBracketIcon className="w-4 h-4" />
        Pull requests ({context.prs.length})
      </h3>
      <PullRequests prs={context.prs} />
    </SectionPanel>
  )
}

function GrantRequestContext({
  detail,
  context,
}: {
  detail: ApprovalDetail
  context: ApprovalContextOf<'grant.request'>
}) {
  const resource = useSharedResource(context.resourceId)
  const team = extraApprovers('grant.request', resource.data?.ownerGroup.name)
  const appName = detail.app?.displayName ?? context.appSlug
  const plugins = context.declaredBy.map(id =>
    id === KIT_CONFIG_PLUGIN_ID ? 'the kit’s optional config' : id
  )
  return (
    <SectionPanel title="What the app would hold">
      <dl>
        <Row label="Shared config">
          <Link to={sharedResourcePath(context.resourceId)} className="link link-hover">
            {context.resourceName}
          </Link>
        </Row>
        <Row label="App">
          <AppLink detail={detail} />
        </Row>
        <Row label="Environment">
          <span className="capitalize font-medium">{context.environment}</span>
        </Row>
        <Row label="It would receive">
          <ul className="space-y-1" aria-label="Items">
            {context.items.map(item => (
              <li key={item.key} className="flex items-center gap-2">
                <Mono>{item.key}</Mono>
                <span className="status-badge no-dot" data-status="draft">
                  {item.kind}
                </span>
              </li>
            ))}
          </ul>
        </Row>
        <Row label="Declared by">
          {plugins.length > 0 ? (
            plugins.join(', ')
          ) : (
            <span className="text-muted">
              None of the app’s plugins — it was asked for by hand.
            </span>
          )}
        </Row>
        <Row label="Lapses">
          {context.expiresAt ? formatDateTime(new Date(context.expiresAt)) : 'Never'}
        </Row>
        <Row label="Decided by">{team}</Row>
      </dl>
      <p className="text-xs text-muted mt-3">
        Approving writes these values into {appName}’s {context.environment} Worker as secrets.
        Nobody sees them — not you, not the app’s owners. The owner team can revoke the grant later
        from the shared config’s page.
      </p>
    </SectionPanel>
  )
}

/**
 * The session's page in Launch: the context's `sessionPath` when it is one of the app's session
 * pages, else built from the app slug and the session id (the route is `/apps/:slug/sessions/:id`).
 */
export function sessionMergeLink(context: ApprovalContextOf<'session.merge'>): string {
  return context.sessionPath.startsWith('/apps/')
    ? context.sessionPath
    : `/apps/${context.appSlug}/sessions/${context.sessionId}`
}

function SessionMergeContext({
  detail,
  context,
}: {
  detail: ApprovalDetail
  context: ApprovalContextOf<'session.merge'>
}) {
  const sessionName = context.title?.trim() || `Session ${context.shortId.slice(0, 6)}`
  return (
    <SectionPanel title="The change to merge">
      <dl>
        <Row label="Pull request">
          <External href={context.prUrl}>
            {context.prTitle} (#{context.prNumber})
          </External>
        </Row>
        <Row label="App">
          <AppLink detail={detail} />
        </Row>
        <Row label="Session">
          <Link to={sessionMergeLink(context)} className="link link-hover">
            {sessionName}
          </Link>
          <span className="text-muted"> — the chat and its live preview</span>
        </Row>
        <Row label="Commit">
          <Mono>{context.headSha.slice(0, 7)}</Mono>
        </Row>
      </dl>
      <h3 className="text-sm font-semibold mt-4 mb-1">What it changes</h3>
      {context.summary.trim() ? (
        <p className="text-sm whitespace-pre-wrap" data-testid="merge-summary">
          {context.summary}
        </p>
      ) : (
        <p className="text-sm text-muted">No summary was written for this change.</p>
      )}
      {context.diffStat.trim() && (
        <details className="mt-3">
          <summary className="cursor-pointer select-none text-sm font-medium">
            Files changed
          </summary>
          <pre
            className="surface-inset mt-1 max-h-64 overflow-auto rounded-md p-2 text-xs"
            data-testid="merge-diffstat"
          >
            {context.diffStat}
          </pre>
        </details>
      )}
      <p className="text-xs text-muted mt-3">
        CI has passed on this exact commit. Approving merges the pull request and puts it live on
        staging; rejecting gives the session back to its author with your comment. Production is a
        separate step.
      </p>
    </SectionPanel>
  )
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`
}

export function ApprovalContext({
  detail,
  requesterName,
  groupNames = new Map(),
}: {
  detail: ApprovalDetail
  requesterName: string
  groupNames?: ReadonlyMap<string, string>
}) {
  const context = detail.context
  switch (context.kind) {
    case 'app.create':
      return (
        <SectionPanel title="The app they want">
          <dl>
            <Row label="Name">{context.displayName}</Row>
            <Row label="Address">
              <Mono>{context.slug}</Mono>
            </Row>
            {context.description && (
              <Row label="Description">
                <span className="whitespace-pre-wrap">{context.description}</span>
              </Row>
            )}
            <Row label="Team">
              {context.ownerGroupId ? (
                (groupNames.get(context.ownerGroupId) ?? 'A team you can’t see')
              ) : (
                <span className="text-muted">No team</span>
              )}
            </Row>
          </dl>
          <p className="text-xs text-muted mt-3">
            Approving starts the launch: a repository, staging and production environments, a
            database and sign-in through Launch.
          </p>
        </SectionPanel>
      )
    case 'app.access':
      return (
        <SectionPanel title="Who wants in">
          <dl>
            <Row label="Person">
              {requesterName}
              {detail.requester && detail.requester.name && (
                <span className="text-muted"> · {detail.requester.email}</span>
              )}
            </Row>
            <Row label="App">
              <AppLink detail={detail} />
            </Row>
            <Row label="Their message">
              {context.message ? (
                <span className="whitespace-pre-wrap">{context.message}</span>
              ) : (
                <span className="text-muted">They didn’t say why.</span>
              )}
            </Row>
          </dl>
          <p className="text-xs text-muted mt-3">
            Approving adds them to the app’s sign-in grants; you can remove it later from the app’s
            Access page.
          </p>
        </SectionPanel>
      )
    case 'deploy.production':
      return <DeployContext detail={detail} context={context} />
    case 'session.budget':
      return (
        <SectionPanel title="The session">
          <dl>
            <Row label="Session">
              {detail.app ? (
                <Link
                  to={`/apps/${detail.app.slug}/sessions/${context.sessionId}`}
                  className="link link-hover"
                >
                  {context.sessionTitle ?? 'Open the session'}
                </Link>
              ) : (
                (context.sessionTitle ?? '—')
              )}
            </Row>
            <Row label="App">
              <AppLink detail={detail} />
            </Row>
            <Row label="Spent">
              {usd(context.spentUsd)} of {usd(context.capUsd)}
            </Row>
            <Row label="Asked for">
              <span className="font-medium">{usd(context.extraUsd)} more</span>
            </Row>
          </dl>
          <p className="text-xs text-muted mt-3">
            Approving adds the extra to this session only; its next message runs straight away.
          </p>
        </SectionPanel>
      )
    case 'grant.request':
      return <GrantRequestContext detail={detail} context={context} />
    case 'session.merge':
      return <SessionMergeContext detail={detail} context={context} />
    case 'config.change':
    case 'app.teardown':
      return (
        <SectionPanel title="The request">
          <p className="text-sm whitespace-pre-wrap">{context.description}</p>
        </SectionPanel>
      )
  }
}
