"use client";

import { useState } from "react";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import {
  Bot, Activity, Zap, TrendingUp, Plus, ArrowRight,
  Play, Pause, CheckCircle, XCircle, AlertTriangle, DollarSign,
  ArrowUpRight, ArrowDownRight, ChevronDown, ChevronRight, Clock,
  FileText,
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from "recharts";
import { api } from "@/lib/api";
import { useOrg, useDashboardData } from "@/lib/hooks";
import { StatSkeleton, TableRowSkeleton } from "@/components/ui/skeleton";

// ─── Types ──────────────────────────────────────────────
interface OrgStats {
  activeAgents: number;
  pausedAgents: number;
  totalAgents: number;
  totalRuns: number;
  runsToday: number;
  runsThisWeek: number;
  successRate: number;
  integrations: number;
  tokensUsed: number;
  tokensToday: number;
  totalCost: number;
  costToday: number;
  runsByDay: DayStats[];
  tokensByDay: TokenDay[];
  topAgents: TopAgent[];
  recentFailures: Array<{ runId: string; agentName: string; error: string; timestamp: string }>;
  agentsByDomain: Record<string, number>;
  runsByDomain: Record<string, number>;
}

interface DayStats { date: string; total: number; completed: number; failed: number }
interface TokenDay { date: string; tokens: number; cost: number }
interface TopAgent { id: string; name: string; domain: string; runs: number; successRate: number; avgTokens: number }

interface Agent {
  id: string;
  name: string;
  domain: string;
  status: string;
  template: { id: string; name: string; domain: string };
  schedule: string | null;
  createdAt: string;
  _count?: { runs: number };
}

interface RunLog {
  id: string;
  level: string;
  message: string;
  createdAt: string;
}

interface Run {
  id: string;
  agentId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  tokensUsed: number;
  cost: number;
  agent?: { name: string; domain: string };
  logs?: RunLog[];
  stepCount?: number;
  _count?: { logs: number };
}

// ─── Utilities ──────────────────────────────────────────
function formatNum(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toLocaleString();
}

function formatDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return "—";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "bg-green-500/10 text-green-400",
  PAUSED: "bg-yellow-500/10 text-yellow-400",
  ERROR: "bg-red-500/10 text-red-400",
  DEPLOYING: "bg-blue-500/10 text-blue-400",
};

const STATUS_DOT: Record<string, string> = {
  ACTIVE: "bg-green-400",
  PAUSED: "bg-yellow-400",
  ERROR: "bg-red-400",
  DEPLOYING: "bg-blue-400",
};

const RUN_STATUS_COLORS: Record<string, string> = {
  COMPLETED: "bg-green-500/10 text-green-400",
  FAILED: "bg-red-500/10 text-red-400",
  RUNNING: "bg-blue-500/10 text-blue-400",
  QUEUED: "bg-yellow-500/10 text-yellow-400",
  CANCELLED: "bg-gray-500/10 text-gray-400",
};

const CHART_COLORS = {
  completed: "#22c55e",
  failed: "#ef4444",
  other: "#3b82f6",
};

