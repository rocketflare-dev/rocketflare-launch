/**
 * The one moment an app's OIDC client secret is visible (spec/05): Launch keeps only its hash, so
 * this modal shows it once, beside the config the app needs — three `[vars]` and a
 * `wrangler secret put` — with a copy button on each. Closing it is the end of the secret.
 */
import { CheckIcon, ClipboardIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import type { AppOidcClientSecretResponse } from '@launch/shared/launch-apps'
import { useState } from 'react'
import { Modal, showToast } from '@/ui/components/shared'

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      showToast(`${label} copied`, 'success')
      setTimeout(() => setCopied(false), 1500)
    } catch {
      showToast('Copy failed — select the text and copy it by hand', 'error')
    }
  }
  return (
    <button
      type="button"
      className="btn btn-sm join-item gap-1"
      onClick={copy}
      aria-label={`Copy ${label}`}
    >
      {copied ? (
        <CheckIcon className="w-4 h-4 text-success" />
      ) : (
        <ClipboardIcon className="w-4 h-4" />
      )}
      Copy
    </button>
  )
}

function Field({
  label,
  value,
  secret = false,
}: {
  label: string
  value: string
  secret?: boolean
}) {
  const id = `oidc-${label.toLowerCase().replace(/\s+/g, '-')}`
  return (
    <div>
      <label htmlFor={id} className="label text-xs font-medium uppercase tracking-wide">
        {label}
      </label>
      <div className="join w-full">
        <input
          id={id}
          type="text"
          readOnly
          className={`input input-sm join-item w-full font-mono text-xs ${secret ? 'tone-warning' : ''}`}
          value={value}
          onFocus={e => e.currentTarget.select()}
        />
        <CopyButton value={value} label={label} />
      </div>
    </div>
  )
}

export function OidcSecretModal({
  result,
  rotated,
  onClose,
}: {
  result: AppOidcClientSecretResponse | null
  /** Rotation invalidates the previous secret — say so. */
  rotated: boolean
  onClose: () => void
}) {
  return (
    <Modal
      open={result !== null}
      onClose={onClose}
      title={rotated ? 'New client secret' : 'OIDC client registered'}
      closeButton={false}
      className="max-w-2xl"
      actions={
        <button type="button" className="btn btn-sm btn-primary" onClick={onClose}>
          I have stored the secret
        </button>
      }
    >
      {result && (
        <div className="space-y-4">
          <div className="alert alert-warning alert-soft text-sm items-start" role="alert">
            <ExclamationTriangleIcon className="w-5 h-5 shrink-0" />
            <span>
              Copy the secret now — this is the only time it is shown. Launch keeps only a hash.
              {rotated && ' The previous secret has stopped working.'}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Issuer" value={result.issuer} />
            <Field label="Client ID" value={result.clientId} />
          </div>
          <Field label="Client secret" value={result.clientSecret} secret />
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="label text-xs font-medium uppercase tracking-wide">
                Wire the app to Launch
              </span>
              <div className="join">
                <CopyButton value={result.snippet} label="Config snippet" />
              </div>
            </div>
            <pre className="surface-inset p-3 text-xs font-mono overflow-x-auto whitespace-pre leading-relaxed">
              {result.snippet}
            </pre>
            <p className="text-xs text-muted mt-2">
              Deploy both environments afterwards. The app’s login page then goes straight to
              Launch, and sign-in follows the app’s access policy.
            </p>
          </div>
        </div>
      )}
    </Modal>
  )
}
