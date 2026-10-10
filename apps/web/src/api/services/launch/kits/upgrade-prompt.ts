/**
 * The adapter's `upgradePrompt` (spec/02; P6 `docs/plans/p6-fleet.md` §1 item 3; D36 `upgrade`):
 * the first message of a kit upgrade's coding session (`launch/upgrades.ts`), which the session runs
 * as its first turn as soon as it is ready. It has the agent READ the kit's own upgrade skill
 * (`upgrade.skill`) and follow it itself, in the turn, to the target version — never invoke it as a
 * slash command or through the Skill tool: headless Claude Code took the Skill tool's "Launching
 * skill" for a background job and ended the turn having done nothing. It adds the rules an
 * UNATTENDED run needs on top of the skill's: nobody is there to answer a question, so every point
 * where the skill would ask is a point where the agent stops and explains.
 *
 * {@link upgradeFollowUpPrompt} is the one turn Launch adds of its own when the first ends with no
 * marker and the checkout untouched (`launch/upgrades.ts` `upgradeFollowUpDue`).
 *
 * The answer ends with one line Launch reads (`upgrade.doneMarker`, Rocketflare's
 * `UPGRADE_RESULT_MARKER`; `upgradeResultOf`): `LAUNCH-UPGRADE: DONE` or `LAUNCH-UPGRADE: STOPPED`.
 * Auto-ship needs `DONE` — and then checks the checkout itself (the app manifest's `kit.version`, a
 * changed workspace) before shipping, so a `DONE` that is not true ships nothing.
 *
 * **A kit with no `upgrade` block has no prompt**: its apps are never "behind" and never upgraded
 * (`TemplateAdapter.upgrade` is null). **Rocketflare's prompt is a legacy text**: the rules it adds
 * name its own upgrade tool's flags, exit codes and work tree (`pnpm kit:upgrade`, `--apply-deletes`,
 * `.upgrade/work/`), which the contract has no field for — they belong in the kit's `rf-upgrade`
 * skill (K6). Until they are there, a manifest whose `kit.id` is `rocketflare` gets them, with every
 * name the contract does carry (the command, the skill, the app manifest, the marker) taken from the
 * manifest; every other kit gets the generic prompt, which leaves those details to its skill.
 */
import type { KitManifest } from '@launch/shared/kit-manifest'
import { fillTemplate } from '@launch/shared/kit-manifest'
import { ROCKETFLARE_KIT_ID, rocketflareFallbackManifest } from './rocketflare-fallback'

export interface UpgradePromptInput {
  /** The app's kit version now (`apps.template_version`); null when Launch could not read one. */
  from: string | null
  /** The pin's tag — the version to upgrade to. */
  to: string
}

type UpgradeKit = Pick<KitManifest, 'kit' | 'scaffold' | 'upgrade'>

const FALLBACK: UpgradeKit = rocketflareFallbackManifest()

/** The manifest's upgrade block; a kit without one is never asked to upgrade. */
function upgradeOf(manifest: UpgradeKit): NonNullable<KitManifest['upgrade']> {
  if (!manifest.upgrade) throw new Error(`Kit ${manifest.kit.id} declares no upgrade`)
  return manifest.upgrade
}

/** The session title an upgrade starts with. */
export function upgradeTitle(input: UpgradePromptInput): string {
  return input.from ? `Upgrade kit ${input.from} → ${input.to}` : `Upgrade kit to ${input.to}`
}

/** The upgrade session's first message. Pure. */
export function upgradePrompt(input: UpgradePromptInput, manifest: UpgradeKit = FALLBACK): string {
  return manifest.kit.id === ROCKETFLARE_KIT_ID
    ? rocketflarePrompt(input, manifest)
    : genericPrompt(input, manifest)
}

/**
 * The ONE turn Launch sends of its own when the upgrade's first turn ended with no result line and
 * the checkout untouched — it never ran the upgrade. Pure.
 */
export function upgradeFollowUpPrompt(
  input: Pick<UpgradePromptInput, 'to'>,
  manifest: UpgradeKit = FALLBACK
): string {
  const { to } = input
  const upgrade = upgradeOf(manifest)
  const marker = upgrade.doneMarker
  const command = fillTemplate(upgrade.command, { to })
  const skill = upgrade.skill ? ` and follow \`${upgrade.skill}\` to the end` : ''
  return `You ended the turn without running the upgrade. Nothing runs in the background. Run \`${command}\` now${skill}, with every rule of the first message, then end with the result line: \`${marker} DONE\` or \`${marker} STOPPED\`.`
}

