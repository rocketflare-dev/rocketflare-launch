/**
 * Settings → Coding agents (`/settings/coding-agents`, §18.22): which coding agents sessions run,
 * each one's model and who pays — `CodingAgentsCard` over `session_policy.runtimes` — then where
 * their containers run (`SessionSandboxCard`, `session_sandbox_host`), then the Anthropic and
 * OpenAI keys sessions on Launch's account spend. Not a connection (Claude Code on the Worker
 * secret works with nothing set), so Home's setup checklist never asks for it. Reads the same setup
 * overview as the Connections pages; `canAdministerPlatform` (the section's guard).
 */
import { SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useSetupOverview } from '@/ui/hooks/useSetup'
import { CodingAgentsCard, codingAgentsKey } from './setup/CodingAgentsCard'
import { CredentialCard } from './setup/CredentialCard'
import { SessionSandboxCard, sessionSandboxKey } from './setup/SessionSandboxCard'

export default function CodingAgents() {
  const { data, isLoading, error } = useSetupOverview()

  if (isLoading) {
    return (
      <SectionPanel>
        <SkeletonRows rows={4} />
      </SectionPanel>
    )
  }
  if (error || !data) {
    return (
      <SectionPanel>
        <p className="text-sm text-error">Could not load the coding agent settings.</p>
      </SectionPanel>
    )
  }

  const anthropic = data.credentials.find(c => c.kind === 'anthropic_api_key')
  const openAi = data.credentials.find(c => c.kind === 'openai_api_key')

  return (
    <div className="space-y-6">
      <CodingAgentsCard
        key={codingAgentsKey(data.sessionAgents)}
        sessionAgents={data.sessionAgents}
      />

      <SessionSandboxCard
        key={sessionSandboxKey(data.sessionSandbox)}
        sessionSandbox={data.sessionSandbox}
      />

      {anthropic && (
        <CredentialCard
          id="anthropic"
          title="Anthropic key"
          status={anthropic.set ? (anthropic.lastCheckStatus ?? 'unchecked') : 'todo'}
          kind="anthropic_api_key"
          credential={anthropic}
          settings={data.settings}
          description="What Claude Code sessions spend when Launch pays. It never enters a sandbox: Launch adds it on the way out."
          help={
            <p>
              An API key from the Anthropic Console (not an admin key). Without one, Launch uses the{' '}
              <code>ANTHROPIC_API_KEY</code> Worker secret if it is set.
            </p>
          }
          settingFields={[]}
          payloadFields={[
            { name: 'apiKey', label: 'API key', secret: true, placeholder: 'sk-ant-api03-…' },
          ]}
        />
      )}

      {openAi && (
        <CredentialCard
          id="openai"
          title="OpenAI key"
          status={openAi.set ? (openAi.lastCheckStatus ?? 'unchecked') : 'todo'}
          kind="openai_api_key"
          credential={openAi}
          settings={data.settings}
          description="What Codex sessions spend when Launch pays. It never enters a sandbox: Launch adds it on the way out."
          help={
            <p>
              A project key from the OpenAI dashboard. Without one, Launch uses the{' '}
              <code>OPENAI_API_KEY</code> Worker secret if it is set.
            </p>
          }
          settingFields={[]}
          payloadFields={[
            { name: 'apiKey', label: 'API key', secret: true, placeholder: 'sk-proj-…' },
          ]}
        />
      )}
    </div>
  )
}
