-- CreateEnum
CREATE TYPE "EmailDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "EmailIngestSource" AS ENUM ('APP_SEND', 'GMAIL_WATCH', 'BACKFILL', 'MANUAL');

-- CreateEnum
CREATE TYPE "ReplyIntent10" AS ENUM ('positive_interest', 'question_or_objection', 'referral', 'not_now', 'wrong_person', 'unsubscribe', 'negative_not_interested', 'auto_reply_ooo', 'bounce_or_ndr', 'spam_or_legal_threat');

-- CreateEnum
CREATE TYPE "SuppressionScope" AS ENUM ('GLOBAL', 'ORG', 'SENDER', 'THREAD');

-- CreateEnum
CREATE TYPE "SuppressionKind" AS ENUM ('UNSUBSCRIBE', 'COMPLAINT', 'HARD_BOUNCE', 'SPAM_TRAP', 'LEGAL', 'CRM_INACTIVE', 'MANUAL', 'THREAD_HUMAN_REPLY', 'OOO_COOLDOWN');

-- CreateEnum
CREATE TYPE "EnrichmentLicenseScope" AS ENUM ('INTERNAL_ONLY', 'RESEARCH_OK', 'SHAREABLE_AGGREGATE');

-- CreateEnum
CREATE TYPE "EvaluatorTargetType" AS ENUM ('ARTIFACT', 'REPLY', 'CLASSIFICATION', 'ENRICHMENT');

-- CreateEnum
CREATE TYPE "LlmRequestStatus" AS ENUM ('OK', 'ERROR', 'TIMEOUT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GoldenSetSource" AS ENUM ('PROMOTED_SENT', 'HUMAN_AUTHORED', 'ADVERSARIAL', 'REGRESSION_SEED');

