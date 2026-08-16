#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CONTRACT_PATH = fileURLToPath(new URL(
  "../deploy/github-production-governance-v1/governance-contract.json",
  import.meta.url,
));
const CONTRACT_SOURCE = readFileSync(CONTRACT_PATH, "utf8");

export const PRODUCTION_GITHUB_GOVERNANCE_CONTRACT = Object.freeze(
  JSON.parse(CONTRACT_SOURCE),
);
export const PRODUCTION_GITHUB_GOVERNANCE_CONTRACT_SHA256 =
  `sha256:${createHash("sha256").update(CONTRACT_SOURCE).digest("hex")}`;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) =>
      [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function apiResult(value) {
  return { ok: true, value };
}

function apiError(reason, status = null) {
  return { ok: false, reason, status };
}

function allowedEndpoints(contract = PRODUCTION_GITHUB_GOVERNANCE_CONTRACT) {
  const endpoints = new Set(["user"]);
  for (const repository of Object.values(contract.repositories)) {
    const prefix = `repos/${repository.fullName}`;
    endpoints.add(prefix);
    endpoints.add(`${prefix}/actions/permissions`);
    endpoints.add(`${prefix}/actions/permissions/workflow`);
    endpoints.add(`${prefix}/actions/permissions/selected-actions`);
    for (const branch of Object.keys(repository.branches)) {
      const encodedBranch = encodeURIComponent(branch);
      endpoints.add(`${prefix}/branches/${encodedBranch}`);
      endpoints.add(`${prefix}/branches/${encodedBranch}/protection`);
    }
    for (const environment of repository.environments) {
      endpoints.add(`${prefix}/environments/${encodeURIComponent(environment)}`);
    }
  }
  return endpoints;
}

export function assertReadOnlyGitHubAuditCommand(
  args,
  contract = PRODUCTION_GITHUB_GOVERNANCE_CONTRACT,
) {
  if (!Array.isArray(args) || args.length !== 4 ||
    args[0] !== "api" || args[1] !== "--method" || args[2] !== "GET" ||
    typeof args[3] !== "string" || !allowedEndpoints(contract).has(args[3])) {
    throw new Error("GitHub command is outside the read-only governance audit allowlist");
  }
  return true;
}

function sanitizeGhError(result) {
  let response = null;
  for (const source of [result.stdout, result.stderr]) {
    const trimmed = String(source ?? "").trim();
    if (!trimmed) continue;
    try {
      response = JSON.parse(trimmed);
      break;
    } catch {
      const jsonLine = trimmed.split("\n").find((line) => line.trim().startsWith("{"));
      if (jsonLine) {
        try {
          response = JSON.parse(jsonLine);
          break;
        } catch {
          // The report retains only the classified error below.
        }
      }
    }
  }
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const statusMatch = combined.match(/HTTP(?:\/\S+)?\s+(\d{3})|HTTP\s+(\d{3})/u);
  const status = Number(response?.status ?? statusMatch?.[1] ?? statusMatch?.[2]) || null;
  const message = String(response?.message ?? combined);
  if (status === 403 &&
    /Upgrade to GitHub Pro or make this repository public/u.test(message)) {
    return apiError("github-plan-insufficient", 403);
  }
  if (status === 404) return apiError("resource-missing", 404);
  if (status === 401 || status === 403) return apiError("github-access-denied", status);
  return apiError("github-api-read-failed", status);
}

function readGitHub(endpoint) {
  const args = ["api", "--method", "GET", endpoint];
  assertReadOnlyGitHubAuditCommand(args);
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) return apiError("github-cli-unavailable");
  if (result.status !== 0) return sanitizeGhError(result);
  try {
    return apiResult(JSON.parse(result.stdout));
  } catch {
    return apiError("github-api-invalid-json");
  }
}

