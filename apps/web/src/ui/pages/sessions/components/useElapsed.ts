import { useEffect, useState } from 'react'

/**
 * How often an elapsed clock re-renders: every second for its first hour, then every minute — a
 * review that waits two days is not re-rendered 170 000 times (ui.md: a clock picks its own tick).
 * Pure.
 */
export function elapsedTickMs(elapsedMs: number): number {
  return elapsedMs < 60 * 60_000 ? 1000 : 60_000
}

/**
 * Milliseconds since `since`, ticking while mounted — the running gate step's, the open turn's and
 * the ship timeline's "now" clock. The origin is a durable row's `at`, so a reload keeps counting
 * from the start.
 */
export function useElapsed(since: Date): number {
  const [now, setNow] = useState(() => Date.now())
  const elapsed = Math.max(0, now - since.getTime())
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), elapsedTickMs(elapsed))
    return () => clearTimeout(timer)
  }, [elapsed])
  return elapsed
}
