"use client";

import { useState, useEffect, useCallback } from "react";

interface AgentTab {
  name: string;
  icon: string;
  description: string;
  metric: string;
  metricLabel: string;
  bullets: string[];
  steps: { type: "tool" | "output" | "result"; text: string }[];
}

const agents: AgentTab[] = [
  {
    name: "SDR Agent",
    icon: "💼",
    description: "Autonomous sales development that researches, qualifies, and engages prospects.",
    metric: "23%",
    metricLabel: "Avg. response rate",
    bullets: [
      "Researches prospects using web search and LinkedIn",
      "Scores leads based on ICP fit and buying signals",
      "Drafts hyper-personalized outreach emails",
      "Updates CRM with deal and contact info",
    ],
    steps: [
      { type: "tool", text: '→ web_search("Acme Corp latest funding round")' },
      { type: "output", text: "  Found: Series B, $12M raised (TechCrunch, Jan 2026)" },
      { type: "tool", text: '→ enrich_contact("Sarah Chen", "Acme Corp")' },
      { type: "output", text: "  CTO, 8 yrs at company, prev. Google, Stanford CS" },
      { type: "tool", text: '→ score_lead({ company: "Acme", signals: [...] })' },
      { type: "output", text: "  Score: 87/100 — High priority (growing team + recent funding)" },
      { type: "tool", text: '→ draft_email({ to: "sarah@acme.com", style: "consultative" })' },
      { type: "result", text: '  ✓ Email sent — Subject: "Scaling eng without scaling headcount"' },
      { type: "tool", text: '→ hubspot.create_deal({ value: "$45,000", stage: "Qualified" })' },
      { type: "result", text: "  ✓ HubSpot updated — Deal created in pipeline" },
    ],
  },
  {
    name: "Content Writer",
    icon: "✍️",
    description: "Creates on-brand content for LinkedIn, Twitter, and blogs on autopilot.",
    metric: "3x",
    metricLabel: "More content output",
    bullets: [
      "Generates LinkedIn posts, tweets, and blog drafts",
      "Matches your brand voice and tone guidelines",
      "Schedules posts across platforms",
      "Tracks engagement and optimizes over time",
    ],
    steps: [
      { type: "tool", text: '→ analyze_brand_voice({ source: "last 20 posts" })' },
      { type: "output", text: "  Tone: Professional-casual, emphasis on data-driven insights" },
      { type: "tool", text: '→ research_topic("AI agents in enterprise sales 2026")' },
      { type: "output", text: "  Found 12 trending articles, 3 key themes identified" },
      { type: "tool", text: '→ draft_post({ platform: "linkedin", topic: "AI SDRs" })' },
      { type: "output", text: '  Draft: "We replaced 40hrs/week of manual prospecting..."' },
      { type: "tool", text: '→ schedule_post({ platform: "linkedin", time: "Tue 9am" })' },
      { type: "result", text: "  ✓ Post scheduled — LinkedIn, Tuesday 9:00 AM EST" },
    ],
  },
  {
    name: "Inbox Monitor",
    icon: "📬",
    description: "Triages your inbox, categorizes emails, and drafts replies for priority messages.",
    metric: "100+",
    metricLabel: "Emails processed/day",
    bullets: [
      "Monitors inbox in real-time for new messages",
      "Categorizes: urgent, follow-up, FYI, spam",
      "Drafts context-aware replies for priority emails",
      "Ensures zero-miss follow-ups on open threads",
    ],
    steps: [
      { type: "tool", text: '→ gmail.fetch_unread({ limit: 50 })' },
      { type: "output", text: "  Found 47 unread emails since last check" },
      { type: "tool", text: '→ classify_emails({ batch: 47 })' },
      { type: "output", text: "  Urgent: 5 | Follow-up: 12 | FYI: 18 | Low: 12" },
      { type: "tool", text: '→ draft_reply({ email: "RE: Q1 pricing proposal", priority: "urgent" })' },
      { type: "result", text: '  ✓ Reply drafted — "Thanks for the proposal, I\'ve reviewed..."' },
      { type: "tool", text: '→ flag_followups({ overdue: true })' },
      { type: "result", text: "  ✓ 3 overdue follow-ups flagged and reminders set" },
    ],
  },
  {
    name: "CRM Sync",
    icon: "🔄",
    description: "Keeps your CRM perfectly up-to-date by syncing across email, calendar, and deals.",
    metric: "0",
    metricLabel: "Manual data entry",
    bullets: [
      "Syncs contacts and deals from email threads",
      "Updates deal stages based on conversation signals",
      "Logs meeting notes and action items automatically",
      "Flags data conflicts and duplicates",
    ],
    steps: [
      { type: "tool", text: '→ gmail.scan_threads({ since: "24h" })' },
      { type: "output", text: "  Scanned 34 threads, found 8 with CRM-relevant updates" },
      { type: "tool", text: '→ hubspot.sync_contacts({ new: 3, updated: 5 })' },
      { type: "output", text: "  3 new contacts created, 5 records updated" },
      { type: "tool", text: '→ hubspot.update_deals({ signals: "email_sentiment" })' },
      { type: "result", text: '  ✓ Deal "Acme Corp" moved: Proposal → Negotiation' },
      { type: "tool", text: '→ detect_conflicts({ scope: "recent_syncs" })' },
      { type: "result", text: "  ✓ 1 duplicate flagged: john@acme.com (merged)" },
    ],
  },
  {
    name: "Social",
    icon: "📱",
    description: "Monitors social media for relevant conversations and engages thoughtfully.",
    metric: "5x",
    metricLabel: "More engagement",
    bullets: [
      "Tracks mentions, keywords, and competitor activity",
      "Identifies high-value conversations to join",
      "Drafts thoughtful, on-brand replies",
      "Reports weekly engagement analytics",
    ],
    steps: [
      { type: "tool", text: '→ monitor_mentions({ keywords: ["AI agents", "sales automation"] })' },
      { type: "output", text: "  Found 28 relevant conversations across LinkedIn + Twitter" },
      { type: "tool", text: '→ rank_opportunities({ by: "engagement_potential" })' },
      { type: "output", text: "  Top 5 threads ranked — highest: 2.4K views, 45 comments" },
      { type: "tool", text: '→ draft_reply({ thread: "Best AI tools for sales teams?" })' },
      { type: "result", text: '  ✓ Reply posted — "We built Apex specifically for this..."' },
      { type: "tool", text: '→ generate_report({ period: "weekly" })' },
      { type: "result", text: "  ✓ Report: 340 posts monitored, 28 engaged, 156 impressions" },
    ],
  },
  {
    name: "Reporting",
    icon: "📊",
    description: "Generates real-time reports with actionable insights from your data.",
    metric: "Real-time",
    metricLabel: "Dashboard updates",
    bullets: [
      "Pulls data from CRM, email, and integrations",
      "Generates daily/weekly summary reports",
      "Highlights trends, anomalies, and action items",
      "Delivers via email or dashboard",
    ],
    steps: [
      { type: "tool", text: '→ hubspot.pull_metrics({ period: "this_week" })' },
      { type: "output", text: "  Pipeline: $127K | New deals: 8 | Closed: 3 ($34K)" },
      { type: "tool", text: '→ gmail.pull_metrics({ period: "this_week" })' },
      { type: "output", text: "  Sent: 142 | Response rate: 23% | Meetings: 8" },
      { type: "tool", text: '→ analyze_trends({ compare: "last_week" })' },
      { type: "output", text: "  Pipeline +15%, response rate +3%, meetings +2" },
      { type: "tool", text: '→ generate_report({ format: "executive_summary" })' },
      { type: "result", text: "  ✓ Weekly report generated — 3 action items identified" },
    ],
  },
];

