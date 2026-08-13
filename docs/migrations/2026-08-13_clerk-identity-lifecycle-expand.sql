-- Migration: immutable Clerk tenant, membership, and deletion authority
-- Date drafted: 2026-08-13
-- Status: PENDING APPROVAL - REVIEW ONLY; NOT APPLIED BY CODEX.
--
-- Apply before the application version that reads the new identity columns or
-- lifecycle tables. This migration deliberately marks every legacy User row
-- inactive. During the writer pause, an operator must reconcile local rows to
-- verified Clerk organization/membership inventory and explicitly reactivate
-- only confirmed current principals. Local workspaces may retain null Clerk
-- ids, but their owners must also be explicitly reviewed and reactivated.
-- Never infer immutable Clerk ids from mutable organization slugs.
--
-- CREATE INDEX CONCURRENTLY must run outside a transaction. Execute with
-- psql ON_ERROR_STOP and without --single-transaction. Pause Clerk webhook and
-- local identity writers from the column step through reconciliation and the
-- final index postcondition. Attach the redacted reconciliation inventory and
-- invariant-query output to this migration's postcondition evidence receipt.

\set ON_ERROR_STOP on
\set AUTOCOMMIT on

BEGIN;

ALTER TYPE "UserRole"
  ADD VALUE IF NOT EXISTS 'MANAGER' BEFORE 'MEMBER';

ALTER TABLE "Org"
  ADD COLUMN IF NOT EXISTS "clerkOrgId" TEXT;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "clerkMembershipId" TEXT,
  ADD COLUMN IF NOT EXISTS "membershipActive" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "clerk_identity_cutover" (
  "id" INTEGER NOT NULL,
  "minimumEventVersion" BIGINT NOT NULL,
  "ready" BOOLEAN NOT NULL DEFAULT false,
  "inventoryEvidenceHash" TEXT,
  "expectedActiveOrganizationCount" INTEGER NOT NULL DEFAULT -1,
  "expectedActiveMembershipCount" INTEGER NOT NULL DEFAULT -1,
  "expectedActiveUserCount" INTEGER NOT NULL DEFAULT -1,
  "establishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "clerk_identity_cutover_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "clerk_identity_cutover_singleton" CHECK ("id" = 1),
  CONSTRAINT "clerk_identity_cutover_positive_version" CHECK (
    "minimumEventVersion" > 0
  ),
  CONSTRAINT "clerk_identity_cutover_inventory_counts" CHECK (
    "expectedActiveOrganizationCount" >= -1
    AND "expectedActiveMembershipCount" >= -1
    AND "expectedActiveUserCount" >= -1
  ),
  CONSTRAINT "clerk_identity_cutover_ready_evidence" CHECK (
    NOT "ready"
    OR (
      "minimumEventVersion" <= 9007199254740991
      AND "minimumEventVersion" BETWEEN
        ((EXTRACT(EPOCH FROM "establishedAt") * 1000)::BIGINT - 86400000)
        AND ((EXTRACT(EPOCH FROM "establishedAt") * 1000)::BIGINT + 86400000)
      AND "inventoryEvidenceHash" ~ '^sha256:[0-9a-f]{64}$'
      AND "expectedActiveOrganizationCount" >= 0
      AND "expectedActiveMembershipCount" >= 0
      AND "expectedActiveUserCount" >= 0
    )
  )
);

-- Authority-creating webhooks stay blocked until the verified current Clerk
-- inventory has been seeded and an operator explicitly flips ready to true.
-- Only the first installation deactivates legacy rows; a completed, reconciled
-- migration is idempotent and must not cause a tenant-wide outage on rerun.
WITH inserted_cutover AS (
  INSERT INTO "clerk_identity_cutover" (
    "id",
    "minimumEventVersion",
    "ready",
    "inventoryEvidenceHash",
    "expectedActiveOrganizationCount",
    "expectedActiveMembershipCount",
    "expectedActiveUserCount",
    "establishedAt",
    "updatedAt"
  )
  VALUES (
    1,
    9223372036854775807,
    false,
    NULL,
    -1,
    -1,
    -1,
    clock_timestamp() AT TIME ZONE 'UTC',
    clock_timestamp()
  )
  ON CONFLICT ("id") DO NOTHING
  RETURNING "id"
)
UPDATE "User"
SET "membershipActive" = false
WHERE EXISTS (SELECT 1 FROM inserted_cutover);

