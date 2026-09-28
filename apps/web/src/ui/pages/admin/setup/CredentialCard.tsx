/**
 * A credential step: the non-secret settings it depends on, the write-only credential fields, and
 * the last check's probes. "Save and check" saves whichever of the two changed — settings first,
 * because the probes read them — and the server checks on every credential PUT; with only settings
 * changed it re-runs the check itself so the dots describe what is now stored.
 *
 * Validation is the server's own schemas (`launchSettingValueSchemas`,
 * `credentialPayloadSchemas`), so a field error here is the 400 the server would have sent.
 */
import {
  type CredentialKind,
  credentialPayloadSchemas,
  type SetupCredential,
  type SetupSettingKey,
  type SetupSettings,
  type SetupStepId,
  type SetupStepStatus,
} from '@launch/shared/launch-setup'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { ConfirmModal, FieldError } from '@/ui/components/shared'
import {
  useCheckCredential,
  usePutCredential,
  useRemoveCredential,
  useUpdateSetupSettings,
} from '@/ui/hooks/useSetup'
import { timeAgo } from '@/ui/lib/format'
import { settingsPatch } from './fields'
import { SecretField } from './SecretField'
import { CheckList } from './StatusDot'
import { StepCard } from './StepCard'

export interface SettingFieldSpec {
  key: SetupSettingKey
  label: string
  placeholder?: string
  hint?: string
  /**
   * Known values, offered as a select (the Neon region). The server validates the free text the
   * same way either way; "Other…" keeps a value the list does not know yet.
   */
  options?: readonly { value: string; label: string }[]
  /** The select's blank choice, e.g. "Pick on the first check". */
  blankLabel?: string
}

const OTHER = '__other__'

