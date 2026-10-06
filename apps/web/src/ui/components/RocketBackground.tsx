/**
 * The sign-in page's backdrop: a night sky of twinkling stars with a little Rocketflare rocket
 * that chases the pointer — and loops on its own while the pointer is still or over anything
 * marked `data-rocket-ignore` (`AuthCard`'s panel) — leaving an exhaust trail; a click on the sky
 * fires a burst of sparks. Ported from the hola-world app's login, with three deliberate changes:
 *
 * - the sky is ALWAYS night (`.night-sky` + the `--night-*` / `--rocket-*` colours at the top of
 *   `index.css`), in the light theme too — fixed brand colours, never theme tokens, so nothing here
 *   re-reads on a theme switch;
 * - the stars are bright and visibly twinkle, each at its own pace;
 * - the rocket wears the mark's fills inside a dark ink outline, so its shape reads on the sky.
 *
 * Purely decorative: `pointer-events-none`, nothing focusable, and `AuthCard` hides its layer from
 * assistive tech. `prefers-reduced-motion: reduce` paints the sky once — stars at rest, no rocket
 * flight, no twinkle, no listeners — and repaints it only on resize.
 */
import { useEffect, useRef } from 'react'

interface Star {
  x: number
  y: number
  depth: number // 0.2 (far) … 1 (near): size, brightness and parallax
  phase: number
  speed: number // twinkle rate, so the field never pulses in unison
}

interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  life: number // 1 → 0
  size: number
  hot: boolean
}

interface Palette {
  star: string
  body: string
  nose: string
  outline: string
  window: string
  fin: string
  flameHot: string
  flameCool: string
}

/** The fixed night-sky colours from `index.css` `:root` (theme-independent by design). */
function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return {
    star: v('--night-star', 'white'),
    body: v('--rocket-body', 'white'),
    nose: v('--rocket-nose', 'gold'),
    outline: v('--rocket-outline', 'black'),
    window: v('--rocket-window', 'steelblue'),
    fin: v('--rocket-fin', 'tomato'),
    flameHot: v('--rocket-flame-hot', 'gold'),
    flameCool: v('--rocket-flame-cool', 'tomato'),
  }
}

/** Drawn at this multiple of its native ~44px length (`drawRocket`'s own coordinates). */
const ROCKET_SCALE = 1.7

