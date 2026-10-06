/**
 * The card every page OUTSIDE the shell renders in (login, invite, select-tenant, pending):
 * brand header (mark, name, "by Rocketflare") + theme toggle over `main-gradient`, with the
 * dark theme's `starfield`. Keeps the public pages visually one family.
 *
 * `background` replaces that backdrop with a decorative layer of the caller's (the sign-in pages'
 * `RocketBackground` night sky): fixed behind the card, `aria-hidden`, and the panel is marked
 * `data-rocket-ignore` so the rocket leaves the card alone. The card keeps its theme surface either
 * way; only the footer, which sits straight on the backdrop, switches to the sky's ink.
 */
import { ShieldCheckIcon } from '@heroicons/react/24/outline'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAppInfo } from '@/ui/hooks/useAppInfo'
import { SETTINGS_PATH } from '@/ui/lib/settings-paths'
import { BrandLockup } from './shared/LogoMark'
import ThemeToggle from './ThemeToggle'

interface AuthCardProps {
  children: ReactNode
  /** `max-w-md` (default) or wider for lists */
  width?: 'md' | 'lg'
  /** Rendered under the card (e.g. "Signed in as … · Sign out") */
  footer?: ReactNode
  /** Decorative layer painted behind the card instead of the starfield (`RocketBackground`) */
  background?: ReactNode
}

export function AuthCard({ children, width = 'md', footer, background }: AuthCardProps) {
  const { name } = useAppInfo()
  return (
    <div
      className={`min-h-screen main-gradient flex flex-col items-center justify-center px-4 py-10 ${
        background ? 'relative isolate' : 'starfield'
      }`}
    >
      {background && (
        <div aria-hidden="true" className="fixed inset-0 -z-10">
          {background}
        </div>
      )}
      <div className={`w-full ${width === 'lg' ? 'max-w-lg' : 'max-w-md'}`}>
        <div className="surface-panel !p-0 overflow-hidden" data-rocket-ignore>
          <div className="flex h-14 items-center justify-between px-6 border-b border-[color:var(--border-subtle)]">
            <BrandLockup name={name} />
            <ThemeToggle />
          </div>
          <div className="p-6 md:p-8">{children}</div>
        </div>
        {footer && (
          <div
            className={`mt-4 text-center text-sm ${
              background ? 'text-[color:var(--night-sky-ink)]' : 'text-secondary'
            }`}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

/** "Signed in as X · Sign out" — the footer most no-tenant pages share. */
export function SignedInAs({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return (
    <span>
      Signed in as <span className="font-medium text-base-content">{email}</span>
      {' · '}
      <button type="button" className="link link-hover" onClick={onSignOut}>
        Sign out
      </button>
    </span>
  )
}

/**
 * A global admin parked on a no-tenant page can still run the platform: Settings needs no
 * membership (`ProtectedRoute`'s one exemption) and shows them its Connections, the access-request
 * queue where they approve the next person, and the operator's sections.
 */
export function AdminAreaLink({ className = '' }: { className?: string }) {
  return (
    <div className={`surface-inset rounded-lg p-3 text-sm flex items-center gap-3 ${className}`}>
      <ShieldCheckIcon className="w-5 h-5 shrink-0 text-muted" />
      <span className="flex-1 text-secondary">
        You're a global administrator — Settings works without an organisation.
      </span>
      <Link to={SETTINGS_PATH} className="btn btn-primary btn-sm whitespace-nowrap">
        Open Settings
      </Link>
    </div>
  )
}