export function AgentShowcase() {
  const [activeTab, setActiveTab] = useState(0);
  const [visibleSteps, setVisibleSteps] = useState(0);

  const agent = agents[activeTab];

  const resetAnimation = useCallback(() => {
    setVisibleSteps(0);
  }, []);

  useEffect(() => {
    resetAnimation();
  }, [activeTab, resetAnimation]);

  useEffect(() => {
    if (visibleSteps < agent.steps.length) {
      const timer = setTimeout(
        () => setVisibleSteps((prev) => prev + 1),
        400
      );
      return () => clearTimeout(timer);
    }
  }, [visibleSteps, agent.steps.length]);

  return (
    <div>
      {/* Tab bar */}
      <div className="flex gap-1 overflow-x-auto pb-2 mb-6 scrollbar-hide">
        {agents.map((a, i) => (
          <button
            key={a.name}
            onClick={() => setActiveTab(i)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
              i === activeTab
                ? "bg-apex-indigo text-white"
                : "bg-apex-surface text-apex-muted hover:text-white hover:bg-apex-slate"
            }`}
          >
            <span>{a.icon}</span>
            <span className="hidden sm:inline">{a.name}</span>
          </button>
        ))}
      </div>

      <div className="grid lg:grid-cols-5 gap-6">
        {/* Terminal window */}
        <div className="lg:col-span-3">
          <div className="bg-apex-navy-dark border border-apex-border rounded-xl overflow-hidden">
            {/* Terminal header */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-apex-border bg-apex-surface/50">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
              </div>
              <span className="flex-1 text-center text-xs text-apex-muted font-mono">
                {agent.icon} {agent.name} — <span className="text-green-400">Running</span>
              </span>
            </div>

            {/* Terminal body */}
            <div className="p-4 font-mono text-xs sm:text-sm space-y-1.5 min-h-[300px] max-h-[400px] overflow-y-auto">
              {agent.steps.map((step, i) => (
                <div
                  key={`${activeTab}-${i}`}
                  className={`transition-all duration-300 ${
                    i < visibleSteps
                      ? "opacity-100 translate-y-0"
                      : "opacity-0 translate-y-2 h-0 overflow-hidden"
                  }`}
                >
                  <span
                    className={
                      step.type === "tool"
                        ? "text-apex-indigo-light"
                        : step.type === "result"
                        ? "text-green-400"
                        : "text-apex-muted"
                    }
                  >
                    {step.text}
                  </span>
                </div>
              ))}
              {visibleSteps < agent.steps.length && (
                <div className="flex items-center gap-1.5 text-apex-muted mt-2">
                  <span className="animate-pulse">▊</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Info card */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          <div className="card flex-1">
            <h3 className="text-lg font-semibold mb-1">{agent.icon} {agent.name}</h3>
            <p className="text-sm text-apex-muted mb-4">{agent.description}</p>
            <ul className="space-y-2.5">
              {agent.bullets.map((b) => (
                <li key={b} className="flex items-start gap-2 text-sm">
                  <span className="text-apex-indigo-light mt-0.5">✓</span>
                  <span className="text-gray-300">{b}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="card bg-gradient-to-br from-apex-indigo/10 to-transparent border-apex-indigo/20">
            <p className="text-3xl font-bold text-apex-indigo-light">{agent.metric}</p>
            <p className="text-sm text-apex-muted">{agent.metricLabel}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
