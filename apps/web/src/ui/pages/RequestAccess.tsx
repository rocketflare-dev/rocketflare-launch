/**
 * `/request-access?client_id=…&return=…` (spec/05): where `/oidc/authorize` sends a signed-in
 * person the app's access policy does not admit. They ask the app's owners for access, see a
 * pending or rejected request, and — once admitted — continue to the app through `return`.
 *
 * `return` is followed only when it is a same-origin `/oidc/authorize` path: the authorize
 * endpoint re-checks everything (the client, the redirect URI, the policy), so it is the one place
 * this page may send the browser.
 */
import {
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  LockClosedIcon,
} from '@heroicons/react/24/outline'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmptyStateCard, PageHeader, SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useAppAccessRequestContext, useRequestAppAccess } from '@/ui/hooks/useAppAccess'
import { hardNavigate, safeReturnUrl } from '@/ui/lib/navigation'

/** Only the issuer's own authorize endpoint — never an arbitrary path, never another origin. */
function continueUrl(value: string | null): string | null {
  const safe = safeReturnUrl(value, '')
  return safe.startsWith('/oidc/authorize?') ? safe : null
}

export default function RequestAccess() {
  const [params] = useSearchParams()
  const clientId = params.get('client_id')
  const back = continueUrl(params.get('return'))
  const { data, isLoading, isError } = useAppAccessRequestContext(clientId)
  const requestAccess = useRequestAppAccess()
  const [message, setMessage] = useState('')

  if (!clientId) {
    return (
      <div className="max-w-2xl">
        <PageHeader title="Request access" />
        <EmptyStateCard
          icon={ExclamationTriangleIcon}
          message="No app was named"
          description="Open the app you were trying to use and sign in again."
        />
      </div>
    )
  }

  const appName = data?.app.displayName ?? 'this app'
  const standing = requestAccess.data?.standing ?? data?.standing

  return (
    <div className="max-w-2xl">
      <PageHeader
        title={data ? `Access to ${data.app.displayName}` : 'Request access'}
        description="Launch signs you in to the company's apps. This one is limited to the people its owners allow."
      />
      {isLoading ? (
        <SectionPanel>
          <SkeletonRows rows={3} />
        </SectionPanel>
      ) : isError || !data ? (
        <EmptyStateCard
          icon={ExclamationTriangleIcon}
          message="App not found"
          description="This app is not registered in your organisation."
        />
      ) : standing === 'allowed' ? (
        <EmptyStateCard
          icon={CheckCircleIcon}
          message={`You have access to ${appName}`}
          description="Continue and Launch will sign you in."
          action={
            back ? (
              <button
                type="button"
                className="btn btn-primary btn-flame"
                onClick={() => hardNavigate(back)}
              >
                Continue to {appName}
              </button>
            ) : undefined
          }
        />
      ) : standing === 'pending' ? (
        <EmptyStateCard
          icon={ClockIcon}
          message="Your request is with the app's owners"
          description="You will be able to sign in once one of them approves it. Try again after that."
          action={
            back ? (
              <button type="button" className="btn btn-ghost" onClick={() => hardNavigate(back)}>
                Try again
              </button>
            ) : undefined
          }
        />
      ) : (
        <SectionPanel
          title={
            <span className="inline-flex items-center gap-2">
              <LockClosedIcon className="w-5 h-5 text-muted" aria-hidden="true" />
              You do not have access to {appName} yet
            </span>
          }
          description={
            standing === 'rejected'
              ? 'Your last request was declined. You can ask again — say why you need it.'
              : "Ask the app's owners. They will see your request and your message."
          }
        >
          <form
            className="space-y-4"
            onSubmit={e => {
              e.preventDefault()
              requestAccess.mutate({ clientId, message: message.trim() || undefined })
            }}
          >
            <label className="form-control w-full">
              <span className="label-text mb-1">Message (optional)</span>
              <textarea
                className="textarea textarea-bordered w-full"
                rows={3}
                maxLength={1000}
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="What do you need it for?"
              />
            </label>
            <button
              type="submit"
              className="btn btn-primary btn-flame"
              disabled={requestAccess.isPending}
            >
              {requestAccess.isPending ? 'Sending…' : 'Request access'}
            </button>
          </form>
        </SectionPanel>
      )}
    </div>
  )
}
