import { useEffect, useState } from 'react'

/**
 * Milliseconds since `since`, ticking every second while mounted — the running gate step's and the
 * open turn's clock. The origin is a durable row's `at`, so a reload keeps counting from the start.
 */
export function useElapsed(since: Date): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return Math.max(0, now - since.getTime())
}
