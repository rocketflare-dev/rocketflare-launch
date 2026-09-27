export default {
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/set-cookie') {
      return new Response('set', { headers: { 'set-cookie': '__Host-session=' + "rfspike-b-v2" + '; Path=/; Secure; HttpOnly; SameSite=Lax' } })
    }
    return Response.json({ worker: "rfspike-b", host: url.host, cookie: req.headers.get('cookie') })
  },
}