const PIE_COLORS = ["#22c55e", "#ef4444", "#3b82f6", "#eab308"];

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
  const [sortCol, setSortCol] = useState<string>("runs");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  const isLoading = orgLoading || dataLoading;

  async function handleToggleAgent(agent: Agent) {
    try {
      if (agent.status === "ACTIVE") {
        await api.agents.pause(agent.id);
      } else {
        await api.agents.deploy(agent.id);
      }
    } catch { /* ignore */ }
  }

  async function handleTriggerRun(agent: Agent) {
    if (!orgId) return;
    try {
      await api.runs.trigger(agent.id, orgId);
      mutateRuns();
    } catch { /* ignore */ }
  }

  function handleSort(col: string) {
    if (sortCol === col) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  }

  // ─── Loading State ──────────────────────────────────
  if (isLoading) {
    return (
      <div>
        <div className="flex items-center justify-between mb-8">
          <div>
            <div className="h-7 w-40 bg-apex-surface rounded animate-pulse" />
            <div className="h-4 w-64 bg-apex-surface rounded animate-pulse mt-2" />
          </div>
          <div className="h-10 w-32 bg-apex-surface rounded-lg animate-pulse" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
          {Array.from({ length: 6 }).map((_, i) => <StatSkeleton key={i} />)}
        </div>
        <div className="card mb-8">
          <div className="h-5 w-48 bg-apex-surface rounded animate-pulse mb-4" />
          <div className="h-52 bg-apex-surface rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 mb-8">
          <div className="lg:col-span-3 card">
            <div className="h-5 w-40 bg-apex-surface rounded animate-pulse mb-4" />
            {Array.from({ length: 4 }).map((_, i) => <TableRowSkeleton key={i} />)}
          </div>
          <div className="lg:col-span-2 card">
            <div className="h-5 w-32 bg-apex-surface rounded animate-pulse mb-4" />
            <div className="h-64 bg-apex-surface rounded animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  // ─── No Org State ───────────────────────────────────
  if (!orgId) {
    return (
      <div className="card text-center py-16">
        <Bot size={48} className="mx-auto text-apex-border mb-4" />
        <h2 className="text-lg font-semibold mb-2">Get started</h2>
        <p className="text-apex-muted mb-6 max-w-md mx-auto">Set up your organization and deploy your first AI agent.</p>
        <Link href="/onboarding" className="btn-primary inline-flex items-center gap-2"><Plus size={16} /> Start Onboarding</Link>
      </div>
    );
  }

  // ─── Derived Data ───────────────────────────────────
  const runsByDay: DayStats[] = stats?.runsByDay || [];
  const tokensByDay: TokenDay[] = stats?.tokensByDay || [];
  const topAgentsData: TopAgent[] = stats?.topAgents || [];

  // Chart data for Recharts
  const activityChartData = runsByDay.map((day) => ({
    date: new Date(day.date + "T00:00:00").toLocaleDateString("en-US", { weekday: "short" }),
    Completed: day.completed,
    Failed: day.failed,
    Other: Math.max(0, day.total - day.completed - day.failed),
  }));

  // Donut data for success/failure
  const totalCompleted = runsByDay.reduce((s, d) => s + d.completed, 0);
  const totalFailed = runsByDay.reduce((s, d) => s + d.failed, 0);
  const totalOther = runsByDay.reduce((s, d) => s + Math.max(0, d.total - d.completed - d.failed), 0);
  const pieData = [
    { name: "Completed", value: totalCompleted },
    { name: "Failed", value: totalFailed },
    { name: "Running", value: totalOther },
  ].filter((d) => d.value > 0);

  // Sort agents
  const sortedAgents = [...agents].sort((a, b) => {
    let aVal: number | string = 0, bVal: number | string = 0;
    if (sortCol === "name") { aVal = a.name.toLowerCase(); bVal = b.name.toLowerCase(); }
    else if (sortCol === "domain") { aVal = a.domain; bVal = b.domain; }
    else if (sortCol === "status") { aVal = a.status; bVal = b.status; }
    else if (sortCol === "runs") { aVal = a._count?.runs || 0; bVal = b._count?.runs || 0; }
    if (typeof aVal === "string") return sortDir === "asc" ? aVal.localeCompare(bVal as string) : (bVal as string).localeCompare(aVal);
    return sortDir === "asc" ? aVal - (bVal as number) : (bVal as number) - aVal;
  });

  // Alerts
  const alerts: Array<{ type: "warning" | "error" | "info"; message: string }> = [];
  const staleAgents = agents.filter((a) => {
    const agentTop = topAgentsData.find((t) => t.id === a.id);
    return agentTop && agentTop.runs === 0;
  });
  if (staleAgents.length > 0) {
    alerts.push({ type: "warning", message: `${staleAgents.length} agent${staleAgents.length > 1 ? "s" : ""} haven't run in 7+ days` });
  }
  const lowSuccessAgents = topAgentsData.filter((a) => a.runs > 0 && a.successRate < 50);
  for (const a of lowSuccessAgents) {
    alerts.push({ type: "error", message: `${a.name} has ${a.successRate}% failure rate - check configuration` });
  }
  if (stats && stats.integrations === 0) {
    alerts.push({ type: "info", message: "No integrations connected - connect to enable real outreach" });
  }

  const weekCost = tokensByDay.reduce((sum, d) => sum + d.cost, 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-apex-muted mt-1">
            {user?.firstName ? `Welcome back, ${user.firstName}` : "Command center for your AI workforce"}
          </p>
        </div>
        <Link href="/onboarding" className="btn-primary flex items-center gap-2">
          <Plus size={16} /> New Agent
        </Link>
      </div>

      {error && (
        <div className="card border-red-500/30 bg-red-500/5 mb-6">
          <p className="text-red-400 text-sm">{error instanceof Error ? error.message : "Failed to load dashboard"}</p>
        </div>
      )}

      {/* ─── Section 1: KPI Bar ──────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
        <KPICard label="Active Agents" value={stats?.activeAgents ?? 0} icon={Bot} color="text-indigo-400" sub={`${stats?.totalAgents ?? 0} total`} />
        <KPICard
          label="Runs Today" value={stats?.runsToday ?? 0} icon={Activity} color="text-green-400"
          sub={`${stats?.runsThisWeek ?? 0} this week`}
          trend={stats?.runsToday !== undefined && stats.runsThisWeek > 0 ? Math.round((stats.runsToday / (stats.runsThisWeek / 7)) * 100 - 100) : undefined}
        />
        <KPICard
          label="Success Rate" value={`${stats?.successRate ?? 0}%`} icon={CheckCircle}
          color={(stats?.successRate ?? 0) >= 90 ? "text-green-400" : (stats?.successRate ?? 0) >= 75 ? "text-yellow-400" : "text-red-400"}
          sub={`${stats?.totalRuns ?? 0} total runs`}
        />
        <KPICard label="Tokens Today" value={formatNum(stats?.tokensToday ?? 0)} icon={TrendingUp} color="text-yellow-400" sub={`$${(stats?.costToday ?? 0).toFixed(2)}`} />
        <KPICard label="Total Cost" value={`$${(stats?.totalCost ?? 0).toFixed(2)}`} icon={DollarSign} color="text-cyan-400" sub={`$${weekCost.toFixed(2)} this week`} />
        <KPICard label="Integrations" value={stats?.integrations ?? 0} icon={Zap} color="text-purple-400" sub="connected" />
      </div>

      {/* ─── Section 2: Charts Row ───────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Runs Over Time (Area Chart) */}
        <div className="lg:col-span-2 card">
          <h2 className="text-lg font-semibold mb-4">Runs Over Time (7 Days)</h2>
          {activityChartData.length === 0 ? (
            <div className="flex items-center justify-center h-52 text-apex-muted text-sm">
              <Activity size={24} className="mr-2 text-apex-border" /> No run data yet
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={activityChartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorCompleted" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={CHART_COLORS.completed} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={CHART_COLORS.completed} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorFailed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={CHART_COLORS.failed} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={CHART_COLORS.failed} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#2d3a4d" />
                <XAxis dataKey="date" tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={false} tickLine={false} allowDecimals={false} />
                <RechartsTooltip
                  contentStyle={{ backgroundColor: "#1a2332", border: "1px solid #2d3a4d", borderRadius: "8px", fontSize: 12 }}
                  labelStyle={{ color: "#fff" }}
                />
                <Area type="monotone" dataKey="Completed" stackId="1" stroke={CHART_COLORS.completed} fill="url(#colorCompleted)" />
                <Area type="monotone" dataKey="Failed" stackId="1" stroke={CHART_COLORS.failed} fill="url(#colorFailed)" />
                <Area type="monotone" dataKey="Other" stackId="1" stroke={CHART_COLORS.other} fill={CHART_COLORS.other} fillOpacity={0.1} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Success/Failure Donut */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Success / Failure</h2>
          {pieData.length === 0 ? (
            <div className="flex items-center justify-center h-52 text-apex-muted text-sm">
              <CheckCircle size={24} className="mr-2 text-apex-border" /> No data yet
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="50%" innerRadius={55} outerRadius={80} paddingAngle={3} dataKey="value">
                  {pieData.map((_, index) => (
                    <Cell key={index} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Legend
                  verticalAlign="bottom"
                  formatter={(value: string) => <span className="text-xs text-apex-muted">{value}</span>}
                />
                <RechartsTooltip
                  contentStyle={{ backgroundColor: "#1a2332", border: "1px solid #2d3a4d", borderRadius: "8px", fontSize: 12 }}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* ─── Section 3: Agent Status Cards ────────────────── */}
      <div className="card mb-8 overflow-hidden">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Agent Status</h2>
          <Link href="/agents" className="text-apex-indigo text-sm flex items-center gap-1 hover:underline">
            View all <ArrowRight size={14} />
          </Link>
        </div>
        {agents.length === 0 ? (
          <div className="text-center py-8">
            <Bot size={32} className="mx-auto text-apex-border mb-3" />
            <p className="text-sm text-apex-muted">No agents deployed yet</p>
            <Link href="/onboarding" className="text-apex-indigo text-sm mt-2 inline-block hover:underline">Deploy your first agent</Link>
          </div>
        ) : (
          <div className="overflow-x-auto -mx-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-apex-border text-apex-muted text-xs">
                  {[
                    { key: "name", label: "Agent" },
                    { key: "domain", label: "Domain" },
                    { key: "status", label: "Status" },
                    { key: "runs", label: "Runs" },
                  ].map((col) => (
                    <th key={col.key} className="text-left px-6 py-3 font-medium cursor-pointer hover:text-white transition-colors" onClick={() => handleSort(col.key)}>
                      {col.label}
                      {sortCol === col.key && <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>}
                    </th>
                  ))}
                  <th className="text-left px-6 py-3 font-medium">Success Rate</th>
                  <th className="text-right px-6 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedAgents.map((agent) => {
                  const agentTop = topAgentsData.find((t) => t.id === agent.id);
                  return (
                    <tr key={agent.id} className="border-b border-apex-border/50 hover:bg-apex-surface/50 transition-colors">
                      <td className="px-6 py-3">
                        <Link href={`/agents/${agent.id}`} className="font-medium hover:text-apex-indigo-light transition-colors">{agent.name}</Link>
                      </td>
                      <td className="px-6 py-3">
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-apex-indigo/10 text-apex-indigo-light">{agent.domain}</span>
                      </td>
                      <td className="px-6 py-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[agent.status] || "bg-gray-500/10 text-gray-400"}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[agent.status] || "bg-gray-400"}`} />
                          {agent.status}
                        </span>
                      </td>
                      <td className="px-6 py-3 font-medium">{agent._count?.runs || 0}</td>
                      <td className="px-6 py-3">
                        {agentTop && agentTop.runs > 0 ? (
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 bg-apex-surface rounded-full overflow-hidden">
                              <div className="h-full bg-green-500 rounded-full" style={{ width: `${agentTop.successRate}%` }} />
                            </div>
                            <span className="text-xs text-apex-muted">{agentTop.successRate}%</span>
                          </div>
                        ) : (
                          <span className="text-xs text-apex-muted">—</span>
                        )}
                      </td>
                      <td className="px-6 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => handleTriggerRun(agent)} className="p-1.5 rounded-md hover:bg-apex-surface transition-colors text-apex-muted hover:text-white" title="Run now">
                            <Play size={14} />
                          </button>
                          <button onClick={() => handleToggleAgent(agent)} className="p-1.5 rounded-md hover:bg-apex-surface transition-colors text-apex-muted hover:text-white" title={agent.status === "ACTIVE" ? "Pause" : "Resume"}>
                            {agent.status === "ACTIVE" ? <Pause size={14} /> : <Play size={14} />}
                          </button>
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

      {/* ─── Section 4: Run History Table ─────────────────── */}
      <div className="card mb-8 overflow-hidden">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Run History</h2>
          <Link href="/activity" className="text-apex-indigo text-sm flex items-center gap-1 hover:underline">
            View all <ArrowRight size={14} />
          </Link>
        </div>
        {runs.length === 0 ? (
          <div className="text-center py-8">
            <FileText size={32} className="mx-auto text-apex-border mb-3" />
            <p className="text-sm text-apex-muted">No runs recorded yet</p>
          </div>
        ) : (
          <div className="overflow-x-auto -mx-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-apex-border text-apex-muted text-xs">
                  <th className="text-left px-6 py-3 font-medium w-8" />
                  <th className="text-left px-6 py-3 font-medium">Agent</th>
                  <th className="text-left px-6 py-3 font-medium">Status</th>
                  <th className="text-left px-6 py-3 font-medium">Duration</th>
                  <th className="text-left px-6 py-3 font-medium">Tokens</th>
                  <th className="text-left px-6 py-3 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {runs.slice(0, 20).map((run) => {
                  const isExpanded = expandedRun === run.id;
                  const logs = run.logs || [];
                  return (
                    <RunHistoryRow
                      key={run.id}
                      run={run}
                      logs={logs}
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

      {/* ─── Section 5: Domain Breakdown ─────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        {(["SALES", "MARKETING", "OPS"] as const).map((domain) => {
          const agentCount = stats?.agentsByDomain?.[domain] || 0;
          const runsCount = stats?.runsByDomain?.[domain] || 0;
          const domainAgents = topAgentsData.filter((a) => a.domain === domain);
          const dCompleted = domainAgents.reduce((s, a) => s + Math.round(a.runs * a.successRate / 100), 0);
          const dFailed = domainAgents.reduce((s, a) => s + (a.runs - Math.round(a.runs * a.successRate / 100)), 0);
          const topAgent = domainAgents.length > 0 ? domainAgents[0] : null;
          const domainColor = domain === "SALES" ? "text-blue-400" : domain === "MARKETING" ? "text-purple-400" : "text-orange-400";

          return (
            <div key={domain} className="card">
              <div className="flex items-center justify-between mb-4">
                <h3 className={`text-sm font-semibold ${domainColor}`}>{domain}</h3>
                <span className="text-xs text-apex-muted">{agentCount} agents</span>
              </div>
              <div className="flex items-center gap-4">
                <MiniDonut success={dCompleted} fail={dFailed} size={64} />
                <div className="flex-1">
                  <p className="text-2xl font-bold">{runsCount}</p>
                  <p className="text-xs text-apex-muted">runs this week</p>
                  {topAgent && (
                    <p className="text-xs text-apex-muted mt-1">
                      Top: <Link href={`/agents/${topAgent.id}`} className="text-apex-indigo-light hover:underline">{topAgent.name}</Link>
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ─── Section 6: Alerts & Recommendations ─────────── */}
      {alerts.length > 0 && (
        <div className="card mb-8">
          <h2 className="text-lg font-semibold mb-4">Alerts & Recommendations</h2>
          <div className="space-y-3">
            {alerts.map((alert, i) => (
              <div key={i} className={`flex items-start gap-3 p-3 rounded-lg ${
                alert.type === "error" ? "bg-red-500/5 border border-red-500/20" :
                alert.type === "warning" ? "bg-yellow-500/5 border border-yellow-500/20" :
                "bg-blue-500/5 border border-blue-500/20"
              }`}>
                {alert.type === "error" ? <XCircle size={16} className="text-red-400 mt-0.5 flex-shrink-0" /> :
                 alert.type === "warning" ? <AlertTriangle size={16} className="text-yellow-400 mt-0.5 flex-shrink-0" /> :
                 <Zap size={16} className="text-blue-400 mt-0.5 flex-shrink-0" />}
                <p className="text-sm">{alert.message}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── Section 7: Token Usage & Cost ───────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Token Usage & Cost</h2>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-apex-muted">Today: <span className="text-white font-medium">${(stats?.costToday ?? 0).toFixed(2)}</span></span>
            <span className="text-apex-muted">This Week: <span className="text-white font-medium">${weekCost.toFixed(2)}</span></span>
            <span className="text-apex-muted">Total: <span className="text-white font-medium">${(stats?.totalCost ?? 0).toFixed(2)}</span></span>
          </div>
        </div>
        <div className="mb-6">
          <div className="flex items-center justify-between text-xs text-apex-muted mb-2">
            <span>{formatNum(stats?.tokensUsed ?? 0)} tokens used</span>
            <span>Plan limit varies</span>
          </div>
          <div className="w-full h-3 bg-apex-surface rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-apex-indigo to-apex-indigo-light rounded-full transition-all"
              style={{ width: `${Math.min(100, ((stats?.tokensUsed ?? 0) / Math.max(stats?.tokensUsed ?? 1, 100000)) * 100)}%` }}
            />
          </div>
        </div>
        {topAgentsData.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-apex-muted mb-3">Per-Agent Usage (7 days)</h3>
            <div className="space-y-2">
              {topAgentsData.filter((a) => a.runs > 0).map((agent) => {
                const maxTokens = Math.max(...topAgentsData.map((a) => a.avgTokens * a.runs), 1);
                const width = ((agent.avgTokens * agent.runs) / maxTokens) * 100;
                return (
                  <div key={agent.id} className="flex items-center gap-3">
                    <Link href={`/agents/${agent.id}`} className="text-sm w-36 truncate hover:text-apex-indigo-light transition-colors">{agent.name}</Link>
                    <div className="flex-1 h-2 bg-apex-surface rounded-full overflow-hidden">
                      <div className="h-full bg-apex-indigo/60 rounded-full" style={{ width: `${width}%` }} />
                    </div>
                    <span className="text-xs text-apex-muted w-20 text-right">{formatNum(agent.avgTokens * agent.runs)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Run History Row ─────────────────────────────────────
function RunHistoryRow({ run, logs, isExpanded, onToggle }: {
  run: Run;
  logs: RunLog[];
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-b border-apex-border/50 hover:bg-apex-surface/50 transition-colors cursor-pointer" onClick={onToggle}>
        <td className="px-6 py-3">
          {logs.length > 0 ? (
            isExpanded ? <ChevronDown size={14} className="text-apex-muted" /> : <ChevronRight size={14} className="text-apex-muted" />
          ) : (
            <span className="w-3.5" />
          )}
        </td>
        <td className="px-6 py-3 font-medium">{run.agent?.name || "Unknown"}</td>
        <td className="px-6 py-3">
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${RUN_STATUS_COLORS[run.status] || "bg-gray-500/10 text-gray-400"}`}>
            {run.status === "RUNNING" && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
            {run.status}
          </span>
        </td>
        <td className="px-6 py-3 text-apex-muted">
          <span className="inline-flex items-center gap-1">
            <Clock size={12} />
            {formatDuration(run.startedAt, run.completedAt)}
          </span>
        </td>
        <td className="px-6 py-3 text-apex-muted">{run.tokensUsed > 0 ? formatNum(run.tokensUsed) : "—"}</td>
        <td className="px-6 py-3 text-apex-muted">
          {formatDate(run.startedAt)} {formatTime(run.startedAt)}
        </td>
      </tr>
      {isExpanded && logs.length > 0 && (
        <tr>
          <td colSpan={6} className="px-6 py-0">
            <div className="bg-apex-surface/50 rounded-lg p-4 my-2 max-h-64 overflow-y-auto font-mono text-xs">
              {logs.map((log) => (
                <div key={log.id} className="flex gap-3 py-1">
                  <span className="text-apex-muted flex-shrink-0 w-20">{formatTime(log.createdAt)}</span>
                  <span className={`flex-shrink-0 w-12 uppercase font-medium ${
                    log.level === "ERROR" ? "text-red-400" :
                    log.level === "WARN" ? "text-yellow-400" :
                    log.level === "DEBUG" ? "text-gray-500" : "text-blue-400"
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

// ─── KPI Card Component ─────────────────────────────────
function KPICard({ label, value, icon: Icon, color, sub, trend }: {
  label: string;
  value: string | number;
  icon: typeof Bot;
  color: string;
  sub?: string;
  trend?: number;
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <span className="text-apex-muted text-xs">{label}</span>
        <Icon size={16} className={color} />
      </div>
      <div className="flex items-end gap-2">
        <p className="text-2xl font-bold">{value}</p>
        {trend !== undefined && trend !== 0 && (
          <span className={`flex items-center text-xs mb-1 ${trend > 0 ? "text-green-400" : "text-red-400"}`}>
            {trend > 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
            {Math.abs(trend)}%
          </span>
        )}
      </div>
      {sub && <p className="text-xs text-apex-muted mt-1">{sub}</p>}
    </div>
  );
}

// ─── Mini Donut ─────────────────────────────────────────
function MiniDonut({ success, fail, size = 80 }: { success: number; fail: number; size?: number }) {
  const total = success + fail;
  const successPct = total > 0 ? (success / total) * 100 : 0;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: total > 0
            ? `conic-gradient(#22c55e 0% ${successPct}%, #ef4444 ${successPct}% 100%)`
            : `conic-gradient(#2d3a4d 0% 100%)`,
        }}
      />
      <div className="absolute inset-2 rounded-full bg-apex-card flex items-center justify-center">
        <span className="text-sm font-bold">{Math.round(successPct)}%</span>
      </div>
    </div>
  );
}
