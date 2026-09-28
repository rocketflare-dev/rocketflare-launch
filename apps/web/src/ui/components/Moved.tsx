import { Navigate, useLocation } from 'react-router-dom'

/**
 * A page that moved: replace the URL, keeping its query and hash — the setup wizard's step anchors
 * (`/admin/setup#setup-public_url` → `/settings/platform/setup#setup-public_url`) survive. The
 * target's own guard decides who may open it; this decides nothing.
 */
export function Moved({ to }: { to: string }) {
  const { search, hash } = useLocation()
  return <Navigate to={`${to}${search}${hash}`} replace />
}
