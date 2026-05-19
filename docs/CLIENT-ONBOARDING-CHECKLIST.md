# Apex Client Onboarding Checklist

## Pre-Onboarding (Internal)

- [x] Production DB purged of all demo/test data
- [x] Azure API live and healthy (`apex-gtm-api` container app)
- [x] No local dev servers running
- [ ] **Frontend mock data removal** — dashboard, drafts, campaigns, analytics, and settings pages still display hardcoded mock data (workhorse-os `src/lib/mock-data.ts`). These pages need to be wired to real API endpoints or show empty states. Pages already on real API: ICP, Companies, People, Lead Gen.
- [ ] Verify Clerk auth is working for new signups (test a fresh account)
- [ ] Confirm CORS allows the production frontend domain
- [ ] AgentTemplates seeded (currently 6: SDR, CRM Sync, Content Writer, Social Engagement, Inbox Monitor, Reporting)

---

## Client Onboarding Steps

### Step 1: Account Setup
| Item | Details | Status |
|------|---------|--------|
| Company name | | ☐ |
| Primary contact name | | ☐ |
| Primary contact email | | ☐ |
| Clerk account created | | ☐ |
| Org provisioned in Apex | | ☐ |
| Plan tier assigned | | ☐ |

### Step 2: ICP Configuration
Fill out for each Ideal Customer Profile the client wants to target:

**ICP Template:**
```
ICP Name: ____________________________
Target Titles: (e.g., VP Sales, CRO, Head of Revenue)
  1. ____________________________
  2. ____________________________
  3. ____________________________
  4. ____________________________

Target Industries: (e.g., fintech, SaaS, healthcare)
  1. ____________________________
  2. ____________________________
  3. ____________________________

Target Geographies: (e.g., UK, US East Coast, DACH)
  1. ____________________________
  2. ____________________________

Company Size:
  Min employees: ________
  Max employees: ________

Seed Domains: (5-10 example companies they'd love to sell to)
  1. ____________________________
  2. ____________________________
  3. ____________________________
  4. ____________________________
  5. ____________________________

Tech Stack Signals: (optional, tools their ideal customers use)
  1. ____________________________
  2. ____________________________

Intent Keywords: (optional, hiring signals or topics)
  1. ____________________________
  2. ____________________________
```

### Step 3: Email & Integration Setup
| Item | Details | Status |
|------|---------|--------|
| Sending email address | | ☐ |
| Email provider (Gmail/Outlook/SMTP) | | ☐ |
| SPF/DKIM/DMARC verified | | ☐ |
| Email warm-up started | | ☐ |
| CRM connected (if applicable) | | ☐ |
| LinkedIn connected (if applicable) | | ☐ |
| Calendar connected (if applicable) | | ☐ |

### Step 4: Agent Configuration
| Agent | Enabled | Config Notes | Status |
|-------|---------|-------------|--------|
| SDR Agent | ☐ | ICP linked, outreach cadence set | ☐ |
| CRM Sync Agent | ☐ | CRM credentials connected | ☐ |
| Content Writer | ☐ | Brand voice doc provided | ☐ |
| Social Engagement | ☐ | Social accounts linked | ☐ |
| Inbox Monitor | ☐ | Email access granted | ☐ |
| Reporting Agent | ☐ | KPI targets defined | ☐ |

### Step 5: Brand & Voice Setup
```
Company Description (2-3 sentences):
____________________________________________________________
____________________________________________________________

Value Proposition (1 sentence):
____________________________________________________________

Tone of Voice: [ ] Professional  [ ] Casual  [ ] Technical  [ ] Friendly

Key Differentiators:
  1. ____________________________
  2. ____________________________
  3. ____________________________

Words/Phrases to ALWAYS use:
  1. ____________________________
  2. ____________________________

Words/Phrases to NEVER use:
  1. ____________________________
  2. ____________________________

Case Studies / Social Proof:
  1. ____________________________
  2. ____________________________
```

### Step 6: Outreach Cadence
```
Cadence Name: ____________________________

Day 0: [ ] Email  [ ] LinkedIn connect
Day 1: [ ] LinkedIn message  [ ] Email follow-up
Day 3: [ ] Email follow-up  [ ] Phone
Day 5: [ ] LinkedIn follow-up  [ ] Email
Day 7: [ ] Breakup email  [ ] Phone

Max emails per day: ________
Max LinkedIn actions per day: ________
Sending window: ________ to ________ (timezone: ________)
Exclude weekends: [ ] Yes  [ ] No
```

### Step 7: Go-Live Verification
| Check | Status |
|-------|--------|
| First ICP discovery run completed | ☐ |
| Leads appearing in dashboard | ☐ |
| Email sending test passed | ☐ |
| Agent runs showing in logs | ☐ |
| Client can log in and see their data | ☐ |
| No other org's data visible | ☐ |
| Reporting/analytics loading correctly | ☐ |

---

## Post-Onboarding (Week 1)

- [ ] Daily check-in with client (first 3 days)
- [ ] Review first batch of generated leads for quality
- [ ] Tune ICP scoring thresholds if needed
- [ ] Review email drafts before enabling auto-send
- [ ] Set up weekly reporting cadence
- [ ] Schedule Week 1 review call

---

## Client Information Template

```
CLIENT ONBOARDING FORM
======================

Company Information
  Company Name: ____________________________
  Website: ____________________________
  Industry: ____________________________
  Company Size: ____________________________
  HQ Location: ____________________________

Primary Contact
  Name: ____________________________
  Email: ____________________________
  Phone: ____________________________
  Role: ____________________________

What They Sell
  Product/Service: ____________________________
  Target Buyer: ____________________________
  Average Deal Size: ____________________________
  Sales Cycle Length: ____________________________

Current Sales Stack
  CRM: ____________________________
  Email Tool: ____________________________
  LinkedIn (Sales Nav?): [ ] Yes  [ ] No
  Other Tools: ____________________________

Goals
  Monthly meeting target: ________
  Monthly email volume target: ________
  Priority markets: ____________________________
  Top 3 dream clients:
    1. ____________________________
    2. ____________________________
    3. ____________________________

Onboarding Date: ____________________________
Go-Live Target: ____________________________
Account Manager: ____________________________
```