/** Any kit's prompt: the command, the skill, the unattended rules, the result line. */
function genericPrompt(input: UpgradePromptInput, manifest: UpgradeKit): string {
  const { from, to } = input
  const upgrade = upgradeOf(manifest)
  const marker = upgrade.doneMarker
  const command = fillTemplate(upgrade.command, { to })
  const appManifest = manifest.scaffold.appManifest
  return [
    `Upgrade this app's ${manifest.kit.name} kit${from ? ` from ${from}` : ''} to ${to}. Nobody is watching this turn: Launch ships the result on its own when you finish cleanly, and hands it to the app's owner when you stop.`,
    '',
    ...(upgrade.skill
      ? [
          `Read \`${upgrade.skill}\` and follow it yourself, in this turn: do not invoke it as a slash command or through the Skill tool. Nothing runs in the background and nothing will complete on its own — every step is a command you run with Bash and a file you edit, and the turn ends only when you end it.`,
          '',
        ]
      : []),
    `Run \`${command}\` with Bash, work through what it leaves for you${upgrade.notes ? ', then follow the porting notes of every release in the range' : ''}. Leave every change in the working tree: do not \`git add\`, \`git commit\`, push or open a pull request. This session is isolated; when you finish, Launch runs the gate, commits, pushes and opens the pull request itself.`,
    '',
    'Rules for this unattended run, on top of the skill’s own (they replace its commit step):',
    `- Never edit \`${appManifest}\` by hand; the upgrade writes it.`,
    '- Never write a resource id into a wrangler toml; a new binding keeps its `<PLACEHOLDER>`.',
    '- Do not run the full gate: Launch runs the gate itself when it ships. Targeted checks of the files you touched are fine.',
    '- Do not ask a question and do not end with `AskUserQuestion`: there is nobody to answer. Where the skill would ask, stop instead.',
    '',
    'Stop and explain — what happened, what the choices are, and what you would do — whenever the upgrade needs a decision, a conflict you cannot resolve with confidence, a deletion, or a manual step that needs a person.',
    '',
    'Do not end the turn until the upgrade is applied, or you have hit one of those stop conditions and explained it.',
    '',
    `End your final message with exactly one line on its own: \`${marker} DONE\` when the upgrade to ${to} is applied and \`${appManifest}\` says ${to}; otherwise \`${marker} STOPPED\`.`,
  ].join('\n')
}

/** Rocketflare's legacy prompt (see the header): its upgrade tool's rules, spelled out. */
function rocketflarePrompt(input: UpgradePromptInput, manifest: UpgradeKit): string {
  const { from, to } = input
  const upgrade = upgradeOf(manifest)
  const marker = upgrade.doneMarker
  const command = fillTemplate(upgrade.command, { to })
  const skill = upgrade.skill ?? '.claude/skills/rf-upgrade/SKILL.md'
  const appManifest = manifest.scaffold.appManifest
  return [
    `Upgrade this app's ${manifest.kit.name} kit${from ? ` from ${from}` : ''} to ${to}. Nobody is watching this turn: Launch ships the result on its own when you finish cleanly, and hands it to the app's owner when you stop.`,
    '',
    `Read \`${skill}\` and follow it yourself, in this turn: do not invoke it as a slash command or through the Skill tool. Nothing runs in the background and nothing will complete on its own — every step is a command you run with Bash and a file you edit, and the turn ends only when you end it.`,
    '',
    `Run \`${command}\` with Bash as ONE apply straight to ${to}, not one release at a time, work through its plan and every reject it leaves, then follow the "How to apply" steps of every porting note in the range, and finish with \`pnpm exec biome format --write ${appManifest}\` (a copy's upgrade script before 0.16.3 stamps that file in a layout its own lint rejects). Leave every change in the working tree: do not \`git add\`, \`git commit\`, push or open a pull request. This session is isolated; when you finish, Launch runs the gate, commits, pushes and opens the pull request itself.`,
    '',
    `The porting notes are at \`.upgrade/work/${to}/notes/X.Y.Z.md\`, one per release in the range (also in \`.upgrade/work/${to}/plan.md\`); the app's \`docs/upgrades/\` gets a new note only after \`--apply\`, so read them there even when an older copy's upgrade script prints a \`docs/upgrades/\` path that does not exist yet.`,
    '',
    'Rules for this unattended run, on top of the skill’s own (they replace its commit step):',
    '- Never pass `--force`, and never `--apply-deletes`. Never apply one of the kit’s deletions.',
    '- Never recreate a file under a surface this app removed (`skipped-surface-absent`).',
    `- Never edit \`${appManifest}\` by hand; the upgrade script writes it, last, only after a clean apply.`,
    '- Never write a resource id into a wrangler toml; a new binding keeps its `<PLACEHOLDER>`.',
    '- Do not upgrade the installed plugins here, and do not run the full gate (`pnpm gate`): Launch runs the gate itself when it ships. Targeted checks of the files you touched are fine.',
    '- Do not ask a question and do not end with `AskUserQuestion`: there is nobody to answer. Where the skill would ask, stop instead.',
    '',
    `Stop and explain — what happened, what the choices are, and what you would do — whenever one of these comes up: \`pnpm kit:upgrade\` exits 6 (a plugin does not support ${to}); a porting note calls for a decision; a reject (exit 4) you cannot resolve with confidence; a kit deletion; a manual step that needs a person; or anything that would need one of the things above.`,
    '',
    'Do not end the turn until the upgrade is applied and its porting notes are followed, or you have hit one of those stop conditions and explained it.',
    '',
    `End your final message with exactly one line on its own: \`${marker} DONE\` when the upgrade to ${to} is applied, its porting notes are followed and \`${appManifest}\` says ${to}; otherwise \`${marker} STOPPED\`.`,
  ].join('\n')
}
