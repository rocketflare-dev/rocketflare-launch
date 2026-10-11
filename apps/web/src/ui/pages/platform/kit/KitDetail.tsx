/**
 * One kit's page, `/settings/kit/:slug` (D36 K1, K3, K5) — what the Kit version card showed for the
 * default kit, now for ANY kit, so the default is not shown twice:
 *
 * - **Version** — the repo, what it is pinned to, the commit, and for Follow latest when Launch
 *   last looked and what it found (a failed lookup says so); the pin editor (`PinForm`: Follow
 *   latest, a release tag picked from the repo's tags or typed, a commit or `main`), checked by
 *   the server before it is stored. The default kit adds Check now while it follows latest, and
 *   the built-in Rocketflare kit, once re-pinned, Reset to Launch's default.
 * - **Check** — the status, when it was checked, the problems a failed check found, and the last
 *   scaffold check with its run and what became of its test repo.
 * - **What it declares** — the manifest snapshot (`kitManifestSummary`): its source, the init
 *   command, the release workflow, the required check, upgrades, default plugins.
 *
 * The header carries Check and the same ⋯ menu as the list's row (Run the scaffold check, Make
 * default, Remove…). The kit comes from the catalogue (`useKits`, which polls while a check runs);
 * the manifest from `useKit`.
 */
import { ChevronLeftIcon } from '@heroicons/react/24/outline'
import { type Kit, kitManifestSummary } from '@launch/shared/kits'
import { DEFAULT_TEMPLATE_PIN, isFollowLatestPin, shortSha } from '@launch/shared/launch-setup'
import type { ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useKit, useKits } from '@/ui/hooks/useKits'
import { useResetTemplatePin } from '@/ui/hooks/useSetup'
import { SETTINGS_PATHS } from '@/ui/lib/settings-paths'
import { Ago, ExternalLink, MoreMenu } from '@/ui/pages/apps/app/bits'
import { SectionHeader } from '@/ui/pages/settings/SectionHeader'
import {
  DefaultLabel,
  DynamicCheckLine,
  KitStatus,
  PinForm,
  ProblemList,
  pinnedToText,
  useKitMenu,
} from './kitBits'

/** The built-in kit — the only one Launch has a code default for (`ROCKETFLARE_KIT_ID`). */
const BUILT_IN_SLUG = 'rocketflare'

