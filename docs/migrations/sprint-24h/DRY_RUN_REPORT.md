# Sprint 24h — Migration Dry-Run Report

**Branch:** `agent/sprint24h-integration` (apex-product origin)
**Status:** Stage-and-verify only — NO prod writes
**Migrations:** 12 forward + 12 paired down under `docs/migrations/sprint-24h/`
**Apply method:** human-driven `prod-schema-snapshot-workflow` (NOT `prisma migrate deploy`)

## Pre-flight prerequisites

1. **Extensions** — verify on target DB before 001 and 002:
   - `pgcrypto` (already present per `phase-observability-prod-schema` memory)
   - `citext` (installed by 001)
2. **App role placeholder** — `009_email_event_append_only.sql` contains literal `"<app-role>"`. **Must be replaced** with the actual prod app role (e.g. `apex_api_app`) before applying. Apply will fail otherwise.
3. **Concurrent index migrations (010, 011)** — `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. Apply each statement individually, NOT wrapped in `BEGIN/COMMIT`.
4. **Backfill window for 005** — `Reply.emailMessageId` becomes `NOT NULL` with no default. If any rows exist in `Reply` at apply time, migration fails. See per-file notes below.
5. **Env vars set before image roll**:
   - `APEX_PUBLIC_BASE_URL`
   - `OUTREACH_UNSUBSCRIBE_SECRET`
   - `APEX_TENANT_ZERO_ORG_ID`

## Per-file impact summary

| # | File | Type | Reversible? | Risk |
|---|------|------|-------------|------|
| 001 | citext.sql | `CREATE EXTENSION` | Yes (no-op down) | Low |
| 002 | new_enums.sql | 9 `CREATE TYPE` | Yes | Low |
| 003 | alter_existing_enums.sql | 5 `ALTER TYPE ADD VALUE` | **Forward-only** | Medium |
| 004 | new_tables.sql | 7 new tables + 26 indexes + 8 FKs | Yes | Low |
| 005 | replace_reply_models.sql | Drop columns, new `EmailMessage`, restructure `Reply` | Lossy down | **High** |
| 006 | reply_classification.sql | 1 new table + 4 indexes + 2 FKs | Yes | Low |
| 007 | drop_legacy_reply_intent.sql | `DROP TYPE ReplyIntent` | Yes (recreate) | Low |
| 008 | outreach_back_relations.sql | 2 FKs | Yes | Low |
| 009 | email_event_append_only.sql | REVOKE + trigger | Yes | **Medium (placeholder)** |
| 010 | email_message_references_gin.sql | 1 GIN index (CONCURRENTLY) | Yes | Low |
| 011 | suppression_partial_indexes.sql | 5 partial indexes (CONCURRENTLY) | Yes | Low |
| 012 | outreach_suppression_reason.sql | 1 column add | Yes | Low |

## Detailed file analysis

### 001 — citext.sql
`CREATE EXTENSION IF NOT EXISTS citext`. Idempotent. Required before any `@db.Citext` column in 004/005. **Down** is no-op (cannot drop extension if dependent columns exist).

### 002 — new_enums.sql
Creates 9 enum types: `EmailDirection`, `EmailIngestSource`, `ReplyIntent10`, `SuppressionScope`, `SuppressionKind`, `EnrichmentLicenseScope`, `EvaluatorTargetType`, `LlmRequestStatus`, `GoldenSetSource`. Safe additive. Each has a paired `DROP TYPE` in down.

### 003 — alter_existing_enums.sql — **FORWARD-ONLY**
Adds 4 values to `OutreachArtifactStatus` (`QUEUED`, `REPLIED`, `BOUNCED`, `SUPPRESSED`) and 1 to `EmailEventKind` (`SUPPRESSED`).
- **PG limitation:** cannot remove enum values without rebuilding the type. The `.down.sql` documents this — rollback is "stop writing the new values" not a SQL revert.
- **Mitigation:** code-level rollback works (revert image), but DB carries the extra values permanently. Acceptable per project convention.

### 004 — new_tables.sql
Creates: `SuppressionEntry`, `EnrichmentFact`, `LlmRequestFact`, `OrgHourlyUsage`, `OrgDailyUsage`, `EvaluatorRun`, `GoldenSetExample`.
- All have `orgId TEXT` FK to `Org` with `ON DELETE CASCADE` except `SuppressionEntry.orgId` which is **nullable** (intentional: `GLOBAL` scope rows have `orgId = NULL`).
- 26 indexes including 3 unique composites used by upsert paths (`OrgHourlyUsage_orgId_bucketStart_key`, `OrgDailyUsage_orgId_bucketStart_key`, `EnrichmentFact_orgId_provider_lookupKey_field_key`).
- `LlmRequestFact.graphRunId` FK to `GraphRun` with `ON DELETE SET NULL` — preserves billing rows when GraphRun is deleted.
- Pure additive — no existing row impact.

### 005 — replace_reply_models.sql — **HIGH RISK, LOSSY**
**Destructive column drops** (data lost without backfill):
- `OutreachArtifact`: `inReplyTo`, `providerMessageId`, `providerThreadId`, `references`
- `Reply`: 16 columns including `bodyHtml`, `bodyText`, `subject`, `intent`, `intentConfidence`, `providerMessageId`, `providerThreadId`, `references`, ...

**Schema restructure:**
- New `EmailMessage` table absorbs message content + Gmail provider metadata.
- `Reply.emailMessageId TEXT NOT NULL` added with FK to `EmailMessage`.
- `Reply.isOrphan BOOLEAN DEFAULT false` added.

**Pre-apply checks required:**
1. `SELECT COUNT(*) FROM "Reply";` — if > 0, **MIGRATION WILL FAIL** because `emailMessageId NOT NULL` has no default.
2. `SELECT COUNT(*) FROM "OutreachArtifact" WHERE "providerMessageId" IS NOT NULL;` — these references vanish.

**Recommended apply order on prod with existing data:**
1. Apply 002 (new enums needed for EmailMessage columns).
2. Apply 004 (creates SuppressionEntry etc. — independent).
3. Build a backfill script that: (a) inserts `EmailMessage` rows from existing `OutreachArtifact.providerMessageId` + `Reply.providerMessageId`, (b) populates `Reply.emailMessageId`, (c) THEN runs 005.
4. If prod `Reply` table is empty (likely for tenant-zero outreach in dry-run staging), 005 is safe to apply directly.

**Tenant-zero today (2026-05-31):** per `phase-2.5-prod-schema-stage4` memory, OutreachArtifact rows exist but `Reply` likely empty (no production replies received yet). Verify before apply.

### 006 — reply_classification.sql
New `ReplyClassification` table + 4 indexes + 2 FKs. Pure additive. Unique on `(replyId, classifierName, classifierVersion)` — the partial unique index that prevents duplicate suppressions on re-classification (idempotency proof referenced in WS-9 PR_NOTES).

### 007 — drop_legacy_reply_intent.sql
`DROP TYPE IF EXISTS "ReplyIntent"`. The legacy enum (replaced by `ReplyIntent10`). Safe only AFTER 005 drops `Reply.intent` column. Order critical.

### 008 — outreach_back_relations.sql
Adds FKs `EmailMessage.artifactId → OutreachArtifact` and `LlmRequestFact.artifactId → OutreachArtifact`, both `ON DELETE SET NULL`. Safe additive.

### 009 — email_event_append_only.sql — **PLACEHOLDER MUST BE REPLACED**
Three statements:
1. `REVOKE UPDATE, DELETE, TRUNCATE ON email_event FROM "<app-role>";` — **literal placeholder**, will error if not substituted.
2. Creates `email_event_no_mutation()` plpgsql function that raises on UPDATE/DELETE.
3. Creates BEFORE UPDATE OR DELETE trigger on `email_event`.

**Pre-apply step:** `sed -i 's/<app-role>/apex_api_app/g' 009_email_event_append_only.sql` (or substitute via deployment tooling). Verify the role exists: `SELECT rolname FROM pg_roles WHERE rolname = 'apex_api_app';`.

Pattern is intentional: mirrors `apps/api/docs/evidence-event.sql` (already live per `phase-observability-prod-schema` memory).

### 010 — email_message_references_gin.sql
`CREATE INDEX CONCURRENTLY` GIN on `EmailMessage.references` with partial predicate (only non-empty arrays). **MUST run outside a transaction** — most migration tools handle this; verify your runner. Backstops inbound correlator walk-back.

### 011 — suppression_partial_indexes.sql
Five `CREATE INDEX CONCURRENTLY` statements:
- 2 partial scan indexes for `GLOBAL` scope rows (`orgId IS NULL`)
- 3 partial unique indexes per subject shape (email / domain / thread)
**MUST run outside transaction.** Partial uniques enforce idempotency on `suppressionService.add()`; WS-9 catches `P2002` and treats as success.

### 012 — outreach_suppression_reason.sql
`ALTER TABLE "OutreachArtifact" ADD COLUMN "suppressionReason" TEXT` (nullable). Safe additive.

## Recommended apply sequence on staging clone

```
001 → 002 → 003 → 004 → 006 → 008 → 012   # safe additive batch
# manually verify Reply row count before 005
005 → 007                                   # destructive batch (Reply restructure)
# 009 requires placeholder substitution + role verify
009                                         # append-only trigger
# 010, 011 must each run outside a transaction
010                                         # GIN index (CONCURRENTLY)
011                                         # 5 partial indexes (CONCURRENTLY)
```

Rationale: front-load all safe additive DDL so the cluster gains capacity for WS-4/5/6/7/8/9 modules before the lossy 005 restructure. 007 sits right after 005 because dropping `ReplyIntent` type requires the column to be gone first. 009/010/011 close out with the special-handling migrations.

## Rollback plan

Per `docs/SPRINT_24H_RELEASE_CHECKLIST.md`:

```
012 → 011 → 010 → 009 → 008 → 007 → 006 → 005 → 004 → 003 (stop-writing) → 002 → 001 (no-op)
```

**Caveats:**
- 003 rollback is forward-only (cannot drop enum values cleanly). Revert app image to stop writing the new values.
- 005 rollback restores column names but data is gone unless a pre-005 backup exists. Take `pg_dump` before applying 005 — non-negotiable.

## Verification commands (post-apply on staging)

```sql
-- 001 extension
SELECT extname FROM pg_extension WHERE extname IN ('citext','pgcrypto');

