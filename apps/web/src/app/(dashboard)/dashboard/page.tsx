"use client";

import { useState, useEffect, useCallback } from "react";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import {
  Bot, Activity, Zap, TrendingUp, TrendingDown, Plus, ArrowRight, Loader2,
  Play, Pause, CheckCircle, XCircle, Clock, AlertTriangle, DollarSign,
  BarChart3, ArrowUpRight, ArrowDownRight,
} from "lucide-react";
import { api } from "@/lib/api";

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
  runsByDay: Array<{ date: string; total: number; completed: number; failed: number }>;
  tokensByDay: Array<{ date: string; tokens: number; cost: number }>;
  topAgents: Array<{ id: string; name: string; domain: string; runs: number; successRate: number; avgTokens: number }>;
  recentFailures: Array<{ runId: string; agentName: string; error: string; timestamp: string }>;
  agentsByDomain: Record<string, number>;
  runsByDomain: Record<string, number>;
}

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

interface Run {
  id: string;
  agentId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  tokensUsed: number;
  cost: number;
  agent?: { name: string; domain: string };
}

// ─── Utility Components ─────────────────────────────────

function DonutChart({ success, fail, size = 80 }: { success: number; fail: number; size?: number }) {
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

function formatDay(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short" });
}

function formatNum(n: number) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toLocaleString();
}

