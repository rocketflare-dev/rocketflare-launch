/**
 * `/apps/:slug` (spec/06): one app — its environments with URLs, health and declared resources,
 * twenty-four hours of health history, its sign-in through Launch (the OIDC client, with the secret
 * shown once), the operations log, and a link to who may sign in (`/apps/:slug/access`). Every
 * member reads it; "Check now", Edit and the OIDC actions are for admins (`manage App`).
 */
import {
  ArrowPathIcon,
  CodeBracketIcon,
  ExclamationTriangleIcon,
  PencilSquareIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline'
import type { AppDetail } from '@launch/shared/launch-apps'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  EmptyStateCard,
  PageHeader,
  SectionPanel,
  SectionPanelSkeleton,
} from '@/ui/components/shared'
import { useApp, useCheckAppHealth } from '@/ui/hooks/useApps'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { ApiError } from '@/ui/lib/api-client'
import { formatDate } from '@/ui/lib/format'
import { EditAppModal } from './components/EditAppModal'
import { EnvironmentCard } from './components/EnvironmentCard'
import { HealthHistory } from './components/HealthHistory'
import { OidcClientCard } from './components/OidcClientCard'
import { OperationsLog } from './components/OperationsLog'

function About({ app }: { app: AppDetail }) {
  const repo = app.repoOwner && app.repoName ? `${app.repoOwner}/${app.repoName}` : null
  return (
    <SectionPanel title="About">
      <dl className="space-y-3 text-sm">
        <AboutRow label="Repository">
          {repo ? (
            <a
              href={`https://github.com/${repo}`}
              target="_blank"
              rel="noopener noreferrer"
              className="link link-hover font-mono text-xs inline-flex items-center gap-1"
            >
              <CodeBracketIcon className="w-3.5 h-3.5" />
              {repo}
            </a>
          ) : (
            '—'
          )}
        </AboutRow>
        <AboutRow label="Branch">
          <span className="font-mono text-xs">{app.defaultBranch ?? '—'}</span>
        </AboutRow>
        <AboutRow label="Team">
          {app.ownerGroup?.name ?? <span className="text-muted italic">No team</span>}
        </AboutRow>
        <AboutRow label="Template">
          <span className="font-mono text-xs">
            {app.template} {app.templateVersion ?? ''}
            {app.templateContractVersion ? ` · contract v${app.templateContractVersion}` : ''}
          </span>
        </AboutRow>
        <AboutRow label="Registered">
          {app.source === 'imported' ? 'Imported' : 'Created'} {formatDate(app.createdAt)}
        </AboutRow>
      </dl>
    </SectionPanel>
  )
}

function AboutRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted shrink-0">{label}</dt>
      <dd className="text-right min-w-0 truncate">{children}</dd>
    </div>
  )
}

function CheckNowButton({ app }: { app: AppDetail }) {
  const check = useCheckAppHealth(app)
  return (
    <button
      type="button"
      className="btn btn-sm gap-1.5"
      disabled={check.isPending}
      onClick={() => check.mutate()}
      title="Probe /api/health and /api/ready on every environment now"
    >
      <ArrowPathIcon className={`w-4 h-4 ${check.isPending ? 'animate-spin' : ''}`} />
      {check.isPending ? 'Checking…' : 'Check now'}
    </button>
  )
}

export default function AppDetailPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const { data: app, isLoading, error } = useApp(slug)
  const { can } = usePermissions()
  const canManage = can('manage', 'App')
  const [editOpen, setEditOpen] = useState(false)

  if (isLoading) {
    return (
      <div className="max-w-6xl space-y-4">
        <PageHeader title={slug} breadcrumbs={[{ label: 'Apps', to: '/apps' }, { label: slug }]} />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SectionPanelSkeleton rows={5} />
          <SectionPanelSkeleton rows={5} />
        </div>
      </div>
    )
  }

  if (error || !app) {
    const missing = error instanceof ApiError && error.status === 404
    return (
      <div className="max-w-6xl">
        <PageHeader title={slug} breadcrumbs={[{ label: 'Apps', to: '/apps' }, { label: slug }]} />
        <EmptyStateCard
          icon={missing ? Squares2X2Icon : ExclamationTriangleIcon}
          message={missing ? 'No app by that name' : 'This app could not be loaded'}
          description={missing ? undefined : error?.message}
          action={
            <Link to="/apps" className="btn btn-sm">
              Back to the catalogue
            </Link>
          }
        />
      </div>
    )
  }

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        className="mb-0"
        title={app.displayName}
        badge={
          app.status === 'live' ? null : (
            <span
              className="status-badge"
              data-status={app.status === 'archived' ? 'archived' : 'pending'}
            >
              {app.status}
            </span>
          )
        }
        breadcrumbs={[{ label: 'Apps', to: '/apps' }, { label: app.displayName }]}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-xs">{app.slug}</span>
            {app.description && (
              <>
                <span aria-hidden="true" className="text-muted">
                  ·
                </span>
                <span>{app.description}</span>
              </>
            )}
          </span>
        }
        actions={
          canManage && (
            <>
              <CheckNowButton app={app} />
              <button
                type="button"
                className="btn btn-sm btn-ghost gap-1.5"
                onClick={() => setEditOpen(true)}
              >
                <PencilSquareIcon className="w-4 h-4" />
                Edit
              </button>
            </>
          )
        }
      />

      {app.environments.length === 0 ? (
        <EmptyStateCard icon={Squares2X2Icon} message="No environments recorded" />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {app.environments.map(env => (
            <EnvironmentCard key={env.id} env={env} />
          ))}
        </div>
      )}

      {app.environments.length > 0 && (
        <HealthHistory appId={app.id} environments={app.environments} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        <div className="lg:col-span-2">
          <OidcClientCard appId={app.id} slug={app.slug} canManage={canManage} />
        </div>
        <About app={app} />
      </div>

      <OperationsLog appId={app.id} />

      {editOpen && <EditAppModal app={app} open={editOpen} onClose={() => setEditOpen(false)} />}
    </div>
  )
}
