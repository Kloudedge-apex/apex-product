-- Deterministic synthetic reconciliation performed after the identity expand.
-- The two psql variables are supplied by the rehearsal controller so negative
-- tests can prove the database trigger rejects mismatched inventory and cursors.

\set ON_ERROR_STOP on

BEGIN;

WITH snapshot AS (
  SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT AS cutoff
)
SELECT
  cutoff AS snapshot_cutoff,
  cutoff + :identity_event_offset AS lifecycle_event_version
FROM snapshot
\gset

UPDATE "Org"
SET "clerkOrgId" = 'ci_clerk_org_alpha'
WHERE "id" = 'ci_org_alpha';

UPDATE "User"
SET "clerkMembershipId" = 'ci_clerk_membership_alpha',
    "membershipActive" = true,
    "role" = 'OWNER'
WHERE "id" = 'ci_user_alpha';

-- A deliberately local workspace remains valid only as an explicitly reviewed
-- active OWNER with no Clerk organization or membership id.
UPDATE "User"
SET "clerkMembershipId" = NULL,
    "membershipActive" = true,
    "role" = 'OWNER'
WHERE "id" = 'ci_user_beta';

INSERT INTO "clerk_organization_lifecycle" (
  "clerkOrgId", "eventVersion", "eventRank", "deleted", "lastEventId", "updatedAt"
) VALUES (
  'ci_clerk_org_alpha', :lifecycle_event_version, 2, false,
  'ci_synthetic_org_event', clock_timestamp()
);

INSERT INTO "clerk_membership_lifecycle" (
  "clerkMembershipId", "clerkUserId", "clerkOrgId", "eventVersion",
  "eventRank", "role", "deleted", "lastEventId", "updatedAt"
) VALUES (
  'ci_clerk_membership_alpha', 'ci_clerk_user_alpha', 'ci_clerk_org_alpha',
  :lifecycle_event_version, 2, 'ADMIN', false,
  'ci_synthetic_membership_event', clock_timestamp()
);

INSERT INTO "clerk_user_lifecycle" (
  "clerkUserId", "deleted", "clerkMembershipId", "clerkOrgId",
  "membershipEventVersion", "membershipEventRank", "membershipActive",
  "role", "lastEventId", "updatedAt"
) VALUES (
  'ci_clerk_user_alpha', false, 'ci_clerk_membership_alpha',
  'ci_clerk_org_alpha', :lifecycle_event_version, 2, true, 'ADMIN',
  'ci_synthetic_user_event', clock_timestamp()
);

UPDATE "clerk_identity_cutover"
SET "minimumEventVersion" = :snapshot_cutoff,
    "ready" = true,
    "inventoryEvidenceHash" =
      'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    "expectedActiveOrganizationCount" = :identity_expected_organization_count,
    "expectedActiveMembershipCount" = 1,
    "expectedActiveUserCount" = 1,
    "updatedAt" = clock_timestamp()
WHERE "id" = 1 AND NOT "ready";

COMMIT;
