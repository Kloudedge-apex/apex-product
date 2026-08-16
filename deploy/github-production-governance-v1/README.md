# Workforce OS GitHub production governance v1

This package fixes the repository-side production admission contract for both
Workforce OS repositories. It is deliberately separate from the Azure
authority package: GitHub governance must be `GO` before the reviewed Azure
deployment is applied or the ten-day credential-drain checkpoint is created.

The contract requires:

- explicitly authorized public backend and console repositories with their
  exact default branches for the protected release and ten-day drain window;
- GitHub secret scanning and push protection enabled in both public
  repositories;
- protected default/candidate branches with strict, exact CI checks, one or
  more approvals, stale-review dismissal, conversation resolution,
  administrator enforcement, and no force-push or deletion;
- `workforce-os-production-build` and `workforce-os-production` environments in
  both repositories, with administrator bypass disabled, no reviewer rule, and
  deployment restricted to protected branches. Manual dispatch plus the exact
  typed confirmation is the accountable owner approval;
- read-only default workflow permissions, no workflow-created PR approvals,
  selected Actions only, and full-SHA pin enforcement.

The audit is read-only. It never prints reviewer identities, environment
variables, secrets, or API response bodies. Any GitHub plan response that
blocks required protection is reported as `github-plan-insufficient`; it is
not treated as missing evidence or silently ignored.

Run the live audit from an authenticated `gh` session:

```bash
node scripts/production-github-governance-audit.mjs
```

The command exits zero only for `GO` and emits a sanitized JSON report. For
tests, pass a local snapshot without contacting GitHub:

```bash
node scripts/production-github-governance-audit.mjs --fixture snapshot.json
```

Provisioning order for the explicitly authorized public release window:

1. enable secret scanning and push protection in both repositories;
2. set the Actions policy in the contract;
3. protect every contract branch with the exact checks and review controls;
4. create both direct-dispatch environments in both repositories without a
   required-reviewer rule;
5. run this audit and inspect its `GO` report;
6. merge the release changes into the protected default branches;
7. apply and read back the Azure authority package;
8. create the server-timed drain checkpoint, then wait the full ten days.

Public clones, forks, and caches cannot be recalled by a later visibility
change. Do not return either repository to private on GitHub Free while this
release authority is active: the required protection and environment controls
would no longer be available. Do not start the drain clock from a local
timestamp or before the protected GitHub authority is operational.
