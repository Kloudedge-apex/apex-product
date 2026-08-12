-- Migration: terminal state for ambiguous outbound delivery (expand only)
-- Date drafted: 2026-08-12
-- Status: PENDING APPROVAL - do not deploy worker code that writes
--         DELIVERY_UNKNOWN until this enum value exists in the target DB.
--
-- DELIVERY_UNKNOWN means a live provider request may have succeeded, but the
-- worker cannot prove either acceptance or rejection (for example, response
-- loss after POST or a stale SENDING claim after process death). It is a
-- terminal, operator-reconciled state. The worker and reconcile sweep must
-- never automatically move it back to APPROVED or invoke the provider again.
--
-- This implements at-most-once *automatic dispatch* for ambiguous outcomes.
-- It does not and cannot guarantee exactly-once provider delivery: the
-- provider may have accepted a request whose response was lost. Reconcile the
-- provider's Sent mailbox/API before creating and separately approving any
-- replacement artifact.

BEGIN;

ALTER TYPE "OutreachArtifactStatus"
  ADD VALUE IF NOT EXISTS 'DELIVERY_UNKNOWN';

COMMIT;
