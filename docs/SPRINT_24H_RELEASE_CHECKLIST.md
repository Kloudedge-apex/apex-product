# Sprint 24h Release Checklist

## Pre-deploy
- [ ] Merge all 10 WS branches into integration branch
- [ ] All 5 validation gates green on integration tip
- [ ] Apply migrations 001-012 in order via `prod-schema-snapshot-workflow` (NOT prisma migrate)
- [ ] Verify prod has `pgcrypto` + `citext` extensions before 002
- [ ] Set new env vars: APEX_PUBLIC_BASE_URL, OUTREACH_UNSUBSCRIBE_SECRET, APEX_TENANT_ZERO_ORG_ID

## Deploy
- [ ] Build new apps/api image
- [ ] Roll apex-gtm-api revision
- [ ] Roll apex-gtm-worker revision (BullMQ workers must restart to pick up new queues: reply-classifier, usage-rollup)

## Post-deploy smoke
- [ ] Run `apps/api/scripts/sprint24h-smoke.ts` against staging
- [ ] Trigger one tenant-zero outbound → confirm EmailMessage/EmailEvent/LlmRequestFact rows land
- [ ] Reply to that outbound from a test mailbox → confirm Reply + ReplyClassification land within 30s
- [ ] POST to /unsubscribe/:token with List-Unsubscribe=One-Click → confirm SuppressionEntry created
- [ ] Manually run usage rollup for current hour → confirm OrgHourlyUsage row totals match LlmRequestFact sum
- [ ] Run `pnpm ts-node apps/api/scripts/seed-golden-set.ts --org=$APEX_TENANT_ZERO_ORG_ID` → confirm 45 GoldenSetExample rows

## Rollback plan
- [ ] Migrations 001-012 each have paired .down.sql
- [ ] Down order: 012, 011, 010, 009, 008, 007, 006, 005, 004, 003 (note: 003 down is "stop writing" — Postgres can't drop enum values), 002, 001 (citext is a no-op rollback)
- [ ] Revert app images to prior revision

## Owners
- WS-1/2/3/4/5/6/7/8/9: backend
- WS-10 release coordination: backend + ops

