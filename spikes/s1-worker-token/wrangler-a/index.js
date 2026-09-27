export default {
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/set-cookie') {
      return new Response('set', { headers: { 'set-cookie': '__Host-session=' + "rfspike-a" + '; Path=/; Secure; HttpOnly; SameSite=Lax' } })
    }
    return Response.json({ worker: "rfspike-a", via: "wrangler", host: url.host, cookie: req.headers.get('cookie') })
  },
}