export function collectProductionGitHubGovernanceSnapshot(
  contract = PRODUCTION_GITHUB_GOVERNANCE_CONTRACT,
) {
  const repositories = {};
  for (const [repositoryKey, repository] of Object.entries(contract.repositories)) {
    const prefix = `repos/${repository.fullName}`;
    const branches = {};
    for (const branch of Object.keys(repository.branches)) {
      const encodedBranch = encodeURIComponent(branch);
      branches[branch] = {
        metadata: readGitHub(`${prefix}/branches/${encodedBranch}`),
        protection: readGitHub(`${prefix}/branches/${encodedBranch}/protection`),
      };
    }
    const environments = {};
    for (const environment of repository.environments) {
      environments[environment] = readGitHub(
        `${prefix}/environments/${encodeURIComponent(environment)}`,
      );
    }
    repositories[repositoryKey] = {
      metadata: readGitHub(prefix),
      actions: readGitHub(`${prefix}/actions/permissions`),
      workflowPermissions: readGitHub(`${prefix}/actions/permissions/workflow`),
      selectedActions: readGitHub(`${prefix}/actions/permissions/selected-actions`),
      branches,
      environments,
    };
  }
  return {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    actor: readGitHub("user"),
    repositories,
  };
}

function addFinding(findings, code, repository, target, details = {}) {
  findings.push({ code, repository, target, ...details });
}

function valueOrFinding(result, findings, repository, target) {
  if (result?.ok === true && result.value && typeof result.value === "object") {
    return result.value;
  }
  const reason = typeof result?.reason === "string"
    ? result.reason
    : "github-evidence-invalid";
  addFinding(findings, reason, repository, target,
    Number.isInteger(result?.status) ? { status: result.status } : {});
  return null;
}

function equalStringSets(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return canonicalJson(normalizedLeft) === canonicalJson(normalizedRight);
}

function inspectSecurityAndAnalysis(repositoryKey, expected, metadata, findings) {
  const observed = metadata?.security_and_analysis;
  if (!observed ||
    observed.secret_scanning?.status !== expected.secretScanning ||
    observed.secret_scanning_push_protection?.status !==
      expected.secretScanningPushProtection) {
    addFinding(findings, "security-and-analysis-drift", repositoryKey, "repository", {
      expectedSecretScanning: expected.secretScanning,
      expectedSecretScanningPushProtection: expected.secretScanningPushProtection,
    });
  }
}

function inspectActions(repositoryKey, expected, observed, findings) {
  const permissions = valueOrFinding(
    observed.actions,
    findings,
    repositoryKey,
    "actions-permissions",
  );
  if (permissions && (
    permissions.enabled !== expected.enabled ||
    permissions.allowed_actions !== expected.allowedActions ||
    permissions.sha_pinning_required !== expected.shaPinningRequired
  )) {
    addFinding(findings, "actions-policy-drift", repositoryKey, "actions-permissions", {
      expectedAllowedActions: expected.allowedActions,
      expectedShaPinningRequired: expected.shaPinningRequired,
    });
  }

  const workflow = valueOrFinding(
    observed.workflowPermissions,
    findings,
    repositoryKey,
    "workflow-permissions",
  );
  if (workflow && (
    workflow.default_workflow_permissions !== expected.defaultWorkflowPermissions ||
    workflow.can_approve_pull_request_reviews !== expected.canApprovePullRequestReviews
  )) {
    addFinding(findings, "workflow-permissions-drift", repositoryKey, "workflow-permissions");
  }

  const selected = valueOrFinding(
    observed.selectedActions,
    findings,
    repositoryKey,
    "selected-actions",
  );
  if (selected && (
    selected.github_owned_allowed !== expected.selectedActions.githubOwnedAllowed ||
    selected.verified_allowed !== expected.selectedActions.verifiedAllowed ||
    !equalStringSets(selected.patterns_allowed, expected.selectedActions.patternsAllowed)
  )) {
    addFinding(findings, "selected-actions-drift", repositoryKey, "selected-actions");
  }
}

function requiredCheckNames(protection) {
  const contexts = Array.isArray(protection.required_status_checks?.contexts)
    ? protection.required_status_checks.contexts
    : [];
  const checks = Array.isArray(protection.required_status_checks?.checks)
    ? protection.required_status_checks.checks
      .map((check) => check?.context)
      .filter((context) => typeof context === "string")
    : [];
  return [...new Set([...contexts, ...checks])];
}

