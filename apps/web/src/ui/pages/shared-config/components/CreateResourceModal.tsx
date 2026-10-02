/**
 * Create a shared resource (Launch P5, plan §1.1) — admins only. A resource is a named bundle of
 * items (`{key, kind, description?}`: M365's tenant id and client id are vars, its client secret a
 * secret) owned by a team, which then sets the values and decides who holds it. Values are NOT
 * set here: the owner team sets them per environment on the resource's page, so an admin creating
 * the bundle never handles a credential that is not theirs.
 *
 * Validated with `createSharedResourceSchema`, the route's own (keys are env-var names, unique).
 * The slug defaults from the name and is what `launch shared` addresses it by.
 */
import { PlusIcon, TrashIcon } from '@heroicons/react/24/outline'
import {
  createSharedResourceSchema,
  GRANT_ERROR_CODES,
  SHARED_RESOURCE_ITEM_KINDS,
  type SharedResourceItemKind,
  sharedResourcePath,
} from '@launch/shared/launch-grants'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FieldError, Modal, showToast } from '@/ui/components/shared'
import { useGroups } from '@/ui/hooks/useGroups'
import { useCreateSharedResource } from '@/ui/hooks/useSharedResources'
import { ApiError } from '@/ui/lib/api-client'

interface ItemDraft {
  id: number
  key: string
  kind: SharedResourceItemKind
  description: string
}

/** "Microsoft 365" → "microsoft-365". Pure. */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 40)
}

let nextId = 1
const blankItem = (kind: SharedResourceItemKind = 'secret'): ItemDraft => ({
  id: nextId++,
  key: '',
  kind,
  description: '',
})

export function CreateResourceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const create = useCreateSharedResource()
  const groups = useGroups()
  const [displayName, setDisplayName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [ownerGroupId, setOwnerGroupId] = useState('')
  const [items, setItems] = useState<ItemDraft[]>(() => [blankItem('var'), blankItem('secret')])
  const [errors, setErrors] = useState<Record<string, string>>({})

  const effectiveSlug = slugTouched ? slug : slugFromName(displayName)

  const submit = () => {
    const parsed = createSharedResourceSchema.safeParse({
      slug: effectiveSlug,
      displayName,
      ...(description.trim() ? { description } : {}),
      ownerGroupId,
      items: items
        .filter(item => item.key.trim() !== '')
        .map(item => ({
          key: item.key.trim(),
          kind: item.kind,
          ...(item.description.trim() ? { description: item.description.trim() } : {}),
        })),
    })
    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0])
        next[field] ??= field === 'ownerGroupId' ? 'Pick the team that owns it' : issue.message
      }
      setErrors(next)
      return
    }
    setErrors({})
    create.mutate(parsed.data, {
      onSuccess: detail => {
        showToast(`Created ${detail.displayName}. Its owner team sets the values next.`, 'success')
        onClose()
        navigate(sharedResourcePath(detail.id))
      },
    })
  }

  const slugTaken =
    create.error instanceof ApiError && create.error.code === GRANT_ERROR_CODES.slugTaken

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New secret"
      className="max-w-2xl"
      actions={
        <>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={create.isPending}
            onClick={submit}
          >
            {create.isPending && <span className="loading loading-spinner loading-xs" />}
            Create
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-xs text-muted">
            Name
            <input
              className="input input-sm w-full mt-1"
              value={displayName}
              placeholder="Microsoft 365"
              onChange={event => setDisplayName(event.target.value)}
            />
            <FieldError message={errors.displayName} />
          </label>
          <label className="text-xs text-muted">
            Slug
            <input
              className="input input-sm w-full mt-1 font-mono"
              value={effectiveSlug}
              onChange={event => {
                setSlugTouched(true)
                setSlug(event.target.value)
              }}
            />
            <FieldError
              message={slugTaken ? 'Another secret already uses this slug' : errors.slug}
            />
          </label>
        </div>
        <label className="block text-xs text-muted">
          Description (optional)
          <textarea
            className="textarea w-full text-sm mt-1"
            rows={2}
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </label>
        <label className="block text-xs text-muted">
          Owner team — its members set the values and decide who holds it
          <select
            className="select select-sm w-full mt-1"
            value={ownerGroupId}
            onChange={event => setOwnerGroupId(event.target.value)}
          >
            <option value="">Pick a team…</option>
            {(groups.data?.items ?? []).map(group => (
              <option key={group.id} value={group.id}>
                {group.name} ({group.typeName})
              </option>
            ))}
          </select>
          <FieldError message={errors.ownerGroupId} />
        </label>

        <fieldset>
          <legend className="text-xs text-muted mb-1">
            Items — the env-var names apps read, exactly as their plugins declare them
          </legend>
          <ul className="space-y-2">
            {items.map(item => (
              <li key={item.id} className="flex flex-wrap items-center gap-2">
                <input
                  aria-label="Key"
                  className="input input-sm font-mono flex-1 min-w-40"
                  placeholder="M365_CLIENT_SECRET"
                  value={item.key}
                  onChange={event =>
                    setItems(current =>
                      current.map(i =>
                        i.id === item.id ? { ...i, key: event.target.value.toUpperCase() } : i
                      )
                    )
                  }
                />
                <select
                  aria-label="Kind"
                  className="select select-sm w-28"
                  value={item.kind}
                  onChange={event =>
                    setItems(current =>
                      current.map(i =>
                        i.id === item.id
                          ? { ...i, kind: event.target.value as SharedResourceItemKind }
                          : i
                      )
                    )
                  }
                >
                  {SHARED_RESOURCE_ITEM_KINDS.map(kind => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Description"
                  className="input input-sm flex-1 min-w-40"
                  placeholder="What it is (optional)"
                  value={item.description}
                  onChange={event =>
                    setItems(current =>
                      current.map(i =>
                        i.id === item.id ? { ...i, description: event.target.value } : i
                      )
                    )
                  }
                />
                <button
                  type="button"
                  className="btn btn-sm btn-ghost btn-square"
                  aria-label="Remove item"
                  disabled={items.length === 1}
                  onClick={() => setItems(current => current.filter(i => i.id !== item.id))}
                >
                  <TrashIcon className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-xs btn-ghost gap-1 mt-2"
            onClick={() => setItems(current => [...current, blankItem()])}
          >
            <PlusIcon className="w-3.5 h-3.5" />
            Add an item
          </button>
          <FieldError message={errors.items} />
        </fieldset>

        {create.error && !slugTaken && (
          <div className="alert alert-error alert-soft text-sm" role="alert">
            <span>{create.error.message}</span>
          </div>
        )}
      </div>
    </Modal>
  )
}
