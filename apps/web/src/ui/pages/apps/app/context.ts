/**
 * What `AppLayout` hands every tab through `<Outlet context>`: the app, whether the first build
 * holds the page, and the create/teardown pipeline the layout owns (one `usePipeline` per kind,
 * whatever tab is open — the teardown panel and the takeover read the same query).
 */
import type { AppDetail } from '@launch/shared/launch-apps'
import type { PipelineKind, PipelineView } from '@launch/shared/launch-pipeline'
import { useOutletContext } from 'react-router-dom'
import type { AppStage } from './appPageModel'

export interface AppPipelineControls {
  create: PipelineView | undefined
  teardown: PipelineView | undefined
  onRetry: (kind: PipelineKind) => () => void
  retrying: boolean
  onRescaffold: () => void
  rescaffolding: boolean
  onCancel: () => void
  cancelling: boolean
  /** A run this tab just started: poll for it through the grace window. */
  startWatching: (kind: PipelineKind) => void
}

export interface AppPageContext {
  app: AppDetail
  stage: AppStage
  /** `manage App`: edit, check health, retry the launch, archive. */
  canManage: boolean
  hasRepo: boolean
  /** The pending `app.create` approval a new app waits on, or null. */
  createApprovalId: string | null
  pipeline: AppPipelineControls
}

export function useAppPage(): AppPageContext {
  return useOutletContext<AppPageContext>()
}
