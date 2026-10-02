import { Navigate, type Params, useLocation, useParams } from 'react-router-dom'

/**
 * A page that moved: replace the URL, keeping its query and hash — the setup wizard's step anchors
 * (`/admin/setup#setup-public_url` → `/settings/platform/setup#setup-public_url`) survive. `to` is
 * a path, or a function of the old route's params for a page with an id (`/shared-config/:id` →
 * `/secrets/:id`). The target's own guard decides who may open it; this decides nothing.
 */
export function Moved({ to }: { to: string | ((params: Readonly<Params>) => string) }) {
  const { search, hash } = useLocation()
  const params = useParams()
  const path = typeof to === 'function' ? to(params) : to
  return <Navigate to={`${path}${search}${hash}`} replace />
}
