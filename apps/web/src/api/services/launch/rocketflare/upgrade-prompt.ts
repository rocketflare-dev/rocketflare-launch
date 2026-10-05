/**
 * The Rocketflare adapter's `upgradePrompt` (spec/02; P6 `docs/plans/p6-fleet.md` §1 item 3): the
 * first message of a kit upgrade's coding session (`launch/upgrades.ts`), which the session runs as
 * its first turn as soon as it is ready. It has the agent READ the kit's own `rf-upgrade` skill
 * (`.claude/skills/rf-upgrade/SKILL.md`) and follow it itself, in the turn, to the pin's tag — never
 * invoke it as a slash command or through the Skill tool: headless Claude Code took the Skill tool's
 * "Launching skill" for a background job and ended the turn having done nothing. It adds the rules
 * an UNATTENDED run needs on top of the skill's: nobody is there to answer a question, so every
 * point where the skill would ask is a point where the agent stops and explains.
 *
 * {@link upgradeFollowUpPrompt} is the one turn Launch adds of its own when the first ends with no
 * marker and the checkout untouched (`launch/upgrades.ts` `upgradeFollowUpDue`).
 *
 * The answer ends with one line Launch reads (`UPGRADE_RESULT_MARKER`, `upgradeResultOf`):
 * `LAUNCH-UPGRADE: DONE` or `LAUNCH-UPGRADE: STOPPED`. Auto-ship needs `DONE` — and then checks the
 * checkout itself (`.rocketflare.json`'s `kit.version`, a changed workspace) before shipping, so a
 * `DONE` that is not true ships nothing.
 */
import { UPGRADE_RESULT_MARKER } from '@launch/shared/launch-upgrades'

export interface UpgradePromptInput {
  /** The app's kit version now (`apps.template_version`); null when Launch could not read one. */
  from: string | null
  /** The pin's tag — the version to upgrade to. */
  to: string
}

/** The session title an upgrade starts with. */
export function upgradeTitle(input: UpgradePromptInput): string {
  return input.from ? `Upgrade kit ${input.from} → ${input.to}` : `Upgrade kit to ${input.to}`
}

/** The upgrade session's first message. Pure. */
export function upgradePrompt(input: UpgradePromptInput): string {
  const { from, to } = input
  return [
    `Upgrade this app's Rocketflare kit${from ? ` from ${from}` : ''} to ${to}. Nobody is watching this turn: Launch ships the result on its own when you finish cleanly, and hands it to the app's owner when you stop.`,
    '',
    `Read \`.claude/skills/rf-upgrade/SKILL.md\` and follow it yourself, in this turn: do not invoke it as a slash command or through the Skill tool. Nothing runs in the background and nothing will complete on its own — every step is a command you run with Bash and a file you edit, and the turn ends only when you end it.`,
    '',
    `Run \`pnpm kit:upgrade --to ${to} --apply\` with Bash as ONE apply straight to ${to}, not one release at a time, work through its plan and every reject it leaves, then follow the "How to apply" steps of every porting note in the range, and finish with \`pnpm exec biome format --write .rocketflare.json\` (a copy's upgrade script before 0.16.3 stamps that file in a layout its own lint rejects). Leave every change in the working tree: do not \`git add\`, \`git commit\`, push or open a pull request. This session is isolated; when you finish, Launch runs the gate, commits, pushes and opens the pull request itself.`,
    '',
    `The porting notes are at \`.upgrade/work/${to}/notes/X.Y.Z.md\`, one per release in the range (also in \`.upgrade/work/${to}/plan.md\`); the app's \`docs/upgrades/\` gets a new note only after \`--apply\`, so read them there even when an older copy's upgrade script prints a \`docs/upgrades/\` path that does not exist yet.`,
    '',
    'Rules for this unattended run, on top of the skill’s own (they replace its commit step):',
    '- Never pass `--force`, and never `--apply-deletes`. Never apply one of the kit’s deletions.',
    '- Never recreate a file under a surface this app removed (`skipped-surface-absent`).',
    '- Never edit `.rocketflare.json` by hand; the upgrade script writes it, last, only after a clean apply.',
    '- Never write a resource id into a wrangler toml; a new binding keeps its `<PLACEHOLDER>`.',
    '- Do not upgrade the installed plugins here, and do not run the full gate (`pnpm gate`): Launch runs the gate itself when it ships. Targeted checks of the files you touched are fine.',
    '- Do not ask a question and do not end with `AskUserQuestion`: there is nobody to answer. Where the skill would ask, stop instead.',
    '',
    `Stop and explain — what happened, what the choices are, and what you would do — whenever one of these comes up: \`pnpm kit:upgrade\` exits 6 (a plugin does not support ${to}); a porting note calls for a decision; a reject (exit 4) you cannot resolve with confidence; a kit deletion; a manual step that needs a person; or anything that would need one of the things above.`,
    '',
    'Do not end the turn until the upgrade is applied and its porting notes are followed, or you have hit one of those stop conditions and explained it.',
    '',
    `End your final message with exactly one line on its own: \`${UPGRADE_RESULT_MARKER} DONE\` when the upgrade to ${to} is applied, its porting notes are followed and \`.rocketflare.json\` says ${to}; otherwise \`${UPGRADE_RESULT_MARKER} STOPPED\`.`,
  ].join('\n')
}

/**
 * The ONE turn Launch sends of its own when the upgrade's first turn ended with no
 * `LAUNCH-UPGRADE:` line and the checkout untouched — it never ran the upgrade. Pure.
 */
export function upgradeFollowUpPrompt(input: Pick<UpgradePromptInput, 'to'>): string {
  const { to } = input
  return `You ended the turn without running the upgrade. Nothing runs in the background. Run \`pnpm kit:upgrade --to ${to} --apply\` now and follow \`.claude/skills/rf-upgrade/SKILL.md\` to the end, with every rule of the first message, then end with the result line: \`${UPGRADE_RESULT_MARKER} DONE\` or \`${UPGRADE_RESULT_MARKER} STOPPED\`.`
}
