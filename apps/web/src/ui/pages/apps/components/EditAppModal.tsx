/** Edit an app's name, description and owner team (`PATCH /api/apps/:id`, admins). */
import { type AppDetail, updateAppRequestSchema } from '@launch/shared/launch-apps'
import { useState } from 'react'
import { FieldError, fieldErrorFor, Modal } from '@/ui/components/shared'
import { useUpdateApp } from '@/ui/hooks/useApps'
import { useGroups } from '@/ui/hooks/useGroups'

export function EditAppModal({
  app,
  open,
  onClose,
}: {
  app: AppDetail
  open: boolean
  onClose: () => void
}) {
  const update = useUpdateApp(app.id)
  const groups = useGroups(undefined, open)
  const [displayName, setDisplayName] = useState(app.displayName)
  const [description, setDescription] = useState(app.description ?? '')
  const [ownerGroupId, setOwnerGroupId] = useState(app.ownerGroup?.id ?? '')
  const [issues, setIssues] = useState<{ path: PropertyKey[]; message: string }[]>()

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const parsed = updateAppRequestSchema.safeParse({
      displayName,
      description: description.trim() || null,
      ownerGroupId: ownerGroupId || null,
    })
    if (!parsed.success) return setIssues(parsed.error.issues)
    setIssues(undefined)
    update.mutate(parsed.data, { onSuccess: onClose })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit app"
      actions={
        <>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            disabled={update.isPending}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="edit-app-form"
            className="btn btn-sm btn-primary"
            disabled={update.isPending}
          >
            {update.isPending ? <span className="loading loading-spinner loading-xs" /> : 'Save'}
          </button>
        </>
      }
    >
      <form id="edit-app-form" onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="app-name" className="label text-sm">
            Name
          </label>
          <input
            id="app-name"
            className="input w-full"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
          />
          <FieldError message={fieldErrorFor(issues, 'displayName')} />
        </div>
        <div>
          <label htmlFor="app-description" className="label text-sm">
            Description <span className="text-muted">(optional)</span>
          </label>
          <textarea
            id="app-description"
            className="textarea w-full"
            rows={3}
            value={description}
            onChange={e => setDescription(e.target.value)}
          />
          <FieldError message={fieldErrorFor(issues, 'description')} />
        </div>
        <div>
          <label htmlFor="app-team" className="label text-sm">
            Owner team
          </label>
          <select
            id="app-team"
            className="select w-full"
            value={ownerGroupId}
            onChange={e => setOwnerGroupId(e.target.value)}
          >
            <option value="">No team</option>
            {groups.data?.items.map(group => (
              <option key={group.id} value={group.id}>
                {group.name} ({group.typeName})
              </option>
            ))}
          </select>
        </div>
      </form>
    </Modal>
  )
}