function inspectBranch(
  repositoryKey,
  branchName,
  expected,
  observed,
  policy,
  findings,
) {
  const metadata = valueOrFinding(
    observed?.metadata,
    findings,
    repositoryKey,
    `branch:${branchName}`,
  );
  if (metadata && (metadata.name !== branchName || metadata.protected !== true)) {
    addFinding(findings, "branch-unprotected", repositoryKey, `branch:${branchName}`);
  }

  const protection = valueOrFinding(
    observed?.protection,
    findings,
    repositoryKey,
    `branch-protection:${branchName}`,
  );
  if (!protection) return;
  if (protection.required_status_checks?.strict !== policy.strictStatusChecks) {
    addFinding(findings, "strict-status-checks-disabled", repositoryKey,
      `branch-protection:${branchName}`);
  }
  const checks = requiredCheckNames(protection);
  if (!equalStringSets(checks, expected.requiredChecks)) {
    addFinding(findings, "required-checks-drift", repositoryKey,
      `branch-protection:${branchName}`, {
        expectedChecks: [...expected.requiredChecks].sort(),
        observedChecks: checks.sort(),
      });
  }
  const reviews = protection.required_pull_request_reviews;
  if (!Number.isSafeInteger(reviews?.required_approving_review_count) ||
    reviews.required_approving_review_count < policy.minimumApprovals) {
    addFinding(findings, "pull-request-approval-missing", repositoryKey,
      `branch-protection:${branchName}`);
  }
  if (reviews?.dismiss_stale_reviews !== policy.dismissStaleReviews) {
    addFinding(findings, "stale-review-dismissal-disabled", repositoryKey,
      `branch-protection:${branchName}`);
  }
  if (protection.required_conversation_resolution?.enabled !==
    policy.requireConversationResolution) {
    addFinding(findings, "conversation-resolution-disabled", repositoryKey,
      `branch-protection:${branchName}`);
  }
  if (protection.enforce_admins?.enabled !== policy.enforceAdministrators) {
    addFinding(findings, "administrator-enforcement-disabled", repositoryKey,
      `branch-protection:${branchName}`);
  }
  if (protection.allow_force_pushes?.enabled !== policy.allowForcePushes) {
    addFinding(findings, "force-push-policy-drift", repositoryKey,
      `branch-protection:${branchName}`);
  }
  if (protection.allow_deletions?.enabled !== policy.allowDeletions) {
    addFinding(findings, "deletion-policy-drift", repositoryKey,
      `branch-protection:${branchName}`);
  }
}

function reviewerIdentity(reviewer) {
  return reviewer?.reviewer?.id ?? reviewer?.id ?? null;
}

function inspectEnvironment(
  repositoryKey,
  environmentName,
  observed,
  policy,
  actorId,
  findings,
) {
  const environment = valueOrFinding(
    observed,
    findings,
    repositoryKey,
    `environment:${environmentName}`,
  );
  if (!environment) return;
  if (environment.name !== environmentName) {
    addFinding(findings, "environment-name-drift", repositoryKey,
      `environment:${environmentName}`);
  }
  if (environment.can_admins_bypass !== policy.canAdministratorsBypass) {
    addFinding(findings, "environment-administrator-bypass-enabled", repositoryKey,
      `environment:${environmentName}`);
  }
  if (environment.deployment_branch_policy?.protected_branches !==
      policy.protectedBranchesOnly ||
    environment.deployment_branch_policy?.custom_branch_policies !==
      policy.customBranchPolicies) {
    addFinding(findings, "environment-branch-policy-drift", repositoryKey,
      `environment:${environmentName}`);
  }
  const rules = Array.isArray(environment.protection_rules)
    ? environment.protection_rules.filter((rule) => rule?.type === "required_reviewers")
    : [];
  const reviewers = rules.flatMap((rule) => Array.isArray(rule.reviewers) ? rule.reviewers : []);
  if (policy.approvalMode === "direct-owner-dispatch") {
    if (policy.requireReviewers || policy.preventSelfReview ||
      policy.minimumReviewerCount !== 0 || rules.length !== 0) {
      addFinding(findings, "environment-review-policy-drift", repositoryKey,
        `environment:${environmentName}`);
    }
  } else if (policy.approvalMode === "independent-review") {
    if (policy.requireReviewers && (rules.length < 1 ||
      reviewers.length < policy.minimumReviewerCount)) {
      addFinding(findings, "environment-reviewer-missing", repositoryKey,
        `environment:${environmentName}`);
    }
    if (policy.preventSelfReview &&
      (rules.length < 1 || rules.some((rule) => rule.prevent_self_review !== true))) {
      addFinding(findings, "environment-self-review-enabled", repositoryKey,
        `environment:${environmentName}`);
    }
    if (actorId !== null && reviewers.some((reviewer) => reviewerIdentity(reviewer) === actorId)) {
      addFinding(findings, "environment-reviewer-not-independent", repositoryKey,
        `environment:${environmentName}`);
    }
  } else {
    addFinding(findings, "environment-approval-mode-invalid", repositoryKey,
      `environment:${environmentName}`);
  }
}

