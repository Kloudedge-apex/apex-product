-- 011_suppression_partial_indexes.down.sql
DROP INDEX CONCURRENTLY IF EXISTS idx_suppression_global_email;
DROP INDEX CONCURRENTLY IF EXISTS idx_suppression_global_domain;
DROP INDEX CONCURRENTLY IF EXISTS uniq_suppression_email;
DROP INDEX CONCURRENTLY IF EXISTS uniq_suppression_domain;
DROP INDEX CONCURRENTLY IF EXISTS uniq_suppression_thread;