/** A rocket pointing along +x, centred on its middle, about 44px long. */
function drawRocket(ctx: CanvasRenderingContext2D, p: Palette, flicker: number) {
  // flame (no outline: it is light, not a part)
  ctx.fillStyle = p.flameCool
  ctx.beginPath()
  ctx.moveTo(-16, -6)
  ctx.quadraticCurveTo(-30 - flicker * 10, 0, -16, 6)
  ctx.fill()
  ctx.fillStyle = p.flameHot
  ctx.beginPath()
  ctx.moveTo(-16, -3.5)
  ctx.quadraticCurveTo(-24 - flicker * 6, 0, -16, 3.5)
  ctx.fill()

  // A heavier ink line than the source's 1.5, with round joins so the fin tips stay neat.
  ctx.lineWidth = 2.25
  ctx.lineJoin = 'round'
  ctx.strokeStyle = p.outline
  // fins
  ctx.fillStyle = p.fin
  for (const s of [-1, 1]) {
    ctx.beginPath()
    ctx.moveTo(-6, 6 * s)
    ctx.lineTo(-17, 15 * s)
    ctx.lineTo(-15, 4 * s)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  }
  // body
  const body = () => {
    ctx.beginPath()
    ctx.moveTo(22, 0)
    ctx.bezierCurveTo(14, -10, -6, -9, -16, -6)
    ctx.lineTo(-16, 6)
    ctx.bezierCurveTo(-6, 9, 14, 10, 22, 0)
    ctx.closePath()
  }
  ctx.fillStyle = p.body
  body()
  ctx.fill()
  // nose cone: the body's front, clipped to the body so it shares its edge exactly
  ctx.save()
  body()
  ctx.clip()
  ctx.fillStyle = p.nose
  ctx.fillRect(13, -12, 12, 24)
  ctx.restore()
  body()
  ctx.stroke()
  // window
  ctx.fillStyle = p.window
  ctx.beginPath()
  ctx.arc(4, 0, 3.6, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
}

export function RocketBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const palette = readPalette()
    let width = 0
    let height = 0
    let stars: Star[] = []
    const sparks: Spark[] = []

    const pointer = { x: 0, y: 0, active: false, lastMove: 0 }
    const rocket = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 4 }
    const parallax = { x: 0, y: 0 }

    const drawStars = (t: number) => {
      ctx.fillStyle = palette.star
      for (const s of stars) {
        const px = (((s.x + parallax.x * s.depth * 40) % width) + width) % width
        const py = (((s.y + parallax.y * s.depth * 40) % height) + height) % height
        // Bright at rest (0.55–1 by depth); in motion each star swings between ~25% and 100%
        // of that, so the twinkle is visible rather than a shimmer.
        const base = 0.55 + 0.45 * s.depth
        const swing = reducedMotion ? 1 : 0.625 + 0.375 * Math.sin(t * s.speed + s.phase)
        ctx.globalAlpha = base * swing
        ctx.beginPath()
        ctx.arc(px, py, 0.7 + s.depth * 1.3, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const count = Math.round((width * height) / 4000)
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        depth: 0.2 + Math.random() * 0.8,
        phase: Math.random() * Math.PI * 2,
        speed: 0.0015 + Math.random() * 0.0035,
      }))
      if (!rocket.x) {
        rocket.x = width * 0.2
        rocket.y = height * 0.75
      }
      if (reducedMotion) {
        ctx.clearRect(0, 0, width, height)
        drawStars(0)
      }
    }

    resize()
    window.addEventListener('resize', resize)

    if (reducedMotion) {
      return () => window.removeEventListener('resize', resize)
    }

    const ignored = (target: EventTarget | null) =>
      target instanceof Element && target.closest('[data-rocket-ignore]') !== null
    const onMove = (e: PointerEvent) => {
      pointer.x = e.clientX
      pointer.y = e.clientY
      // Over the card the rocket goes back to flying on its own.
      pointer.active = !ignored(e.target)
      pointer.lastMove = performance.now()
    }
    const onDown = (e: PointerEvent) => {
      if (ignored(e.target)) return // a click on the card is a click, not a firework
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * Math.PI * 2
        const speed = 1 + Math.random() * 4
        sparks.push({
          x: e.clientX,
          y: e.clientY,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          life: 1,
          size: 1.5 + Math.random() * 2.5,
          hot: Math.random() > 0.5,
        })
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerdown', onDown)

    let frame = 0
    const tick = (t: number) => {
      // Idle (or no pointer yet): the rocket loops a lazy figure-eight around the page.
      const idle = !pointer.active || t - pointer.lastMove > 4000
      const targetX = idle ? width / 2 + Math.sin(t * 0.0004) * width * 0.38 : pointer.x
      const targetY = idle ? height / 2 + Math.sin(t * 0.0008) * height * 0.3 : pointer.y

      // Steer like a spring with drag, so it overshoots a little and swoops.
      rocket.vx = (rocket.vx + (targetX - rocket.x) * 0.004) * 0.93
      rocket.vy = (rocket.vy + (targetY - rocket.y) * 0.004) * 0.93
      rocket.x += rocket.vx
      rocket.y += rocket.vy
      const speed = Math.hypot(rocket.vx, rocket.vy)
      if (speed > 0.15) {
        const want = Math.atan2(rocket.vy, rocket.vx)
        let diff = want - rocket.angle
        diff = Math.atan2(Math.sin(diff), Math.cos(diff))
        rocket.angle += diff * 0.15
      }

      // Stars drift against the rocket's motion, plus a slow constant cruise.
      parallax.x -= rocket.vx * 0.02 + 0.01
      parallax.y -= rocket.vy * 0.02 - 0.02

      // Exhaust: more sparks the faster it flies.
      const tailX = rocket.x - Math.cos(rocket.angle) * 20 * ROCKET_SCALE
      const tailY = rocket.y - Math.sin(rocket.angle) * 20 * ROCKET_SCALE
      const puffs = 1 + Math.min(3, Math.floor(speed / 2))
      for (let i = 0; i < puffs; i++) {
        const spread = (Math.random() - 0.5) * 0.8
        sparks.push({
          x: tailX,
          y: tailY,
          vx: -Math.cos(rocket.angle + spread) * (1 + Math.random() * 1.5) + rocket.vx * 0.3,
          vy: -Math.sin(rocket.angle + spread) * (1 + Math.random() * 1.5) + rocket.vy * 0.3,
          life: 1,
          size: 2 + Math.random() * 3,
          hot: Math.random() > 0.4,
        })
      }

      ctx.clearRect(0, 0, width, height)
      drawStars(t)

      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i] as Spark
        s.x += s.vx
        s.y += s.vy
        s.vx *= 0.96
        s.vy *= 0.96
        s.life -= 0.025
        if (s.life <= 0) {
          sparks.splice(i, 1)
          continue
        }
        ctx.globalAlpha = s.life * 0.8
        ctx.fillStyle = s.hot ? palette.flameHot : palette.flameCool
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.size * s.life, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1

      ctx.save()
      ctx.translate(rocket.x, rocket.y)
      ctx.rotate(rocket.angle)
      ctx.scale(ROCKET_SCALE, ROCKET_SCALE)
      drawRocket(ctx, palette, Math.random())
      ctx.restore()

      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [])

  return (
    <div className="night-sky pointer-events-none fixed inset-0" data-night-sky>
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  )
}