export function evaluateProductionGitHubGovernance(
  snapshot,
  contract = PRODUCTION_GITHUB_GOVERNANCE_CONTRACT,
) {
  const findings = [];
  const actor = valueOrFinding(snapshot?.actor, findings, "global", "authenticated-actor");
  const actorId = Number.isSafeInteger(actor?.id) ? actor.id : null;
  if (actor && actorId === null) {
    addFinding(findings, "authenticated-actor-invalid", "global", "authenticated-actor");
  }

  for (const [repositoryKey, expected] of Object.entries(contract.repositories)) {
    const observed = snapshot?.repositories?.[repositoryKey];
    if (!observed || typeof observed !== "object") {
      addFinding(findings, "repository-evidence-missing", repositoryKey, "repository");
      continue;
    }
    const metadata = valueOrFinding(
      observed.metadata,
      findings,
      repositoryKey,
      "repository",
    );
    if (metadata && (
      metadata.full_name !== expected.fullName ||
      metadata.visibility !== expected.visibility ||
      metadata.default_branch !== expected.defaultBranch
    )) {
      addFinding(findings, "repository-metadata-drift", repositoryKey, "repository", {
        expectedDefaultBranch: expected.defaultBranch,
        expectedVisibility: expected.visibility,
      });
    }
    if (metadata) {
      inspectSecurityAndAnalysis(
        repositoryKey,
        expected.securityAndAnalysis,
        metadata,
        findings,
      );
    }
    inspectActions(repositoryKey, expected.actions, observed, findings);
    for (const [branchName, branch] of Object.entries(expected.branches)) {
      inspectBranch(
        repositoryKey,
        branchName,
        branch,
        observed.branches?.[branchName],
        contract.branchProtection,
        findings,
      );
    }
    for (const environmentName of expected.environments) {
      inspectEnvironment(
        repositoryKey,
        environmentName,
        observed.environments?.[environmentName],
        contract.environmentProtection,
        actorId,
        findings,
      );
    }
  }

  const sortedFindings = [...new Map(findings.map((finding) =>
    [canonicalJson(finding), finding])).values()]
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const expectedBranchCount = Object.values(contract.repositories)
    .reduce((count, repository) => count + Object.keys(repository.branches).length, 0);
  const expectedEnvironmentCount = Object.values(contract.repositories)
    .reduce((count, repository) => count + repository.environments.length, 0);
  return {
    schemaVersion: 1,
    kind: "workforce-os-production-github-governance-audit",
    status: sortedFindings.length === 0 ? "GO" : "NO-GO",
    observedAt: typeof snapshot?.observedAt === "string" ? snapshot.observedAt : null,
    contractSha256: PRODUCTION_GITHUB_GOVERNANCE_CONTRACT_SHA256,
    findings: sortedFindings,
    summary: {
      repositoryCount: Object.keys(contract.repositories).length,
      expectedProtectedBranchCount: expectedBranchCount,
      expectedProtectedEnvironmentCount: expectedEnvironmentCount,
      githubPlanInsufficient: sortedFindings.some((finding) =>
        finding.code === "github-plan-insufficient"),
      findingCount: sortedFindings.length,
    },
  };
}

function parseArguments(argv) {
  if (argv.length === 0) return { fixture: null };
  if (argv.length === 2 && argv[0] === "--fixture" && argv[1]) {
    return { fixture: resolve(argv[1]) };
  }
  throw new Error("usage: production-github-governance-audit.mjs [--fixture snapshot.json]");
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  let snapshot;
  try {
    snapshot = options.fixture
      ? JSON.parse(readFileSync(options.fixture, "utf8"))
      : collectProductionGitHubGovernanceSnapshot();
  } catch {
    process.stderr.write("GitHub governance snapshot could not be loaded\n");
    process.exitCode = 2;
    return;
  }
  const report = evaluateProductionGitHubGovernance(snapshot);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "GO") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) main();

export { apiError, apiResult };
