-- Synthetic-only two-tenant fixture for the hermetic migration rehearsal.
-- Every identifier and address is reserved test data; no production export or
-- customer row may be substituted here.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO "Org" ("id", "name", "slug", "updatedAt") VALUES
  ('ci_org_alpha', 'Synthetic Alpha', 'ci-synthetic-alpha', clock_timestamp()),
  ('ci_org_beta', 'Synthetic Beta', 'ci-synthetic-beta', clock_timestamp());

INSERT INTO "User" (
  "id", "orgId", "email", "name", "role", "clerkId"
) VALUES
  (
    'ci_user_alpha', 'ci_org_alpha', 'owner-alpha@workforce.invalid',
    'Synthetic Alpha Owner', 'OWNER', 'ci_clerk_user_alpha'
  ),
  (
    'ci_user_beta', 'ci_org_beta', 'owner-beta@workforce.invalid',
    'Synthetic Beta Owner', 'OWNER', 'ci_local_user_beta'
  );

INSERT INTO "Integration" (
  "id", "orgId", "provider", "credentials", "scopes", "updatedAt"
) VALUES
  (
    'ci_integration_alpha', 'ci_org_alpha', 'ci-synthetic-gmail',
    '{"synthetic":true}'::jsonb, ARRAY['ci.synthetic'], clock_timestamp()
  ),
  (
    'ci_integration_beta', 'ci_org_beta', 'ci-synthetic-gmail',
    '{"synthetic":true}'::jsonb, ARRAY['ci.synthetic'], clock_timestamp()
  );

INSERT INTO "GraphRun" (
  "id", "orgId", "threadId", "graphName", "status", "state"
) VALUES
  (
    'ci_graph_alpha', 'ci_org_alpha', 'ci-thread-alpha',
    'ci-synthetic-graph', 'RUNNING', '{"synthetic":true}'::jsonb
  ),
  (
    'ci_graph_beta', 'ci_org_beta', 'ci-thread-beta',
    'ci-synthetic-graph', 'AWAITING_APPROVAL', '{"synthetic":true}'::jsonb
  );

INSERT INTO "OutreachArtifact" (
  "id", "orgId", "graphRunId", "toolName", "channel", "recipientRef",
  "subject", "payload", "status", "updatedAt"
) VALUES
  (
    'ci_artifact_alpha', 'ci_org_alpha', 'ci_graph_alpha', 'ci_synthetic_send',
    'EMAIL', 'recipient-alpha@workforce.invalid', 'Synthetic alpha',
    '{"synthetic":true}'::jsonb, 'PENDING_REVIEW', clock_timestamp()
  ),
  (
    'ci_artifact_beta', 'ci_org_beta', 'ci_graph_beta', 'ci_synthetic_send',
    'EMAIL', 'recipient-beta@workforce.invalid', 'Synthetic beta',
    '{"synthetic":true}'::jsonb, 'PENDING_REVIEW', clock_timestamp()
  );

DO $fixture_contract$
BEGIN
  IF (SELECT COUNT(*) FROM "Org" WHERE "id" LIKE 'ci_org_%') <> 2
    OR (SELECT COUNT(*) FROM "User" WHERE "id" LIKE 'ci_user_%') <> 2
    OR (SELECT COUNT(*) FROM "Integration" WHERE "id" LIKE 'ci_integration_%') <> 2
    OR (SELECT COUNT(*) FROM "GraphRun" WHERE "id" LIKE 'ci_graph_%') <> 2
    OR (SELECT COUNT(*) FROM "OutreachArtifact" WHERE "id" LIKE 'ci_artifact_%') <> 2
  THEN
    RAISE EXCEPTION 'synthetic two-tenant fixture cardinality failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "User"
    WHERE "id" LIKE 'ci_user_%' AND "email" NOT LIKE '%@workforce.invalid'
  ) OR EXISTS (
    SELECT 1 FROM "OutreachArtifact"
    WHERE "id" LIKE 'ci_artifact_%'
      AND "recipientRef" NOT LIKE '%@workforce.invalid'
  ) THEN
    RAISE EXCEPTION 'synthetic fixture contains a non-reserved address';
  END IF;
END
$fixture_contract$;

COMMIT;
