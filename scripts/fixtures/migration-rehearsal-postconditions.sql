-- Fail-closed postconditions for the synthetic seven-file rehearsal.
-- Successful execution emits no row data. The controller separately records
-- only the resulting aggregate counts in its non-authoritative receipt.

\set ON_ERROR_STOP on

DO $rehearsal_postconditions$
DECLARE
  projection_mismatch_count BIGINT;
  orphan_active_authority_count BIGINT;
  readiness_violation_count BIGINT;
  fixed_index_count INTEGER;
  expected_index RECORD;
  actual_table NAME;
  actual_columns NAME[];
  actual_predicate TEXT;
  actual_unique BOOLEAN;
  actual_valid BOOLEAN;
  actual_ready BOOLEAN;
  actual_live BOOLEAN;
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'Conversation')) IS NULL
    OR to_regclass(format('%I.%I', current_schema(), 'ConversationMessage')) IS NULL
    OR to_regclass(format('%I.%I', current_schema(), 'FollowUpTask')) IS NULL
  THEN
    RAISE EXCEPTION 'conversation expand postcondition failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum AS e
    JOIN pg_type AS t ON t.oid = e.enumtypid
    JOIN pg_namespace AS n ON n.oid = t.typnamespace
    WHERE n.nspname = current_schema()
      AND t.typname = 'OutreachArtifactStatus'
      AND e.enumlabel = 'DELIVERY_UNKNOWN'
  ) THEN
    RAISE EXCEPTION 'DELIVERY_UNKNOWN enum postcondition failed';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'GraphRun'
      AND (
        (column_name = 'lastActivityAt' AND data_type = 'timestamp without time zone'
          AND is_nullable = 'NO')
        OR (column_name = 'startIcpProfileIds' AND data_type = 'ARRAY'
          AND udt_name = '_text' AND is_nullable = 'NO')
        OR (column_name = 'pendingResumeApproved' AND data_type = 'boolean'
          AND is_nullable = 'YES')
        OR (column_name = 'pendingResumeApprovedBy' AND data_type = 'text'
          AND is_nullable = 'YES')
        OR (column_name = 'dispatchGeneration' AND data_type = 'integer'
          AND is_nullable = 'NO')
      )
  ) <> 5 THEN
    RAISE EXCEPTION 'GraphRun expand-column postcondition failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class AS idx
    JOIN pg_index AS i ON i.indexrelid = idx.oid
    JOIN pg_class AS t ON t.oid = i.indrelid
    JOIN pg_namespace AS n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND idx.relname = 'GraphRun_status_lastActivityAt_idx'
      AND t.relname = 'GraphRun'
      AND i.indisvalid AND i.indisready AND i.indislive
      AND NOT i.indisunique
      AND ARRAY(
        SELECT a.attname
        FROM unnest(i.indkey::SMALLINT[]) WITH ORDINALITY AS k(attnum, position)
        JOIN pg_attribute AS a
          ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE k.position <= i.indnkeyatts
        ORDER BY k.position
      ) = ARRAY['status', 'lastActivityAt']::NAME[]
  ) THEN
    RAISE EXCEPTION 'GraphRun activity-index postcondition failed';
  END IF;

  FOR expected_index IN
    SELECT * FROM (VALUES
      ('Org_clerkOrgId_key', 'Org', ARRAY['clerkOrgId']::NAME[], false),
      ('User_clerkMembershipId_key', 'User', ARRAY['clerkMembershipId']::NAME[], false),
      ('OutreachArtifact_idempotency_uniq', 'OutreachArtifact',
        ARRAY['orgId', 'graphRunId', 'toolName', 'recipientRef']::NAME[], true),
      ('OutreachArtifact_one_reply_per_inbound_uniq', 'OutreachArtifact',
        ARRAY['orgId', 'conversationId', 'replyToMessageId']::NAME[], true),
      ('OutreachArtifact_one_open_reply_per_conversation_uniq', 'OutreachArtifact',
        ARRAY['orgId', 'conversationId']::NAME[], true),
      ('GraphRun_one_active_per_org_key', 'GraphRun', ARRAY['orgId']::NAME[], true)
    ) AS expected(index_name, table_name, columns, predicate_required)
  LOOP
    SELECT
      t.relname,
      ARRAY(
        SELECT a.attname
        FROM unnest(i.indkey::SMALLINT[]) WITH ORDINALITY AS k(attnum, position)
        JOIN pg_attribute AS a
          ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE k.position <= i.indnkeyatts
        ORDER BY k.position
      ),
      regexp_replace(
        COALESCE(pg_get_expr(i.indpred, i.indrelid), ''),
        '[[:space:]()"]', '', 'g'
      ),
      i.indisunique,
      i.indisvalid,
      i.indisready,
      i.indislive
    INTO
      actual_table,
      actual_columns,
      actual_predicate,
      actual_unique,
      actual_valid,
      actual_ready,
      actual_live
    FROM pg_class AS idx
    JOIN pg_index AS i ON i.indexrelid = idx.oid
    JOIN pg_class AS t ON t.oid = i.indrelid
    JOIN pg_namespace AS n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND idx.relname = expected_index.index_name
      AND idx.relkind = 'i';

    IF actual_table IS DISTINCT FROM expected_index.table_name
      OR actual_columns IS DISTINCT FROM expected_index.columns
      OR actual_unique IS DISTINCT FROM true
      OR actual_valid IS DISTINCT FROM true
      OR actual_ready IS DISTINCT FROM true
      OR actual_live IS DISTINCT FROM true
      OR (expected_index.predicate_required AND actual_predicate = '')
      OR (NOT expected_index.predicate_required AND actual_predicate <> '')
    THEN
      RAISE EXCEPTION 'fixed-index postcondition failed for %', expected_index.index_name;
    END IF;

    IF expected_index.index_name = 'OutreachArtifact_one_reply_per_inbound_uniq'
      AND (
        position('purpose=''REPLY''::OutreachArtifactPurpose' IN actual_predicate) = 0
        OR position('conversationIdISNOTNULL' IN actual_predicate) = 0
        OR position('replyToMessageIdISNOTNULL' IN actual_predicate) = 0
        OR position('''SENT''::OutreachArtifactStatus' IN actual_predicate) = 0
        OR position('''DELIVERY_UNKNOWN''::OutreachArtifactStatus' IN actual_predicate) = 0
      )
    THEN
      RAISE EXCEPTION 'inbound-reply fixed-index predicate postcondition failed';
    END IF;

    IF expected_index.index_name = 'OutreachArtifact_one_open_reply_per_conversation_uniq'
      AND (
        position('purpose=''REPLY''::OutreachArtifactPurpose' IN actual_predicate) = 0
        OR position('conversationIdISNOTNULL' IN actual_predicate) = 0
        OR position('''DELIVERY_UNKNOWN''::OutreachArtifactStatus' IN actual_predicate) = 0
        OR position('''SENT''::OutreachArtifactStatus' IN actual_predicate) <> 0
      )
    THEN
      RAISE EXCEPTION 'open-reply fixed-index predicate postcondition failed';
    END IF;
  END LOOP;

  SELECT COUNT(*)
  INTO fixed_index_count
  FROM pg_class AS idx
  JOIN pg_index AS i ON i.indexrelid = idx.oid
  JOIN pg_namespace AS n ON n.oid = idx.relnamespace
  WHERE n.nspname = current_schema()
    AND idx.relname IN (
      'Org_clerkOrgId_key',
      'User_clerkMembershipId_key',
      'OutreachArtifact_idempotency_uniq',
      'OutreachArtifact_one_reply_per_inbound_uniq',
      'OutreachArtifact_one_open_reply_per_conversation_uniq',
      'GraphRun_one_active_per_org_key'
    )
    AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive;

  IF fixed_index_count <> 6 THEN
    RAISE EXCEPTION 'fixed-index count postcondition failed: %', fixed_index_count;
  END IF;

  SELECT COUNT(*)
  INTO projection_mismatch_count
  FROM "User" AS u
  JOIN "Org" AS o ON o."id" = u."orgId"
  LEFT JOIN "clerk_organization_lifecycle" AS ol
    ON ol."clerkOrgId" = o."clerkOrgId"
  LEFT JOIN "clerk_membership_lifecycle" AS ml
    ON ml."clerkMembershipId" = u."clerkMembershipId"
  LEFT JOIN "clerk_user_lifecycle" AS ul
    ON ul."clerkUserId" = u."clerkId"
  WHERE u."membershipActive"
    AND (
      (o."clerkOrgId" IS NULL AND (
        u."clerkMembershipId" IS NOT NULL
        OR u."clerkId" IS NULL
        OR u."role" <> 'OWNER'
      ))
      OR (o."clerkOrgId" IS NOT NULL AND (
        u."clerkId" IS NULL
        OR u."clerkMembershipId" IS NULL
        OR ol."clerkOrgId" IS NULL
        OR ol."deleted"
        OR ml."clerkMembershipId" IS NULL
        OR ml."deleted"
        OR ml."clerkUserId" IS DISTINCT FROM u."clerkId"
        OR ml."clerkOrgId" IS DISTINCT FROM o."clerkOrgId"
        OR ul."clerkUserId" IS NULL
        OR ul."deleted"
        OR NOT ul."membershipActive"
        OR ul."clerkMembershipId" IS DISTINCT FROM u."clerkMembershipId"
        OR ul."clerkOrgId" IS DISTINCT FROM o."clerkOrgId"
        OR ul."membershipEventVersion" IS DISTINCT FROM ml."eventVersion"
        OR ul."membershipEventRank" IS DISTINCT FROM ml."eventRank"
        OR ml."role" IS DISTINCT FROM ul."role"
        OR NOT (
          u."role" = ul."role"
          OR (u."role" = 'OWNER' AND ul."role" = 'ADMIN')
        )
      ))
    );

  SELECT COUNT(*)
  INTO orphan_active_authority_count
  FROM (
    SELECT ml."clerkMembershipId"
    FROM "clerk_membership_lifecycle" AS ml
    LEFT JOIN "clerk_user_lifecycle" AS ul
      ON ul."clerkMembershipId" = ml."clerkMembershipId"
    LEFT JOIN "Org" AS o ON o."clerkOrgId" = ml."clerkOrgId"
    LEFT JOIN "User" AS u
      ON u."clerkId" = ml."clerkUserId" AND u."orgId" = o."id"
    WHERE NOT ml."deleted"
      AND (
        ul."clerkUserId" IS NULL
        OR ul."deleted"
        OR NOT ul."membershipActive"
        OR ul."clerkUserId" IS DISTINCT FROM ml."clerkUserId"
        OR ul."clerkOrgId" IS DISTINCT FROM ml."clerkOrgId"
        OR ul."membershipEventVersion" IS DISTINCT FROM ml."eventVersion"
        OR ul."membershipEventRank" IS DISTINCT FROM ml."eventRank"
        OR ul."role" IS DISTINCT FROM ml."role"
        OR u."id" IS NULL
        OR NOT u."membershipActive"
        OR u."clerkMembershipId" IS DISTINCT FROM ml."clerkMembershipId"
      )
    UNION ALL
    SELECT ol."clerkOrgId"
    FROM "clerk_organization_lifecycle" AS ol
    LEFT JOIN "Org" AS o ON o."clerkOrgId" = ol."clerkOrgId"
    WHERE NOT ol."deleted" AND o."id" IS NULL
    UNION ALL
    SELECT ul."clerkUserId"
    FROM "clerk_user_lifecycle" AS ul
    LEFT JOIN "clerk_membership_lifecycle" AS ml
      ON ml."clerkMembershipId" = ul."clerkMembershipId"
    WHERE NOT ul."deleted"
      AND ul."membershipActive"
      AND (ml."clerkMembershipId" IS NULL OR ml."deleted")
  ) AS orphan_authorities;

  SELECT COUNT(*)
  INTO readiness_violation_count
  FROM (
    WITH singleton AS (
      SELECT
        COUNT(*) AS row_count,
        COUNT(*) FILTER (
          WHERE "id" = 1
            AND "ready"
            AND "minimumEventVersion" BETWEEN 1 AND 9007199254740991
            AND "minimumEventVersion" BETWEEN
              ((EXTRACT(EPOCH FROM "establishedAt") * 1000)::BIGINT - 86400000)
              AND ((EXTRACT(EPOCH FROM "establishedAt") * 1000)::BIGINT + 86400000)
            AND "inventoryEvidenceHash" ~ '^sha256:[0-9a-f]{64}$'
            AND "expectedActiveOrganizationCount" = 1
            AND "expectedActiveMembershipCount" = 1
            AND "expectedActiveUserCount" = 1
        ) AS ready_count
      FROM "clerk_identity_cutover"
    )
    SELECT 'cutover-singleton' AS violation
    FROM singleton
    WHERE row_count <> 1 OR ready_count <> 1
    UNION ALL
    SELECT 'organization-count'
    FROM "clerk_identity_cutover" AS c
    WHERE c."id" = 1 AND c."ready"
      AND c."expectedActiveOrganizationCount" <>
        (SELECT COUNT(*) FROM "clerk_organization_lifecycle" WHERE NOT "deleted")
    UNION ALL
    SELECT 'membership-count'
    FROM "clerk_identity_cutover" AS c
    WHERE c."id" = 1 AND c."ready"
      AND c."expectedActiveMembershipCount" <>
        (SELECT COUNT(*) FROM "clerk_membership_lifecycle" WHERE NOT "deleted")
    UNION ALL
    SELECT 'user-count'
    FROM "clerk_identity_cutover" AS c
    WHERE c."id" = 1 AND c."ready"
      AND c."expectedActiveUserCount" <>
        (SELECT COUNT(*) FROM "clerk_user_lifecycle"
          WHERE NOT "deleted" AND "membershipActive")
    UNION ALL
    SELECT 'organization-cursor-bound'
    FROM "clerk_organization_lifecycle" AS l
    CROSS JOIN "clerk_identity_cutover" AS c
    WHERE c."id" = 1 AND c."ready"
      AND (l."eventVersion" NOT BETWEEN 1 AND 9007199254740991
        OR l."eventRank" NOT BETWEEN 1 AND 3
        OR l."eventVersion" > c."minimumEventVersion")
    UNION ALL
    SELECT 'membership-cursor-bound'
    FROM "clerk_membership_lifecycle" AS l
    CROSS JOIN "clerk_identity_cutover" AS c
    WHERE c."id" = 1 AND c."ready"
      AND (l."eventVersion" NOT BETWEEN 1 AND 9007199254740991
        OR l."eventRank" NOT BETWEEN 1 AND 3
        OR l."eventVersion" > c."minimumEventVersion")
    UNION ALL
    SELECT 'user-cursor-bound'
    FROM "clerk_user_lifecycle" AS l
    CROSS JOIN "clerk_identity_cutover" AS c
    WHERE c."id" = 1 AND c."ready"
      AND ((l."membershipEventVersion" IS NULL)
          IS DISTINCT FROM (l."membershipEventRank" IS NULL)
        OR (l."membershipEventVersion" IS NOT NULL AND (
          l."membershipEventVersion" NOT BETWEEN 1 AND 9007199254740991
          OR l."membershipEventRank" NOT BETWEEN 1 AND 3
          OR l."membershipEventVersion" > c."minimumEventVersion"
        )))
  ) AS readiness_violations;

  IF projection_mismatch_count <> 0
    OR orphan_active_authority_count <> 0
    OR readiness_violation_count <> 0
  THEN
    RAISE EXCEPTION
      'identity invariant postcondition failed: projection %, orphan %, readiness %',
      projection_mismatch_count,
      orphan_active_authority_count,
      readiness_violation_count;
  END IF;

  IF (SELECT COUNT(*) FROM "Org" WHERE "id" LIKE 'ci_org_%') <> 2
    OR (SELECT COUNT(DISTINCT "orgId") FROM "User" WHERE "id" LIKE 'ci_user_%') <> 2
    OR (SELECT COUNT(DISTINCT "orgId") FROM "Integration"
        WHERE "id" LIKE 'ci_integration_%') <> 2
    OR (SELECT COUNT(DISTINCT "orgId") FROM "GraphRun"
        WHERE "id" LIKE 'ci_graph_%') <> 2
    OR EXISTS (
      SELECT 1
      FROM "OutreachArtifact" AS a
      JOIN "GraphRun" AS g ON g."id" = a."graphRunId"
      WHERE a."id" LIKE 'ci_artifact_%' AND a."orgId" <> g."orgId"
    )
  THEN
    RAISE EXCEPTION 'synthetic tenant-isolation postcondition failed';
  END IF;
END
$rehearsal_postconditions$;
