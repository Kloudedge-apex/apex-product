--
-- PostgreSQL database dump
--

\restrict HemsFArhVx2xRBf8pG5i2lyFnLM7Eu28odOwfpdF4jKdJQFBlmCfgfNSBTtQYj4

-- Dumped from database version 16.13
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "public";


--
-- Name: AgentStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."AgentStatus" AS ENUM (
    'ACTIVE',
    'PAUSED',
    'ERROR',
    'DEPLOYING'
);


--
-- Name: Department; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."Department" AS ENUM (
    'SALES',
    'MARKETING',
    'ENGINEERING',
    'FINANCE',
    'OPERATIONS',
    'HR',
    'LEGAL',
    'EXECUTIVE',
    'OTHER',
    'UNKNOWN'
);


--
-- Name: Domain; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."Domain" AS ENUM (
    'SALES',
    'MARKETING',
    'OPS'
);


--
-- Name: EmailSource; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."EmailSource" AS ENUM (
    'TEAM_PAGE',
    'GITHUB_COMMIT',
    'PATTERN_GUESS',
    'HUNTER',
    'SEC_FILING',
    'PRESS_RELEASE'
);


--
-- Name: GraphRunStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."GraphRunStatus" AS ENUM (
    'RUNNING',
    'AWAITING_APPROVAL',
    'COMPLETED',
    'FAILED',
    'CANCELLED'
);


--
-- Name: IntegrationStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."IntegrationStatus" AS ENUM (
    'PENDING',
    'CONNECTED',
    'ERROR',
    'REVOKED'
);


--
-- Name: LogLevel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."LogLevel" AS ENUM (
    'DEBUG',
    'INFO',
    'WARN',
    'ERROR'
);


--
-- Name: MeetingSource; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."MeetingSource" AS ENUM (
    'AGENT_PROPOSED',
    'HUMAN_LOGGED',
    'IMPORTED'
);


--
-- Name: MeetingStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."MeetingStatus" AS ENUM (
    'PROPOSED',
    'CONFIRMED',
    'CANCELLED',
    'COMPLETED',
    'NO_SHOW'
);


--
-- Name: OutreachArtifactStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."OutreachArtifactStatus" AS ENUM (
    'DRAFT',
    'PENDING_REVIEW',
    'APPROVED',
    'REJECTED',
    'SENT'
);


--
-- Name: OutreachChannel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."OutreachChannel" AS ENUM (
    'EMAIL',
    'LINKEDIN',
    'HUBSPOT_NOTE'
);


--
-- Name: Plan; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."Plan" AS ENUM (
    'TRIAL',
    'STARTER',
    'GROWTH',
    'ENTERPRISE'
);


--
-- Name: RunStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."RunStatus" AS ENUM (
    'QUEUED',
    'RUNNING',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'PENDING_APPROVAL'
);


--
-- Name: RunStepType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."RunStepType" AS ENUM (
    'LLM_CALL',
    'TOOL_CALL',
    'TOOL_RESULT',
    'ERROR',
    'FINAL_OUTPUT'
);


--
-- Name: ScrapeStage; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."ScrapeStage" AS ENUM (
    'COMPANY_DISCOVERY',
    'PEOPLE_DISCOVERY',
    'IDENTITY_RESOLUTION',
    'CONTACT_ENRICHMENT',
    'SCORING'
);


--
-- Name: ScrapeStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."ScrapeStatus" AS ENUM (
    'QUEUED',
    'RUNNING',
    'COMPLETED',
    'FAILED'
);


--
-- Name: Seniority; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."Seniority" AS ENUM (
    'C_LEVEL',
    'VP',
    'DIRECTOR',
    'MANAGER',
    'IC',
    'UNKNOWN'
);


--
-- Name: UserRole; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."UserRole" AS ENUM (
    'OWNER',
    'ADMIN',
    'MEMBER'
);


--
-- Name: VerificationResult; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."VerificationResult" AS ENUM (
    'VALID',
    'INVALID',
    'CATCH_ALL',
    'UNKNOWN'
);


--
-- Name: WorkflowRunStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."WorkflowRunStatus" AS ENUM (
    'RUNNING',
    'AWAITING_APPROVAL',
    'COMPLETED',
    'FAILED',
    'CANCELLED'
);


--
-- Name: evidence_event_block_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."evidence_event_block_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  RAISE EXCEPTION 'evidence_event is append-only';
END;
$$;


SET default_table_access_method = "heap";

