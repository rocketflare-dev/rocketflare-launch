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
 *
 * User-written text (the access message, the reason) renders verbatim with `whitespace-pre-wrap`.
 */
import { ArrowTopRightOnSquareIcon, CodeBracketIcon } from '@heroicons/react/24/outline'
import type { ApprovalContextOf, ApprovalDetail } from '@launch/shared/launch-approvals'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { SectionPanel } from '@/ui/components/shared'
import { HEALTH_LABEL, HealthDot } from '@/ui/pages/apps/components/HealthDot'

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
    // P5: the keys the app would receive, never a value (slice 5f owns the full renderer).
    case 'grant.request':
      return (
        <SectionPanel title="The request">
          <p className="text-sm">
            {context.resourceName} in {context.environment}:{' '}
            {context.items.map(item => item.key).join(', ')}
          </p>
        </SectionPanel>
      )
    case 'config.change':
    case 'app.teardown':
      return (
        <SectionPanel title="The request">
          <p className="text-sm whitespace-pre-wrap">{context.description}</p>
        </SectionPanel>
      )
  }
}
