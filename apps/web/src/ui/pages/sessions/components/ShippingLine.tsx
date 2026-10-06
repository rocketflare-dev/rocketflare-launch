/**
 * A ship in flight on one line of a list (issue #22): "PR #6 · Merged, waiting for main’s checks ·
 * 2 min (releases anyway after 30 min)" — `shippingLineText`, the same words `launch sessions ls`
 * prints, re-read once a minute so the time moves without re-rendering every second.
 *
 * Light on purpose, like `SessionStatusBadge`: the app page's lists import it.
 */

import type { SessionShipping } from '@launch/shared/launch-sessions'
import { shippingLineText } from '@launch/shared/launch-ship-progress'
import { useEffect, useState } from 'react'

export function ShippingLine({
  shipping,
  className = '',
}: {
  shipping: SessionShipping
  className?: string
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return (
    <span
      className={`text-xs text-secondary ${className}`.trim()}
      data-testid="session-shipping"
      title={new Date(shipping.since).toLocaleString()}
    >
      {shippingLineText(shipping, now)}
    </span>
  )
}
