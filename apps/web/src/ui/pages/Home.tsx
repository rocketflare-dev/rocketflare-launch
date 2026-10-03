/**
 * Home: an overview of what this organisation runs and what is waiting on the reader — the
 * approvals they can decide, then the apps with their Live and Staging versions and one word where
 * something needs a look. Each block is its own small section component (`pages/home/`), each
 * behind the same guard as the page it summarises, so a richer widget is one more section rather
 * than a rewrite. It spans the whole main area. No hero, no stat tiles (docs/DESIGN.md); the full
 * lists are one link away.
 *
 * Lazy in `App.tsx` like every other page: its sections reuse the app page's and the inbox's
 * models, which the eager shell should not carry.
 *
 * Installed plugins' quick links (`UiPlugin.homeLinks`, D31) close the page as one quiet line,
 * each filtered by its route's own guard.
 */
import type { ComponentType } from 'react'
import { Link } from 'react-router-dom'
import { uiPlugins } from '@/plugins/ui'
import { PageHeader } from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import { type NavGuard, useNavGuard } from '@/ui/hooks/useNavGuard'
import { ApprovalsWaitingSection } from './home/ApprovalsWaitingSection'
import { AppsSection } from './home/AppsSection'

export interface QuickLink {
  to: string
  label: string
  description: string
  icon: ComponentType<{ className?: string }>
  guard?: NavGuard
}

/** The same guards as `/approvals` and `/apps` (and their nav items). */
const APPROVALS_GUARD: NavGuard = { action: 'read', subject: 'Approval' }
const APPS_GUARD: NavGuard = { action: 'read', subject: 'App' }

const PLUGIN_LINKS: QuickLink[] = uiPlugins.flatMap(p => p.homeLinks ?? [])

function PluginLinks({ links }: { links: QuickLink[] }) {
  if (links.length === 0) return null
  return (
    <nav aria-label="More in Launch" className="text-sm text-secondary">
      <ul className="flex flex-wrap gap-x-5 gap-y-1">
        {links.map(link => (
          <li key={link.to}>
            <Link to={link.to} className="link link-hover" title={link.description}>
              {link.label} →
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export default function Home() {
  const { tenant } = useAuth()
  const canAccess = useNavGuard()
  return (
    <div className="w-full space-y-10">
      <PageHeader title={tenant?.name ?? 'Home'} className="mb-0" />
      {canAccess(APPROVALS_GUARD) && <ApprovalsWaitingSection />}
      {canAccess(APPS_GUARD) && <AppsSection />}
      <PluginLinks links={PLUGIN_LINKS.filter(link => canAccess(link.guard))} />
    </div>
  )
}
