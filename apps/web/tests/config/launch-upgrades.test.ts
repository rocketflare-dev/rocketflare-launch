/**
 * The pure parts of P6 6c's kit upgrades: the version comparison behind "Requires upgrade", the
 * `LAUNCH-UPGRADE:` line the auto-ship reads, the auto-ship verdict itself (every way a first turn
 * can fail to be clean), when Launch sends its one follow-up turn instead, and the upgrade
 * prompt's unattended rules.
 */
import {
  kitVersionBehind,
  kitVersionOf,
  kitVersionReached,
  OPEN_APP_UPGRADE_STATUSES,
  upgradeResultOf,
} from '@launch/shared/launch-upgrades'
import { describe, expect, it } from 'vitest'
import {
  upgradeFollowUpPrompt,
  upgradePrompt,
  upgradeTitle,
} from '@/api/services/launch/rocketflare/upgrade-prompt'
import {
  autoShipVerdict,
  type UpgradeTurnEvidence,
  upgradeFollowUpDue,
} from '@/api/services/launch/upgrades'

describe('kit versions', () => {
  it('reads X.Y.Z with or without a v, and nothing else', () => {
    expect(kitVersionOf('0.16.1')).toBe('0.16.1')
    expect(kitVersionOf('v0.16.1')).toBe('0.16.1')
    expect(kitVersionOf('0.16')).toBeNull()
    expect(kitVersionOf('main')).toBeNull()
    expect(kitVersionOf(null)).toBeNull()
  })

  it('is behind only when both versions are readable and the app is semver-below', () => {
    expect(kitVersionBehind('0.16.0', '0.16.1')).toBe(true)
    expect(kitVersionBehind('0.9.9', '0.16.0')).toBe(true)
    expect(kitVersionBehind('0.16.1', '0.16.1')).toBe(false)
    expect(kitVersionBehind('0.17.0', '0.16.1')).toBe(false)
    expect(kitVersionBehind(null, '0.16.1')).toBe(false)
    expect(kitVersionBehind('0.16.0', null)).toBe(false)
    expect(kitVersionReached('0.16.2', '0.16.1')).toBe(true)
    expect(kitVersionReached('0.16.0', '0.16.1')).toBe(false)
  })

  it('an open upgrade is one still in flight', () => {
    expect(OPEN_APP_UPGRADE_STATUSES).toEqual(['queued', 'running', 'pr_open', 'needs_attention'])
  })
})

describe('upgradeResultOf', () => {
  it('reads the LAST marker line, tolerating markdown bold', () => {
    expect(upgradeResultOf('All good.\n\nLAUNCH-UPGRADE: DONE')).toBe('DONE')
    expect(upgradeResultOf('**LAUNCH-UPGRADE: STOPPED**')).toBe('STOPPED')
    expect(upgradeResultOf('LAUNCH-UPGRADE: DONE\n…then a reject.\nLAUNCH-UPGRADE: STOPPED')).toBe(
      'STOPPED'
    )
  })

  it('is null for a question, a marker inside a sentence, or nothing', () => {
    expect(upgradeResultOf('Should I force it?')).toBeNull()
    expect(upgradeResultOf('I will end with LAUNCH-UPGRADE: DONE when finished.')).toBeNull()
    expect(upgradeResultOf(null)).toBeNull()
  })
})

describe('autoShipVerdict — a first turn ended cleanly only with all the evidence', () => {
  const clean: UpgradeTurnEvidence = {
    status: 'completed',
    result: { subtype: 'success', isError: false, tail: 'Applied.\nLAUNCH-UPGRADE: DONE' },
    changed: true,
    askedQuestion: false,
    manifestVersion: '0.16.1',
  }

  it('ships the clean turn', () => {
    expect(autoShipVerdict(clean, '0.16.1')).toEqual({ ship: true })
  })

  const notClean: [string, Partial<UpgradeTurnEvidence>][] = [
    ['a failed turn', { status: 'failed' }],
    ['an interrupted turn', { status: 'interrupted' }],
    ['a turn with no result line', { result: undefined }],
    [
      'an error result',
      { result: { subtype: 'success', isError: true, tail: 'LAUNCH-UPGRADE: DONE' } },
    ],
    ['out of turns', { result: { subtype: 'error_max_turns', isError: true, tail: null } }],
    ['a question', { result: { subtype: 'success', isError: false, tail: 'Which one?' } }],
    [
      'STOPPED',
      { result: { subtype: 'success', isError: false, tail: 'LAUNCH-UPGRADE: STOPPED' } },
    ],
    ['AskUserQuestion', { askedQuestion: true }],
    ['an unchanged workspace', { changed: false }],
    ['an unmeasured workspace', { changed: undefined }],
    ['the manifest behind', { manifestVersion: '0.16.0' }],
    ['an unreadable manifest', { manifestVersion: null }],
  ]
  for (const [name, over] of notClean) {
    it(`does not ship ${name}`, () => {
      const verdict = autoShipVerdict({ ...clean, ...over }, '0.16.1')
      expect(verdict.ship).toBe(false)
      expect(verdict).toHaveProperty('reason', expect.any(String))
    })
  }
})

