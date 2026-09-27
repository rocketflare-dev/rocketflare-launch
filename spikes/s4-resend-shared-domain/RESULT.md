# S4: one shared Resend sending domain

Status: **done (2026-09-27)**. Verdict: **yes**, with the known gap confirmed and **no way to detect
it through Resend**.

## What ran (`node s4-resend-shared-domain/run.mjs`)

- Created `notifications.clewro.com` in Resend.
- Wrote its 4 records into the zone through the CF DNS API: DKIM TXT, SPF MX, SPF TXT, and an
  SPF/return-path CNAME.
- **Verified after 87 s.** This happens once, in the setup wizard, not per app.
- Minted two `sending_access` keys bound to the domain (apps A and B).
- Sent test mail to `delivered@resend.dev`, Resend's test sink, which reaches no one.

| Case | Result |
|---|---|
| A sends as `rfspike-a@notifications…` | 200 ✅ |
| A sends as `rfspike-b@notifications…` | **200: the known gap** |
| A sends as `"Payroll" <rfspike-b@notifications…>` | **200**: the display name is free text too |
| A sends as `noreply@from.mirevue.com` (another verified domain on the account) | 403 ✅ "This API key is not authorized to send emails from from.mirevue.com" |
| A's sending key lists domains | 401 ✅: a sending key can't read anything |

## Can Launch detect impersonation afterwards? No

`GET /emails/{id}` returns
`object, id, to, from, created_at, subject, bcc, cc, reply_to, last_event, scheduled_at, message_id, html, text`.
**There is no field for the API key that sent it**, so Launch can't match a `from` address to the
key that used it. Tags would be set by the sending app, so a compromised app could forge them too.

## Conclusion

- One domain per fleet works: 87 s once at setup, then a key per app in ~120 ms, with no DNS
  work per app. Pipeline step 12 becomes one API call.
- The key's domain binding holds, so an app can't send as any *other* domain on the account.
- Within the shared domain, any app can send as any other app, **and it can't be detected from
  Resend**.

spec/04 should say "not detectable" rather than "detect it from Resend's logs". If per-app sender
enforcement becomes a requirement, the path is Cloudflare Email Service
(`allowed_sender_addresses` on each Worker's `send_email` binding), which is a template-contract
change.
