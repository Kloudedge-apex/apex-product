import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCTION_GITHUB_GOVERNANCE_CONTRACT,
  apiError,
  apiResult,
  assertReadOnlyGitHubAuditCommand,
  evaluateProductionGitHubGovernance,
} from "../production-github-governance-audit.mjs";

const CONTRACT = PRODUCTION_GITHUB_GOVERNANCE_CONTRACT;
const ACTOR_ID = 1001;
const REVIEWER_ID = 2002;

function protection(requiredChecks) {
  return {
    required_status_checks: {
      strict: true,
      contexts: [...requiredChecks],
      checks: [],
    },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      required_approving_review_count: 1,
    },
    enforce_admins: { enabled: true },
    required_conversation_resolution: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };
}

function environment(name) {
  return {
    name,
    can_admins_bypass: false,
    protection_rules: [{
      type: "required_reviewers",
      prevent_self_review: true,
      reviewers: [{
        type: "User",
        reviewer: { id: REVIEWER_ID, login: "independent-reviewer" },
      }],
    }],
    deployment_branch_policy: {
      protected_branches: true,
      custom_branch_policies: false,
    },
  };
}

function compliantSnapshot() {
  const repositories = {};
  for (const [repositoryKey, repository] of Object.entries(CONTRACT.repositories)) {
    const branches = {};
    for (const [branchName, branch] of Object.entries(repository.branches)) {
      branches[branchName] = {
        metadata: apiResult({ name: branchName, protected: true }),
        protection: apiResult(protection(branch.requiredChecks)),
      };
    }
    const environments = {};
    for (const environmentName of repository.environments) {
      environments[environmentName] = apiResult(environment(environmentName));
    }
    repositories[repositoryKey] = {
      metadata: apiResult({
        full_name: repository.fullName,
        visibility: repository.visibility,
        default_branch: repository.defaultBranch,
      }),
      actions: apiResult({
        enabled: repository.actions.enabled,
        allowed_actions: repository.actions.allowedActions,
        sha_pinning_required: repository.actions.shaPinningRequired,
      }),
      workflowPermissions: apiResult({
        default_workflow_permissions: repository.actions.defaultWorkflowPermissions,
        can_approve_pull_request_reviews:
          repository.actions.canApprovePullRequestReviews,
      }),
      selectedActions: apiResult({
        github_owned_allowed: repository.actions.selectedActions.githubOwnedAllowed,
        verified_allowed: repository.actions.selectedActions.verifiedAllowed,
        patterns_allowed: [...repository.actions.selectedActions.patternsAllowed],
      }),
      branches,
      environments,
    };
  }
  return {
    schemaVersion: 1,
    observedAt: "2026-08-15T10:00:00.000Z",
    actor: apiResult({ id: ACTOR_ID, login: "release-actor" }),
    repositories,
  };
}

function evaluateMutation(mutate) {
  const snapshot = compliantSnapshot();
  mutate(snapshot);
  return evaluateProductionGitHubGovernance(snapshot);
}

function assertFinding(report, code) {
  assert.equal(report.status, "NO-GO");
  assert.ok(report.findings.some((finding) => finding.code === code),
    `expected ${code} in ${JSON.stringify(report.findings)}`);
}

test("fixed contract names both repositories, three branches, and four environments", () => {
  assert.deepEqual(Object.keys(CONTRACT.repositories), ["backend", "console"]);
  assert.equal(CONTRACT.repositories.backend.fullName, "Kloudedge-apex/apex-product");
  assert.equal(CONTRACT.repositories.backend.defaultBranch, "master");
  assert.equal(CONTRACT.repositories.console.fullName, "Kloudedge-apex/Workforce-OS");
  assert.equal(CONTRACT.repositories.console.defaultBranch, "main");
  assert.deepEqual(Object.keys(CONTRACT.repositories.backend.branches), [
    "master",
    "release/go-live-2026-06-01",
  ]);
  assert.deepEqual(Object.keys(CONTRACT.repositories.console.branches), ["main"]);
  assert.deepEqual(CONTRACT.repositories.backend.branches.master.requiredChecks, [
    "API Tests (blocking)",
    "Lint, Type Check & Build",
    "Migration Rehearsal (blocking)",
    "Production Image Contract",
  ]);
  assert.deepEqual(CONTRACT.repositories.console.branches.main.requiredChecks, [
    "Production Console Image Contract",
    "Type Check, Test & Build",
  ]);
  for (const repository of Object.values(CONTRACT.repositories)) {
    assert.deepEqual(repository.environments, [
      "workforce-os-production-build",
      "workforce-os-production",
    ]);
    assert.equal(repository.actions.allowedActions, "selected");
    assert.equal(repository.actions.shaPinningRequired, true);
    assert.deepEqual(repository.actions.selectedActions.patternsAllowed, [
      "Azure/login@*",
      "pnpm/action-setup@*",
    ]);
  }
  assert.equal(Object.values(CONTRACT.repositories)
    .reduce((count, repository) => count + repository.environments.length, 0), 4);
});

test("the canonical protected snapshot is GO and redacts identities", () => {
  const report = evaluateProductionGitHubGovernance(compliantSnapshot());
  assert.equal(report.status, "GO");
  assert.equal(report.summary.findingCount, 0);
  assert.equal(report.summary.expectedProtectedBranchCount, 3);
  assert.equal(report.summary.expectedProtectedEnvironmentCount, 4);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /release-actor/u);
  assert.doesNotMatch(serialized, /independent-reviewer/u);
  assert.doesNotMatch(serialized, new RegExp(String(REVIEWER_ID), "u"));
});

