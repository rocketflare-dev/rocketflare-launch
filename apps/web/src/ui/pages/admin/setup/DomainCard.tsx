/**
 * Step 1 — the dedicated apps domain (spec/04) and the notifications sending domain beneath it.
 * The zone itself is probed with the Cloudflare token (step 2), so this card shows the `zone.*`
 * probes from that credential's last check, and re-runs it after a change when a token is set.
 */
import type {
  SetupCredential,
  SetupSettingKey,
  SetupSettings,
  SetupStepStatus,
} from '@launch/shared/launch-setup'
import { type FormEvent, useEffect, useState } from 'react'
import { FieldError } from '@/ui/components/shared'
import { useCheckCredential, useUpdateSetupSettings } from '@/ui/hooks/useSetup'
import { settingsPatch } from './fields'
import { CheckList } from './StatusDot'
import { StepCard } from './StepCard'

const KEYS: SetupSettingKey[] = ['apps_domain', 'notifications_domain']

export function DomainCard({
  status,
  settings,
  effectiveNotificationsDomain,
  cloudflare,
}: {
  status: SetupStepStatus
  settings: SetupSettings
  effectiveNotificationsDomain: string | null
  cloudflare: SetupCredential
}) {
  const update = useUpdateSetupSettings()
  const check = useCheckCredential('cloudflare_api_token')
  const [values, setValues] = useState<Partial<Record<SetupSettingKey, string>>>({})
  const [errors, setErrors] = useState<Partial<Record<SetupSettingKey, string>>>({})

  const serverValues = `${settings.apps_domain}|${settings.notifications_domain}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: serverValues is the dependency
  useEffect(() => {
    setValues({
      apps_domain: settings.apps_domain ?? '',
      notifications_domain: settings.notifications_domain ?? '',
    })
  }, [serverValues])

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    const { patch, errors: nextErrors } = settingsPatch(KEYS, values, settings)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0 || Object.keys(patch).length === 0) return
    await update.mutateAsync(patch)
    if (cloudflare.set) await check.mutateAsync()
  }

  const zoneChecks = (cloudflare.lastCheck ?? []).filter(c => c.id.startsWith('zone.'))
  const busy = update.isPending || check.isPending

  return (
    <StepCard
      id="domain"
      number={1}
      title="Domain and zone"
      status={status}
      description={
        <>
          A domain used only for apps, e.g. <code>company-apps.com</code>. Every app is a
          first-level host on it (<code>&lt;slug&gt;.company-apps.com</code>), served by a Worker
          route on one proxied wildcard record.
        </>
      }
    >
      <ul className="text-sm text-secondary list-disc pl-5 space-y-0.5">
        <li>The zone must be in the Cloudflare account you enter in step 2.</li>
        <li>
          It needs one proxied wildcard record, <code>AAAA *</code> → <code>100::</code>. With no{' '}
          <code>*</code> record at all, Launch creates it when the Cloudflare token is saved or
          checked (the token needs DNS Edit on the zone); an existing record is never changed.
        </li>
      </ul>
      <form className="space-y-4" onSubmit={e => void onSubmit(e).catch(() => undefined)}>
        <div className="space-y-1">
          <label htmlFor="domain-apps_domain" className="block text-sm font-medium">
            Apps domain
          </label>
          <input
            id="domain-apps_domain"
            className="input input-bordered w-full"
            placeholder="company-apps.com"
            value={values.apps_domain ?? ''}
            onChange={e => setValues(v => ({ ...v, apps_domain: e.target.value }))}
            aria-invalid={Boolean(errors.apps_domain)}
          />
          <FieldError message={errors.apps_domain} />
        </div>
        <div className="space-y-1">
          <label htmlFor="domain-notifications_domain" className="block text-sm font-medium">
            Notifications domain
          </label>
          <input
            id="domain-notifications_domain"
            className="input input-bordered w-full"
            placeholder={
              effectiveNotificationsDomain ??
              (settings.apps_domain ? `notifications.${settings.apps_domain}` : 'notifications.…')
            }
            value={values.notifications_domain ?? ''}
            onChange={e => setValues(v => ({ ...v, notifications_domain: e.target.value }))}
            aria-invalid={Boolean(errors.notifications_domain)}
          />
          <p className="text-xs text-muted">
            The one sending domain for every app's email. Leave blank for{' '}
            <code>notifications.&lt;apps domain&gt;</code>.
          </p>
          <FieldError message={errors.notifications_domain} />
        </div>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
      {zoneChecks.length > 0 ? (
        <CheckList checks={zoneChecks} />
      ) : (
        <p className="text-xs text-muted">
          The zone is checked with the Cloudflare token in the next step.
        </p>
      )}
    </StepCard>
  )
}
