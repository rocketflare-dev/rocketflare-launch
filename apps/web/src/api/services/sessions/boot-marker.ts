/**
 * The boot marker (Launch P3): how Launch tells the container a session's boot PREPARED from one
 * the platform recreated under it. `sandbox.start` writes a fresh id into `SESSION_BOOT_MARKER`
 * and the Workflow carries that id (`bootId`) through every later step of the boot, the turns and
 * the checkpoints. A container that died — out of memory, most often (`pnpm build` in a turn) —
 * comes back EMPTY the next time anything calls into it: no checkout, no dependencies, no
 * transcript and no marker. Reading the marker is therefore both the probe and the verdict.
 *
 * Reading it may itself boot that empty container (the Durable Object starts one for any call):
 * harmless, because the marker is then missing, which is exactly the signal. A read that does
 * not answer is bounded by the caller and is NOT evidence either way (`unknown`).
 */
import { SandboxInterruptedError, type SandboxPort } from './ports'
import { SESSION_LAUNCH_DIR } from './rocketflare-dev'

/** Where `sandbox.start` writes this boot's id. */
export const SESSION_BOOT_MARKER = `${SESSION_LAUNCH_DIR}/boot-id`

/**
 * - `ours` — the marker is the boot's id: the container is the one the boot prepared.
 * - `replaced` — the container ANSWERED, and the marker is missing or another boot's.
 * - `interrupted` — the platform replaced the container under the call (a rollout).
 * - `unknown` — the read failed or did not answer in time: no evidence either way.
 */
export type ContainerVerdict = 'ours' | 'replaced' | 'interrupted' | 'unknown'

/** Read the marker (within `callMs` when given) and compare it with `bootId`. Never throws. */
export async function checkContainer(
  sandbox: Pick<SandboxPort, 'readFile'>,
  bootId: string,
  callMs?: number
): Promise<ContainerVerdict> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = sandbox.readFile(SESSION_BOOT_MARKER)
  read.catch(() => {})
  try {
    const marker = callMs
      ? await Promise.race([
          read,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no answer within ${callMs} ms`)), callMs)
          }),
        ])
      : await read
    return marker?.trim() === bootId ? 'ours' : 'replaced'
  } catch (err) {
    return err instanceof SandboxInterruptedError ? 'interrupted' : 'unknown'
  } finally {
    clearTimeout(timer)
  }
}

/** True / false when the marker could be read; null when the sandbox could not even be asked. */
export async function containerIsOurs(
  sandbox: Pick<SandboxPort, 'readFile'>,
  bootId: string
): Promise<boolean | null> {
  const verdict = await checkContainer(sandbox, bootId)
  return verdict === 'ours' ? true : verdict === 'replaced' ? false : null
}

/**
 * The container is gone and its unsaved work with it: the session goes `suspended`, and the next
 * message boots a new container from the last checkpoint (the branch, or the workspace backup).
 */
export const CONTAINER_LOST_MESSAGE =
  "The session's container stopped during this turn — most likely it ran out of memory (a build" +
  ' or a test run can do that). Send a message to carry on: the session restarts from its last' +
  ' save, and changes made since then are lost.'

/** Before a turn: the message has not run, and the resume that is starting will run it. */
export const CONTAINER_LOST_BEFORE_TURN_MESSAGE =
  "The session's container had stopped — most likely it ran out of memory — so your message has" +
  ' not run yet. The session is restarting from its last save and will run it then; changes made' +
  ' since that save are lost.'

/** A checkpoint that found the container empty: nothing to save, and nothing live was lost now. */
export function containerLostCheckpointMessage(suspends: boolean): string {
  return (
    "Could not save the session's work: its container stopped — most likely it ran out of memory" +
    ' — and came back empty, so the changes since the last save are lost.' +
    (suspends ? ' Send a message to restart the session from its last save.' : '')
  )
}
