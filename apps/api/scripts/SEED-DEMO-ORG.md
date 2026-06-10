# Seed the Loom demo Org

Populates a freshly-signed-up Org with realistic-looking B2B SaaS outbound
data: 80 companies, 120 contacts, 120 lead scores, 30 outreach artifacts
in a 10/10/10 PENDING_REVIEW/APPROVED/SENT split.

## One-time flow

1. **Sign up the demo user** via the production FE
   ([https://workforceos.xyz](https://workforceos.xyz)) using whatever email
   you want to record the Loom from (e.g. `demo@nikxius.ai`). Pick a
   memorable org name — this is what appears on-camera.

2. **Capture the new Org id**. From the dashboard hit `GET /api/orgs/me`
   in the network tab, or check the URL after onboarding completes.

3. **Open a temporary firewall rule to prod Postgres** so the script can
   write directly. Replace `<your-ip>` with `curl -s ipify.org`:

   ```bash
   MY_IP=$(curl -s https://api.ipify.org)
   az postgres flexible-server firewall-rule create \
     --resource-group Ledgr-prod --name apex-prod-db \
     --rule-name demo-seed-temp \
     --start-ip-address "$MY_IP" --end-ip-address "$MY_IP"
   ```

4. **Pull the prod DATABASE_URL** from the Container App secret:

   ```bash
   export DATABASE_URL=$(az containerapp secret show \
     -n apex-gtm-api -g Ledgr-prod \
     --secret-name database-url --query value -o tsv)
   ```

5. **Run the seed script**:

   ```bash
   cd apps/api
   DEMO_ORG_ID=<the-org-id-from-step-2> pnpm tsx scripts/seed-demo-org.ts
   ```

   Takes ~30 seconds. Logs each phase:
   ```
   Seeding demo data into org: Demo Inc. (cm...)
     ✓ IcpProfile demo-icp-...
     ✓ 80 Companies
     ✓ 120 Persons
     ✓ 120 LeadScores
     ✓ 30 OutreachArtifacts (10/10/10 PENDING_REVIEW/APPROVED/SENT)

   Demo seed complete.
   ```

6. **Close the firewall rule** the moment the script finishes:

   ```bash
   az postgres flexible-server firewall-rule delete \
     --resource-group Ledgr-prod --name apex-prod-db \
     --rule-name demo-seed-temp --yes
   ```

7. **Refresh the dashboard** in the demo browser. Drafts / Inbox / Companies
   / Leads / Dashboard all populate. The Compliance tab in Settings shows
   an empty suppression list (clean slate for the demo arc).

## Re-runs are safe

The script is idempotent — every row uses a deterministic id
(`demo-{co|p|icp|art}-{ORG_ID}-{index}`) and `upsert({create, update: {}})`
so re-running does not duplicate rows. If you want to wipe and reseed, call
`prisma.outreachArtifact.deleteMany({where: { orgId: '...' }})` etc first.

## On-camera recommended path

The seed produces a clean "mid-flight org" so any of these flows work:

* **Drafts → Approve** — 10 PENDING_REVIEW artifacts wait. Show the drafter
  output + approve a couple. Worker would dispatch live, but with no
  `OUTREACH_LIVE_FOR_ORGS` opt-in the demo Org stays dry-run safely.

* **Dashboard → Live pipeline** — 5s polling on the index page makes the
  KPIs feel alive. Trigger a new pipeline run during the Loom and watch
  stages tick through.

* **Inbox** — 10 SENT artifacts seed the historical baseline so the
  inbox/replies UX has content to navigate. (No real Gmail Pub/Sub replies
  unless you also stub Conversation rows — out of scope here.)

* **Settings → Compliance** — covers the GDPR + unsubscribe story without
  needing a real recipient to click anything.
