-- 001_citext.sql
-- Apply BEFORE any migrations that introduce @db.Citext columns.
CREATE EXTENSION IF NOT EXISTS citext;
