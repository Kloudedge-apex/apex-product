"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Bot, Play, Pause, Settings, Clock, Activity, ArrowLeft, Loader2, CheckCircle, XCircle } from "lucide-react";
import { api } from "@/lib/api";

interface Agent {
  id: string;
  name: string;
  domain: string;
  status: string;
  templateId: string;
  orgId: string;
  config: Record<string, unknown>;
  schedule: string | null;
  lastRunAt: string | null;
  createdAt: string;
}

interface Run {
  id: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  tokensUsed: number;
  output: Record<string, unknown> | null;
  error: string | null;
}

export default function AgentDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [agent, setAgent] = useState<Agent | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const [agentData, runsData] = await Promise.all([
          api.agents.get(id),
          api.runs.listByAgent(id, 20).catch(() => []),
        ]);
        setAgent(agentData);
        setRuns(Array.isArray(runsData) ? runsData : []);
      } catch {
        // handle error
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  async function handleDeploy() {
    if (!agent) return;
    setActionLoading(true);
    try {
      await api.agents.deploy(agent.id);
      setAgent({ ...agent, status: "ACTIVE" });
    } catch { /* */ }
    setActionLoading(false);
  }

  async function handlePause() {
    if (!agent) return;
    setActionLoading(true);
    try {
      await api.agents.pause(agent.id);
      setAgent({ ...agent, status: "PAUSED" });
    } catch { /* */ }
    setActionLoading(false);
  }

  async function handleTriggerRun() {
    if (!agent) return;
    setActionLoading(true);
    try {
      const run = await api.runs.trigger(agent.id, agent.orgId);
      setRuns([run, ...runs]);
    } catch { /* */ }
    setActionLoading(false);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="animate-spin text-apex-indigo" size={32} />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="card text-center py-16">
        <p className="text-apex-muted">Agent not found</p>
        <Link href="/agents" className="text-apex-indigo mt-4 inline-block hover:underline">
          Back to agents
        </Link>
      </div>
    );
  }

  const statusColor = agent.status === "ACTIVE" ? "bg-green-500/10 text-green-400" :
    agent.status === "PAUSED" ? "bg-yellow-500/10 text-yellow-400" : "bg-gray-500/10 text-gray-400";
  const statusDot = agent.status === "ACTIVE" ? "bg-green-400" :
    agent.status === "PAUSED" ? "bg-yellow-400" : "bg-gray-400";

  return (
    <div>
      {/* Back link */}
      <Link href="/agents" className="text-apex-muted text-sm flex items-center gap-1 mb-4 hover:text-white transition-colors">
        <ArrowLeft size={14} /> Back to agents
      </Link>

      {/* Agent Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-apex-indigo/10 rounded-xl flex items-center justify-center">
            <Bot size={24} className="text-apex-indigo" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{agent.name}</h1>
            <div className="flex items-center gap-2 mt-1">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusColor}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
                {agent.status}
              </span>
              <span className="text-apex-muted text-sm">{agent.domain} Domain</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {agent.status === "ACTIVE" ? (
            <button onClick={handlePause} disabled={actionLoading} className="btn-secondary flex items-center gap-2">
              <Pause size={14} /> Pause
            </button>
          ) : (
            <button onClick={handleDeploy} disabled={actionLoading} className="btn-primary flex items-center gap-2">
              <Play size={14} /> Deploy
            </button>
          )}
          <button onClick={handleTriggerRun} disabled={actionLoading} className="btn-secondary flex items-center gap-2">
            <Activity size={14} /> Run Now
          </button>
        </div>
      </div>

      {/* Agent Info Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="card">
          <div className="flex items-center gap-2 text-apex-muted text-sm mb-2">
            <Clock size={14} /> Schedule
          </div>
          <p className="font-medium">{agent.schedule || "Not configured"}</p>
        </div>
        <div className="card">
          <div className="flex items-center gap-2 text-apex-muted text-sm mb-2">
            <Activity size={14} /> Total Runs
          </div>
          <p className="font-medium">{runs.length}</p>
        </div>
        <div className="card">
          <div className="flex items-center gap-2 text-apex-muted text-sm mb-2">
            <Settings size={14} /> Created
          </div>
          <p className="font-medium">{new Date(agent.createdAt).toLocaleDateString()}</p>
        </div>
      </div>

      {/* Config */}
      {agent.config && Object.keys(agent.config).length > 0 && (
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4">Configuration</h2>
          <div className="space-y-2">
            {Object.entries(agent.config).map(([key, val]) => (
              <div key={key} className="flex items-center justify-between py-2 border-b border-apex-border last:border-0">
                <span className="text-sm text-apex-muted">{key}</span>
                <span className="text-sm font-medium">{String(val)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Run History */}
      <div className="card">
        <h2 className="text-lg font-semibold mb-4">Run History</h2>
        {runs.length === 0 ? (
          <div className="text-center py-12">
            <Activity size={48} className="mx-auto text-apex-border mb-4" />
            <p className="text-apex-muted">No runs yet</p>
            <p className="text-sm text-apex-muted mt-1">Deploy this agent or trigger a manual run</p>
          </div>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => (
              <div key={run.id} className="flex items-center justify-between p-3 rounded-lg bg-apex-surface">
                <div className="flex items-center gap-3">
                  {run.status === "COMPLETED" ? (
                    <CheckCircle size={16} className="text-green-400" />
                  ) : run.status === "FAILED" ? (
                    <XCircle size={16} className="text-red-400" />
                  ) : (
                    <Loader2 size={16} className="text-yellow-400 animate-spin" />
                  )}
                  <div>
                    <p className="text-sm font-medium">{run.status}</p>
                    <p className="text-xs text-apex-muted">
                      {new Date(run.startedAt).toLocaleString()}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm text-apex-muted">{run.tokensUsed?.toLocaleString() || 0} tokens</p>
                  {run.completedAt && (
                    <p className="text-xs text-apex-muted">
                      {Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s
                    </p>
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