// ─── Main Dashboard ─────────────────────────────────────
export default function DashboardPage() {
  const { user } = useUser();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [stats, setStats] = useState<OrgStats | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [recentRuns, setRecentRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<string>("runs");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [hoveredDay, setHoveredDay] = useState<number | null>(null);

  const loadDashboard = useCallback(async () => {
    if (!user?.id) return;
    try {
      const org = await api.orgs.getByClerkUser(user.id).catch(() => null);
      if (org?.id) {
        setOrgId(org.id);
        const [statsData, agentsData, runsData] = await Promise.all([
          api.orgs.getStats(org.id).catch(() => null),
          api.agents.list(org.id).catch(() => []),
          api.runs.listByOrg(org.id, 20).catch(() => ({ runs: [] })),
        ]);
        if (statsData) setStats(statsData);
        setAgents(Array.isArray(agentsData) ? agentsData : []);
        const runs = Array.isArray(runsData) ? runsData : (runsData?.runs || []);
        setRecentRuns(runs);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  // Auto-refresh every 10 seconds
  useEffect(() => {
    if (!orgId) return;
    const interval = setInterval(loadDashboard, 10000);
    return () => clearInterval(interval);
  }, [orgId, loadDashboard]);

  async function handleToggleAgent(agent: Agent) {
    try {
      if (agent.status === "ACTIVE") {
        await api.agents.pause(agent.id);
        setAgents((prev) => prev.map((a) => a.id === agent.id ? { ...a, status: "PAUSED" } : a));
      } else {
        await api.agents.deploy(agent.id);
        setAgents((prev) => prev.map((a) => a.id === agent.id ? { ...a, status: "ACTIVE" } : a));
      }
    } catch { /* */ }
  }

  async function handleTriggerRun(agent: Agent) {
    if (!orgId) return;
    try {
      const run = await api.runs.trigger(agent.id, orgId);
      setRecentRuns((prev) => [run, ...prev].slice(0, 20));
    } catch { /* */ }
  }

  function handleSort(col: string) {
    if (sortCol === col) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="animate-spin text-apex-indigo" size={32} />
      </div>
    );
  }

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

  // Chart data
  const runsByDay = stats?.runsByDay || [];
  const maxRuns = Math.max(...runsByDay.map((d) => d.total), 1);
  const tokensByDay = stats?.tokensByDay || [];
  const topAgentsData = stats?.topAgents || [];

  // Sort agents for the table
  const sortedAgents = [...agents].sort((a, b) => {
    let aVal: number | string = 0, bVal: number | string = 0;
    if (sortCol === "name") { aVal = a.name.toLowerCase(); bVal = b.name.toLowerCase(); }
    else if (sortCol === "domain") { aVal = a.domain; bVal = b.domain; }
    else if (sortCol === "status") { aVal = a.status; bVal = b.status; }
    else if (sortCol === "runs") { aVal = a._count?.runs || 0; bVal = b._count?.runs || 0; }
    if (typeof aVal === "string") return sortDir === "asc" ? aVal.localeCompare(bVal as string) : (bVal as string).localeCompare(aVal);
    return sortDir === "asc" ? aVal - (bVal as number) : (bVal as number) - aVal;
  });

  // Alerts & recommendations
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

  // Cost calculations
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
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* ─── Section 1: KPI Bar ──────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
        <KPICard
          label="Active Agents"
          value={stats?.activeAgents ?? 0}
          icon={Bot}
          color="text-indigo-400"
          sub={`${stats?.totalAgents ?? 0} total`}
        />
        <KPICard
          label="Runs Today"
          value={stats?.runsToday ?? 0}
          icon={Activity}
          color="text-green-400"
          sub={`${stats?.runsThisWeek ?? 0} this week`}
          trend={stats?.runsToday !== undefined && stats.runsThisWeek > 0
            ? Math.round((stats.runsToday / (stats.runsThisWeek / 7)) * 100 - 100)
            : undefined}
        />
        <KPICard
          label="Success Rate"
          value={`${stats?.successRate ?? 0}%`}
          icon={CheckCircle}
          color={
            (stats?.successRate ?? 0) >= 90 ? "text-green-400" :
            (stats?.successRate ?? 0) >= 75 ? "text-yellow-400" : "text-red-400"
          }
          sub={`${stats?.totalRuns ?? 0} total runs`}
        />
        <KPICard
          label="Tokens Today"
          value={formatNum(stats?.tokensToday ?? 0)}
          icon={TrendingUp}
          color="text-yellow-400"
          sub={`$${(stats?.costToday ?? 0).toFixed(2)}`}
        />
        <KPICard
          label="Total Cost"
          value={`$${(stats?.totalCost ?? 0).toFixed(2)}`}
          icon={DollarSign}
          color="text-cyan-400"
          sub={`$${weekCost.toFixed(2)} this week`}
        />
        <KPICard
          label="Integrations"
          value={stats?.integrations ?? 0}
          icon={Zap}
          color="text-purple-400"
          sub="connected"
        />
      </div>

      {/* ─── Section 2: Activity Chart ───────────────────── */}
      <div className="card mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Activity (Last 7 Days)</h2>
          <div className="flex items-center gap-4 text-xs">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-green-500/80" /> Completed</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-red-500/80" /> Failed</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-blue-500/80" /> Other</span>
          </div>
        </div>
        <div className="flex items-end gap-2 h-44">
          {runsByDay.map((day, i) => {
            const other = Math.max(0, day.total - day.completed - day.failed);
            const isHovered = hoveredDay === i;
            return (
              <div
                key={day.date}
                className="flex-1 flex flex-col justify-end relative"
                onMouseEnter={() => setHoveredDay(i)}
                onMouseLeave={() => setHoveredDay(null)}
              >
                {isHovered && (
                  <div className="absolute -top-16 left-1/2 -translate-x-1/2 bg-apex-surface border border-apex-border rounded-lg p-2 text-xs whitespace-nowrap z-10 shadow-lg">
                    <p className="font-medium mb-1">{new Date(day.date + "T00:00:00").toLocaleDateString()}</p>
                    <p className="text-green-400">{day.completed} completed</p>
                    <p className="text-red-400">{day.failed} failed</p>
                    {other > 0 && <p className="text-blue-400">{other} other</p>}
                  </div>
                )}
                <div className="flex flex-col rounded-t overflow-hidden" style={{ minHeight: day.total > 0 ? 4 : 0 }}>
                  {other > 0 && (
                    <div className="bg-blue-500/80 transition-all" style={{ height: `${(other / maxRuns) * 140}px` }} />
                  )}
                  {day.failed > 0 && (
                    <div className="bg-red-500/80 transition-all" style={{ height: `${(day.failed / maxRuns) * 140}px` }} />
                  )}
                  {day.completed > 0 && (
                    <div className="bg-green-500/80 transition-all rounded-t" style={{ height: `${(day.completed / maxRuns) * 140}px` }} />
                  )}
                </div>
                {day.total === 0 && <div className="bg-apex-border/30 rounded-t" style={{ height: 4 }} />}
                <span className="text-xs text-apex-muted text-center mt-2">{formatDay(day.date)}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ─── Section 3: Two Column Layout ────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 mb-8">
        {/* Left: Agent Performance Table (60%) */}
        <div className="lg:col-span-3 card overflow-hidden">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Agent Performance</h2>
            <Link href="/agents" className="text-apex-indigo text-sm flex items-center gap-1 hover:underline">
              View all <ArrowRight size={14} />
            </Link>
          </div>
          {agents.length === 0 ? (
            <div className="text-center py-8">
              <Bot size={32} className="mx-auto text-apex-border mb-3" />
              <p className="text-sm text-apex-muted">No agents yet</p>
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
                      <th
                        key={col.key}
                        className="text-left px-6 py-3 font-medium cursor-pointer hover:text-white transition-colors"
                        onClick={() => handleSort(col.key)}
                      >
                        {col.label}
                        {sortCol === col.key && (
                          <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>
                        )}
                      </th>
                    ))}
                    <th className="text-right px-6 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAgents.map((agent) => {
                    const agentTop = topAgentsData.find((t) => t.id === agent.id);
                    return (
                      <tr key={agent.id} className="border-b border-apex-border/50 hover:bg-apex-surface/50 transition-colors">
                        <td className="px-6 py-3">
                          <Link href={`/agents/${agent.id}`} className="font-medium hover:text-apex-indigo-light transition-colors">
                            {agent.name}
                          </Link>
                        </td>
                        <td className="px-6 py-3">
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-apex-indigo/10 text-apex-indigo-light">
                            {agent.domain}
                          </span>
                        </td>
                        <td className="px-6 py-3">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                            agent.status === "ACTIVE" ? "bg-green-500/10 text-green-400" :
                            agent.status === "PAUSED" ? "bg-yellow-500/10 text-yellow-400" :
                            agent.status === "ERROR" ? "bg-red-500/10 text-red-400" :
                            "bg-gray-500/10 text-gray-400"
                          }`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${
                              agent.status === "ACTIVE" ? "bg-green-400" :
                              agent.status === "PAUSED" ? "bg-yellow-400" :
                              agent.status === "ERROR" ? "bg-red-400" : "bg-gray-400"
                            }`} />
                            {agent.status}
                          </span>
                        </td>
                        <td className="px-6 py-3">
                          <div>
                            <span className="font-medium">{agent._count?.runs || 0}</span>
                            {agentTop && agentTop.runs > 0 && (
                              <span className="text-xs text-apex-muted ml-1">({agentTop.successRate}%)</span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => handleTriggerRun(agent)}
                              className="p-1.5 rounded-md hover:bg-apex-surface transition-colors text-apex-muted hover:text-white"
                              title="Run now"
                            >
                              <Play size={14} />
                            </button>
                            <button
                              onClick={() => handleToggleAgent(agent)}
                              className="p-1.5 rounded-md hover:bg-apex-surface transition-colors text-apex-muted hover:text-white"
                              title={agent.status === "ACTIVE" ? "Pause" : "Resume"}
                            >
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

        {/* Right: Live Activity Feed (40%) */}
        <div className="lg:col-span-2 card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Live Activity</h2>
            <Link href="/activity" className="text-apex-indigo text-sm flex items-center gap-1 hover:underline">
              View all <ArrowRight size={14} />
            </Link>
          </div>
          {recentRuns.length === 0 ? (
            <div className="text-center py-8">
              <Activity size={32} className="mx-auto text-apex-border mb-3" />
              <p className="text-sm text-apex-muted">No activity yet</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {recentRuns.slice(0, 15).map((run) => {
                const duration = run.completedAt
                  ? ((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000).toFixed(1)
                  : null;
                return (
                  <div key={run.id} className="flex items-start gap-3 p-2 rounded-lg hover:bg-apex-surface/50 transition-colors">
                    <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${
                      run.status === "COMPLETED" ? "bg-green-400" :
                      run.status === "FAILED" ? "bg-red-400" :
                      run.status === "RUNNING" ? "bg-blue-400 animate-pulse" :
                      "bg-yellow-400"
                    }`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">
                        <span className="font-medium">{run.agent?.name || "Agent"}</span>
                        {run.status === "COMPLETED" && duration && (
                          <span className="text-apex-muted"> completed in {duration}s ({(run.tokensUsed || 0).toLocaleString()} tokens)</span>
                        )}
                        {run.status === "FAILED" && (
                          <span className="text-red-400"> failed</span>
                        )}
                        {run.status === "RUNNING" && (
                          <span className="text-blue-400"> running...</span>
                        )}
                        {run.status === "QUEUED" && (
                          <span className="text-yellow-400"> queued</span>
                        )}
                      </p>
                      <p className="text-xs text-apex-muted">
                        {new Date(run.startedAt).toLocaleTimeString()}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ─── Section 4: Domain Breakdown ─────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        {(["SALES", "MARKETING", "OPS"] as const).map((domain) => {
          const agentCount = stats?.agentsByDomain?.[domain] || 0;
          const runsCount = stats?.runsByDomain?.[domain] || 0;
          const domainAgents = topAgentsData.filter((a) => a.domain === domain);
          const totalCompleted = domainAgents.reduce((s, a) => s + Math.round(a.runs * a.successRate / 100), 0);
          const totalFailed = domainAgents.reduce((s, a) => s + (a.runs - Math.round(a.runs * a.successRate / 100)), 0);
          const topAgent = domainAgents.length > 0 ? domainAgents[0] : null;
          const domainColor = domain === "SALES" ? "text-blue-400" : domain === "MARKETING" ? "text-purple-400" : "text-orange-400";

          return (
            <div key={domain} className="card">
              <div className="flex items-center justify-between mb-4">
                <h3 className={`text-sm font-semibold ${domainColor}`}>{domain}</h3>
                <span className="text-xs text-apex-muted">{agentCount} agents</span>
              </div>
              <div className="flex items-center gap-4">
                <DonutChart success={totalCompleted} fail={totalFailed} size={64} />
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

      {/* ─── Section 5: Alerts & Recommendations ─────────── */}
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

      {/* ─── Section 6: Token Usage & Cost ───────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Token Usage & Cost</h2>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-apex-muted">Today: <span className="text-white font-medium">${(stats?.costToday ?? 0).toFixed(2)}</span></span>
            <span className="text-apex-muted">This Week: <span className="text-white font-medium">${weekCost.toFixed(2)}</span></span>
            <span className="text-apex-muted">Total: <span className="text-white font-medium">${(stats?.totalCost ?? 0).toFixed(2)}</span></span>
          </div>
        </div>
        {/* Token usage bar */}
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
        {/* Per-agent cost breakdown */}
        {topAgentsData.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-apex-muted mb-3">Per-Agent Usage (7 days)</h3>
            <div className="space-y-2">
              {topAgentsData.filter((a) => a.runs > 0).map((agent) => {
                const maxTokens = Math.max(...topAgentsData.map((a) => a.avgTokens * a.runs), 1);
                const width = ((agent.avgTokens * agent.runs) / maxTokens) * 100;
                return (
                  <div key={agent.id} className="flex items-center gap-3">
                    <Link href={`/agents/${agent.id}`} className="text-sm w-36 truncate hover:text-apex-indigo-light transition-colors">
                      {agent.name}
                    </Link>
                    <div className="flex-1 h-2 bg-apex-surface rounded-full overflow-hidden">
                      <div
                        className="h-full bg-apex-indigo/60 rounded-full"
                        style={{ width: `${width}%` }}
                      />
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

// ─── KPI Card Component ─────────────────────────────────
function KPICard({
  label, value, icon: Icon, color, sub, trend,
}: {
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