-- 002 enums (expect 9 new rows)
SELECT typname FROM pg_type WHERE typname IN (
  'EmailDirection','EmailIngestSource','ReplyIntent10','SuppressionScope',
  'SuppressionKind','EnrichmentLicenseScope','EvaluatorTargetType',
  'LlmRequestStatus','GoldenSetSource'
);

-- 003 enum values
SELECT enumlabel FROM pg_enum
  JOIN pg_type t ON pg_enum.enumtypid = t.oid
  WHERE t.typname = 'OutreachArtifactStatus'
  ORDER BY enumsortorder;

-- 004 tables (expect 7)
SELECT tablename FROM pg_tables WHERE tablename IN (
  'SuppressionEntry','EnrichmentFact','LlmRequestFact',
  'OrgHourlyUsage','OrgDailyUsage','EvaluatorRun','GoldenSetExample'
);

-- 009 trigger
SELECT tgname FROM pg_trigger WHERE tgrelid = 'email_event'::regclass AND NOT tgisinternal;

-- 010, 011 indexes (expect 6)
SELECT indexname FROM pg_indexes WHERE indexname IN (
  'idx_email_message_org_references_gin',
  'idx_suppression_global_email','idx_suppression_global_domain',
  'uniq_suppression_email','uniq_suppression_domain','uniq_suppression_thread'
);
```

## Open questions (require operator decision before apply)

1. **Prod `Reply` row count today?** If non-zero, 005 needs a backfill plan before apply.
2. **Confirm app role name** for 009 placeholder substitution. Memory suggests `apex_api_app` but verify via `\du` on prod.
3. **Backup policy for 005:** confirm `pg_dump` window scheduled before apply.
4. **CONCURRENTLY runner support:** confirm the chosen migration runner (psql-piped vs Prisma raw vs Cloud Build script) does NOT wrap individual statements in a transaction for 010 and 011.
