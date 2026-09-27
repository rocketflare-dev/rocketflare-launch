# S0: fleet limits

Status: **done (2026-09-27)**. Verdict: **yes-with-workaround**. Hyperdrive capped the fleet at about 12 apps per account.
**Resolved by decision (2026-09-27): apps use Neon's serverless driver, not Hyperdrive** ([S3](../s3-neon-hyperdrive/RESULT.md)).
The next limits are Workers (500 per account → ~225 apps here) and Neon projects (100 on Launch, 1,000 on Scale).

## Per app, as spec/06 provisions it

2 Workers, 2 Custom Domains, 2 Hyperdrive configs, 2 KV, 2 Queues, 2 R2 buckets, 1 Neon project
(with a `staging` branch), 1 Resend domain.

## Documented limits (paid plans, checked 2026-09-27)

| Resource | Limit | Apps that fit | Source |
|---|---|---|---|
| **Hyperdrive configs / account** | **25** (10 free); raisable by request, not guaranteed | **12** | developers.cloudflare.com/hyperdrive/platform/limits |
| **Resend domains** | **3 Free, 10 Pro**, 1,000 Scale; +100 for $20/mo on Pro/Scale | **10 on Pro** | resend.com/pricing |
| **Custom domains / zone** | **100** | **50** | developers.cloudflare.com/workers/platform/limits |
| Workers / account | 500 | 250 (fewer with session/preview Workers) | same |
| Neon projects | 100 Free/Launch, 1,000 Scale (soft) | 100 / 1,000 | neon.com/docs/introduction/plans |
| Neon branches / project | 10 Free/Launch, 25 Scale | per-PR previews capped at ~8 | same |
| KV namespaces | 1,000 | 500 | developers.cloudflare.com/kv/platform/limits |
| Queues | 10,000 | 5,000 | developers.cloudflare.com/queues/platform/limits |
| R2 buckets | 1,000,000 | — | developers.cloudflare.com/r2/platform/limits |
| Cron triggers / account | 250 | — (apps with crons count too) | workers limits |

## Verdict (desk): **yes-with-workaround**, the Hyperdrive limit must be dealt with before P2

Out of the box, **Hyperdrive caps the fleet at about 12 apps**.

Decided since (spec/04, 2026-09-27), which removes two of the caps:
- **Resend:** one shared sending domain (`notifications.<apps domain>`) with a key per app, so
  the domain cap no longer applies.
- **Custom domains:** not used. Apps are Worker routes on a wildcard record on a dedicated apps
  domain (1,000 routes per zone), and the zone's Universal SSL wildcard covers every host,
  including session previews. That also removes the need for Advanced Certificate Manager: Sandbox
  preview URLs (`{port}-{sandbox}-{token}.<host>`) need a wildcard, which Custom Domains can't do,
  and Universal SSL covers only the first level.

Still open, with S3 adding evidence:
- **Hyperdrive.** The options:
  - production only on Hyperdrive, with staging on Neon's serverless driver or a direct TCP
    connection → 25 apps;
  - a limit increase requested as part of onboarding;
  - dropping Hyperdrive for Neon's own pooler.

  The kit's `/api/ready` and DB client assume a `HYPERDRIVE` binding, so dropping it is a
  contract change (spec/02).
- **Workers:** 500 per account → 250 apps, minus Launch's own Workers.

## Account check (`node s0-limits/run.mjs`, 2026-09-27)

The account is a shared one (Workers Paid; the zone is Free), with other projects in it.

| Resource | Per app | Limit | In use | Apps that fit |
|---|---|---|---|---|
| Workers scripts | 2 | 500 | 50 | 225 |
| Worker routes (zone) | 2 | 1,000 | 0 | 500 |
| **Hyperdrive configs** | 2 | 25 | 3 | **11** |
| KV namespaces | 2 | 1,000 | 18 | 491 |
| Queues | 2 | 10,000 | 8 | 4,996 |
| R2 buckets | 2 | 1,000,000 | 20 | ~500,000 |
| Neon projects (Launch plan) | 1 | 100 | 4 | 96 |
| Resend domains | shared | plan | 4 | — |

In a real company account, **other teams' Hyperdrive configs come out of the same 25**. The wizard
should show the headroom, and the registry should refuse a create it can't finish, rather than fail
at step 5.

The zone's Universal SSL certificate pack is active for `clewro.com, *.clewro.com`, so every
first-level app host is covered with no per-host issuance (the certificate half of S2).
