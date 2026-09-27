// Stand-in for Launch's SessionDO side (spec/07): drives a session sandbox step by step so each
// step can be timed, fronts the live preview behind a session check, and runs a locked-down class
// whose model calls are keyed and metered outside the sandbox.
import { ContainerProxy, Sandbox, getSandbox } from '@cloudflare/sandbox'

export { ContainerProxy }

/** Internet on: for timing the cold start without egress rules in the way. */
export class OpenSession extends Sandbox {}

/** Internet off except an allowlist. The model key never enters the sandbox. */
export class LockedSession extends Sandbox {
  // Off by default on the stable packages (containers 0.3.7 / sandbox 0.12.10), despite the docs:
  // without it no HTTPS leaves a locked sandbox, allowlisted or not.
  interceptHttps = true
  enableInternet = false
  // api.anthropic.com must be allowed for its outbound handler to run (S7): without it the proxy answers 520.
  allowedHosts = ['registry.npmjs.org', 'github.com', 'codeload.github.com', 'api.anthropic.com']
}

/**
 * api.anthropic.com: the sandbox sends a placeholder key; this handler, running in the Worker,
 * swaps in the real one and meters usage from the response (JSON or SSE) as it streams through.
 */
LockedSession.outboundByHost = {
  'api.anthropic.com': async (req, env, ctx) => {
    const sentKey = req.headers.get('x-api-key') ?? req.headers.get('authorization') ?? ''
    const upstream = new Request(req)
    upstream.headers.delete('authorization')
    upstream.headers.set('x-api-key', env.ANTHROPIC_API_KEY)
    const res = await fetch(upstream)
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const decoder = new TextDecoder()
    let buffer = ''
    const take = (u) => {
      if (!u) return
      usage.input += u.input_tokens ?? 0
      usage.output += u.output_tokens ?? 0
      usage.cacheRead += u.cache_read_input_tokens ?? 0
      usage.cacheWrite += u.cache_creation_input_tokens ?? 0
    }
    const meter = new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        controller.enqueue(chunk)
      },
      async flush() {
        // SSE: usage arrives in message_start (input) and message_delta (output); JSON: one usage object.
        for (const line of buffer.split('\n')) {
          const data = line.startsWith('data: ') ? line.slice(6) : line.startsWith('{') ? line : null
          if (!data) continue
          try {
            const j = JSON.parse(data)
            take(j.message?.usage)
            if (j.type === 'message_delta') take({ output_tokens: j.usage?.output_tokens })
            if (j.type === 'message' || (j.usage && !j.type)) take(j.usage)
          } catch {}
        }
        const key = `meter:${ctx.containerId}`
        const prev = JSON.parse((await env.METER.get(key)) ?? '{"requests":0,"input":0,"output":0,"cacheRead":0,"cacheWrite":0}')
        await env.METER.put(
          key,
          JSON.stringify({
            requests: prev.requests + 1,
            input: prev.input + usage.input,
            output: prev.output + usage.output,
            cacheRead: prev.cacheRead + usage.cacheRead,
            cacheWrite: prev.cacheWrite + usage.cacheWrite,
            path: new URL(req.url).pathname,
            status: res.status,
            keySentBySandbox: sentKey.slice(0, 18),
          }),
        )
      },
    })
    return new Response(res.body?.pipeThrough(meter), { status: res.status, headers: res.headers })
  },
}

const ns = (env, cls) => (cls === 'locked' ? env.LOCKED : env.OPEN)
const tail = (s, n = 2500) => (s && s.length > n ? '…' + s.slice(-n) : s)

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)

    // Live preview: <port>-less for the spike, one host per session. Launch checks its own session
    // (here: a cookie) and then proxies to the container port itself, so the preview is never public.
    const pv = url.hostname.match(/^rfspike-pv-(open|locked)-([a-z0-9]+)\./)
    if (pv) {
      const cookie = (req.headers.get('cookie') ?? '').match(/pv=([^;]+)/)?.[1]
      if (cookie !== env.ADMIN_KEY) return new Response('sign in to Launch to see this preview', { status: 401 })
      const sandbox = getSandbox(ns(env, pv[1]), pv[2])
      // :3000 inside a sandbox is the SDK's own control server, so the UI runs on :5173.
      return sandbox.containerFetch(req, 5173)
    }

    if (req.headers.get('x-admin-key') !== env.ADMIN_KEY) return new Response('forbidden', { status: 403 })
    const [, x, cls, id, op, arg] = url.pathname.split('/')
    if (x !== 'x') return new Response('not found', { status: 404 })
    const sandbox = getSandbox(ns(env, cls), id, { keepAlive: false })
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    const t0 = Date.now()
    try {
      if (op === 'exec') {
        const r = await sandbox.exec(body.cmd, { cwd: body.cwd, env: body.env, timeout: body.timeout ?? 600000 })
        return Response.json({ ms: Date.now() - t0, exitCode: r.exitCode, stdout: tail(r.stdout), stderr: tail(r.stderr) })
      }
      // What the SessionDO does for the chat: run a turn and relay its output as it arrives.
      if (op === 'stream') {
        const { readable, writable } = new TransformStream()
        const w = writable.getWriter()
        const enc = new TextEncoder()
        const line = (o) => w.write(enc.encode(JSON.stringify({ t: Date.now() - t0, ...o }) + '\n'))
        const run = sandbox
          .exec(body.cmd, { cwd: body.cwd, env: body.env, timeout: body.timeout ?? 600000, stream: true, onOutput: (stream, data) => line({ stream, data }) })
          .then((r) => line({ done: true, exitCode: r.exitCode }))
          .catch((e) => line({ error: String(e?.message ?? e) }))
          .finally(() => w.close())
        ctx.waitUntil(run)
        return new Response(readable, { headers: { 'content-type': 'application/x-ndjson' } })
      }
      if (op === 'bg') {
        const p = await sandbox.startProcess(body.cmd, { cwd: body.cwd, env: body.env })
        return Response.json({ ms: Date.now() - t0, id: p.id })
      }
      if (op === 'port') {
        await sandbox.waitForPort(body.port, { path: body.path, timeout: body.timeout ?? 300000 })
        return Response.json({ ms: Date.now() - t0 })
      }
      if (op === 'logs') {
        const l = await sandbox.getProcessLogs(arg)
        return Response.json({ stdout: tail(l.stdout, 4000), stderr: tail(l.stderr, 4000) })
      }
      if (op === 'allow') {
        await sandbox.setAllowedHosts(body.hosts)
        return Response.json({ ms: Date.now() - t0 })
      }
      if (op === 'destroy') {
        await sandbox.destroy()
        return Response.json({ ms: Date.now() - t0 })
      }
      return new Response('no op', { status: 404 })
    } catch (e) {
      return Response.json({ ms: Date.now() - t0, error: String(e?.message ?? e), name: e?.name }, { status: 500 })
    }
  },
}
