"use client";

import { useState, useEffect, useCallback } from "react";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import {
  Bot, Activity, Zap, TrendingUp, Plus, ArrowRight,
  Play, Pause, CheckCircle, XCircle, AlertTriangle, DollarSign,
  ArrowUpRight, ArrowDownRight, ChevronDown, ChevronRight, Clock,
  FileText, Sparkles, RefreshCw, BarChart3, Target,
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend, BarChart, Bar,
} from "recharts";
import { api } from "@/lib/api";
import { useOrg, useDashboardData } from "@/lib/hooks";
import { StatSkeleton, TableRowSkeleton } from "@/components/ui/skeleton";

// ─── Types ──────────────────────────────────────────────
interface OrgStats {
  activeAgents: number; pausedAgents: number; totalAgents: number;
  totalRuns: number; runsToday: number; runsThisWeek: number;
  successRate: number; integrations: number;
  tokensUsed: number; tokensToday: number; totalCost: number; costToday: number;
  runsByDay: DayStats[]; tokensByDay: TokenDay[];
  topAgents: TopAgent[];
  recentFailures: Array<{ runId: string; agentName: string; error: string; timestamp: string }>;
  agentsByDomain: Record<string, number>;
  runsByDomain: Record<string, number>;
}
interface DayStats { date: string; total: number; completed: number; failed: number }
interface TokenDay { date: string; tokens: number; cost: number }
interface TopAgent { id: string; name: string; domain: string; runs: number; successRate: number; avgTokens: number }
interface Agent {
  id: string; name: string; domain: string; status: string;
  template: { id: string; name: string; domain: string };
  schedule: string | null; createdAt: string;
  _count?: { runs: number };
}
interface RunLog { id: string; level: string; message: string; createdAt: string }
interface Run {
  id: string; agentId: string; status: string;
  startedAt: string; completedAt: string | null;
  tokensUsed: number; cost: number;
  agent?: { name: string; domain: string };
  logs?: RunLog[]; stepCount?: number; _count?: { logs: number };
}

