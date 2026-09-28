/**
 * Pure helpers shared by the setup cards: turning form strings into a settings patch (only what
 * changed, `''` meaning "clear") validated with the SAME per-key schemas the server uses.
 */
import {
  launchSettingValueSchemas,
  type SetupSettingKey,
  type SetupSettings,
  type SetupSettingsUpdate,
} from '@launch/shared/launch-setup'

export interface SettingsPatchResult {
  patch: SetupSettingsUpdate
  errors: Partial<Record<SetupSettingKey, string>>
}

export function settingsPatch(
  keys: readonly SetupSettingKey[],
  values: Partial<Record<SetupSettingKey, string>>,
  current: SetupSettings
): SettingsPatchResult {
  const patch: Record<string, string | null> = {}
  const errors: Partial<Record<SetupSettingKey, string>> = {}
  for (const key of keys) {
    const raw = (values[key] ?? '').trim()
    if (raw === '') {
      if (current[key] !== null) patch[key] = null
      continue
    }
    const parsed = launchSettingValueSchemas[key].safeParse(raw)
    if (!parsed.success) {
      errors[key] = parsed.error.issues[0]?.message ?? 'Invalid value'
      continue
    }
    if (parsed.data !== current[key]) patch[key] = parsed.data
  }
  return { patch: patch as SetupSettingsUpdate, errors }
}