--
-- Name: Agent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."Agent" (
    "id" "text" NOT NULL,
    "orgId" "text" NOT NULL,
    "templateId" "text" NOT NULL,
    "name" "text" NOT NULL,
    "domain" "public"."Domain" NOT NULL,
    "config" "jsonb" NOT NULL,
    "schedule" "text",
    "status" "public"."AgentStatus" DEFAULT 'PAUSED'::"public"."AgentStatus" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: AgentLog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."AgentLog" (
    "id" "text" NOT NULL,
    "runId" "text" NOT NULL,
    "level" "public"."LogLevel" NOT NULL,
    "message" "text" NOT NULL,
    "metadata" "jsonb",
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: AgentMemory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."AgentMemory" (
    "id" "text" NOT NULL,
    "agentId" "text" NOT NULL,
    "key" "text" NOT NULL,
    "value" "jsonb" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: AgentMemoryEmbedding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."AgentMemoryEmbedding" (
    "id" "text" NOT NULL,
    "agentId" "text" NOT NULL,
    "content" "text" NOT NULL,
    "embedding" "public"."vector"(3072) NOT NULL,
    "metadata" "jsonb",
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: AgentRun; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."AgentRun" (
    "id" "text" NOT NULL,
    "agentId" "text" NOT NULL,
    "orgId" "text" NOT NULL,
    "startedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completedAt" timestamp(3) without time zone,
    "status" "public"."RunStatus" DEFAULT 'RUNNING'::"public"."RunStatus" NOT NULL,
    "result" "jsonb",
    "tokensUsed" integer DEFAULT 0 NOT NULL,
    "cost" double precision DEFAULT 0 NOT NULL,
    "requiresApproval" boolean DEFAULT false NOT NULL,
    "approvedAt" timestamp(3) without time zone,
    "approvedBy" "text"
);


--
-- Name: AgentTemplate; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."AgentTemplate" (
    "id" "text" NOT NULL,
    "domain" "public"."Domain" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text" NOT NULL,
    "defaultConfig" "jsonb" NOT NULL,
    "requiredIntegrations" "text"[],
    "systemPrompt" "text",
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: Company; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."Company" (
    "id" "text" NOT NULL,
    "orgId" "text",
    "domain" "text" NOT NULL,
    "name" "text" NOT NULL,
    "industry" "text",
    "employeeRange" "text",
    "country" "text",
    "city" "text",
    "registryId" "text",
    "registrySource" "text",
    "fundingStage" "text",
    "techStack" "text"[],
    "atsProvider" "text",
    "atsSlug" "text",
    "teamPageUrl" "text",
    "raw" "jsonb",
    "confidence" double precision DEFAULT 0 NOT NULL,
    "intentScore" integer DEFAULT 0 NOT NULL,
    "intentSignals" "text"[],
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: EmailCandidate; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."EmailCandidate" (
    "id" "text" NOT NULL,
    "personId" "text" NOT NULL,
    "email" "text" NOT NULL,
    "pattern" "text",
    "source" "public"."EmailSource" NOT NULL,
    "verified" boolean DEFAULT false NOT NULL,
    "verificationResult" "public"."VerificationResult" DEFAULT 'UNKNOWN'::"public"."VerificationResult" NOT NULL,
    "confidence" double precision DEFAULT 0 NOT NULL,
    "verifiedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: GraphCheckpoint; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."GraphCheckpoint" (
    "threadId" "text" NOT NULL,
    "checkpointNamespace" "text" DEFAULT ''::"text" NOT NULL,
    "checkpointId" "text" NOT NULL,
    "parentCheckpointId" "text",
    "type" "text",
    "checkpoint" "bytea" NOT NULL,
    "metadata" "jsonb",
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: GraphCheckpointWrite; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."GraphCheckpointWrite" (
    "threadId" "text" NOT NULL,
    "checkpointNamespace" "text" DEFAULT ''::"text" NOT NULL,
    "checkpointId" "text" NOT NULL,
    "taskId" "text" NOT NULL,
    "idx" integer NOT NULL,
    "channel" "text" NOT NULL,
    "type" "text",
    "value" "bytea" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: GraphRun; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."GraphRun" (
    "id" "text" NOT NULL,
    "orgId" "text" NOT NULL,
    "threadId" "text" NOT NULL,
    "graphName" "text" NOT NULL,
    "status" "public"."GraphRunStatus" DEFAULT 'RUNNING'::"public"."GraphRunStatus" NOT NULL,
    "currentNode" "text",
    "state" "jsonb",
    "needsApproval" boolean DEFAULT false NOT NULL,
    "approvedAt" timestamp(3) without time zone,
    "approvedBy" "text",
    "error" "text",
    "startedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completedAt" timestamp(3) without time zone,
    "langsmithRootRunId" "text"
);


--
-- Name: IcpProfile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."IcpProfile" (
    "id" "text" NOT NULL,
    "orgId" "text" NOT NULL,
    "name" "text" NOT NULL,
    "targetTitles" "text"[],
    "targetIndustries" "text"[],
    "targetGeos" "text"[],
    "minEmployees" integer,
    "maxEmployees" integer,
    "techStackSignals" "text"[],
    "intentKeywords" "text"[],
    "seedDomains" "text"[],
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "lastRunAt" timestamp(3) without time zone,
    "scheduleEnabled" boolean DEFAULT false NOT NULL,
    "scheduleInterval" integer DEFAULT 24 NOT NULL
);


--
-- Name: Integration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."Integration" (
    "id" "text" NOT NULL,
    "orgId" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "credentials" "jsonb" NOT NULL,
    "status" "public"."IntegrationStatus" DEFAULT 'PENDING'::"public"."IntegrationStatus" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "encryptedCredentials" "text",
    "lastErrorAt" timestamp(3) without time zone,
    "lastErrorMessage" "text",
    "scopes" "text"[],
    "lastSyncAt" timestamp(3) without time zone,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: LeadScore; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."LeadScore" (
    "id" "text" NOT NULL,
    "orgId" "text" NOT NULL,
    "personId" "text" NOT NULL,
    "score" integer DEFAULT 0 NOT NULL,
    "breakdown" "jsonb" NOT NULL,
    "qualifiedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: MeetingLedger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."MeetingLedger" (
    "id" "text" NOT NULL,
    "orgId" "text" NOT NULL,
    "outreachArtifactId" "text",
    "personId" "text",
    "title" "text" NOT NULL,
    "description" "text",
    "scheduledFor" timestamp(3) without time zone NOT NULL,
    "durationMinutes" integer DEFAULT 30 NOT NULL,
    "attendeeEmails" "text"[],
    "notes" "text",
    "status" "public"."MeetingStatus" DEFAULT 'PROPOSED'::"public"."MeetingStatus" NOT NULL,
    "source" "public"."MeetingSource" DEFAULT 'AGENT_PROPOSED'::"public"."MeetingSource" NOT NULL,
    "createdBy" "text",
    "confirmedBy" "text",
    "confirmedAt" timestamp(3) without time zone,
    "cancelledReason" "text",
    "cancelledAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: Org; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."Org" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "plan" "public"."Plan" DEFAULT 'TRIAL'::"public"."Plan" NOT NULL,
    "trialEndsAt" timestamp(3) without time zone,
    "billingId" "text",
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "website" "text"
);


--
-- Name: OutreachArtifact; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."OutreachArtifact" (
    "id" "text" NOT NULL,
    "orgId" "text" NOT NULL,
    "graphRunId" "text",
    "toolName" "text" NOT NULL,
    "channel" "public"."OutreachChannel" NOT NULL,
    "recipientRef" "text",
    "subject" "text",
    "bodyText" "text",
    "bodyHtml" "text",
    "payload" "jsonb" NOT NULL,
    "status" "public"."OutreachArtifactStatus" DEFAULT 'PENDING_REVIEW'::"public"."OutreachArtifactStatus" NOT NULL,
    "reviewerNote" "text",
    "reviewedBy" "text",
    "reviewedAt" timestamp(3) without time zone,
    "sentAt" timestamp(3) without time zone,
    "sendReceiptId" "text",
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: PatternStore; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."PatternStore" (
    "id" "text" NOT NULL,
    "domain" "text" NOT NULL,
    "patterns" "jsonb" NOT NULL,
    "sampleSize" integer DEFAULT 0 NOT NULL,
    "lastUpdated" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: Person; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."Person" (
    "id" "text" NOT NULL,
    "companyId" "text" NOT NULL,
    "firstName" "text" NOT NULL,
    "lastName" "text" NOT NULL,
    "title" "text",
    "seniority" "public"."Seniority" DEFAULT 'UNKNOWN'::"public"."Seniority" NOT NULL,
    "department" "public"."Department" DEFAULT 'UNKNOWN'::"public"."Department" NOT NULL,
    "linkedinSlug" "text",
    "linkedinUrl" "text",
    "githubHandle" "text",
    "twitterHandle" "text",
    "location" "text",
    "bio" "text",
    "raw" "jsonb",
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: RunStep; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."RunStep" (
    "id" "text" NOT NULL,
    "runId" "text" NOT NULL,
    "stepIndex" integer NOT NULL,
    "toolName" "text",
    "input" "jsonb",
    "output" "jsonb",
    "durationMs" integer DEFAULT 0 NOT NULL,
    "tokenCount" integer DEFAULT 0 NOT NULL,
    "error" "text",
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "type" "public"."RunStepType" NOT NULL
);


--
-- Name: ScrapeJob; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ScrapeJob" (
    "id" "text" NOT NULL,
    "orgId" "text" NOT NULL,
    "icpProfileId" "text" NOT NULL,
    "stage" "public"."ScrapeStage" NOT NULL,
    "status" "public"."ScrapeStatus" DEFAULT 'QUEUED'::"public"."ScrapeStatus" NOT NULL,
    "source" "text",
    "totalItems" integer DEFAULT 0 NOT NULL,
    "processedItems" integer DEFAULT 0 NOT NULL,
    "failedItems" integer DEFAULT 0 NOT NULL,
    "progress" double precision DEFAULT 0 NOT NULL,
    "metadata" "jsonb",
    "startedAt" timestamp(3) without time zone,
    "completedAt" timestamp(3) without time zone,
    "error" "text",
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: ToolCallReceipt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ToolCallReceipt" (
    "id" "text" NOT NULL,
    "runId" "text" NOT NULL,
    "orgId" "text" NOT NULL,
    "toolName" "text" NOT NULL,
    "inputHash" "text" NOT NULL,
    "output" "jsonb" NOT NULL,
    "success" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: User; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."User" (
    "id" "text" NOT NULL,
    "orgId" "text" NOT NULL,
    "email" "text" NOT NULL,
    "name" "text",
    "role" "public"."UserRole" DEFAULT 'MEMBER'::"public"."UserRole" NOT NULL,
    "clerkId" "text",
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "apiKey" "text",
    "passwordHash" "text"
);


--
-- Name: WorkflowRun; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."WorkflowRun" (
    "id" "text" NOT NULL,
    "orgId" "text" NOT NULL,
    "templateId" "text" NOT NULL,
    "graphRunId" "text",
    "input" "jsonb" NOT NULL,
    "status" "public"."WorkflowRunStatus" DEFAULT 'RUNNING'::"public"."WorkflowRunStatus" NOT NULL,
    "output" "jsonb",
    "error" "text",
    "startedBy" "text",
    "startedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completedAt" timestamp(3) without time zone
);


--
-- Name: WorkflowTemplate; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."WorkflowTemplate" (
    "id" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "graphName" "text" NOT NULL,
    "config" "jsonb" NOT NULL,
    "requiresApproval" boolean DEFAULT true NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: evidence_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."evidence_event" (
    "id" "text" NOT NULL,
    "orgId" "text" NOT NULL,
    "runId" "text",
    "traceId" "text",
    "kind" "text" NOT NULL,
    "refType" "text" NOT NULL,
    "refId" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: AgentLog AgentLog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."AgentLog"
    ADD CONSTRAINT "AgentLog_pkey" PRIMARY KEY ("id");


--
-- Name: AgentMemoryEmbedding AgentMemoryEmbedding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."AgentMemoryEmbedding"
    ADD CONSTRAINT "AgentMemoryEmbedding_pkey" PRIMARY KEY ("id");


--
-- Name: AgentMemory AgentMemory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."AgentMemory"
    ADD CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("id");


--
-- Name: AgentRun AgentRun_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."AgentRun"
    ADD CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id");


--
-- Name: AgentTemplate AgentTemplate_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."AgentTemplate"
    ADD CONSTRAINT "AgentTemplate_pkey" PRIMARY KEY ("id");


--
-- Name: Agent Agent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."Agent"
    ADD CONSTRAINT "Agent_pkey" PRIMARY KEY ("id");


--
-- Name: Company Company_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."Company"
    ADD CONSTRAINT "Company_pkey" PRIMARY KEY ("id");


--
-- Name: EmailCandidate EmailCandidate_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."EmailCandidate"
    ADD CONSTRAINT "EmailCandidate_pkey" PRIMARY KEY ("id");


--
-- Name: GraphCheckpointWrite GraphCheckpointWrite_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."GraphCheckpointWrite"
    ADD CONSTRAINT "GraphCheckpointWrite_pkey" PRIMARY KEY ("threadId", "checkpointNamespace", "checkpointId", "taskId", "idx");


--
-- Name: GraphCheckpoint GraphCheckpoint_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."GraphCheckpoint"
    ADD CONSTRAINT "GraphCheckpoint_pkey" PRIMARY KEY ("threadId", "checkpointNamespace", "checkpointId");


--
-- Name: GraphRun GraphRun_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."GraphRun"
    ADD CONSTRAINT "GraphRun_pkey" PRIMARY KEY ("id");


--
-- Name: IcpProfile IcpProfile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."IcpProfile"
    ADD CONSTRAINT "IcpProfile_pkey" PRIMARY KEY ("id");


--
-- Name: Integration Integration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."Integration"
    ADD CONSTRAINT "Integration_pkey" PRIMARY KEY ("id");


--
-- Name: LeadScore LeadScore_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."LeadScore"
    ADD CONSTRAINT "LeadScore_pkey" PRIMARY KEY ("id");


--
-- Name: MeetingLedger MeetingLedger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."MeetingLedger"
    ADD CONSTRAINT "MeetingLedger_pkey" PRIMARY KEY ("id");


--
-- Name: Org Org_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."Org"
    ADD CONSTRAINT "Org_pkey" PRIMARY KEY ("id");


--
-- Name: OutreachArtifact OutreachArtifact_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."OutreachArtifact"
    ADD CONSTRAINT "OutreachArtifact_pkey" PRIMARY KEY ("id");


--
-- Name: PatternStore PatternStore_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."PatternStore"
    ADD CONSTRAINT "PatternStore_pkey" PRIMARY KEY ("id");


--
-- Name: Person Person_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."Person"
    ADD CONSTRAINT "Person_pkey" PRIMARY KEY ("id");


--
-- Name: RunStep RunStep_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."RunStep"
    ADD CONSTRAINT "RunStep_pkey" PRIMARY KEY ("id");


--
-- Name: ScrapeJob ScrapeJob_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ScrapeJob"
    ADD CONSTRAINT "ScrapeJob_pkey" PRIMARY KEY ("id");


--
-- Name: ToolCallReceipt ToolCallReceipt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ToolCallReceipt"
    ADD CONSTRAINT "ToolCallReceipt_pkey" PRIMARY KEY ("id");


--
-- Name: User User_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."User"
    ADD CONSTRAINT "User_pkey" PRIMARY KEY ("id");


--
-- Name: WorkflowRun WorkflowRun_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."WorkflowRun"
    ADD CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id");


--
-- Name: WorkflowTemplate WorkflowTemplate_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."WorkflowTemplate"
    ADD CONSTRAINT "WorkflowTemplate_pkey" PRIMARY KEY ("id");


--
-- Name: evidence_event evidence_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."evidence_event"
    ADD CONSTRAINT "evidence_event_pkey" PRIMARY KEY ("id");


--
-- Name: AgentLog_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentLog_createdAt_idx" ON "public"."AgentLog" USING "btree" ("createdAt");


--
-- Name: AgentLog_runId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentLog_runId_idx" ON "public"."AgentLog" USING "btree" ("runId");


--
-- Name: AgentLog_runId_level_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentLog_runId_level_idx" ON "public"."AgentLog" USING "btree" ("runId", "level");


--
-- Name: AgentMemoryEmbedding_agentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentMemoryEmbedding_agentId_idx" ON "public"."AgentMemoryEmbedding" USING "btree" ("agentId");


--
-- Name: AgentMemory_agentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentMemory_agentId_idx" ON "public"."AgentMemory" USING "btree" ("agentId");


--
-- Name: AgentMemory_agentId_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "AgentMemory_agentId_key_key" ON "public"."AgentMemory" USING "btree" ("agentId", "key");


--
-- Name: AgentRun_agentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentRun_agentId_idx" ON "public"."AgentRun" USING "btree" ("agentId");


--
-- Name: AgentRun_agentId_startedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentRun_agentId_startedAt_idx" ON "public"."AgentRun" USING "btree" ("agentId", "startedAt");


--
-- Name: AgentRun_orgId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentRun_orgId_idx" ON "public"."AgentRun" USING "btree" ("orgId");


--
-- Name: AgentRun_orgId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentRun_orgId_status_idx" ON "public"."AgentRun" USING "btree" ("orgId", "status");


--
-- Name: AgentRun_startedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentRun_startedAt_idx" ON "public"."AgentRun" USING "btree" ("startedAt");


--
-- Name: AgentTemplate_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentTemplate_domain_idx" ON "public"."AgentTemplate" USING "btree" ("domain");


--
-- Name: AgentTemplate_isActive_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentTemplate_isActive_idx" ON "public"."AgentTemplate" USING "btree" ("isActive");


--
-- Name: AgentTemplate_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "AgentTemplate_name_key" ON "public"."AgentTemplate" USING "btree" ("name");


--
-- Name: Agent_orgId_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Agent_orgId_domain_idx" ON "public"."Agent" USING "btree" ("orgId", "domain");


--
-- Name: Agent_orgId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Agent_orgId_idx" ON "public"."Agent" USING "btree" ("orgId");


--
-- Name: Agent_orgId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Agent_orgId_status_idx" ON "public"."Agent" USING "btree" ("orgId", "status");


--
-- Name: Agent_templateId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Agent_templateId_idx" ON "public"."Agent" USING "btree" ("templateId");


--
-- Name: Company_country_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Company_country_idx" ON "public"."Company" USING "btree" ("country");


--
-- Name: Company_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Company_domain_idx" ON "public"."Company" USING "btree" ("domain");


--
-- Name: Company_industry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Company_industry_idx" ON "public"."Company" USING "btree" ("industry");


--
-- Name: Company_orgId_domain_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Company_orgId_domain_key" ON "public"."Company" USING "btree" ("orgId", "domain");


--
-- Name: EmailCandidate_personId_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "EmailCandidate_personId_email_key" ON "public"."EmailCandidate" USING "btree" ("personId", "email");


--
-- Name: EmailCandidate_personId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "EmailCandidate_personId_idx" ON "public"."EmailCandidate" USING "btree" ("personId");


--
-- Name: GraphCheckpointWrite_threadId_checkpointNamespace_checkpoin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GraphCheckpointWrite_threadId_checkpointNamespace_checkpoin_idx" ON "public"."GraphCheckpointWrite" USING "btree" ("threadId", "checkpointNamespace", "checkpointId");


--
-- Name: GraphCheckpointWrite_threadId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GraphCheckpointWrite_threadId_idx" ON "public"."GraphCheckpointWrite" USING "btree" ("threadId");


--
-- Name: GraphCheckpoint_threadId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GraphCheckpoint_threadId_idx" ON "public"."GraphCheckpoint" USING "btree" ("threadId");


--
-- Name: GraphRun_orgId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GraphRun_orgId_idx" ON "public"."GraphRun" USING "btree" ("orgId");


--
-- Name: GraphRun_orgId_startedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GraphRun_orgId_startedAt_idx" ON "public"."GraphRun" USING "btree" ("orgId", "startedAt");


--
-- Name: GraphRun_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GraphRun_status_idx" ON "public"."GraphRun" USING "btree" ("status");


--
-- Name: GraphRun_threadId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "GraphRun_threadId_key" ON "public"."GraphRun" USING "btree" ("threadId");


--
-- Name: IcpProfile_orgId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IcpProfile_orgId_idx" ON "public"."IcpProfile" USING "btree" ("orgId");


--
-- Name: IcpProfile_scheduleEnabled_lastRunAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IcpProfile_scheduleEnabled_lastRunAt_idx" ON "public"."IcpProfile" USING "btree" ("scheduleEnabled", "lastRunAt");


--
-- Name: Integration_orgId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Integration_orgId_idx" ON "public"."Integration" USING "btree" ("orgId");


--
-- Name: Integration_orgId_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Integration_orgId_provider_idx" ON "public"."Integration" USING "btree" ("orgId", "provider");


--
-- Name: Integration_orgId_provider_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Integration_orgId_provider_key" ON "public"."Integration" USING "btree" ("orgId", "provider");


--
-- Name: Integration_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Integration_status_idx" ON "public"."Integration" USING "btree" ("status");


--
-- Name: LeadScore_orgId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "LeadScore_orgId_idx" ON "public"."LeadScore" USING "btree" ("orgId");


--
-- Name: LeadScore_orgId_personId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "LeadScore_orgId_personId_key" ON "public"."LeadScore" USING "btree" ("orgId", "personId");


--
-- Name: LeadScore_personId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "LeadScore_personId_idx" ON "public"."LeadScore" USING "btree" ("personId");


--
-- Name: MeetingLedger_orgId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MeetingLedger_orgId_idx" ON "public"."MeetingLedger" USING "btree" ("orgId");


--
-- Name: MeetingLedger_orgId_scheduledFor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MeetingLedger_orgId_scheduledFor_idx" ON "public"."MeetingLedger" USING "btree" ("orgId", "scheduledFor");


--
-- Name: MeetingLedger_orgId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MeetingLedger_orgId_status_idx" ON "public"."MeetingLedger" USING "btree" ("orgId", "status");


--
-- Name: MeetingLedger_outreachArtifactId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MeetingLedger_outreachArtifactId_idx" ON "public"."MeetingLedger" USING "btree" ("outreachArtifactId");


--
-- Name: MeetingLedger_personId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MeetingLedger_personId_idx" ON "public"."MeetingLedger" USING "btree" ("personId");


--
-- Name: Org_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Org_slug_idx" ON "public"."Org" USING "btree" ("slug");


--
-- Name: Org_slug_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Org_slug_key" ON "public"."Org" USING "btree" ("slug");


--
-- Name: OutreachArtifact_graphRunId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "OutreachArtifact_graphRunId_idx" ON "public"."OutreachArtifact" USING "btree" ("graphRunId");


--
-- Name: OutreachArtifact_orgId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "OutreachArtifact_orgId_createdAt_idx" ON "public"."OutreachArtifact" USING "btree" ("orgId", "createdAt");


--
-- Name: OutreachArtifact_orgId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "OutreachArtifact_orgId_idx" ON "public"."OutreachArtifact" USING "btree" ("orgId");


--
-- Name: OutreachArtifact_orgId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "OutreachArtifact_orgId_status_idx" ON "public"."OutreachArtifact" USING "btree" ("orgId", "status");


--
-- Name: PatternStore_domain_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PatternStore_domain_key" ON "public"."PatternStore" USING "btree" ("domain");


--
-- Name: Person_companyId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Person_companyId_idx" ON "public"."Person" USING "btree" ("companyId");


--
-- Name: Person_linkedinSlug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Person_linkedinSlug_idx" ON "public"."Person" USING "btree" ("linkedinSlug");


--
-- Name: Person_seniority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Person_seniority_idx" ON "public"."Person" USING "btree" ("seniority");


--
-- Name: RunStep_runId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "RunStep_runId_idx" ON "public"."RunStep" USING "btree" ("runId");


--
-- Name: RunStep_runId_stepIndex_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "RunStep_runId_stepIndex_idx" ON "public"."RunStep" USING "btree" ("runId", "stepIndex");


--
-- Name: RunStep_runId_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "RunStep_runId_type_idx" ON "public"."RunStep" USING "btree" ("runId", "type");


--
-- Name: ScrapeJob_orgId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ScrapeJob_orgId_idx" ON "public"."ScrapeJob" USING "btree" ("orgId");


--
-- Name: ScrapeJob_stage_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ScrapeJob_stage_idx" ON "public"."ScrapeJob" USING "btree" ("stage");


--
-- Name: ScrapeJob_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ScrapeJob_status_idx" ON "public"."ScrapeJob" USING "btree" ("status");


--
-- Name: ToolCallReceipt_orgId_toolName_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ToolCallReceipt_orgId_toolName_idx" ON "public"."ToolCallReceipt" USING "btree" ("orgId", "toolName");


--
-- Name: ToolCallReceipt_runId_toolName_inputHash_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ToolCallReceipt_runId_toolName_inputHash_key" ON "public"."ToolCallReceipt" USING "btree" ("runId", "toolName", "inputHash");


--
-- Name: User_apiKey_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "User_apiKey_idx" ON "public"."User" USING "btree" ("apiKey");


--
-- Name: User_apiKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "User_apiKey_key" ON "public"."User" USING "btree" ("apiKey");


--
-- Name: User_clerkId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "User_clerkId_idx" ON "public"."User" USING "btree" ("clerkId");


--
-- Name: User_clerkId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "User_clerkId_key" ON "public"."User" USING "btree" ("clerkId");


--
-- Name: User_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "User_email_key" ON "public"."User" USING "btree" ("email");


--
-- Name: User_orgId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "User_orgId_idx" ON "public"."User" USING "btree" ("orgId");


--
-- Name: WorkflowRun_graphRunId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "WorkflowRun_graphRunId_key" ON "public"."WorkflowRun" USING "btree" ("graphRunId");


--
-- Name: WorkflowRun_orgId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "WorkflowRun_orgId_idx" ON "public"."WorkflowRun" USING "btree" ("orgId");


--
-- Name: WorkflowRun_orgId_startedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "WorkflowRun_orgId_startedAt_idx" ON "public"."WorkflowRun" USING "btree" ("orgId", "startedAt");


--
-- Name: WorkflowRun_orgId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "WorkflowRun_orgId_status_idx" ON "public"."WorkflowRun" USING "btree" ("orgId", "status");


--
-- Name: WorkflowRun_templateId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "WorkflowRun_templateId_idx" ON "public"."WorkflowRun" USING "btree" ("templateId");


--
-- Name: WorkflowTemplate_isActive_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "WorkflowTemplate_isActive_idx" ON "public"."WorkflowTemplate" USING "btree" ("isActive");


--
-- Name: WorkflowTemplate_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "WorkflowTemplate_slug_idx" ON "public"."WorkflowTemplate" USING "btree" ("slug");


--
-- Name: WorkflowTemplate_slug_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "WorkflowTemplate_slug_key" ON "public"."WorkflowTemplate" USING "btree" ("slug");


--
-- Name: evidence_event_orgId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "evidence_event_orgId_createdAt_idx" ON "public"."evidence_event" USING "btree" ("orgId", "createdAt");


--
-- Name: evidence_event_orgId_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "evidence_event_orgId_kind_idx" ON "public"."evidence_event" USING "btree" ("orgId", "kind");


--
-- Name: evidence_event_runId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "evidence_event_runId_idx" ON "public"."evidence_event" USING "btree" ("runId");


--
-- Name: evidence_event evidence_event_no_update_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "evidence_event_no_update_delete" BEFORE DELETE OR UPDATE ON "public"."evidence_event" FOR EACH ROW EXECUTE FUNCTION "public"."evidence_event_block_mutation"();


--
-- Name: AgentLog AgentLog_runId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."AgentLog"
    ADD CONSTRAINT "AgentLog_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."AgentRun"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: AgentMemoryEmbedding AgentMemoryEmbedding_agentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."AgentMemoryEmbedding"
    ADD CONSTRAINT "AgentMemoryEmbedding_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: AgentMemory AgentMemory_agentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."AgentMemory"
    ADD CONSTRAINT "AgentMemory_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: AgentRun AgentRun_agentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."AgentRun"
    ADD CONSTRAINT "AgentRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: AgentRun AgentRun_orgId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."AgentRun"
    ADD CONSTRAINT "AgentRun_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."Org"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Agent Agent_orgId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."Agent"
    ADD CONSTRAINT "Agent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."Org"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Agent Agent_templateId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."Agent"
    ADD CONSTRAINT "Agent_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "public"."AgentTemplate"("id") ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: Company Company_orgId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."Company"
    ADD CONSTRAINT "Company_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."Org"("id") ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: EmailCandidate EmailCandidate_personId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."EmailCandidate"
    ADD CONSTRAINT "EmailCandidate_personId_fkey" FOREIGN KEY ("personId") REFERENCES "public"."Person"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: GraphRun GraphRun_orgId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."GraphRun"
    ADD CONSTRAINT "GraphRun_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."Org"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: IcpProfile IcpProfile_orgId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."IcpProfile"
    ADD CONSTRAINT "IcpProfile_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."Org"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Integration Integration_orgId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."Integration"
    ADD CONSTRAINT "Integration_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."Org"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: LeadScore LeadScore_orgId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."LeadScore"
    ADD CONSTRAINT "LeadScore_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."Org"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: LeadScore LeadScore_personId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."LeadScore"
    ADD CONSTRAINT "LeadScore_personId_fkey" FOREIGN KEY ("personId") REFERENCES "public"."Person"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: MeetingLedger MeetingLedger_orgId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."MeetingLedger"
    ADD CONSTRAINT "MeetingLedger_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."Org"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: OutreachArtifact OutreachArtifact_graphRunId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."OutreachArtifact"
    ADD CONSTRAINT "OutreachArtifact_graphRunId_fkey" FOREIGN KEY ("graphRunId") REFERENCES "public"."GraphRun"("id") ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: OutreachArtifact OutreachArtifact_orgId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."OutreachArtifact"
    ADD CONSTRAINT "OutreachArtifact_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."Org"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Person Person_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."Person"
    ADD CONSTRAINT "Person_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: RunStep RunStep_runId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."RunStep"
    ADD CONSTRAINT "RunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."AgentRun"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ScrapeJob ScrapeJob_icpProfileId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ScrapeJob"
    ADD CONSTRAINT "ScrapeJob_icpProfileId_fkey" FOREIGN KEY ("icpProfileId") REFERENCES "public"."IcpProfile"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ScrapeJob ScrapeJob_orgId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ScrapeJob"
    ADD CONSTRAINT "ScrapeJob_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."Org"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ToolCallReceipt ToolCallReceipt_runId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ToolCallReceipt"
    ADD CONSTRAINT "ToolCallReceipt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."AgentRun"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: User User_orgId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."User"
    ADD CONSTRAINT "User_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."Org"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: WorkflowRun WorkflowRun_orgId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."WorkflowRun"
    ADD CONSTRAINT "WorkflowRun_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."Org"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: WorkflowRun WorkflowRun_templateId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."WorkflowRun"
    ADD CONSTRAINT "WorkflowRun_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "public"."WorkflowTemplate"("id") ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: evidence_event evidence_event_orgId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."evidence_event"
    ADD CONSTRAINT "evidence_event_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."Org"("id") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict HemsFArhVx2xRBf8pG5i2lyFnLM7Eu28odOwfpdF4jKdJQFBlmCfgfNSBTtQYj4