// ─── Utilities ──────────────────────────────────────────
function formatNum(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toLocaleString();
}
function formatDuration(startedAt: string, completedAt: string | null) {
  if (!completedAt) return "—";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
function formatTime(d: string) {
  return new Date(d).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}
function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function timeAgo(d: string) {
  const diff = Date.now() - new Date(d).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

const DOMAIN_COLORS: Record<string, { text: string; bg: string; border: string }> = {
  SALES: { text: "text-blue-400", bg: "bg-blue-400/10", border: "border-blue-400/20" },
  MARKETING: { text: "text-purple-400", bg: "bg-purple-400/10", border: "border-purple-400/20" },
  OPS: { text: "text-orange-400", bg: "bg-orange-400/10", border: "border-orange-400/20" },
};

const RUN_STATUS_STYLES: Record<string, { cls: string; dot?: string }> = {
  COMPLETED: { cls: "badge-green" },
  FAILED: { cls: "badge-red" },
  RUNNING: { cls: "badge-blue", dot: "live-dot-blue" },
  QUEUED: { cls: "badge-yellow" },
  CANCELLED: { cls: "badge-gray" },
};

const CHART_COLORS = { completed: "#22c55e", failed: "#ef4444", other: "#6366f1" };
const PIE_COLORS = ["#22c55e", "#ef4444", "#6366f1", "#eab308"];

// ─── Custom Tooltip ─────────────────────────────────────
function CustomChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#0a1628] border border-apex-indigo/20 rounded-xl p-3 shadow-2xl text-xs">
      <p className="text-apex-muted mb-2 font-medium">{label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2 py-0.5">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-apex-muted">{p.name}:</span>
          <span className="text-white font-semibold">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main Dashboard ─────────────────────────────────────
export default function DashboardPage() {
  const { user } = useUser();
  const { org, orgId, isLoading: orgLoading } = useOrg(user?.id);
  const dashData = useDashboardData(orgId);
  const stats = dashData.stats as OrgStats | null;
  const agents = dashData.agents as Agent[];
  const runs = dashData.runs as Run[];
  const dataLoading = dashData.isLoading;
  const error = dashData.error as Error | null;
  const mutateRuns = dashData.mutateRuns;

  const [sortCol, setSortCol] = useState("runs");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [chartRange, setChartRange] = useState<"7d" | "30d">("7d");
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const isLoading = orgLoading || dataLoading;

  const handleToggleAgent = useCallback(async (agent: Agent) => {
    try {
      if (agent.status === "ACTIVE") await api.agents.pause(agent.id);
      else await api.agents.deploy(agent.id);
    } catch { /* ignore */ }
  }, []);

  const handleTriggerRun = useCallback(async (agent: Agent) => {
    if (!orgId) return;
    try { await api.runs.trigger(agent.id, orgId); mutateRuns(); } catch { /* ignore */ }
  }, [orgId, mutateRuns]);

  function handleSort(col: string) {
    setSortDir(sortCol === col ? (sortDir === "asc" ? "desc" : "asc") : "desc");
    setSortCol(col);
  }

  // ── Loading ────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="animate-fade-in">
        <div className="flex items-center justify-between mb-8">
          <div>
            <div className="h-7 w-44 bg-apex-surface rounded-lg animate-pulse" />
            <div className="h-4 w-64 bg-apex-surface rounded-lg animate-pulse mt-2" />
          </div>
          <div className="h-10 w-32 bg-apex-surface rounded-lg animate-pulse" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
          {Array.from({ length: 6 }).map((_, i) => <StatSkeleton key={i} />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-8">
          <div className="lg:col-span-2 card"><div className="h-5 w-48 bg-apex-surface rounded animate-pulse mb-4" /><div className="h-52 bg-apex-surface rounded animate-pulse" /></div>
          <div className="card"><div className="h-5 w-32 bg-apex-surface rounded animate-pulse mb-4" /><div className="h-52 bg-apex-surface rounded animate-pulse" /></div>
        </div>
        <div className="card mb-6"><div className="h-5 w-40 bg-apex-surface rounded animate-pulse mb-4" />{Array.from({ length: 4 }).map((_, i) => <TableRowSkeleton key={i} />)}</div>
      </div>
    );
  }

  // ── No org ─────────────────────────────────────────────
  if (!orgId) {
    return (
      <div className="card-glass text-center py-20 animate-fade-in-up">
        <div className="w-16 h-16 rounded-2xl bg-apex-indigo/10 border border-apex-indigo/20 flex items-center justify-center mx-auto mb-4">
          <Sparkles size={28} className="text-apex-indigo-light" />
        </div>
        <h2 className="text-xl font-bold mb-2">Set up your workspace</h2>
        <p className="text-apex-muted mb-6 max-w-sm mx-auto text-sm">Deploy your first AI agent and start automating your workforce operations.</p>
        <Link href="/onboarding" className="btn-primary inline-flex items-center gap-2"><Plus size={16} /> Start Onboarding</Link>
      </div>
    );
  }

  // ── Derived data ───────────────────────────────────────
  const runsByDay = stats?.runsByDay || [];
  const tokensByDay = stats?.tokensByDay || [];
  const topAgentsData = stats?.topAgents || [];
  const weekCost = tokensByDay.reduce((s, d) => s + d.cost, 0);

  const chartData = runsByDay.map((d) => ({
    date: new Date(d.date + "T00:00:00").toLocaleDateString("en-US", { weekday: "short" }),
    Completed: d.completed,
    Failed: d.failed,
    Other: Math.max(0, d.total - d.completed - d.failed),
  }));

  const totalCompleted = runsByDay.reduce((s, d) => s + d.completed, 0);
  const totalFailed = runsByDay.reduce((s, d) => s + d.failed, 0);
  const totalOther = runsByDay.reduce((s, d) => s + Math.max(0, d.total - d.completed - d.failed), 0);
  const pieData = [
    { name: "Completed", value: totalCompleted },
    { name: "Failed", value: totalFailed },
    { name: "Running", value: totalOther },
  ].filter((d) => d.value > 0);

  const sortedAgents = [...agents].sort((a, b) => {
    let aVal: number | string = 0, bVal: number | string = 0;
    if (sortCol === "name") { aVal = a.name.toLowerCase(); bVal = b.name.toLowerCase(); }
    if (sortCol === "domain") { aVal = a.domain; bVal = b.domain; }
    if (sortCol === "status") { aVal = a.status; bVal = b.status; }
    if (sortCol === "runs") { aVal = a._count?.runs || 0; bVal = b._count?.runs || 0; }
    if (typeof aVal === "string") return sortDir === "asc" ? aVal.localeCompare(bVal as string) : (bVal as string).localeCompare(aVal);
    return sortDir === "asc" ? aVal - (bVal as number) : (bVal as number) - aVal;
  });

  const alerts: Array<{ type: "warning" | "error" | "info"; message: string; action?: string; href?: string }> = [];
  const lowSuccessAgents = topAgentsData.filter((a) => a.runs > 0 && a.successRate < 50);
  for (const a of lowSuccessAgents) {
    alerts.push({ type: "error", message: `${a.name} has ${a.successRate}% failure rate`, action: "View Agent", href: `/agents/${a.id}` });
  }
  if (stats && stats.integrations === 0) {
    alerts.push({ type: "info", message: "No integrations connected — enable real outreach", action: "Connect", href: "/integrations" });
  }

  // Plan run limit (rough estimate)
  const planLimits: Record<string, number> = { TRIAL: 3, STARTER: 10, GROWTH: 50, ENTERPRISE: Infinity };
  const plan = (org as { plan?: string } | null)?.plan ?? "TRIAL";
  const runLimit = planLimits[plan] ?? 3;
  const runUsagePct = Math.min(100, ((stats?.runsToday ?? 0) / runLimit) * 100);

  // ── Render ─────────────────────────────────────────────
  return (
    <div className="animate-fade-in max-w-screen-2xl">

      {/* ══ Header ══════════════════════════════════════ */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">
            {user?.firstName ? `Welcome back, ${user.firstName} 👋` : "Dashboard"}
          </h1>
          <p className="text-apex-muted text-sm mt-1">
            {now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Run usage chip */}
          {runLimit !== Infinity && (
            <div className="hidden sm:flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs">
              <div className="w-20 h-1.5 bg-apex-surface rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${runUsagePct}%`,
                    background: runUsagePct > 80 ? "#ef4444" : runUsagePct > 60 ? "#eab308" : "#6366f1",
                  }}
                />
              </div>
              <span className="text-apex-muted">
                <span className="text-white font-medium">{stats?.runsToday ?? 0}</span>/{runLimit} runs
              </span>
            </div>
          )}
          <Link href="/onboarding" className="btn-primary flex items-center gap-2 text-sm">
            <Plus size={15} /> New Agent
          </Link>
        </div>
      </div>

      {error && (
        <div className="card mb-6 border-red-500/20 bg-red-500/5">
          <p className="text-red-400 text-sm">{error.message}</p>
        </div>
      )}

      {/* ══ KPI Cards ═══════════════════════════════════ */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
        {[
          {
            label: "Active Agents", value: stats?.activeAgents ?? 0,
            icon: Bot, color: "text-indigo-400", iconBg: "bg-indigo-500/10",
            sub: `${stats?.totalAgents ?? 0} total`,
            delay: "stagger-1",
          },
          {
            label: "Runs Today", value: stats?.runsToday ?? 0,
            icon: Activity, color: "text-green-400", iconBg: "bg-green-500/10",
            sub: `${stats?.runsThisWeek ?? 0} this week`,
            trend: stats?.runsToday !== undefined && stats.runsThisWeek > 0
              ? Math.round((stats.runsToday / (stats.runsThisWeek / 7)) * 100 - 100)
              : undefined,
            delay: "stagger-2",
          },
          {
            label: "Success Rate",
            value: `${stats?.successRate ?? 0}%`,
            icon: CheckCircle,
            color: (stats?.successRate ?? 0) >= 90 ? "text-green-400" : (stats?.successRate ?? 0) >= 75 ? "text-yellow-400" : "text-red-400",
            iconBg: (stats?.successRate ?? 0) >= 90 ? "bg-green-500/10" : "bg-red-500/10",
            sub: `${stats?.totalRuns ?? 0} total runs`,
            delay: "stagger-3",
          },
          {
            label: "Tokens Today", value: formatNum(stats?.tokensToday ?? 0),
            icon: TrendingUp, color: "text-yellow-400", iconBg: "bg-yellow-500/10",
            sub: `$${(stats?.costToday ?? 0).toFixed(3)}`,
            delay: "stagger-4",
          },
          {
            label: "Total Cost", value: `$${(stats?.totalCost ?? 0).toFixed(2)}`,
            icon: DollarSign, color: "text-cyan-400", iconBg: "bg-cyan-500/10",
            sub: `$${weekCost.toFixed(2)} this week`,
            delay: "stagger-5",
          },
          {
            label: "Integrations", value: stats?.integrations ?? 0,
            icon: Zap, color: "text-purple-400", iconBg: "bg-purple-500/10",
            sub: "connected",
            delay: "stagger-6",
          },
        ].map((card) => (
          <KPICard key={card.label} {...card} />
        ))}
      </div>

      {/* ══ Charts Row ══════════════════════════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-8">
        {/* Area Chart */}
        <div className="lg:col-span-2 card-glass animate-fade-in-up stagger-1">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <BarChart3 size={16} className="text-apex-indigo-light" />
              <h2 className="section-title">Run Activity</h2>
            </div>
            <div className="flex items-center gap-1 p-1 bg-apex-surface/60 rounded-lg">
              {(["7d", "30d"] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setChartRange(r)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${chartRange === r ? "bg-apex-indigo text-white shadow" : "text-apex-muted hover:text-white"
                    }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {chartData.length === 0 ? (
            <EmptyChart icon={Activity} label="No run data yet" />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="gCompleted" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={CHART_COLORS.completed} stopOpacity={0.35} />
                    <stop offset="95%" stopColor={CHART_COLORS.completed} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gFailed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={CHART_COLORS.failed} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={CHART_COLORS.failed} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gOther" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={CHART_COLORS.other} stopOpacity={0.2} />
                    <stop offset="95%" stopColor={CHART_COLORS.other} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(99,102,241,0.08)" />
                <XAxis dataKey="date" tick={{ fill: "#475569", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#475569", fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
                <RechartsTooltip content={<CustomChartTooltip />} />
                <Area type="monotone" dataKey="Completed" stackId="1" stroke={CHART_COLORS.completed} strokeWidth={2} fill="url(#gCompleted)" />
                <Area type="monotone" dataKey="Failed" stackId="1" stroke={CHART_COLORS.failed} strokeWidth={2} fill="url(#gFailed)" />
                <Area type="monotone" dataKey="Other" stackId="1" stroke={CHART_COLORS.other} strokeWidth={2} fill="url(#gOther)" />
              </AreaChart>
            </ResponsiveContainer>
          )}

          {/* Legend */}
          <div className="flex items-center gap-4 mt-3 px-1">
            {[["Completed", CHART_COLORS.completed], ["Failed", CHART_COLORS.failed], ["Running", CHART_COLORS.other]].map(([label, color]) => (
              <div key={label} className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
                <span className="text-xs text-apex-muted">{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Donut */}
        <div className="card-glass animate-fade-in-up stagger-2 flex flex-col">
          <div className="flex items-center gap-2 mb-4">
            <Target size={16} className="text-apex-indigo-light" />
            <h2 className="section-title">Success Rate</h2>
          </div>
          {pieData.length === 0 ? (
            <EmptyChart icon={CheckCircle} label="No data yet" />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center">
              <div className="relative">
                <ResponsiveContainer width={200} height={200}>
                  <PieChart>
                    <Pie data={pieData} cx="50%" cy="50%" innerRadius={62} outerRadius={88}
                      paddingAngle={3} dataKey="value" strokeWidth={0}>
                      {pieData.map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <RechartsTooltip content={<CustomChartTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                {/* Center label */}
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-3xl font-bold">{stats?.successRate ?? 0}%</span>
                  <span className="text-xs text-apex-muted">success</span>
                </div>
              </div>
              <div className="flex items-center gap-4 mt-2">
                {pieData.map((d, i) => (
                  <div key={d.name} className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <span className="text-xs text-apex-muted">{d.name}</span>
                    <span className="text-xs text-white font-medium">{d.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ══ Agents Table + Live Feed ════════════════════ */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-5 mb-8">

        {/* Agent Status Table */}
        <div className="xl:col-span-3 card-glass animate-fade-in-up overflow-hidden">
          <div className="section-header">
            <div className="flex items-center gap-2">
              <Bot size={16} className="text-apex-indigo-light" />
              <h2 className="section-title">Agent Status</h2>
            </div>
            <Link href="/agents" className="section-link">
              View all <ArrowRight size={13} />
            </Link>
          </div>

          {agents.length === 0 ? (
            <div className="text-center py-10">
              <div className="w-12 h-12 rounded-xl bg-apex-indigo/10 border border-apex-indigo/20 flex items-center justify-center mx-auto mb-3">
                <Bot size={20} className="text-apex-indigo-light" />
              </div>
              <p className="text-sm text-apex-muted">No agents deployed yet</p>
              <Link href="/onboarding" className="text-apex-indigo-light text-sm mt-1 inline-block hover:underline">Deploy your first agent →</Link>
            </div>
          ) : (
            <div className="overflow-x-auto -mx-6">
              <table className="w-full text-sm data-table">
                <thead>
                  <tr className="border-b border-apex-border/40">
                    {[
                      { key: "name", label: "Agent" },
                      { key: "domain", label: "Domain" },
                      { key: "status", label: "Status" },
                      { key: "runs", label: "Runs" },
                    ].map((col) => (
                      <th key={col.key} onClick={() => handleSort(col.key)} className="hover:text-white transition-colors">
                        <span className="flex items-center gap-1">
                          {col.label}
                          {sortCol === col.key && (
                            <span className="text-apex-indigo-light">{sortDir === "asc" ? "↑" : "↓"}</span>
                          )}
                        </span>
                      </th>
                    ))}
                    <th>Success</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAgents.map((agent) => {
                    const agentTop = topAgentsData.find((t) => t.id === agent.id);
                    const dc = DOMAIN_COLORS[agent.domain] ?? DOMAIN_COLORS.OPS;
                    const isActive = agent.status === "ACTIVE";
                    return (
                      <tr key={agent.id}>
                        <td>
                          <Link href={`/agents/${agent.id}`} className="font-medium hover:text-apex-indigo-light transition-colors flex items-center gap-2">
                            <span className={`live-dot ${isActive ? "" : "opacity-0"}`} />
                            {agent.name}
                          </Link>
                        </td>
                        <td>
                          <span className={`badge text-[10px] ${dc.bg} ${dc.text} border ${dc.border}`}>
                            {agent.domain}
                          </span>
                        </td>
                        <td>
                          <span className={`badge ${isActive ? "badge-green" : "badge-yellow"}`}>
                            {isActive && <span className="live-dot" />}
                            {agent.status}
                          </span>
                        </td>
                        <td className="font-medium tabular-nums">{agent._count?.runs || 0}</td>
                        <td>
                          {agentTop && agentTop.runs > 0 ? (
                            <div className="flex items-center gap-2">
                              <div className="progress-bar w-20">
                                <div
                                  className="progress-fill"
                                  style={{
                                    width: `${agentTop.successRate}%`,
                                    background: agentTop.successRate >= 80 ? "#22c55e" : agentTop.successRate >= 60 ? "#eab308" : "#ef4444",
                                  }}
                                />
                              </div>
                              <span className="text-xs text-apex-muted tabular-nums">{agentTop.successRate}%</span>
                            </div>
                          ) : (
                            <span className="text-xs text-apex-muted">—</span>
                          )}
                        </td>
                        <td className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => handleTriggerRun(agent)}
                              className="p-1.5 rounded-md hover:bg-green-500/10 hover:text-green-400 text-apex-muted transition-colors"
                              title="Run now"
                            >
                              <Play size={13} />
                            </button>
                            <button
                              onClick={() => handleToggleAgent(agent)}
                              className="p-1.5 rounded-md hover:bg-apex-surface text-apex-muted hover:text-white transition-colors"
                              title={isActive ? "Pause" : "Resume"}
                            >
                              {isActive ? <Pause size={13} /> : <Play size={13} />}
                            </button>
                            <Link href={`/agents/${agent.id}`} className="p-1.5 rounded-md hover:bg-apex-surface text-apex-muted hover:text-white transition-colors">
                              <ArrowRight size={13} />
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Live Activity Feed */}
        <div className="xl:col-span-2 card-glass animate-fade-in-up overflow-hidden flex flex-col">
          <div className="section-header flex-shrink-0">
            <div className="flex items-center gap-2">
              <span className="live-dot" />
              <h2 className="section-title">Live Activity</h2>
            </div>
            <button onClick={() => mutateRuns()} className="btn-ghost flex items-center gap-1 py-1">
              <RefreshCw size={12} /> Refresh
            </button>
          </div>

          <div className="flex-1 overflow-y-auto space-y-2 -mx-1 px-1 max-h-72">
            {runs.length === 0 ? (
              <div className="text-center py-8 text-apex-muted text-sm">No recent activity</div>
            ) : (
              runs.slice(0, 15).map((run) => {
                const statusStyle = RUN_STATUS_STYLES[run.status] ?? { cls: "badge-gray" };
                const isRunning = run.status === "RUNNING";
                return (
                  <div
                    key={run.id}
                    className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.04] hover:border-white/10 transition-all group"
                  >
                    <div className="flex-shrink-0 mt-0.5">
                      {run.status === "COMPLETED" && <CheckCircle size={14} className="text-green-400" />}
                      {run.status === "FAILED" && <XCircle size={14} className="text-red-400" />}
                      {isRunning && <span className="live-dot-blue block w-2 h-2 mt-1" />}
                      {run.status === "QUEUED" && <Clock size={14} className="text-yellow-400" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-white truncate">{run.agent?.name ?? "Unknown"}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`badge text-[10px] py-0 ${statusStyle.cls}`}>
                          {statusStyle.dot && <span className={statusStyle.dot} />}
                          {run.status}
                        </span>
                        {run.completedAt && (
                          <span className="text-[10px] text-apex-muted">{formatDuration(run.startedAt, run.completedAt)}</span>
                        )}
                      </div>
                    </div>
                    <span className="text-[10px] text-apex-muted flex-shrink-0">{timeAgo(run.startedAt)}</span>
                  </div>
                );
              })
            )}
          </div>

          <div className="flex-shrink-0 pt-3 border-t border-apex-border/40 mt-3">
            <Link href="/activity" className="section-link text-xs w-full justify-center flex">
              View full history <ArrowRight size={12} />
            </Link>
          </div>
        </div>
      </div>

      {/* ══ Run History ═════════════════════════════════ */}
      <div className="card-glass mb-8 overflow-hidden animate-fade-in-up">
        <div className="section-header">
          <div className="flex items-center gap-2">
            <FileText size={16} className="text-apex-indigo-light" />
            <h2 className="section-title">Run History</h2>
          </div>
          <Link href="/activity" className="section-link">View all <ArrowRight size={13} /></Link>
        </div>
        {runs.length === 0 ? (
          <EmptyChart icon={FileText} label="No runs recorded yet" />
        ) : (
          <div className="overflow-x-auto -mx-6">
            <table className="w-full text-sm data-table">
              <thead>
                <tr className="border-b border-apex-border/40">
                  <th className="w-8" />
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Tokens</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {runs.slice(0, 15).map((run) => {
                  const isExpanded = expandedRun === run.id;
                  const logs = run.logs || [];
                  return (
                    <RunHistoryRow
                      key={run.id} run={run} logs={logs}
                      isExpanded={isExpanded}
                      onToggle={() => setExpandedRun(isExpanded ? null : run.id)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ══ Domain Breakdown ════════════════════════════ */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
        {(["SALES", "MARKETING", "OPS"] as const).map((domain, di) => {
          const dc = DOMAIN_COLORS[domain];
          const agentCount = stats?.agentsByDomain?.[domain] || 0;
          const runsCount = stats?.runsByDomain?.[domain] || 0;
          const domainAgents = topAgentsData.filter((a) => a.domain === domain);
          const dCompleted = domainAgents.reduce((s, a) => s + Math.round(a.runs * a.successRate / 100), 0);
          const dFailed = domainAgents.reduce((s, a) => s + (a.runs - Math.round(a.runs * a.successRate / 100)), 0);
          const topAgent = domainAgents[0] ?? null;
          return (
            <div key={domain} className={`card-glass animate-fade-in-up stagger-${di + 1}`}>
              <div className="flex items-center justify-between mb-4">
                <span className={`text-xs font-bold uppercase tracking-wider ${dc.text}`}>{domain}</span>
                <span className={`badge text-[10px] ${dc.bg} ${dc.text} border ${dc.border}`}>{agentCount} agents</span>
              </div>
              <div className="flex items-center gap-4 mb-4">
                <MiniDonut success={dCompleted} fail={dFailed} size={68} />
                <div>
                  <p className="text-3xl font-bold tabular-nums">{runsCount}</p>
                  <p className="text-xs text-apex-muted">runs this week</p>
                  {topAgent && (
                    <p className="text-xs text-apex-muted mt-1">
                      Top: <Link href={`/agents/${topAgent.id}`} className={`${dc.text} hover:underline`}>{topAgent.name}</Link>
                    </p>
                  )}
                </div>
              </div>
              {/* Mini bar chart for this domain */}
              {domainAgents.filter((a) => a.runs > 0).length > 0 && (
                <div className="space-y-1.5 mt-2 pt-3 border-t border-white/[0.05]">
                  {domainAgents.filter((a) => a.runs > 0).slice(0, 3).map((a) => {
                    const max = Math.max(...domainAgents.map((x) => x.runs), 1);
                    return (
                      <div key={a.id} className="flex items-center gap-2">
                        <Link href={`/agents/${a.id}`} className="text-xs text-apex-muted w-24 truncate hover:text-white transition-colors">{a.name}</Link>
                        <div className="flex-1 h-1.5 bg-apex-surface rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${dc.bg.replace("bg-", "bg-")}`}
                            style={{ width: `${(a.runs / max) * 100}%`, background: dc.text.replace("text-", "") }} />
                        </div>
                        <span className="text-[10px] text-apex-muted tabular-nums w-6 text-right">{a.runs}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ══ Alerts ══════════════════════════════════════ */}
      {alerts.length > 0 && (
        <div className="card-glass mb-8 animate-fade-in-up">
          <div className="flex items-center gap-2 mb-4">
            <AlertTriangle size={16} className="text-yellow-400" />
            <h2 className="section-title">Alerts & Recommendations</h2>
          </div>
          <div className="space-y-2.5">
            {alerts.map((alert, i) => (
              <AlertCard key={i} alert={alert} />
            ))}
          </div>
        </div>
      )}

      {/* ══ Token Usage ══════════════════════════════════ */}
      <div className="card-glass animate-fade-in-up">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <TrendingUp size={16} className="text-apex-indigo-light" />
            <h2 className="section-title">Token Usage & Cost</h2>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <span className="text-apex-muted">Today: <span className="text-white font-semibold">${(stats?.costToday ?? 0).toFixed(3)}</span></span>
            <span className="text-apex-muted">Week: <span className="text-white font-semibold">${weekCost.toFixed(2)}</span></span>
            <span className="text-apex-muted">Total: <span className="text-white font-semibold">${(stats?.totalCost ?? 0).toFixed(2)}</span></span>
          </div>
        </div>

        {/* Per-agent token bars */}
        {topAgentsData.filter((a) => a.runs > 0).length > 0 && (
          <div className="space-y-3">
            {topAgentsData.filter((a) => a.runs > 0).map((agent) => {
              const max = Math.max(...topAgentsData.map((a) => a.avgTokens * a.runs), 1);
              const pct = ((agent.avgTokens * agent.runs) / max) * 100;
              const cost = (agent.avgTokens * agent.runs / 1000) * 0.005;
              return (
                <div key={agent.id} className="flex items-center gap-3">
                  <Link href={`/agents/${agent.id}`} className="text-xs w-32 truncate text-apex-muted hover:text-white transition-colors">{agent.name}</Link>
                  <div className="flex-1 progress-bar">
                    <div className="progress-fill bg-gradient-to-r from-apex-indigo to-apex-indigo-light" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs text-apex-muted tabular-nums w-16 text-right">{formatNum(agent.avgTokens * agent.runs)}</span>
                  <span className="text-xs text-cyan-400/70 tabular-nums w-14 text-right">${cost.toFixed(3)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────

function KPICard({ label, value, icon: Icon, color, iconBg, sub, trend, delay }: {
  label: string; value: string | number; icon: typeof Bot;
  color: string; iconBg: string; sub?: string; trend?: number; delay?: string;
}) {
  return (
    <div className={`kpi-card animate-fade-in-up ${delay ?? ""} group cursor-default`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-apex-muted text-xs font-medium">{label}</span>
        <div className={`w-7 h-7 rounded-lg ${iconBg} flex items-center justify-center group-hover:scale-110 transition-transform`}>
          <Icon size={14} className={color} />
        </div>
      </div>
      <div className="flex items-end gap-2">
        <p className="text-2xl font-bold tabular-nums">{value}</p>
        {trend !== undefined && trend !== 0 && (
          <span className={trend > 0 ? "trend-up mb-1" : "trend-down mb-1"}>
            {trend > 0 ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
            {Math.abs(trend)}%
          </span>
        )}
      </div>
      {sub && <p className="text-xs text-apex-muted mt-1">{sub}</p>}
    </div>
  );
}

function RunHistoryRow({ run, logs, isExpanded, onToggle }: {
  run: Run; logs: RunLog[]; isExpanded: boolean; onToggle: () => void;
}) {
  const statusStyle = RUN_STATUS_STYLES[run.status] ?? { cls: "badge-gray" };
  return (
    <>
      <tr className="cursor-pointer" onClick={onToggle}>
        <td className="px-5 py-3">
          {logs.length > 0
            ? (isExpanded ? <ChevronDown size={13} className="text-apex-muted" /> : <ChevronRight size={13} className="text-apex-muted" />)
            : <span className="w-3.5 block" />}
        </td>
        <td className="px-5 py-3 font-medium">{run.agent?.name || "Unknown"}</td>
        <td className="px-5 py-3">
          <span className={`badge ${statusStyle.cls}`}>
            {statusStyle.dot && <span className={statusStyle.dot} />}
            {run.status}
          </span>
        </td>
        <td className="px-5 py-3 text-apex-muted">
          <span className="inline-flex items-center gap-1">
            <Clock size={11} />{formatDuration(run.startedAt, run.completedAt)}
          </span>
        </td>
        <td className="px-5 py-3 text-apex-muted tabular-nums">{run.tokensUsed > 0 ? formatNum(run.tokensUsed) : "—"}</td>
        <td className="px-5 py-3 text-apex-muted text-xs">{formatDate(run.startedAt)} {formatTime(run.startedAt)}</td>
      </tr>
      {isExpanded && logs.length > 0 && (
        <tr>
          <td colSpan={6} className="px-5 pb-3">
            <div className="bg-[#050f1e] rounded-xl p-4 max-h-56 overflow-y-auto font-mono text-xs border border-apex-indigo/10">
              {logs.map((log) => (
                <div key={log.id} className="flex gap-3 py-0.5 hover:bg-white/[0.02] rounded px-1">
                  <span className="text-apex-muted flex-shrink-0 w-16 tabular-nums">{formatTime(log.createdAt)}</span>
                  <span className={`flex-shrink-0 w-10 uppercase font-semibold text-[10px] ${log.level === "ERROR" ? "text-red-400" : log.level === "WARN" ? "text-yellow-400" : log.level === "DEBUG" ? "text-gray-600" : "text-blue-400"
                    }`}>{log.level}</span>
                  <span className="text-gray-300 break-all">{log.message}</span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AlertCard({ alert }: { alert: { type: "warning" | "error" | "info"; message: string; action?: string; href?: string } }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className={`flex items-center gap-3 p-3 rounded-xl border transition-all animate-fade-in ${alert.type === "error" ? "bg-red-500/5 border-red-500/15" :
        alert.type === "warning" ? "bg-yellow-500/5 border-yellow-500/15" :
          "bg-blue-500/5 border-blue-500/15"
      }`}>
      {alert.type === "error" ? <XCircle size={15} className="text-red-400 flex-shrink-0" /> :
        alert.type === "warning" ? <AlertTriangle size={15} className="text-yellow-400 flex-shrink-0" /> :
          <Zap size={15} className="text-blue-400 flex-shrink-0" />}
      <p className="text-sm flex-1">{alert.message}</p>
      <div className="flex items-center gap-2 flex-shrink-0">
        {alert.action && alert.href && (
          <Link href={alert.href} className={`text-xs font-medium hover:underline ${alert.type === "error" ? "text-red-400" : alert.type === "warning" ? "text-yellow-400" : "text-blue-400"
            }`}>{alert.action}</Link>
        )}
        <button onClick={() => setDismissed(true)} className="text-apex-muted hover:text-white transition-colors text-xs">✕</button>
      </div>
    </div>
  );
}

function EmptyChart({ icon: Icon, label }: { icon: typeof Activity; label: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-52 text-apex-muted text-sm gap-2">
      <Icon size={24} className="text-apex-border" />
      {label}
    </div>
  );
}

function MiniDonut({ success, fail, size = 80 }: { success: number; fail: number; size?: number }) {
  const total = success + fail;
  const pct = total > 0 ? (success / total) * 100 : 0;
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <div className="absolute inset-0 rounded-full" style={{
        background: total > 0
          ? `conic-gradient(#22c55e 0% ${pct}%, #ef4444 ${pct}% 100%)`
          : "conic-gradient(#1e2d3d 0% 100%)",
      }} />
      <div className="absolute inset-2 rounded-full bg-[#020e1f] flex items-center justify-center">
        <span className="text-sm font-bold tabular-nums">{Math.round(pct)}%</span>
      </div>
    </div>
  );
}
