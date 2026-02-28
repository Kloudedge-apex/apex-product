"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Bot, Play, Pause, Clock, Activity, ArrowLeft, Loader2, CheckCircle, XCircle, Trash2, ChevronDown, ChevronRight, Search, Filter } from "lucide-react";
import { api } from "@/lib/api";

interface LogEntry {
  id: string;
  level: string;
  message: string;
  createdAt: string;
}

interface Run {
  id: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  tokensUsed: number;
  cost: number;
  result: Record<string, unknown> | null;
  logs: LogEntry[];
}

interface Agent {
  id: string;
  name: string;
  domain: string;
  status: string;
  template: { id: string; name: string; domain: string; description: string };
  orgId: string;
  config: Record<string, unknown>;
  schedule: string | null;
  createdAt: string;
  runs: Run[];
}

const logLevelColors: Record<string, string> = {
  DEBUG: "text-gray-400",
  INFO: "text-blue-400",
  WARN: "text-yellow-400",
  ERROR: "text-red-400",
};

export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<string>("ALL");
  const [logSearch, setLogSearch] = useState("");
  const [tab, setTab] = useState<"runs" | "config" | "logs">("runs");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const agentData = await api.agents.get(id);
        setAgent(agentData);
      } catch { /* */ }
      finally { setLoading(false); }
    }
    load();
  }, [id]);

  async function handleDeploy() {
    if (!agent) return;
    setActionLoading(true);
    try { await api.agents.deploy(agent.id); setAgent({ ...agent, status: "ACTIVE" }); } catch { /* */ }
    setActionLoading(false);
  }

  async function handlePause() {
    if (!agent) return;
    setActionLoading(true);
    try { await api.agents.pause(agent.id); setAgent({ ...agent, status: "PAUSED" }); } catch { /* */ }
    setActionLoading(false);
  }

  async function handleTriggerRun() {
    if (!agent) return;
    setActionLoading(true);
    try {
      const run = await api.runs.trigger(agent.id, agent.orgId);
      setAgent({ ...agent, runs: [{ ...run, logs: [], cost: 0 }, ...agent.runs] });
    } catch { /* */ }
    setActionLoading(false);
  }

  async function handleDelete() {
    if (!agent || !deleting) return;
    try { await api.agents.delete(agent.id); router.push("/agents"); } catch { /* */ }
  }

  if (loading) {
    return (<div className="flex items-center justify-center min-h-[60vh]"><Loader2 className="animate-spin text-apex-indigo" size={32} /></div>);
  }

  if (!agent) {
    return (<div className="card text-center py-16"><p className="text-apex-muted">Agent not found</p><Link href="/agents" className="text-apex-indigo mt-4 inline-block hover:underline">Back to agents</Link></div>);
  }

  const statusColor = agent.status === "ACTIVE" ? "bg-green-500/10 text-green-400" :
    agent.status === "PAUSED" ? "bg-yellow-500/10 text-yellow-400" :
    agent.status === "ERROR" ? "bg-red-500/10 text-red-400" : "bg-gray-500/10 text-gray-400";
  const statusDot = agent.status === "ACTIVE" ? "bg-green-400" :
    agent.status === "PAUSED" ? "bg-yellow-400" :
    agent.status === "ERROR" ? "bg-red-400" : "bg-gray-400";

  const allLogs = agent.runs
    .flatMap((run) => run.logs.map((log) => ({ ...log, runId: run.id })))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const filteredLogs = allLogs.filter((log) => {
    if (logFilter !== "ALL" && log.level !== logFilter) return false;
    if (logSearch && !log.message.toLowerCase().includes(logSearch.toLowerCase())) return false;
    return true;
  });

  const successRate = agent.runs.length > 0
    ? Math.round((agent.runs.filter((r) => r.status === "COMPLETED").length / agent.runs.length) * 100) : 0;

  return (
    <div>
      <Link href="/agents" className="text-apex-muted text-sm flex items-center gap-1 mb-4 hover:text-white transition-colors">
        <ArrowLeft size={14} /> Agents
      </Link>

      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-apex-indigo/10 rounded-xl flex items-center justify-center">
            <Bot size={24} className="text-apex-indigo" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{agent.name}</h1>
            <div className="flex items-center gap-2 mt-1">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusColor}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />{agent.status}
              </span>
              <span className="text-apex-muted text-sm">{agent.template?.name}</span>
              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-apex-indigo/10 text-apex-indigo-light">{agent.domain}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {agent.status === "ACTIVE" ? (
            <button onClick={handlePause} disabled={actionLoading} className="btn-secondary flex items-center gap-2"><Pause size={14} /> Pause</button>
          ) : (
            <button onClick={handleDeploy} disabled={actionLoading} className="btn-primary flex items-center gap-2"><Play size={14} /> Deploy</button>
          )}
          <button onClick={handleTriggerRun} disabled={actionLoading} className="btn-secondary flex items-center gap-2"><Activity size={14} /> Run Now</button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <div className="card"><div className="flex items-center gap-2 text-apex-muted text-sm mb-2"><Clock size={14} /> Schedule</div><p className="font-medium">{agent.schedule || "None"}</p></div>
        <div className="card"><div className="flex items-center gap-2 text-apex-muted text-sm mb-2"><Activity size={14} /> Total Runs</div><p className="font-medium">{agent.runs.length}</p></div>
        <div className="card"><div className="flex items-center gap-2 text-apex-muted text-sm mb-2"><CheckCircle size={14} /> Success Rate</div><p className="font-medium">{successRate}%</p></div>
        <div className="card"><div className="flex items-center gap-2 text-apex-muted text-sm mb-2"><Clock size={14} /> Created</div><p className="font-medium">{new Date(agent.createdAt).toLocaleDateString()}</p></div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-apex-surface rounded-lg mb-6 w-fit">
        {(["runs", "config", "logs"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 rounded-md text-sm font-medium transition-colors capitalize ${tab === t ? "bg-apex-indigo text-white" : "text-apex-muted hover:text-white"}`}>
            {t === "runs" ? `Runs (${agent.runs.length})` : t === "logs" ? `Logs (${allLogs.length})` : "Config"}
          </button>
        ))}
      </div>

      {tab === "runs" && (
        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Run History</h2>
          {agent.runs.length === 0 ? (
            <div className="text-center py-12">
              <Activity size={48} className="mx-auto text-apex-border mb-4" />
              <p className="text-apex-muted">No runs yet</p>
            </div>
          ) : (
            <div className="space-y-2">
              {agent.runs.map((run) => {
                const isExpanded = expandedRun === run.id;
                const duration = run.completedAt ? Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000) : null;
                return (
                  <div key={run.id} className="rounded-lg bg-apex-surface overflow-hidden">
                    <button onClick={() => setExpandedRun(isExpanded ? null : run.id)} className="w-full flex items-center justify-between p-4 hover:bg-apex-navy-light transition-colors">
                      <div className="flex items-center gap-3">
                        {isExpanded ? <ChevronDown size={16} className="text-apex-muted" /> : <ChevronRight size={16} className="text-apex-muted" />}
                        {run.status === "COMPLETED" ? <CheckCircle size={16} className="text-green-400" /> :
                         run.status === "FAILED" ? <XCircle size={16} className="text-red-400" /> :
                         <Loader2 size={16} className="text-yellow-400 animate-spin" />}
                        <div className="text-left">
                          <p className="text-sm font-medium">{run.status}</p>
                          <p className="text-xs text-apex-muted">{new Date(run.startedAt).toLocaleString()}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-xs text-apex-muted">{(run.tokensUsed || 0).toLocaleString()} tokens</span>
                        {duration !== null && <span className="text-xs text-apex-muted">{duration}s</span>}
                        {run.cost > 0 && <span className="text-xs text-apex-muted">${run.cost.toFixed(4)}</span>}
                      </div>
                    </button>
                    {isExpanded && (
                      <div className="p-4 pt-0 border-t border-apex-border">
                        {run.result && (
                          <div className="mb-4">
                            <h4 className="text-xs font-medium text-apex-muted mb-2">Output</h4>
                            <pre className="bg-apex-navy-dark p-3 rounded-lg text-xs overflow-x-auto max-h-60 overflow-y-auto text-green-300 font-mono">{JSON.stringify(run.result, null, 2)}</pre>
                          </div>
                        )}
                        {run.logs.length > 0 && (
                          <div>
                            <h4 className="text-xs font-medium text-apex-muted mb-2">Logs</h4>
                            <div className="space-y-1">
                              {run.logs.map((log) => (
                                <div key={log.id} className="flex items-start gap-2 text-xs font-mono">
                                  <span className="text-apex-muted whitespace-nowrap">{new Date(log.createdAt).toLocaleTimeString()}</span>
                                  <span className={`font-medium w-12 ${logLevelColors[log.level] || "text-gray-400"}`}>[{log.level}]</span>
                                  <span className="text-white">{log.message}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "config" && (
        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Configuration</h2>
          {agent.config && Object.keys(agent.config).length > 0 ? (
            <div className="space-y-2">
              {Object.entries(agent.config).map(([key, val]) => (
                <div key={key} className="flex items-center justify-between py-3 border-b border-apex-border last:border-0">
                  <span className="text-sm text-apex-muted capitalize">{key.replace(/([A-Z])/g, " $1")}</span>
                  <span className="text-sm font-medium">{typeof val === "object" ? JSON.stringify(val) : String(val)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-apex-muted text-sm">No configuration set</p>
          )}
        </div>
      )}

      {tab === "logs" && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">All Logs</h2>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-apex-muted" />
                <input type="text" placeholder="Search logs..." className="input-field pl-8 py-1.5 text-xs w-48" value={logSearch} onChange={(e) => setLogSearch(e.target.value)} />
              </div>
              <div className="flex items-center gap-1">
                <Filter size={14} className="text-apex-muted" />
                {["ALL", "DEBUG", "INFO", "WARN", "ERROR"].map((level) => (
                  <button key={level} onClick={() => setLogFilter(level)} className={`px-2 py-1 rounded text-xs font-medium transition-colors ${logFilter === level ? "bg-apex-indigo text-white" : "text-apex-muted hover:text-white"}`}>{level}</button>
                ))}
              </div>
            </div>
          </div>
          {filteredLogs.length === 0 ? (
            <div className="text-center py-8"><p className="text-sm text-apex-muted">No logs found</p></div>
          ) : (
            <div className="space-y-1 max-h-96 overflow-y-auto">
              {filteredLogs.map((log) => (
                <div key={log.id} className="flex items-start gap-2 text-xs font-mono py-1">
                  <span className="text-apex-muted whitespace-nowrap">{new Date(log.createdAt).toLocaleString()}</span>
                  <span className={`font-medium w-12 ${logLevelColors[log.level] || "text-gray-400"}`}>[{log.level}]</span>
                  <span className="text-white flex-1">{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Danger Zone */}
      <div className="card mt-6 border-red-500/20">
        <h3 className="text-sm font-semibold text-red-400 mb-3">Danger Zone</h3>
        {!deleting ? (
          <button onClick={() => setDeleting(true)} className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1"><Trash2 size={14} /> Delete this agent</button>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-xs text-apex-muted">Are you sure? This cannot be undone.</p>
            <button onClick={handleDelete} className="bg-red-500/20 text-red-400 hover:bg-red-500/30 px-3 py-1 rounded text-xs font-medium">Yes, delete</button>
            <button onClick={() => setDeleting(false)} className="text-xs text-apex-muted hover:text-white">Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}