test("a private-repository plan gate is explicit and fail closed", () => {
  const report = evaluateMutation((snapshot) => {
    snapshot.repositories.backend.branches.master.protection =
      apiError("github-plan-insufficient", 403);
  });
  assertFinding(report, "github-plan-insufficient");
  assert.equal(report.summary.githubPlanInsufficient, true);
});

test("an unprotected branch is rejected", () => {
  const report = evaluateMutation((snapshot) => {
    snapshot.repositories.console.branches.main.metadata.value.protected = false;
  });
  assertFinding(report, "branch-unprotected");
});

test("missing or extra required checks are rejected", () => {
  const report = evaluateMutation((snapshot) => {
    const checks = snapshot.repositories.backend.branches.master.protection
      .value.required_status_checks.contexts;
    checks.pop();
    checks.push("unreviewed-check");
  });
  assertFinding(report, "required-checks-drift");
});

test("non-strict checks are rejected", () => {
  const report = evaluateMutation((snapshot) => {
    snapshot.repositories.backend.branches.master.protection
      .value.required_status_checks.strict = false;
  });
  assertFinding(report, "strict-status-checks-disabled");
});

test("missing pull-request approval is rejected", () => {
  const report = evaluateMutation((snapshot) => {
    snapshot.repositories.backend.branches.master.protection
      .value.required_pull_request_reviews.required_approving_review_count = 0;
  });
  assertFinding(report, "pull-request-approval-missing");
});

test("stale approvals must be dismissed", () => {
  const report = evaluateMutation((snapshot) => {
    snapshot.repositories.console.branches.main.protection
      .value.required_pull_request_reviews.dismiss_stale_reviews = false;
  });
  assertFinding(report, "stale-review-dismissal-disabled");
});

test("conversation resolution and administrator enforcement are mandatory", () => {
  const report = evaluateMutation((snapshot) => {
    const value = snapshot.repositories.console.branches.main.protection.value;
    value.required_conversation_resolution.enabled = false;
    value.enforce_admins.enabled = false;
  });
  assertFinding(report, "conversation-resolution-disabled");
  assertFinding(report, "administrator-enforcement-disabled");
});

test("force-push and deletion are rejected", () => {
  const report = evaluateMutation((snapshot) => {
    const value = snapshot.repositories.backend.branches.master.protection.value;
    value.allow_force_pushes.enabled = true;
    value.allow_deletions.enabled = true;
  });
  assertFinding(report, "force-push-policy-drift");
  assertFinding(report, "deletion-policy-drift");
});

test("environment administrator bypass is rejected", () => {
  const report = evaluateMutation((snapshot) => {
    snapshot.repositories.backend.environments["workforce-os-production"]
      .value.can_admins_bypass = true;
  });
  assertFinding(report, "environment-administrator-bypass-enabled");
});

test("a missing environment reviewer fails closed", () => {
  const report = evaluateMutation((snapshot) => {
    snapshot.repositories.console.environments["workforce-os-production-build"]
      .value.protection_rules[0].reviewers = [];
  });
  assertFinding(report, "environment-reviewer-missing");
});

test("self review and the authenticated actor as reviewer are rejected", () => {
  const report = evaluateMutation((snapshot) => {
    const rule = snapshot.repositories.backend.environments["workforce-os-production"]
      .value.protection_rules[0];
    rule.prevent_self_review = false;
    rule.reviewers[0].reviewer.id = ACTOR_ID;
  });
  assertFinding(report, "environment-self-review-enabled");
  assertFinding(report, "environment-reviewer-not-independent");
});

test("environment deployment must be limited to protected branches", () => {
  const report = evaluateMutation((snapshot) => {
    const policy = snapshot.repositories.console.environments["workforce-os-production"]
      .value.deployment_branch_policy;
    policy.protected_branches = false;
    policy.custom_branch_policies = true;
  });
  assertFinding(report, "environment-branch-policy-drift");
});

test("broad or unpinned Actions are rejected", () => {
  const report = evaluateMutation((snapshot) => {
    const actions = snapshot.repositories.console.actions.value;
    actions.allowed_actions = "all";
    actions.sha_pinning_required = false;
  });
  assertFinding(report, "actions-policy-drift");
});

test("workflow write authority and PR approval authority are rejected", () => {
  const report = evaluateMutation((snapshot) => {
    const workflow = snapshot.repositories.backend.workflowPermissions.value;
    workflow.default_workflow_permissions = "write";
    workflow.can_approve_pull_request_reviews = true;
  });
  assertFinding(report, "workflow-permissions-drift");
});

test("selected-action allowlist drift is rejected", () => {
  const report = evaluateMutation((snapshot) => {
    snapshot.repositories.backend.selectedActions.value.patterns_allowed
      .push("unreviewed/action@*");
  });
  assertFinding(report, "selected-actions-drift");
});

test("the command allowlist admits only exact GET endpoints", () => {
  assert.equal(assertReadOnlyGitHubAuditCommand([
    "api",
    "--method",
    "GET",
    "repos/Kloudedge-apex/apex-product/branches/release%2Fgo-live-2026-06-01/protection",
  ]), true);
  assert.throws(() => assertReadOnlyGitHubAuditCommand([
    "api",
    "--method",
    "PUT",
    "repos/Kloudedge-apex/apex-product/branches/master/protection",
  ]), /read-only governance audit allowlist/u);
  assert.throws(() => assertReadOnlyGitHubAuditCommand([
    "api",
    "--method",
    "GET",
    "repos/Kloudedge-apex/other/private-data",
  ]), /read-only governance audit allowlist/u);
});