CREATE TABLE IF NOT EXISTS "clerk_organization_lifecycle" (
  "clerkOrgId" TEXT NOT NULL,
  "eventVersion" BIGINT NOT NULL,
  "eventRank" INTEGER NOT NULL,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  "lastEventId" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "clerk_organization_lifecycle_pkey" PRIMARY KEY ("clerkOrgId"),
  CONSTRAINT "clerk_organization_lifecycle_event_version" CHECK (
    "eventVersion" BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT "clerk_organization_lifecycle_event_rank" CHECK (
    "eventRank" BETWEEN 1 AND 3
  )
);

CREATE TABLE IF NOT EXISTS "clerk_membership_lifecycle" (
  "clerkMembershipId" TEXT NOT NULL,
  "clerkUserId" TEXT NOT NULL,
  "clerkOrgId" TEXT NOT NULL,
  "eventVersion" BIGINT NOT NULL,
  "eventRank" INTEGER NOT NULL,
  "role" "UserRole" NOT NULL,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  "lastEventId" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "clerk_membership_lifecycle_pkey" PRIMARY KEY ("clerkMembershipId"),
  CONSTRAINT "clerk_membership_lifecycle_event_version" CHECK (
    "eventVersion" BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT "clerk_membership_lifecycle_event_rank" CHECK (
    "eventRank" BETWEEN 1 AND 3
  )
);

CREATE TABLE IF NOT EXISTS "clerk_user_lifecycle" (
  "clerkUserId" TEXT NOT NULL,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  "clerkMembershipId" TEXT,
  "clerkOrgId" TEXT,
  "membershipEventVersion" BIGINT,
  "membershipEventRank" INTEGER,
  "membershipActive" BOOLEAN NOT NULL DEFAULT false,
  "role" "UserRole" NOT NULL DEFAULT 'MEMBER',
  "lastEventId" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "clerk_user_lifecycle_pkey" PRIMARY KEY ("clerkUserId"),
  CONSTRAINT "clerk_user_lifecycle_membership_cursor" CHECK (
    (
      "membershipEventVersion" IS NULL
      AND "membershipEventRank" IS NULL
    )
    OR (
      "membershipEventVersion" IS NOT NULL
      AND "membershipEventRank" IS NOT NULL
      AND "membershipEventVersion" BETWEEN 1 AND 9007199254740991
      AND "membershipEventRank" BETWEEN 1 AND 3
    )
  )
);

CREATE INDEX IF NOT EXISTS "clerk_membership_lifecycle_clerkUserId_idx"
  ON "clerk_membership_lifecycle" ("clerkUserId");
CREATE INDEX IF NOT EXISTS "clerk_membership_lifecycle_clerkOrgId_idx"
  ON "clerk_membership_lifecycle" ("clerkOrgId");
CREATE INDEX IF NOT EXISTS "clerk_user_lifecycle_clerkMembershipId_idx"
  ON "clerk_user_lifecycle" ("clerkMembershipId");
CREATE INDEX IF NOT EXISTS "clerk_user_lifecycle_clerkOrgId_idx"
  ON "clerk_user_lifecycle" ("clerkOrgId");

-- A rerun may already have the arming trigger. Remove it inside this migration
-- transaction so the behavioral probes below exercise the table CHECKs
-- directly; rollback restores the prior trigger if any probe fails.
DROP TRIGGER IF EXISTS clerk_identity_validate_cutover_arm
  ON "clerk_identity_cutover";

-- IF NOT EXISTS is retry-friendly only when the existing objects have the
-- reviewed contract. Fail before commit if any same-name column/table differs.
DO $clerk_identity_table_contract$
DECLARE
  base_column_count INTEGER;
  lifecycle_column_count INTEGER;
  actual_lifecycle_column_count INTEGER;
  primary_key_count INTEGER;
  lifecycle_index_count INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO base_column_count
  FROM information_schema.columns AS c
  WHERE c.table_schema = current_schema()
    AND (
      (c.table_name = 'Org'
        AND c.column_name = 'clerkOrgId'
        AND c.udt_name = 'text'
        AND c.is_nullable = 'YES')
      OR
      (c.table_name = 'User'
        AND c.column_name = 'clerkMembershipId'
        AND c.udt_name = 'text'
        AND c.is_nullable = 'YES')
      OR
      (c.table_name = 'User'
        AND c.column_name = 'membershipActive'
        AND c.udt_name = 'bool'
        AND c.is_nullable = 'NO'
        AND c.column_default IN ('false', 'false::boolean'))
    );

  IF base_column_count <> 3 THEN
    RAISE EXCEPTION
      'Clerk identity column contract failed: expected 3 exact columns, found %',
      base_column_count;
  END IF;

  WITH expected(table_name, column_name, udt_name, is_nullable) AS (
    VALUES
      ('clerk_identity_cutover', 'id', 'int4', 'NO'),
      ('clerk_identity_cutover', 'minimumEventVersion', 'int8', 'NO'),
      ('clerk_identity_cutover', 'ready', 'bool', 'NO'),
      ('clerk_identity_cutover', 'inventoryEvidenceHash', 'text', 'YES'),
      ('clerk_identity_cutover', 'expectedActiveOrganizationCount', 'int4', 'NO'),
      ('clerk_identity_cutover', 'expectedActiveMembershipCount', 'int4', 'NO'),
      ('clerk_identity_cutover', 'expectedActiveUserCount', 'int4', 'NO'),
      ('clerk_identity_cutover', 'establishedAt', 'timestamp', 'NO'),
      ('clerk_identity_cutover', 'updatedAt', 'timestamp', 'NO'),
      ('clerk_organization_lifecycle', 'clerkOrgId', 'text', 'NO'),
      ('clerk_organization_lifecycle', 'eventVersion', 'int8', 'NO'),
      ('clerk_organization_lifecycle', 'eventRank', 'int4', 'NO'),
      ('clerk_organization_lifecycle', 'deleted', 'bool', 'NO'),
      ('clerk_organization_lifecycle', 'lastEventId', 'text', 'NO'),
      ('clerk_organization_lifecycle', 'updatedAt', 'timestamp', 'NO'),
      ('clerk_membership_lifecycle', 'clerkMembershipId', 'text', 'NO'),
      ('clerk_membership_lifecycle', 'clerkUserId', 'text', 'NO'),
      ('clerk_membership_lifecycle', 'clerkOrgId', 'text', 'NO'),
      ('clerk_membership_lifecycle', 'eventVersion', 'int8', 'NO'),
      ('clerk_membership_lifecycle', 'eventRank', 'int4', 'NO'),
      ('clerk_membership_lifecycle', 'role', 'UserRole', 'NO'),
      ('clerk_membership_lifecycle', 'deleted', 'bool', 'NO'),
      ('clerk_membership_lifecycle', 'lastEventId', 'text', 'NO'),
      ('clerk_membership_lifecycle', 'updatedAt', 'timestamp', 'NO'),
      ('clerk_user_lifecycle', 'clerkUserId', 'text', 'NO'),
      ('clerk_user_lifecycle', 'deleted', 'bool', 'NO'),
      ('clerk_user_lifecycle', 'clerkMembershipId', 'text', 'YES'),
      ('clerk_user_lifecycle', 'clerkOrgId', 'text', 'YES'),
      ('clerk_user_lifecycle', 'membershipEventVersion', 'int8', 'YES'),
      ('clerk_user_lifecycle', 'membershipEventRank', 'int4', 'YES'),
      ('clerk_user_lifecycle', 'membershipActive', 'bool', 'NO'),
      ('clerk_user_lifecycle', 'role', 'UserRole', 'NO'),
      ('clerk_user_lifecycle', 'lastEventId', 'text', 'NO'),
      ('clerk_user_lifecycle', 'updatedAt', 'timestamp', 'NO')
  )
  SELECT COUNT(*)
  INTO lifecycle_column_count
  FROM expected AS e
  JOIN information_schema.columns AS c
    ON c.table_schema = current_schema()
   AND c.table_name = e.table_name
   AND c.column_name = e.column_name
   AND c.udt_name = e.udt_name
   AND c.is_nullable = e.is_nullable
   AND (e.udt_name <> 'timestamp' OR c.datetime_precision = 3);

  SELECT COUNT(*)
  INTO actual_lifecycle_column_count
  FROM information_schema.columns AS c
  WHERE c.table_schema = current_schema()
    AND c.table_name IN (
      'clerk_identity_cutover',
      'clerk_organization_lifecycle',
      'clerk_membership_lifecycle',
      'clerk_user_lifecycle'
    );

  IF lifecycle_column_count <> 34 OR actual_lifecycle_column_count <> 34 THEN
    RAISE EXCEPTION
      'Clerk lifecycle table contract failed: expected 34 exact columns, matched %, actual %',
      lifecycle_column_count,
      actual_lifecycle_column_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns AS c
    WHERE c.table_schema = current_schema()
      AND c.table_name IN (
        'clerk_identity_cutover',
        'clerk_organization_lifecycle',
        'clerk_membership_lifecycle',
        'clerk_user_lifecycle'
      )
      AND c.column_name IN ('ready', 'deleted', 'membershipActive')
      AND COALESCE(c.column_default, '') NOT IN ('false', 'false::boolean')
  ) THEN
    RAISE EXCEPTION 'Clerk lifecycle boolean defaults are not fail-closed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns AS c
    WHERE c.table_schema = current_schema()
      AND c.table_name = 'clerk_identity_cutover'
      AND c.column_name IN (
        'expectedActiveOrganizationCount',
        'expectedActiveMembershipCount',
        'expectedActiveUserCount'
      )
      AND COALESCE(c.column_default, '') NOT IN (
        '-1',
        '(-1)',
        '''-1''::integer'
      )
  ) THEN
    RAISE EXCEPTION 'Clerk cutover inventory-count defaults are not unarmed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns AS c
    WHERE c.table_schema = current_schema()
      AND c.table_name = 'clerk_user_lifecycle'
      AND c.column_name = 'role'
      AND c.column_default LIKE '%MEMBER%UserRole%'
  ) THEN
    RAISE EXCEPTION 'Clerk user lifecycle role default is not MEMBER';
  END IF;

  SELECT COUNT(*)
  INTO primary_key_count
  FROM pg_constraint AS con
  JOIN pg_class AS t ON t.oid = con.conrelid
  JOIN pg_namespace AS n ON n.oid = t.relnamespace
  WHERE n.nspname = current_schema()
    AND con.contype = 'p'
    AND (
      (t.relname = 'clerk_identity_cutover'
        AND con.conname = 'clerk_identity_cutover_pkey'
        AND con.conkey = ARRAY[(
          SELECT a.attnum FROM pg_attribute AS a
          WHERE a.attrelid = t.oid AND a.attname = 'id'
        )]::smallint[])
      OR (t.relname = 'clerk_organization_lifecycle'
        AND con.conname = 'clerk_organization_lifecycle_pkey'
        AND con.conkey = ARRAY[(
          SELECT a.attnum FROM pg_attribute AS a
          WHERE a.attrelid = t.oid AND a.attname = 'clerkOrgId'
        )]::smallint[])
      OR (t.relname = 'clerk_membership_lifecycle'
        AND con.conname = 'clerk_membership_lifecycle_pkey'
        AND con.conkey = ARRAY[(
          SELECT a.attnum FROM pg_attribute AS a
          WHERE a.attrelid = t.oid AND a.attname = 'clerkMembershipId'
        )]::smallint[])
      OR (t.relname = 'clerk_user_lifecycle'
        AND con.conname = 'clerk_user_lifecycle_pkey'
        AND con.conkey = ARRAY[(
          SELECT a.attnum FROM pg_attribute AS a
          WHERE a.attrelid = t.oid AND a.attname = 'clerkUserId'
        )]::smallint[])
    );

  IF primary_key_count <> 4 THEN
    RAISE EXCEPTION
      'Clerk lifecycle primary-key contract failed: expected 4, found %',
      primary_key_count;
  END IF;

  IF (SELECT COUNT(*) FROM "clerk_identity_cutover") <> 1
    OR (
      SELECT COUNT(*)
      FROM "clerk_identity_cutover"
      WHERE "id" = 1
        AND "minimumEventVersion" > 0
        AND (
          (
            NOT "ready"
            AND "inventoryEvidenceHash" IS NULL
            AND "minimumEventVersion" = 9223372036854775807
          )
          OR (
            "ready"
            AND "minimumEventVersion" <= 9007199254740991
            AND "minimumEventVersion" BETWEEN
              ((EXTRACT(EPOCH FROM "establishedAt") * 1000)::BIGINT - 86400000)
              AND ((EXTRACT(EPOCH FROM "establishedAt") * 1000)::BIGINT + 86400000)
            AND "inventoryEvidenceHash" ~ '^sha256:[0-9a-f]{64}$'
            AND "expectedActiveOrganizationCount" >= 0
            AND "expectedActiveMembershipCount" >= 0
            AND "expectedActiveUserCount" >= 0
          )
        )
    ) <> 1
  THEN
    RAISE EXCEPTION
      'Clerk identity cutover singleton is neither pending nor validly armed';
  END IF;

  -- Prove the critical CHECK semantics rather than trusting same-name
  -- constraints. Each successful invalid write raises and fails the migration;
  -- an expected check_violation rolls its subtransaction back and continues.
  BEGIN
    INSERT INTO "clerk_identity_cutover" (
      "id", "minimumEventVersion", "ready", "inventoryEvidenceHash", "updatedAt"
    ) VALUES (2, 1, false, NULL, clock_timestamp());
    RAISE EXCEPTION 'Clerk cutover singleton CHECK is absent or ineffective';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE "clerk_identity_cutover"
    SET "minimumEventVersion" = 0,
        "ready" = false,
        "inventoryEvidenceHash" = NULL
    WHERE "id" = 1;
    RAISE EXCEPTION 'Clerk cutover positive-version CHECK is absent or ineffective';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE "clerk_identity_cutover"
    SET "expectedActiveOrganizationCount" = -2
    WHERE "id" = 1;
    RAISE EXCEPTION 'Clerk cutover inventory-count CHECK is absent or ineffective';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE "clerk_identity_cutover"
    SET "minimumEventVersion" = 1800000000000000,
        "ready" = true,
        "inventoryEvidenceHash" = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    WHERE "id" = 1;
    RAISE EXCEPTION 'Clerk cutover epoch-ms CHECK is absent or ineffective';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE "clerk_identity_cutover"
    SET "minimumEventVersion" = 1,
        "ready" = true,
        "inventoryEvidenceHash" = 'invalid'
    WHERE "id" = 1;
    RAISE EXCEPTION 'Clerk cutover evidence CHECK is absent or ineffective';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE "clerk_identity_cutover"
    SET "minimumEventVersion" = 9223372036854775807,
        "ready" = true,
        "inventoryEvidenceHash" = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    WHERE "id" = 1;
    RAISE EXCEPTION 'Clerk cutover sentinel CHECK is absent or ineffective';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "clerk_organization_lifecycle" (
      "clerkOrgId", "eventVersion", "eventRank", "lastEventId", "updatedAt"
    ) VALUES (
      '__clerk_contract_invalid_org_version__', 0, 1,
      '__clerk_contract_probe__', clock_timestamp()
    );
    RAISE EXCEPTION 'Clerk organization event-version CHECK is absent or ineffective';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "clerk_organization_lifecycle" (
      "clerkOrgId", "eventVersion", "eventRank", "lastEventId", "updatedAt"
    ) VALUES (
      '__clerk_contract_unsafe_org_version__', 9007199254740992, 1,
      '__clerk_contract_probe__', clock_timestamp()
    );
    RAISE EXCEPTION 'Clerk organization JS-safe event-version CHECK is absent or ineffective';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "clerk_organization_lifecycle" (
      "clerkOrgId", "eventVersion", "eventRank", "lastEventId", "updatedAt"
    ) VALUES (
      '__clerk_contract_invalid_org_rank__', 1, 4,
      '__clerk_contract_probe__', clock_timestamp()
    );
    RAISE EXCEPTION 'Clerk organization event-rank CHECK is absent or ineffective';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "clerk_membership_lifecycle" (
      "clerkMembershipId", "clerkUserId", "clerkOrgId", "eventVersion",
      "eventRank", "role", "lastEventId", "updatedAt"
    ) VALUES (
      '__clerk_contract_invalid_membership_version__', '__clerk_contract_user__',
      '__clerk_contract_org__', 0, 1, 'MEMBER', '__clerk_contract_probe__',
      clock_timestamp()
    );
    RAISE EXCEPTION 'Clerk membership event-version CHECK is absent or ineffective';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "clerk_membership_lifecycle" (
      "clerkMembershipId", "clerkUserId", "clerkOrgId", "eventVersion",
      "eventRank", "role", "lastEventId", "updatedAt"
    ) VALUES (
      '__clerk_contract_unsafe_membership_version__', '__clerk_contract_user__',
      '__clerk_contract_org__', 9007199254740992, 1, 'MEMBER',
      '__clerk_contract_probe__', clock_timestamp()
    );
    RAISE EXCEPTION 'Clerk membership JS-safe event-version CHECK is absent or ineffective';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "clerk_membership_lifecycle" (
      "clerkMembershipId", "clerkUserId", "clerkOrgId", "eventVersion",
      "eventRank", "role", "lastEventId", "updatedAt"
    ) VALUES (
      '__clerk_contract_invalid_membership_rank__', '__clerk_contract_user__',
      '__clerk_contract_org__', 1, 4, 'MEMBER', '__clerk_contract_probe__',
      clock_timestamp()
    );
    RAISE EXCEPTION 'Clerk membership event-rank CHECK is absent or ineffective';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "clerk_user_lifecycle" (
      "clerkUserId", "membershipEventVersion", "membershipEventRank",
      "lastEventId", "updatedAt"
    ) VALUES (
      '__clerk_contract_invalid_user_version__', 0, 1,
      '__clerk_contract_probe__', clock_timestamp()
    );
    RAISE EXCEPTION 'Clerk user event-version CHECK is absent or ineffective';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "clerk_user_lifecycle" (
      "clerkUserId", "membershipEventVersion", "membershipEventRank",
      "lastEventId", "updatedAt"
    ) VALUES (
      '__clerk_contract_unsafe_user_version__', 9007199254740992, 1,
      '__clerk_contract_probe__', clock_timestamp()
    );
    RAISE EXCEPTION 'Clerk user JS-safe event-version CHECK is absent or ineffective';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "clerk_user_lifecycle" (
      "clerkUserId", "membershipEventVersion", "membershipEventRank",
      "lastEventId", "updatedAt"
    ) VALUES (
      '__clerk_contract_invalid_user_rank__', 1, 4,
      '__clerk_contract_probe__', clock_timestamp()
    );
    RAISE EXCEPTION 'Clerk user event-rank CHECK is absent or ineffective';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "clerk_user_lifecycle" (
      "clerkUserId", "membershipEventVersion", "membershipEventRank",
      "lastEventId", "updatedAt"
    ) VALUES (
      '__clerk_contract_partial_user_cursor__', 1, NULL,
      '__clerk_contract_probe__', clock_timestamp()
    );
    RAISE EXCEPTION 'Clerk user complete membership-cursor CHECK is absent or ineffective';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  SELECT COUNT(*)
  INTO lifecycle_index_count
  FROM pg_class AS idx
  JOIN pg_index AS i ON i.indexrelid = idx.oid
  JOIN pg_am AS am ON am.oid = idx.relam
  JOIN pg_class AS t ON t.oid = i.indrelid
  JOIN pg_namespace AS n ON n.oid = t.relnamespace
  WHERE n.nspname = current_schema()
    AND i.indisvalid
    AND i.indisready
    AND i.indislive
    AND NOT i.indisunique
    AND idx.relkind = 'i'
    AND am.amname = 'btree'
    AND i.indnkeyatts = 1
    AND i.indnatts = 1
    AND i.indpred IS NULL
    AND i.indexprs IS NULL
    AND i.indoption[0] = 0
    AND i.indclass[0] = (
      SELECT opc.oid
      FROM pg_opclass AS opc
      WHERE opc.opcmethod = am.oid
        AND opc.opcname = 'text_ops'
        AND opc.opcdefault
    )
    AND (
      (idx.relname = 'clerk_membership_lifecycle_clerkUserId_idx'
        AND t.relname = 'clerk_membership_lifecycle'
        AND i.indkey[0] = (
          SELECT a.attnum FROM pg_attribute AS a
          WHERE a.attrelid = t.oid AND a.attname = 'clerkUserId'
        )
        AND i.indcollation[0] = (
          SELECT a.attcollation FROM pg_attribute AS a
          WHERE a.attrelid = t.oid AND a.attname = 'clerkUserId'
        ))
      OR (idx.relname = 'clerk_membership_lifecycle_clerkOrgId_idx'
        AND t.relname = 'clerk_membership_lifecycle'
        AND i.indkey[0] = (
          SELECT a.attnum FROM pg_attribute AS a
          WHERE a.attrelid = t.oid AND a.attname = 'clerkOrgId'
        )
        AND i.indcollation[0] = (
          SELECT a.attcollation FROM pg_attribute AS a
          WHERE a.attrelid = t.oid AND a.attname = 'clerkOrgId'
        ))
      OR (idx.relname = 'clerk_user_lifecycle_clerkMembershipId_idx'
        AND t.relname = 'clerk_user_lifecycle'
        AND i.indkey[0] = (
          SELECT a.attnum FROM pg_attribute AS a
          WHERE a.attrelid = t.oid AND a.attname = 'clerkMembershipId'
        )
        AND i.indcollation[0] = (
          SELECT a.attcollation FROM pg_attribute AS a
          WHERE a.attrelid = t.oid AND a.attname = 'clerkMembershipId'
        ))
      OR (idx.relname = 'clerk_user_lifecycle_clerkOrgId_idx'
        AND t.relname = 'clerk_user_lifecycle'
        AND i.indkey[0] = (
          SELECT a.attnum FROM pg_attribute AS a
          WHERE a.attrelid = t.oid AND a.attname = 'clerkOrgId'
        )
        AND i.indcollation[0] = (
          SELECT a.attcollation FROM pg_attribute AS a
          WHERE a.attrelid = t.oid AND a.attname = 'clerkOrgId'
        ))
    );

  IF lifecycle_index_count <> 4 THEN
    RAISE EXCEPTION
      'Clerk lifecycle index contract failed: expected 4, found %',
      lifecycle_index_count;
  END IF;
END
$clerk_identity_table_contract$;

-- The operator may explicitly capture zero active authorities, but cannot arm
-- a cutover with omitted (-1) counts, a partial lifecycle seed, or cursor data
-- newer than the provider snapshot cutoff. This guard runs only on the first
-- false-to-true transition; later webhook cursors are expected to advance past
-- the fixed snapshot cutoff and therefore must not be revalidated on rerun.
CREATE OR REPLACE FUNCTION clerk_identity_validate_cutover_arm()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $clerk_identity_validate_cutover_arm$
DECLARE
  actual_active_organization_count BIGINT;
  actual_active_membership_count BIGINT;
  actual_active_user_count BIGINT;
BEGIN
  IF NOT NEW."ready" THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."ready" THEN
    RETURN NEW;
  END IF;

  IF NEW."minimumEventVersion" NOT BETWEEN 1 AND 9007199254740991 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Clerk identity cutover requires a positive JS-safe provider snapshot cutoff';
  END IF;

  IF NEW."expectedActiveOrganizationCount" < 0
    OR NEW."expectedActiveMembershipCount" < 0
    OR NEW."expectedActiveUserCount" < 0
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Clerk identity cutover requires explicit nonnegative inventory counts';
  END IF;

  SELECT COUNT(*)
  INTO actual_active_organization_count
  FROM "clerk_organization_lifecycle"
  WHERE NOT "deleted";

  SELECT COUNT(*)
  INTO actual_active_membership_count
  FROM "clerk_membership_lifecycle"
  WHERE NOT "deleted";

  SELECT COUNT(*)
  INTO actual_active_user_count
  FROM "clerk_user_lifecycle"
  WHERE NOT "deleted" AND "membershipActive";

  IF actual_active_organization_count
      <> NEW."expectedActiveOrganizationCount"
    OR actual_active_membership_count
      <> NEW."expectedActiveMembershipCount"
    OR actual_active_user_count
      <> NEW."expectedActiveUserCount"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Clerk identity inventory counts do not match: expected (%s,%s,%s), actual (%s,%s,%s)',
        NEW."expectedActiveOrganizationCount",
        NEW."expectedActiveMembershipCount",
        NEW."expectedActiveUserCount",
        actual_active_organization_count,
        actual_active_membership_count,
        actual_active_user_count
      );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "clerk_organization_lifecycle"
    WHERE "eventVersion" NOT BETWEEN 1 AND 9007199254740991
       OR "eventRank" NOT BETWEEN 1 AND 3
       OR "eventVersion" > NEW."minimumEventVersion"
    UNION ALL
    SELECT 1
    FROM "clerk_membership_lifecycle"
    WHERE "eventVersion" NOT BETWEEN 1 AND 9007199254740991
       OR "eventRank" NOT BETWEEN 1 AND 3
       OR "eventVersion" > NEW."minimumEventVersion"
    UNION ALL
    SELECT 1
    FROM "clerk_user_lifecycle"
    WHERE ("membershipEventVersion" IS NULL)
          IS DISTINCT FROM ("membershipEventRank" IS NULL)
       OR (
         "membershipEventVersion" IS NOT NULL
         AND (
           "membershipEventVersion" NOT BETWEEN 1 AND 9007199254740991
           OR "membershipEventRank" NOT BETWEEN 1 AND 3
           OR "membershipEventVersion" > NEW."minimumEventVersion"
         )
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Clerk identity lifecycle cursor is invalid or newer than the provider snapshot cutoff';
  END IF;

  RETURN NEW;
END
$clerk_identity_validate_cutover_arm$;

DROP TRIGGER IF EXISTS clerk_identity_validate_cutover_arm
  ON "clerk_identity_cutover";
CREATE TRIGGER clerk_identity_validate_cutover_arm
BEFORE INSERT OR UPDATE ON "clerk_identity_cutover"
FOR EACH ROW
EXECUTE FUNCTION clerk_identity_validate_cutover_arm();

COMMIT;

-- IF NOT EXISTS permits a safe retry after one concurrent index succeeded.
-- The exact-table/column/validity postcondition below rejects any incompatible
-- same-name object instead of silently accepting it.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Org_clerkOrgId_key"
  ON "Org" ("clerkOrgId");

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "User_clerkMembershipId_key"
  ON "User" ("clerkMembershipId");

DO $clerk_identity_index_postcondition$
DECLARE
  valid_index_count INTEGER;
  role_labels TEXT[];
BEGIN
  SELECT COUNT(*)
  INTO valid_index_count
  FROM pg_class AS idx
  JOIN pg_index AS i ON i.indexrelid = idx.oid
  JOIN pg_am AS am ON am.oid = idx.relam
  JOIN pg_class AS t ON t.oid = i.indrelid
  JOIN pg_namespace AS n ON n.oid = t.relnamespace
  WHERE n.nspname = current_schema()
    AND i.indisvalid
    AND i.indisready
    AND i.indislive
    AND i.indisunique
    AND NOT COALESCE(
      (to_jsonb(i) ->> 'indnullsnotdistinct')::boolean,
      false
    )
    AND idx.relkind = 'i'
    AND am.amname = 'btree'
    AND i.indnkeyatts = 1
    AND i.indnatts = 1
    AND i.indpred IS NULL
    AND i.indexprs IS NULL
    AND i.indoption[0] = 0
    AND i.indclass[0] = (
      SELECT opc.oid
      FROM pg_opclass AS opc
      WHERE opc.opcmethod = am.oid
        AND opc.opcname = 'text_ops'
        AND opc.opcdefault
    )
    AND (
      (idx.relname = 'Org_clerkOrgId_key'
        AND t.relname = 'Org'
        AND i.indkey[0] = (
          SELECT a.attnum FROM pg_attribute AS a
          WHERE a.attrelid = t.oid AND a.attname = 'clerkOrgId'
        )
        AND i.indcollation[0] = (
          SELECT a.attcollation FROM pg_attribute AS a
          WHERE a.attrelid = t.oid AND a.attname = 'clerkOrgId'
        ))
      OR (idx.relname = 'User_clerkMembershipId_key'
        AND t.relname = 'User'
        AND i.indkey[0] = (
          SELECT a.attnum FROM pg_attribute AS a
          WHERE a.attrelid = t.oid AND a.attname = 'clerkMembershipId'
        )
        AND i.indcollation[0] = (
          SELECT a.attcollation FROM pg_attribute AS a
          WHERE a.attrelid = t.oid AND a.attname = 'clerkMembershipId'
        ))
    );

  IF valid_index_count <> 2 THEN
    RAISE EXCEPTION
      'Clerk identity postcondition failed: expected 2 exact valid/ready/live/unique indexes, found %',
      valid_index_count;
  END IF;

  SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
  INTO role_labels
  FROM pg_enum AS e
  JOIN pg_type AS t ON t.oid = e.enumtypid
  JOIN pg_namespace AS n ON n.oid = t.typnamespace
  WHERE n.nspname = current_schema()
    AND t.typname = 'UserRole';

  IF role_labels IS DISTINCT FROM ARRAY['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'] THEN
    RAISE EXCEPTION
      'Clerk identity postcondition failed: unexpected UserRole order %',
      role_labels;
  END IF;
END
$clerk_identity_index_postcondition$;

-- Reconciliation receipt queries (run during the same writer pause):
--
-- 1. Capture every legacy row, then bind immutable ids only from a verified
--    Clerk export/API inventory. Capture the provider inventory's exact active
--    organization, membership, and active-authority user counts, including
--    explicit zeroes. Seed all three lifecycle tables and the User projection
--    in one reviewed reconciliation transaction. The provider updated_at value
--    is the eventVersion; it must be positive, JS-safe, and no newer than the
--    provider snapshot cutoff. Event ranks are created=1, updated=2, deleted=3.
--    Active rows use deleted=false and matching membership/user cursor values.
--    Do not put row values in logs.
-- SELECT "id", "slug", "clerkOrgId" FROM "Org" ORDER BY "id";
-- SELECT "id", "orgId", "clerkId", "clerkMembershipId",
--        "membershipActive", "role"
-- FROM "User" ORDER BY "id";
--
-- 2. After reviewed reactivation, this invariant must return zero rows. It
--    proves every active projection agrees with non-deleted provider cursors.
-- SELECT u."id"
-- FROM "User" AS u
-- JOIN "Org" AS o ON o."id" = u."orgId"
-- LEFT JOIN "clerk_organization_lifecycle" AS ol
--   ON ol."clerkOrgId" = o."clerkOrgId"
-- LEFT JOIN "clerk_membership_lifecycle" AS ml
--   ON ml."clerkMembershipId" = u."clerkMembershipId"
-- LEFT JOIN "clerk_user_lifecycle" AS ul
--   ON ul."clerkUserId" = u."clerkId"
-- WHERE u."membershipActive"
--   AND (
--     (o."clerkOrgId" IS NULL AND (
--       u."clerkMembershipId" IS NOT NULL
--       OR u."clerkId" IS NULL
--       OR u."role" <> 'OWNER'
--     ))
--     OR
--     (o."clerkOrgId" IS NOT NULL AND (
--       u."clerkId" IS NULL
--       OR u."clerkMembershipId" IS NULL
--       OR ol."clerkOrgId" IS NULL
--       OR ol."deleted"
--       OR ml."clerkMembershipId" IS NULL
--       OR ml."deleted"
--       OR ml."clerkUserId" IS DISTINCT FROM u."clerkId"
--       OR ml."clerkOrgId" IS DISTINCT FROM o."clerkOrgId"
--       OR ul."clerkUserId" IS NULL
--       OR ul."deleted"
--       OR NOT ul."membershipActive"
--       OR ul."clerkMembershipId" IS DISTINCT FROM u."clerkMembershipId"
--       OR ul."clerkOrgId" IS DISTINCT FROM o."clerkOrgId"
--       OR ul."membershipEventVersion" IS DISTINCT FROM ml."eventVersion"
--       OR ul."membershipEventRank" IS DISTINCT FROM ml."eventRank"
--       OR ml."role" IS DISTINCT FROM ul."role"
--       OR NOT (
--         u."role" = ul."role"
--         OR (u."role" = 'OWNER' AND ul."role" = 'ADMIN')
--       )
--     ))
--   );
--
-- The following orphan invariant must also return zero rows. It rejects active
-- provider cursors that do not resolve to the exact current local projection:
-- SELECT ml."clerkMembershipId"
-- FROM "clerk_membership_lifecycle" AS ml
-- LEFT JOIN "clerk_user_lifecycle" AS ul
--   ON ul."clerkMembershipId" = ml."clerkMembershipId"
-- LEFT JOIN "Org" AS o ON o."clerkOrgId" = ml."clerkOrgId"
-- LEFT JOIN "User" AS u
--   ON u."clerkId" = ml."clerkUserId" AND u."orgId" = o."id"
-- WHERE NOT ml."deleted"
--   AND (
--     ul."clerkUserId" IS NULL
--     OR ul."deleted"
--     OR NOT ul."membershipActive"
--     OR ul."clerkUserId" IS DISTINCT FROM ml."clerkUserId"
--     OR ul."clerkOrgId" IS DISTINCT FROM ml."clerkOrgId"
--     OR ul."membershipEventVersion" IS DISTINCT FROM ml."eventVersion"
--     OR ul."membershipEventRank" IS DISTINCT FROM ml."eventRank"
--     OR ul."role" IS DISTINCT FROM ml."role"
--     OR u."id" IS NULL
--     OR NOT u."membershipActive"
--     OR u."clerkMembershipId" IS DISTINCT FROM ml."clerkMembershipId"
--   )
-- UNION ALL
-- SELECT ol."clerkOrgId"
-- FROM "clerk_organization_lifecycle" AS ol
-- LEFT JOIN "Org" AS o ON o."clerkOrgId" = ol."clerkOrgId"
-- WHERE NOT ol."deleted" AND o."id" IS NULL
-- UNION ALL
-- SELECT ul."clerkUserId"
-- FROM "clerk_user_lifecycle" AS ul
-- LEFT JOIN "clerk_membership_lifecycle" AS ml
--   ON ml."clerkMembershipId" = ul."clerkMembershipId"
-- WHERE NOT ul."deleted"
--   AND ul."membershipActive"
--   AND (ml."clerkMembershipId" IS NULL OR ml."deleted");
--
-- 3. Only after both queries return zero, arm the cutover with the sanitized
--    provider-inventory evidence hash and the three counts captured directly
--    from that inventory. This is the last identity-pause write. The trigger
--    rejects omitted counts, count mismatches, invalid cursor versions/ranks,
--    and any seeded event version newer than the snapshot cutoff:
-- UPDATE "clerk_identity_cutover"
-- SET "minimumEventVersion" = <verified-provider-snapshot-cutoff-ms>,
--     "ready" = true,
--     "inventoryEvidenceHash" = 'sha256:<64 lowercase hex>',
--     "expectedActiveOrganizationCount" = <captured-nonnegative-count>,
--     "expectedActiveMembershipCount" = <captured-nonnegative-count>,
--     "expectedActiveUserCount" = <captured-nonnegative-count>,
--     "updatedAt" = clock_timestamp()
-- WHERE "id" = 1 AND NOT "ready";
--
-- This readiness query must also return zero rows while writers remain paused.
-- It proves there is exactly one ready singleton, including for an explicitly
-- verified empty inventory, and rechecks the captured counts and seed bounds:
-- WITH singleton AS (
--   SELECT
--     COUNT(*) AS "rowCount",
--     COUNT(*) FILTER (
--       WHERE "id" = 1
--         AND "ready"
--         AND "minimumEventVersion" BETWEEN 1 AND 9007199254740991
--         AND "minimumEventVersion" BETWEEN
--           ((EXTRACT(EPOCH FROM "establishedAt") * 1000)::BIGINT - 86400000)
--           AND ((EXTRACT(EPOCH FROM "establishedAt") * 1000)::BIGINT + 86400000)
--         AND "inventoryEvidenceHash" ~ '^sha256:[0-9a-f]{64}$'
--         AND "expectedActiveOrganizationCount" >= 0
--         AND "expectedActiveMembershipCount" >= 0
--         AND "expectedActiveUserCount" >= 0
--     ) AS "readyCount"
--   FROM "clerk_identity_cutover"
-- )
-- SELECT 'cutover-singleton' AS violation
-- FROM singleton
-- WHERE "rowCount" <> 1 OR "readyCount" <> 1
-- UNION ALL
-- SELECT 'organization-count'
-- FROM "clerk_identity_cutover" AS c
-- WHERE c."id" = 1 AND c."ready"
--   AND c."expectedActiveOrganizationCount" <>
--     (SELECT COUNT(*) FROM "clerk_organization_lifecycle" WHERE NOT "deleted")
-- UNION ALL
-- SELECT 'membership-count'
-- FROM "clerk_identity_cutover" AS c
-- WHERE c."id" = 1 AND c."ready"
--   AND c."expectedActiveMembershipCount" <>
--     (SELECT COUNT(*) FROM "clerk_membership_lifecycle" WHERE NOT "deleted")
-- UNION ALL
-- SELECT 'user-count'
-- FROM "clerk_identity_cutover" AS c
-- WHERE c."id" = 1 AND c."ready"
--   AND c."expectedActiveUserCount" <>
--     (SELECT COUNT(*) FROM "clerk_user_lifecycle"
--      WHERE NOT "deleted" AND "membershipActive")
-- UNION ALL
-- SELECT 'organization-cursor-bound'
-- FROM "clerk_organization_lifecycle" AS l
-- CROSS JOIN "clerk_identity_cutover" AS c
-- WHERE c."id" = 1 AND c."ready"
--   AND (l."eventVersion" NOT BETWEEN 1 AND 9007199254740991
--     OR l."eventRank" NOT BETWEEN 1 AND 3
--     OR l."eventVersion" > c."minimumEventVersion")
-- UNION ALL
-- SELECT 'membership-cursor-bound'
-- FROM "clerk_membership_lifecycle" AS l
-- CROSS JOIN "clerk_identity_cutover" AS c
-- WHERE c."id" = 1 AND c."ready"
--   AND (l."eventVersion" NOT BETWEEN 1 AND 9007199254740991
--     OR l."eventRank" NOT BETWEEN 1 AND 3
--     OR l."eventVersion" > c."minimumEventVersion")
-- UNION ALL
-- SELECT 'user-cursor-bound'
-- FROM "clerk_user_lifecycle" AS l
-- CROSS JOIN "clerk_identity_cutover" AS c
-- WHERE c."id" = 1 AND c."ready"
--   AND ((l."membershipEventVersion" IS NULL)
--       IS DISTINCT FROM (l."membershipEventRank" IS NULL)
--     OR (l."membershipEventVersion" IS NOT NULL AND (
--       l."membershipEventVersion" NOT BETWEEN 1 AND 9007199254740991
--       OR l."membershipEventRank" NOT BETWEEN 1 AND 3
--       OR l."membershipEventVersion" > c."minimumEventVersion"
--     )));
--
-- 4. Capture exact index state for the signed postcondition evidence.
-- SELECT indexrelid::regclass AS index_name, indisvalid, indisready,
--        indislive, indisunique
-- FROM pg_index
-- WHERE indexrelid IN (
--   '"Org_clerkOrgId_key"'::regclass,
--   '"User_clerkMembershipId_key"'::regclass
-- );

-- Rollback is only safe after reverting every application reference. PostgreSQL
-- cannot remove one enum value in place; MANAGER may remain unused. Drop the
-- unique indexes concurrently before dropping the tables/columns:
-- DROP INDEX CONCURRENTLY IF EXISTS "User_clerkMembershipId_key";
-- DROP INDEX CONCURRENTLY IF EXISTS "Org_clerkOrgId_key";
-- DROP TRIGGER IF EXISTS clerk_identity_validate_cutover_arm
--   ON "clerk_identity_cutover";
-- DROP FUNCTION IF EXISTS clerk_identity_validate_cutover_arm();
-- DROP TABLE IF EXISTS "clerk_user_lifecycle";
-- DROP TABLE IF EXISTS "clerk_membership_lifecycle";
-- DROP TABLE IF EXISTS "clerk_organization_lifecycle";
-- DROP TABLE IF EXISTS "clerk_identity_cutover";
-- ALTER TABLE "User" DROP COLUMN IF EXISTS "clerkMembershipId",
--                    DROP COLUMN IF EXISTS "membershipActive";
-- ALTER TABLE "Org" DROP COLUMN IF EXISTS "clerkOrgId";
