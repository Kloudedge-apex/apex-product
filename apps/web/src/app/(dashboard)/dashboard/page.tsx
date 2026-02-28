"use client";

import { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { Bot, Activity, Zap, TrendingUp, Plus, ArrowRight, Loader2 } from "lucide-react";
import { api } from "@/lib/api";

interface OrgStats {
  totalAgents: number;
  activeAgents: number;
  totalRuns: number;
  totalIntegrations: number;
  tokensUsed: number;
}

interface Agent {
  id: string;
  name: string;
  domain: string;
  status: string;
  lastRunAt: string | null;
}

export default function DashboardPage() {
  const { user } = useUser();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [stats, setStats] = useState<OrgStats | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadDashboard() {
      if (!user?.id) return;
      try {
        setLoading(true);
        // Try to get org by clerk user
        const org = await api.orgs.getByClerkUser(user.id).catch(() => null);
        if (org?.id) {
          setOrgId(org.id);
          const [statsData, agentsData] = await Promise.all([
            api.orgs.getStats(org.id).catch(() => null),
            api.agents.list(org.id).catch(() => []),
          ]);
          if (statsData) setStats(statsData);
          setAgents(Array.isArray(agentsData) ? agentsData : []);
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load dashboard");
      } finally {
        setLoading(false);
      }
    }
    loadDashboard();
  }, [user?.id]);

  const statCards = [
    { label: "Active Agents", value: stats?.activeAgents ?? 0, icon: Bot },
    { label: "Total Runs", value: stats?.totalRuns ?? 0, icon: Activity },
    { label: "Integrations", value: stats?.totalIntegrations ?? 0, icon: Zap },
    { label: "Tokens Used", value: stats?.tokensUsed ?? 0, icon: TrendingUp },
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
                <Icon size={18} className="text-apex-indigo" />
              </div>
              <p className="text-3xl font-bold">{stat.value.toLocaleString()}</p>
            </div>
          );
        })}
      </div>

      {/* Agents Quick View */}
      {agents.length > 0 ? (
        <div className="card mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Your Agents</h2>
            <Link href="/agents" className="text-apex-indigo text-sm flex items-center gap-1 hover:underline">
              View all <ArrowRight size={14} />
            </Link>
          </div>
          <div className="space-y-3">
            {agents.slice(0, 5).map((agent) => (
              <Link
                key={agent.id}
                href={`/agents/${agent.id}`}
                className="flex items-center justify-between p-3 rounded-lg bg-apex-surface hover:bg-apex-surface/80 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-apex-indigo/10 rounded-lg flex items-center justify-center">
                    <Bot size={16} className="text-apex-indigo" />
                  </div>
                  <div>
                    <p className="font-medium text-sm">{agent.name}</p>
                    <p className="text-xs text-apex-muted">{agent.domain}</p>
                  </div>
                </div>
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                  agent.status === "ACTIVE" ? "bg-green-500/10 text-green-400" :
                  agent.status === "PAUSED" ? "bg-yellow-500/10 text-yellow-400" :
                  "bg-gray-500/10 text-gray-400"
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    agent.status === "ACTIVE" ? "bg-green-400" :
                    agent.status === "PAUSED" ? "bg-yellow-400" :
                    "bg-gray-400"
                  }`} />
                  {agent.status}
                </span>
              </Link>
            ))}
          </div>
        </div>
      ) : !orgId ? (
        <div className="card text-center py-12">
          <Bot size={48} className="mx-auto text-apex-border mb-4" />
          <h2 className="text-lg font-semibold mb-2">Get started</h2>
          <p className="text-apex-muted mb-6 max-w-md mx-auto">
            Set up your organization and deploy your first AI agent.
          </p>
          <Link href="/onboarding" className="btn-primary inline-flex items-center gap-2">
            <Plus size={16} />
            Start Onboarding
          </Link>
        </div>
      ) : (
        <div className="card text-center py-12">
          <Activity size={48} className="mx-auto text-apex-border mb-4" />
          <p className="text-apex-muted">No activity yet</p>
          <p className="text-sm text-apex-muted mt-1">Deploy your first agent to see activity here</p>
        </div>
      )}
    </div>
  );
}
