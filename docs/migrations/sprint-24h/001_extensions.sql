-- 001_extensions.sql
-- Prereq for CITEXT columns in 002_sprint24h_canonical.sql.
-- Idempotent: CREATE EXTENSION IF NOT EXISTS is a no-op when already present.
-- apex-prod-db (Azure Flexible PG16) does NOT have citext as of 2026-05-31 probe.

CREATE EXTENSION IF NOT EXISTS citext;
