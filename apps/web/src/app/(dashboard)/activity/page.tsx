"use client";

import { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { Activity, Loader2, CheckCircle, XCircle, Clock, Filter, ChevronDown, ChevronRight, Bot } from "lucide-react";
import { api } from "@/lib/api";

interface Run {
  id: string;
  agentId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  tokensUsed: number;
  cost: number;
  result: Record<string, unknown> | null;
  agent?: { name: string; domain: string };
  logs?: Array<{ id: string; level: string; message: string; createdAt: string }>;
}

export default function ActivityPage() {
  const { user } = useUser();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      if (!user?.id) return;
      try {
        const org = await api.orgs.getByClerkUser(user.id).catch(() => null);
        if (org?.id) {
          const data = await api.runs.listByOrg(org.id, 100).catch(() => []);
          setRuns(Array.isArray(data) ? data : []);
        }
      } catch { /* */ }
      setLoading(false);
    }
    load();
  }, [user?.id]);

  const filteredRuns = statusFilter === "ALL" ? runs : runs.filter((r) => r.status === statusFilter);

  const groupedRuns: Record<string, Run[]> = {};
  for (const run of filteredRuns) {
    const date = new Date(run.startedAt).toLocaleDateString();
    if (!groupedRuns[date]) groupedRuns[date] = [];
    groupedRuns[date].push(run);
  }

  if (loading) {
    return (<div className="flex items-center justify-center min-h-[60vh]"><Loader2 className="animate-spin text-apex-indigo" size={32} /></div>);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Activity</h1>
          <p className="text-apex-muted mt-1">Agent run history and timeline</p>
        </div>
        <div className="flex items-center gap-2">
          <Filter size={14} className="text-apex-muted" />
          {["ALL", "COMPLETED", "FAILED", "RUNNING", "QUEUED"].map((status) => (
            <button key={status} onClick={() => setStatusFilter(status)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${statusFilter === status ? "bg-apex-indigo text-white" : "bg-apex-surface text-apex-muted hover:text-white"}`}>
              {status === "ALL" ? "All" : status.charAt(0) + status.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      {filteredRuns.length === 0 ? (
        <div className="card text-center py-16">
          <Activity size={64} className="mx-auto text-apex-border mb-6" />
          <h2 className="text-xl font-semibold mb-2">No activity yet</h2>
          <p className="text-apex-muted max-w-md mx-auto">
            Once your agents start running, you&apos;ll see their activity here.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(groupedRuns).map(([date, dateRuns]) => (
            <div key={date}>
              <h3 className="text-sm font-medium text-apex-muted mb-3">{date}</h3>
              <div className="space-y-2">
                {dateRuns.map((run) => {
                  const isExpanded = expandedRun === run.id;
                  const duration = run.completedAt ? Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000) : null;
                  return (
                    <div key={run.id} className="card p-0 overflow-hidden">
                      <button onClick={() => setExpandedRun(isExpanded ? null : run.id)} className="w-full flex items-center justify-between p-4 hover:bg-apex-surface/50 transition-colors">
                        <div className="flex items-center gap-3">
                          {isExpanded ? <ChevronDown size={16} className="text-apex-muted" /> : <ChevronRight size={16} className="text-apex-muted" />}
                          {run.status === "COMPLETED" ? <CheckCircle size={18} className="text-green-400" /> :
                           run.status === "FAILED" ? <XCircle size={18} className="text-red-400" /> :
                           run.status === "RUNNING" ? <Loader2 size={18} className="text-blue-400 animate-spin" /> :
                           <Clock size={18} className="text-yellow-400" />}
                          <div className="text-left">
                            <p className="text-sm font-medium flex items-center gap-2">
                              <Bot size={14} className="text-apex-indigo" />
                              {run.agent?.name || `Agent ${run.agentId.slice(0, 8)}`}
                            </p>
                            <p className="text-xs text-apex-muted">{new Date(run.startedAt).toLocaleTimeString()}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                            run.status === "COMPLETED" ? "bg-green-500/10 text-green-400" :
                            run.status === "FAILED" ? "bg-red-500/10 text-red-400" :
                            run.status === "RUNNING" ? "bg-blue-500/10 text-blue-400" :
                            "bg-yellow-500/10 text-yellow-400"
                          }`}>{run.status}</span>
                          <span className="text-xs text-apex-muted">{(run.tokensUsed || 0).toLocaleString()} tokens</span>
                          {duration !== null && <span className="text-xs text-apex-muted">{duration}s</span>}
                        </div>
                      </button>
                      {isExpanded && (
                        <div className="p-4 pt-0 border-t border-apex-border">
                          {run.result && (
                            <div className="mb-4">
                              <h4 className="text-xs font-medium text-apex-muted mb-2">Output</h4>
                              <pre className="bg-apex-navy-dark p-3 rounded-lg text-xs overflow-x-auto max-h-48 overflow-y-auto text-green-300 font-mono">{JSON.stringify(run.result, null, 2)}</pre>
                            </div>
                          )}
                          {run.logs && run.logs.length > 0 && (
                            <div>
                              <h4 className="text-xs font-medium text-apex-muted mb-2">Logs</h4>
                              <div className="space-y-1">
                                {run.logs.map((log) => (
                                  <div key={log.id} className="flex items-start gap-2 text-xs font-mono">
                                    <span className="text-apex-muted whitespace-nowrap">{new Date(log.createdAt).toLocaleTimeString()}</span>
                                    <span className={`font-medium w-12 ${log.level === "ERROR" ? "text-red-400" : log.level === "WARN" ? "text-yellow-400" : log.level === "INFO" ? "text-blue-400" : "text-gray-400"}`}>[{log.level}]</span>
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
