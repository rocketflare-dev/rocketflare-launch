-- Launch P4 integration: the `app.access` default policy is the app's owners AND the organisation's
-- admins (P1 parity — admins decided access requests in P1). 0023 snapshotted the owners-only
-- default onto the P1 requests it moved; widen exactly those snapshots on requests still pending,
-- so nothing an admin edited, and nothing already decided, changes.
UPDATE "approval_requests"
SET "policy" = jsonb_set("policy", '{approvers,admins}', 'true'::jsonb),
    "updated_at" = now()
WHERE "kind" = 'app.access'
  AND "status" = 'pending'
  AND "policy" = '{"approvers":{"appOwners":true,"admins":false,"groupIds":[],"userIds":[]},"minApprovals":1,"allowSelfApproval":false,"expiresAfterMinutes":20160,"autoApproveRole":null}'::jsonb;