describe('upgradeFollowUpDue — a first turn that never ran the upgrade is sent back once', () => {
  const forgot: UpgradeTurnEvidence = {
    status: 'completed',
    result: {
      subtype: 'success',
      isError: false,
      tail: "I've launched the upgrade skill. Let me wait for it to complete.",
    },
    changed: false,
    askedQuestion: false,
    manifestVersion: null,
  }

  it('is due for a clean turn with no marker and an unchanged workspace', () => {
    expect(upgradeFollowUpDue(forgot, false)).toBe(true)
  })

  it('is due at most once', () => {
    expect(upgradeFollowUpDue(forgot, true)).toBe(false)
  })

  const notDue: [string, Partial<UpgradeTurnEvidence>][] = [
    [
      'an explicit STOPPED',
      { result: { subtype: 'success', isError: false, tail: 'Rejects.\nLAUNCH-UPGRADE: STOPPED' } },
    ],
    ['DONE', { result: { subtype: 'success', isError: false, tail: 'LAUNCH-UPGRADE: DONE' } }],
    ['a changed workspace (it stopped mid-way)', { changed: true }],
    ['an unmeasured workspace', { changed: undefined }],
    ['AskUserQuestion', { askedQuestion: true }],
    ['a failed turn', { status: 'failed' }],
    ['a turn with no result line', { result: undefined }],
    ['out of turns', { result: { subtype: 'error_max_turns', isError: true, tail: null } }],
  ]
  for (const [name, over] of notDue) {
    it(`is not due for ${name}`, () => {
      expect(upgradeFollowUpDue({ ...forgot, ...over }, false)).toBe(false)
    })
  }

  it('the follow-up says nothing runs in the background and names the command, skill and marker', () => {
    const text = upgradeFollowUpPrompt({ to: '0.17.1' })
    expect(text).toMatch(/^You ended the turn without running the upgrade\./)
    expect(text).toContain('Nothing runs in the background.')
    expect(text).toContain('`pnpm kit:upgrade --to 0.17.1 --apply`')
    expect(text).toContain('`.claude/skills/rf-upgrade/SKILL.md`')
    expect(text).toContain('LAUNCH-UPGRADE: DONE')
    expect(text).toContain('LAUNCH-UPGRADE: STOPPED')
  })
})

describe('the upgrade prompt', () => {
  it('has the agent follow the rf-upgrade skill itself, with the unattended rules and the marker', () => {
    const text = upgradePrompt({ from: '0.16.0', to: '0.16.1' })
    // Not a slash command or the Skill tool: headless Claude Code took "Launching skill" for a
    // background job and ended the turn. It reads the skill and does the work in this turn.
    expect(text).not.toContain('/rf-upgrade --to')
    expect(text).not.toMatch(/\bRun `\/rf-upgrade/)
    expect(text).toContain(
      'Read `.claude/skills/rf-upgrade/SKILL.md` and follow it yourself, in this turn'
    )
    expect(text).toMatch(/do not invoke it as a slash command or through the Skill tool/)
    expect(text).toMatch(/Nothing runs in the background and nothing will complete on its own/)
    expect(text).toMatch(
      /Do not end the turn until the upgrade is applied and its porting notes are followed/
    )
    expect(text).toContain('with Bash')
    expect(text).toMatch(/every reject/)
    for (const rule of [
      '--force',
      '--apply-deletes',
      'skipped-surface-absent',
      '.rocketflare.json',
    ]) {
      expect(text).toContain(rule)
    }
    expect(text).toMatch(/exits 6/)
    expect(text).toMatch(/exit 4/)
    expect(text).toContain('LAUNCH-UPGRADE: DONE')
    expect(text).toContain('LAUNCH-UPGRADE: STOPPED')
    // One apply to the target, nothing committed: Launch gates, commits and pushes when it ships.
    expect(text).toContain('pnpm kit:upgrade --to 0.16.1 --apply')
    expect(text).toMatch(/not one release at a time/)
    expect(text).toContain('pnpm exec biome format --write .rocketflare.json')
    expect(text).toMatch(/do not `git add`, `git commit`, push or open a pull request/)
    expect(text).not.toMatch(/one commit per release/)
    // Where the porting notes are before the apply (an older script prints the kit's path).
    expect(text).toContain('`.upgrade/work/0.16.1/notes/X.Y.Z.md`')
    expect(text).toContain('`.upgrade/work/0.16.1/plan.md`')
    expect(text).toMatch(/`docs\/upgrades\/` gets a new note only after `--apply`/)
    expect(upgradeTitle({ from: '0.16.0', to: '0.16.1' })).toBe('Upgrade kit 0.16.0 → 0.16.1')
    expect(upgradeTitle({ from: null, to: '0.16.1' })).toBe('Upgrade kit to 0.16.1')
  })
})