function Block({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="px-5 py-5 space-y-3">
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Facts({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <dl
      className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm"
      aria-label={label}
    >
      {children}
    </dl>
  )
}

function VersionBlock({ kit }: { kit: Kit }) {
  const reset = useResetTemplatePin()
  const following = isFollowLatestPin(kit.pin)
  const check = kit.latestCheck && kit.latestCheck.repo === kit.pin.repo ? kit.latestCheck : null
  const canReset = kit.isDefault && kit.slug === BUILT_IN_SLUG && !kit.pinIsCodeDefault
  return (
    <Block id="kit-version-title" title="Version">
      <Facts>
        <dt className="text-muted">Repository</dt>
        <dd className="font-mono text-xs leading-5 break-all">
          <ExternalLink href={`https://github.com/${kit.repo}`}>{kit.repo}</ExternalLink>
        </dd>
        <dt className="text-muted">Pinned to</dt>
        <dd>{pinnedToText(kit)}</dd>
        <dt className="text-muted">Commit</dt>
        <dd className="font-mono tabular-nums text-xs leading-5" title={kit.pin.commit}>
          {shortSha(kit.pin.commit)}
        </dd>
        {following && (
          <>
            <dt className="text-muted">Checked</dt>
            <dd>{check ? <Ago at={check.checkedAt} /> : 'Not yet'}</dd>
            <dt className="text-muted">Latest</dt>
            <dd className="font-mono tabular-nums text-xs leading-5">
              {check?.latest ?? kit.pin.tag}
            </dd>
          </>
        )}
      </Facts>
      {following && check?.error && (
        <p className="text-sm text-error" role="alert">
          The last check failed: {check.error}. Launch tries again within five minutes.
        </p>
      )}
      {!kit.pin.tag && (
        <p className="text-sm text-warning" role="status">
          Unreleased commit, for development: pin a release before making apps people will use.
        </p>
      )}
      <div className="pt-2">
        <PinForm key={`${kit.pin.commit}-${kit.pin.follow ?? ''}`} kit={kit} />
      </div>
      {canReset && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
          <button
            type="button"
            className="btn btn-sm btn-outline"
            disabled={reset.isPending}
            title={`Launch's default is ${DEFAULT_TEMPLATE_PIN.repo} ${DEFAULT_TEMPLATE_PIN.tag ?? shortSha(DEFAULT_TEMPLATE_PIN.commit)}`}
            onClick={() => reset.mutate()}
          >
            Reset to Launch's default
          </button>
          <span className="text-xs text-muted font-mono tabular-nums">
            {DEFAULT_TEMPLATE_PIN.tag ?? shortSha(DEFAULT_TEMPLATE_PIN.commit)}
          </span>
          {reset.error && (
            <p className="text-xs text-error w-full" role="alert">
              {reset.error.message}
            </p>
          )}
        </div>
      )}
    </Block>
  )
}

function CheckBlock({ kit }: { kit: Kit }) {
  return (
    <Block id="kit-check-title" title="Check">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <KitStatus kit={kit} />
        {kit.checkedAt && (
          <span className="text-muted">
            checked <Ago at={kit.checkedAt} />
          </span>
        )}
      </div>
      {kit.status !== 'verified' && kit.problems.length > 0 && (
        <ProblemList problems={kit.problems} label={`Problems with ${kit.name}`} />
      )}
      {kit.dynamicCheck ? (
        <DynamicCheckLine check={kit.dynamicCheck} />
      ) : (
        <p className="text-sm text-muted">No scaffold check at this pin.</p>
      )}
    </Block>
  )
}

/** What the kit's manifest snapshot declares (`kitManifestSummary`). */
function DeclaresBlock({ kit }: { kit: Kit }) {
  const { data, isLoading, error } = useKit(kit.id)
  let body: ReactNode
  if (isLoading) body = <SkeletonRows rows={3} />
  else if (error) {
    body = (
      <p className="text-sm text-error" role="alert">
        Could not load the manifest: {error.message}
      </p>
    )
  } else if (!data?.manifest) {
    body = (
      <p className="text-sm text-muted">No manifest read yet: Check reads its launch.kit.json.</p>
    )
  } else {
    const declared = kitManifestSummary(data.manifest)
    body = (
      <Facts label={`What ${kit.name} declares`}>
        <dt className="text-muted">Manifest</dt>
        <dd>
          {data.manifestSource === 'fallback'
            ? "Launch's built-in Rocketflare manifest"
            : `launch.kit.json, contract ${data.contractVersion ?? '1'}`}
        </dd>
        <dt className="text-muted">Init</dt>
        <dd className="font-mono text-xs leading-5 break-all">{declared.init}</dd>
        <dt className="text-muted">Release workflow</dt>
        <dd className="font-mono text-xs leading-5 break-all">
          .github/workflows/{declared.releaseWorkflow}
        </dd>
        <dt className="text-muted">Required check</dt>
        <dd className="font-mono text-xs leading-5 break-all">{declared.requiredCheck}</dd>
        <dt className="text-muted">Upgrades</dt>
        <dd>
          {declared.upgrades
            ? 'Supported: apps behind the pin are offered an upgrade'
            : 'Not declared: its apps are never shown as behind'}
        </dd>
        <dt className="text-muted">Plugins</dt>
        <dd>{declared.plugins.length ? declared.plugins.join(', ') : 'None by default'}</dd>
      </Facts>
    )
  }
  return (
    <Block id="kit-declares-title" title="What it declares">
      {body}
    </Block>
  )
}

function KitPage({ kit }: { kit: Kit }) {
  const navigate = useNavigate()
  const { items, dialog, check, error } = useKitMenu(kit, {
    onRemoved: () => navigate(SETTINGS_PATHS.kit),
  })
  const checkingStatic = check.isPending && check.variables?.dynamic !== true
  return (
    <div className="space-y-5">
      <SectionHeader
        title={kit.name}
        badge={kit.isDefault ? <DefaultLabel /> : undefined}
        description={
          <>
            {kit.description ? `${kit.description} · ` : ''}
            <span className="tabular-nums">
              {kit.appCount} app{kit.appCount === 1 ? '' : 's'} made from it
            </span>
          </>
        }
        actions={
          <>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              disabled={check.isPending}
              onClick={() => check.mutate({ id: kit.id })}
            >
              {checkingStatic ? 'Checking…' : 'Check'}
            </button>
            <MoreMenu items={items} label={`More actions for ${kit.name}`} />
          </>
        }
      />
      {error && (
        <p className="text-sm text-error" role="alert">
          {error.message}
        </p>
      )}
      <section
        aria-label={kit.name}
        className="surface-panel p-0 divide-y divide-base-300 overflow-visible"
      >
        <VersionBlock kit={kit} />
        <CheckBlock kit={kit} />
        <DeclaresBlock kit={kit} />
      </section>
      {dialog}
    </div>
  )
}

export function KitDetail() {
  const { slug = '' } = useParams()
  const { data, isLoading, error } = useKits()
  const kit = data?.kits.find(k => k.slug === slug)
  return (
    <div className="space-y-4">
      <Link
        to={SETTINGS_PATHS.kit}
        className="inline-flex items-center gap-1 text-sm text-secondary hover:text-base-content"
      >
        <ChevronLeftIcon className="w-4 h-4" aria-hidden="true" />
        Kits
      </Link>
      {isLoading ? (
        <SectionPanel>
          <SkeletonRows rows={4} />
        </SectionPanel>
      ) : error ? (
        <p className="text-sm text-error" role="alert">
          Could not load the kits.
        </p>
      ) : kit ? (
        <KitPage kit={kit} />
      ) : (
        <p className="text-sm text-secondary">There is no kit called {slug}.</p>
      )}
    </div>
  )
}
