/**
 * The setup wizard (spec/03, spec/04): `/api/platform/setup` (`canAdministerPlatform`). Every
 * mutation answers with fresh state, so each one invalidates the one `setup` family and the page re-renders from
 * the overview — there is no second source of truth for a dot. A credential value is sent once, in
 * a PUT body, and never comes back.
 */
import {
  type CredentialKind,
  type CredentialPayload,
  kitTagsResponseSchema,
  publicUrlCheckResponseSchema,
  type SessionAgentsUpdate,
  type SessionSandboxUpdate,
  type SetupSettingsUpdate,
  setupCheckResponseSchema,
  setupOverviewSchema,
  setupRemoveResponseSchema,
  type TemplatePinRequest,
} from '@launch/shared/launch-setup'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

const BASE = '/api/platform/setup'

export function useSetupOverview(enabled = true) {
  return useQuery({
    queryKey: queryKeys.setup.status,
    queryFn: () => api.get(BASE, { schema: setupOverviewSchema }),
    enabled,
  })
}

function useInvalidateSetup() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.setup.all })
}

export function useUpdateSetupSettings() {
  const invalidate = useInvalidateSetup()
  return useMutation({
    mutationFn: (body: SetupSettingsUpdate) =>
      api.put(`${BASE}/settings`, body, { schema: setupOverviewSchema }),
    onSuccess: () => invalidate(),
  })
}

export function usePutCredential<K extends CredentialKind>(kind: K) {
  const invalidate = useInvalidateSetup()
  return useMutation({
    mutationFn: (body: CredentialPayload<K>) =>
      api.put(`${BASE}/credentials/${kind}`, body, { schema: setupCheckResponseSchema }),
    onSuccess: () => invalidate(),
  })
}

export function useCheckCredential(kind: CredentialKind) {
  const invalidate = useInvalidateSetup()
  return useMutation({
    mutationFn: () =>
      api.post(`${BASE}/credentials/${kind}/check`, undefined, {
        schema: setupCheckResponseSchema,
      }),
    onSuccess: () => invalidate(),
  })
}

export function useRemoveCredential(kind: CredentialKind) {
  const invalidate = useInvalidateSetup()
  return useMutation({
    mutationFn: () =>
      api.delete(`${BASE}/credentials/${kind}`, undefined, { schema: setupRemoveResponseSchema }),
    onSuccess: () => invalidate(),
  })
}

/** Probe `APP_URL` from the internet now (step 7); the result is what `POST /api/apps` gates on. */
export function useCheckPublicUrl() {
  const invalidate = useInvalidateSetup()
  return useMutation({
    mutationFn: () =>
      api.post(`${BASE}/public-url/check`, undefined, { schema: publicUrlCheckResponseSchema }),
    onSuccess: () => invalidate(),
  })
}

/** The kit repo's tags, newest release first, for the Kit card's picker — fetched when it opens. */
export function useKitTags(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.setup.kitTags(repo),
    queryFn: () =>
      api.get(`${BASE}/template-pin/tags?repo=${encodeURIComponent(repo)}`, {
        schema: kitTagsResponseSchema,
      }),
    enabled,
    staleTime: 60_000,
  })
}

/**
 * Pin new apps to a release tag, an unreleased commit, or Follow latest; the server resolves it
 * via GitHub.
 */
export function useSetTemplatePin() {
  const invalidate = useInvalidateSetup()
  return useMutation({
    mutationFn: (body: TemplatePinRequest) =>
      api.put(`${BASE}/template-pin`, body, { schema: setupOverviewSchema }),
    onSuccess: () => invalidate(),
  })
}

/**
 * §18.22: the Coding agents card — on/off, model and who pays, per agent. What people can pick
 * when they start a session (and connect on Home) changes too, so that family is refreshed.
 */
export function useUpdateSessionAgents() {
  const invalidate = useInvalidateSetup()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: SessionAgentsUpdate) =>
      api.put(`${BASE}/session-agents`, body, { schema: setupOverviewSchema }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentAccounts.list })
      return invalidate()
    },
  })
}

/** Where new sessions' containers run (`launch_settings.session_sandbox_host`). */
export function useUpdateSessionSandbox() {
  const invalidate = useInvalidateSetup()
  return useMutation({
    mutationFn: (body: SessionSandboxUpdate) =>
      api.put(`${BASE}/session-sandbox`, body, { schema: setupOverviewSchema }),
    onSuccess: () => invalidate(),
  })
}

/** Follow latest's Check now: move the pin to the kit's newest release if there is a newer one. */
export function useCheckLatestKit() {
  const invalidate = useInvalidateSetup()
  return useMutation({
    mutationFn: () =>
      api.post(`${BASE}/template-pin/check`, undefined, { schema: setupOverviewSchema }),
    onSuccess: () => invalidate(),
    // A failed lookup is recorded on the check: the card shows it either way.
    onError: () => invalidate(),
  })
}

/** Back to the code default (`DEFAULT_TEMPLATE_PIN`). */
export function useResetTemplatePin() {
  const invalidate = useInvalidateSetup()
  return useMutation({
    mutationFn: () =>
      api.delete(`${BASE}/template-pin`, undefined, { schema: setupOverviewSchema }),
    onSuccess: () => invalidate(),
  })
}