/** A setting's input: plain text, or a select of `options` with a free-text fallback. */
function SettingInput({
  id,
  field,
  value,
  invalid,
  onChange,
}: {
  id: string
  field: SettingFieldSpec
  value: string
  invalid: boolean
  onChange: (value: string) => void
}) {
  const known = field.options?.some(o => o.value === value) ?? false
  const [other, setOther] = useState(value !== '' && !known)
  // Follow a value the server wrote (a check pins the region): known → the select, else free text.
  useEffect(() => {
    if (value !== '') setOther(!known)
  }, [value, known])

  if (!field.options) {
    return (
      <input
        id={id}
        className="input input-bordered w-full"
        value={value}
        placeholder={field.placeholder}
        onChange={e => onChange(e.target.value)}
        aria-invalid={invalid}
      />
    )
  }
  return (
    <>
      <select
        id={id}
        className="select select-bordered w-full"
        value={other ? OTHER : value}
        onChange={e => {
          if (e.target.value === OTHER) {
            setOther(true)
            if (known) onChange('')
          } else {
            setOther(false)
            onChange(e.target.value)
          }
        }}
        aria-invalid={invalid && !other}
      >
        <option value="">{field.blankLabel ?? '—'}</option>
        {field.options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        <option value={OTHER}>Other…</option>
      </select>
      {other && (
        <input
          id={`${id}-other`}
          aria-label={`${field.label} (other)`}
          className="input input-bordered w-full"
          value={value}
          placeholder={field.placeholder}
          onChange={e => onChange(e.target.value)}
          aria-invalid={invalid}
        />
      )}
    </>
  )
}

export interface PayloadFieldSpec {
  name: string
  label: string
  /** Secret fields are write-only; a non-secret one (the GitHub App id) is shown from metadata. */
  secret: boolean
  multiline?: boolean
  placeholder?: string
  hint?: string
}

interface CredentialCardProps {
  id: SetupStepId
  number: number
  title: string
  description: ReactNode
  status: SetupStepStatus
  kind: CredentialKind
  credential: SetupCredential
  settings: SetupSettings
  settingFields: SettingFieldSpec[]
  payloadFields: PayloadFieldSpec[]
  /** Guidance shown above the fields: where to create the credential, what scope it needs. */
  help?: ReactNode
}

export function CredentialCard({
  id,
  number,
  title,
  description,
  status,
  kind,
  credential,
  settings,
  settingFields,
  payloadFields,
  help,
}: CredentialCardProps) {
  const updateSettings = useUpdateSetupSettings()
  const putCredential = usePutCredential(kind)
  const check = useCheckCredential(kind)
  const remove = useRemoveCredential(kind)

  const [settingValues, setSettingValues] = useState<Partial<Record<SetupSettingKey, string>>>(() =>
    Object.fromEntries(settingFields.map(f => [f.key, settings[f.key] ?? '']))
  )
  // A check can WRITE settings (the Neon org and region it discovered), so follow the server's
  // values whenever they change rather than keeping a stale blank that the next save would clear.
  const serverValues = JSON.stringify(settingFields.map(f => settings[f.key]))
  // biome-ignore lint/correctness/useExhaustiveDependencies: serverValues is the dependency
  useEffect(() => {
    setSettingValues(Object.fromEntries(settingFields.map(f => [f.key, settings[f.key] ?? ''])))
  }, [serverValues])
  const [payload, setPayload] = useState<Record<string, string>>({})
  const [replacing, setReplacing] = useState(false)
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [confirmRemove, setConfirmRemove] = useState(false)

  const editingCredential = !credential.set || replacing
  const busy =
    updateSettings.isPending || putCredential.isPending || check.isPending || remove.isPending

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    const { patch, errors: settingErrors } = settingsPatch(
      settingFields.map(f => f.key),
      settingValues,
      settings
    )
    const nextErrors: Record<string, string | undefined> = { ...settingErrors }

    const typed = payloadFields.some(f => (payload[f.name] ?? '').trim() !== '')
    let body: Record<string, string> | null = null
    if (editingCredential && typed) {
      const parsed = credentialPayloadSchemas[kind].safeParse(payload)
      if (parsed.success) body = payload
      else
        for (const issue of parsed.error.issues) nextErrors[String(issue.path[0])] = issue.message
    }
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) return

    const settingsChanged = Object.keys(patch).length > 0
    if (settingsChanged) await updateSettings.mutateAsync(patch)
    if (body) {
      await putCredential.mutateAsync(body as never)
      setPayload({})
      setReplacing(false)
    } else if (settingsChanged && credential.set) {
      await check.mutateAsync()
    }
  }

  const lastCheck = credential.lastCheck ?? []

  return (
    <StepCard id={id} number={number} title={title} description={description} status={status}>
      {help && <div className="text-sm text-secondary space-y-1">{help}</div>}

      <form className="space-y-4" onSubmit={e => void onSubmit(e).catch(() => undefined)}>
        {settingFields.map(field => (
          <div key={field.key} className="space-y-1">
            <label htmlFor={`${id}-${field.key}`} className="block text-sm font-medium">
              {field.label}
            </label>
            <SettingInput
              id={`${id}-${field.key}`}
              field={field}
              value={settingValues[field.key] ?? ''}
              invalid={Boolean(errors[field.key])}
              onChange={value => setSettingValues(v => ({ ...v, [field.key]: value }))}
            />
            {field.hint && <p className="text-xs text-muted">{field.hint}</p>}
            <FieldError message={errors[field.key]} />
          </div>
        ))}

        {payloadFields.map(field =>
          field.secret ? (
            <SecretField
              key={field.name}
              id={`${id}-${field.name}`}
              label={field.label}
              isSet={credential.set}
              replacing={replacing}
              onReplace={setReplacing}
              value={payload[field.name] ?? ''}
              onChange={value => setPayload(p => ({ ...p, [field.name]: value }))}
              placeholder={field.placeholder}
              multiline={field.multiline}
              hint={field.hint}
              error={errors[field.name]}
            />
          ) : (
            <div key={field.name} className="space-y-1">
              <label htmlFor={`${id}-${field.name}`} className="block text-sm font-medium">
                {field.label}
              </label>
              {editingCredential ? (
                <input
                  id={`${id}-${field.name}`}
                  className="input input-bordered w-full"
                  value={payload[field.name] ?? ''}
                  placeholder={field.placeholder}
                  onChange={e => setPayload(p => ({ ...p, [field.name]: e.target.value }))}
                  aria-invalid={Boolean(errors[field.name])}
                />
              ) : (
                <p id={`${id}-${field.name}`} className="text-sm">
                  {String(credential.metadata[field.name] ?? '—')}
                </p>
              )}
              <FieldError message={errors[field.name]} />
            </div>
          )
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            {putCredential.isPending || updateSettings.isPending ? 'Saving…' : 'Save and check'}
          </button>
          {credential.set && (
            <>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => check.mutate()}
              >
                {check.isPending ? 'Checking…' : 'Re-check'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm text-error"
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
              >
                Remove
              </button>
            </>
          )}
        </div>
      </form>

      {credential.set && (
        <p className="text-xs text-muted">
          Set {timeAgo(credential.setAt)}
          {credential.setByEmail ? ` by ${credential.setByEmail}` : ''}
          {credential.rotatedAt ? ` · replaced ${timeAgo(credential.rotatedAt)}` : ''}
          {' · '}
          {credential.lastCheckedAt
            ? `checked ${timeAgo(credential.lastCheckedAt)}`
            : 'not checked'}
        </p>
      )}
      <CheckList checks={lastCheck} />

      <ConfirmModal
        isOpen={confirmRemove}
        title={`Remove the ${title} credential?`}
        message="Launch stops using it at once. Anything that needs it fails until a new one is set."
        confirmText="Remove"
        confirmButtonClass="btn-error"
        isLoading={remove.isPending}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSettled: () => setConfirmRemove(false),
            onSuccess: () => {
              setPayload({})
              setReplacing(false)
            },
          })
        }
      />
    </StepCard>
  )
}
