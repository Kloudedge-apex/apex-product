"use client";

import { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { Bot, Activity, Zap, TrendingUp, Plus, ArrowRight, Loader2, Play, Pause, CheckCircle, XCircle, Clock } from "lucide-react";
import { api } from "@/lib/api";

interface OrgStats {
  activeAgents: number;
  totalRuns: number;
  integrations: number;
  tokensUsed: number;
}

interface AgentTemplate {
  id: string;
  name: string;
  domain: string;
}

interface Agent {
  id: string;
  name: string;
  domain: string;
  status: string;
  template: AgentTemplate;
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
  agent?: { name: string; domain: string };
}

export default function DashboardPage() {
  const { user } = useUser();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [stats, setStats] = useState<OrgStats | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [recentRuns, setRecentRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadDashboard() {
      if (!user?.id) return;
      try {
        setLoading(true);
        const org = await api.orgs.getByClerkUser(user.id).catch(() => null);
        if (org?.id) {
          setOrgId(org.id);
          const [statsData, agentsData, runsData] = await Promise.all([
            api.orgs.getStats(org.id).catch(() => null),
            api.agents.list(org.id).catch(() => []),
            api.runs.listByOrg(org.id, 10).catch(() => []),
          ]);
          if (statsData) setStats(statsData);
          setAgents(Array.isArray(agentsData) ? agentsData : []);
          setRecentRuns(Array.isArray(runsData) ? runsData : []);
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load dashboard");
      } finally {
        setLoading(false);
      }
    }
    loadDashboard();
  }, [user?.id]);

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
      setRecentRuns((prev) => [run, ...prev].slice(0, 10));
    } catch { /* */ }
  }

  const statCards = [
    { label: "Active Agents", value: stats?.activeAgents ?? 0, icon: Bot, color: "text-indigo-400" },
    { label: "Runs Today", value: stats?.totalRuns ?? 0, icon: Activity, color: "text-green-400" },
    { label: "Tokens Used", value: stats?.tokensUsed ?? 0, icon: TrendingUp, color: "text-yellow-400" },
    { label: "Integrations", value: stats?.integrations ?? 0, icon: Zap, color: "text-cyan-400" },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="animate-spin text-apex-indigo" size={32} />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-apex-muted mt-1">
            {user?.firstName ? `Welcome back, ${user.firstName}` : "Overview of your AI workforce"}
          </p>
        </div>
        <Link href="/onboarding" className="btn-primary flex items-center gap-2">
          <Plus size={16} />
          New Agent
        </Link>
      </div>

      {error && (
        <div className="card border-red-500/30 bg-red-500/5 mb-6">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="card">
              <div className="flex items-center justify-between mb-4">
                <span className="text-apex-muted text-sm">{stat.label}</span>
                <Icon size={18} className={stat.color} />
              </div>
              <p className="text-3xl font-bold">{stat.value.toLocaleString()}</p>
            </div>
          );
        })}
      </div>

      {/* Agent Cards Grid */}
      {agents.length > 0 ? (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Your Agents</h2>
            <Link href="/agents" className="text-apex-indigo text-sm flex items-center gap-1 hover:underline">
              View all <ArrowRight size={14} />
            </Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {agents.slice(0, 6).map((agent) => (
              <div key={agent.id} className="card">
                <div className="flex items-center justify-between mb-3">
                  <Link href={`/agents/${agent.id}`} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
                    <div className="w-10 h-10 bg-apex-indigo/10 rounded-xl flex items-center justify-center">
                      <Bot size={20} className="text-apex-indigo" />
                    </div>
                    <div>
                      <p className="font-semibold text-sm">{agent.name}</p>
                      <p className="text-xs text-apex-muted">{agent.template?.name || agent.domain}</p>
                    </div>
                  </Link>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                    agent.status === "ACTIVE" ? "bg-green-500/10 text-green-400" :
                    agent.status === "PAUSED" ? "bg-yellow-500/10 text-yellow-400" :
                    agent.status === "ERROR" ? "bg-red-500/10 text-red-400" :
                    "bg-gray-500/10 text-gray-400"
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      agent.status === "ACTIVE" ? "bg-green-400" :
                      agent.status === "PAUSED" ? "bg-yellow-400" :
                      agent.status === "ERROR" ? "bg-red-400" :
                      "bg-gray-400"
                    }`} />
                    {agent.status}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-apex-muted mb-3">
                  <span>{agent.schedule || "No schedule"}</span>
                  <span className="text-apex-border">|</span>
                  <span>{agent._count?.runs || 0} runs</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleToggleAgent(agent)}
                    className="btn-secondary text-xs px-2.5 py-1 flex items-center gap-1"
                  >
                    {agent.status === "ACTIVE" ? <><Pause size={12} /> Pause</> : <><Play size={12} /> Resume</>}
                  </button>
                  <button
                    onClick={() => handleTriggerRun(agent)}
                    className="btn-secondary text-xs px-2.5 py-1 flex items-center gap-1"
                  >
                    <Activity size={12} /> Run
                  </button>
                  <Link href={`/agents/${agent.id}`} className="btn-secondary text-xs px-2.5 py-1 ml-auto">
                    Logs
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : !orgId ? (
        <div className="card text-center py-12 mb-8">
          <Bot size={48} className="mx-auto text-apex-border mb-4" />
          <h2 className="text-lg font-semibold mb-2">Get started</h2>
          <p className="text-apex-muted mb-6 max-w-md mx-auto">
            Set up your organization and deploy your first AI agent.
          </p>
          <Link href="/onboarding" className="btn-primary inline-flex items-center gap-2">
            <Plus size={16} /> Start Onboarding
          </Link>
        </div>
      ) : (
        <div className="card text-center py-12 mb-8">
          <Bot size={48} className="mx-auto text-apex-border mb-4" />
          <h2 className="text-lg font-semibold mb-2">Deploy your first agent</h2>
          <p className="text-apex-muted mb-6">Start automating with AI</p>
          <Link href="/onboarding" className="btn-primary inline-flex items-center gap-2">
            <Plus size={16} /> New Agent
          </Link>
        </div>
      )}

      {/* Recent Activity Feed */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Recent Activity</h2>
          <Link href="/activity" className="text-apex-indigo text-sm flex items-center gap-1 hover:underline">
            View all <ArrowRight size={14} />
          </Link>
        </div>
        {recentRuns.length === 0 ? (
          <div className="text-center py-8">
            <Activity size={32} className="mx-auto text-apex-border mb-3" />
            <p className="text-sm text-apex-muted">No activity yet. Deploy an agent to see runs here.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {recentRuns.map((run) => (
              <div key={run.id} className="flex items-center justify-between p-3 rounded-lg bg-apex-surface">
                <div className="flex items-center gap-3">
                  {run.status === "COMPLETED" ? (
                    <CheckCircle size={16} className="text-green-400" />
                  ) : run.status === "FAILED" ? (
                    <XCircle size={16} className="text-red-400" />
                  ) : run.status === "RUNNING" ? (
                    <Loader2 size={16} className="text-blue-400 animate-spin" />
                  ) : (
                    <Clock size={16} className="text-yellow-400" />
                  )}
                  <div>
                    <p className="text-sm font-medium">{run.agent?.name || `Agent ${run.agentId.slice(0, 8)}`}</p>
                    <p className="text-xs text-apex-muted">
                      {new Date(run.startedAt).toLocaleString()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    run.status === "COMPLETED" ? "bg-green-500/10 text-green-400" :
                    run.status === "FAILED" ? "bg-red-500/10 text-red-400" :
                    run.status === "RUNNING" ? "bg-blue-500/10 text-blue-400" :
                    "bg-yellow-500/10 text-yellow-400"
                  }`}>
                    {run.status}
                  </span>
                  <span className="text-xs text-apex-muted">{(run.tokensUsed || 0).toLocaleString()} tokens</span>
                  {run.completedAt && (
                    <span className="text-xs text-apex-muted">
                      {Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
