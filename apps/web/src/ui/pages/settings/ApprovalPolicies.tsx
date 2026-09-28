/**
 * Settings → Approvals (Launch P4, plan §1.5): who approves each kind, at organisation, team (group)
 * or app scope, over `/api/approval-policies`. `manage ApprovalPolicy` only — the tab is hidden
 * otherwise. Slice 4f builds it; 4a registered the tab.
 */
import { EmptyState } from '@/ui/components/shared'

export default function ApprovalPoliciesSettings() {
  return <EmptyState message="Approval policies use the defaults." />
}
