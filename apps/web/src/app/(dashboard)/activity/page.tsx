"use client";

import { useState, useEffect, useCallback } from "react";
import { useUser } from "@clerk/nextjs";
import {
  Activity, Loader2, CheckCircle, XCircle, Clock, Filter, ChevronDown, ChevronRight,
  Bot, Search, Download, Calendar, X,
} from "lucide-react";
import { api } from "@/lib/api";

// ─── Types ──────────────────────────────────────────────
interface LogEntry {
  id: string;
  level: string;
  message: string;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
}

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
  logs?: LogEntry[];
  stepCount?: number;
}

interface Agent {
  id: string;
  name: string;
  domain: string;
}

// ─── CSV export utility ─────────────────────────────────
function exportToCSV(runs: Run[]) {
  const headers = ["ID", "Agent", "Domain", "Status", "Started At", "Completed At", "Duration (s)", "Tokens", "Cost"];
  const rows = runs.map((run) => {
    const duration = run.completedAt
      ? ((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000).toFixed(1)
      : "";
    return [
      run.id,
      run.agent?.name || "",
      run.agent?.domain || "",
      run.status,
      new Date(run.startedAt).toISOString(),
      run.completedAt ? new Date(run.completedAt).toISOString() : "",
      duration,
      String(run.tokensUsed || 0),
      String(run.cost || 0),
    ];
  });
  const csv = [headers, ...rows].map((row) => row.map((cell) => `"${cell}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `activity-export-${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Main Page ──────────────────────────────────────────
export default function ActivityPage() {
  const { user } = useUser();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [agentFilter, setAgentFilter] = useState<string>("ALL");
  const [domainFilter, setDomainFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  const PAGE_SIZE = 25;

  const loadData = useCallback(async (append = false) => {
    if (!orgId) return;
    if (append) setLoadingMore(true); else setLoading(true);
    try {
      const opts: Record<string, string> = {};
      if (statusFilter !== "ALL") opts.status = statusFilter;
      if (agentFilter !== "ALL") opts.agentId = agentFilter;
      if (dateFrom) opts.from = dateFrom;
      if (dateTo) opts.to = dateTo;
      if (searchQuery) opts.search = searchQuery;
      const offset = append ? runs.length : 0;

      const data = await api.runs.listByOrg(orgId, PAGE_SIZE, { ...opts, offset });
      const newRuns = data?.runs || (Array.isArray(data) ? data : []);
      const newTotal = data?.total ?? newRuns.length;

      if (append) {
        setRuns((prev) => [...prev, ...newRuns]);
      } else {
        setRuns(newRuns);
      }
      setTotal(newTotal);
    } catch { /* */ }
    setLoading(false);
    setLoadingMore(false);
  }, [orgId, statusFilter, agentFilter, dateFrom, dateTo, searchQuery, runs.length]);

  // Initial load
  useEffect(() => {
    async function init() {
      if (!user?.id) return;
      try {
        const org = await api.orgs.getByClerkUser(user.id).catch(() => null);
        if (org?.id) {
          setOrgId(org.id);
          const agentsData = await api.agents.list(org.id).catch(() => []);
          setAgents(Array.isArray(agentsData) ? agentsData : []);
        }
      } catch { /* */ }
    }
    init();
  }, [user?.id]);

  // Load runs when filters change
  useEffect(() => {
    if (orgId) loadData(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, statusFilter, agentFilter, dateFrom, dateTo, searchQuery]);

  // Apply domain filter client-side
  const filteredRuns = domainFilter === "ALL"
    ? runs
    : runs.filter((r) => r.agent?.domain === domainFilter);

  // Group by date
  const groupedRuns: Record<string, Run[]> = {};
  for (const run of filteredRuns) {
    const date = new Date(run.startedAt).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    if (!groupedRuns[date]) groupedRuns[date] = [];
    groupedRuns[date].push(run);
  }

  const hasMore = runs.length < total;
  const activeFilterCount = [statusFilter !== "ALL", agentFilter !== "ALL", domainFilter !== "ALL", !!dateFrom, !!dateTo, !!searchQuery].filter(Boolean).length;

  function clearFilters() {
    setStatusFilter("ALL");
    setAgentFilter("ALL");
    setDomainFilter("ALL");
    setSearchQuery("");
    setDateFrom("");
    setDateTo("");
  }

  if (loading && runs.length === 0) {
    return <div className="flex items-center justify-center min-h-[60vh]"><Loader2 className="animate-spin text-apex-indigo" size={32} /></div>;
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Activity</h1>
          <p className="text-apex-muted mt-1">
            {total > 0 ? `${total} total runs` : "Agent run history and timeline"}
          </p>
        </div>
        <button
          onClick={() => exportToCSV(filteredRuns)}
          disabled={filteredRuns.length === 0}
          className="btn-secondary flex items-center gap-2 text-sm"
        >
          <Download size={14} /> Export CSV
        </button>
      </div>

      {/* Filter Bar */}
      <div className="card mb-6">
        <div className="flex flex-wrap items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-apex-muted" />
            <input
              type="text"
              placeholder="Search runs, agents, results..."
              className="input-field pl-8 py-2 text-sm w-full"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Status filter */}
          <div className="flex items-center gap-1">
            <Filter size={14} className="text-apex-muted" />
            {["ALL", "COMPLETED", "FAILED", "RUNNING", "QUEUED"].map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  statusFilter === status
                    ? "bg-apex-indigo text-white"
                    : "bg-apex-surface text-apex-muted hover:text-white"
                }`}
              >
                {status === "ALL" ? "All" : status.charAt(0) + status.slice(1).toLowerCase()}
              </button>
            ))}
          </div>

          {/* Agent filter */}
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="input-field py-1.5 text-sm bg-apex-surface border-apex-border"
          >
            <option value="ALL">All Agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>

          {/* Domain filter */}
          <select
            value={domainFilter}
            onChange={(e) => setDomainFilter(e.target.value)}
            className="input-field py-1.5 text-sm bg-apex-surface border-apex-border"
          >
            <option value="ALL">All Domains</option>
            <option value="SALES">Sales</option>
            <option value="MARKETING">Marketing</option>
            <option value="OPS">Ops</option>
          </select>

          {/* Date range */}
          <div className="flex items-center gap-2">
            <Calendar size={14} className="text-apex-muted" />
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="input-field py-1.5 text-xs bg-apex-surface border-apex-border"
              placeholder="From"
            />
            <span className="text-apex-muted text-xs">to</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="input-field py-1.5 text-xs bg-apex-surface border-apex-border"
              placeholder="To"
            />
          </div>

          {/* Clear filters */}
          {activeFilterCount > 0 && (
            <button onClick={clearFilters} className="text-xs text-apex-muted hover:text-white flex items-center gap-1">
              <X size={12} /> Clear ({activeFilterCount})
            </button>
          )}
        </div>
      </div>

      {/* Results */}
      {filteredRuns.length === 0 ? (
        <div className="card text-center py-16">
          <Activity size={64} className="mx-auto text-apex-border mb-6" />
          <h2 className="text-xl font-semibold mb-2">No activity found</h2>
          <p className="text-apex-muted max-w-md mx-auto">
            {activeFilterCount > 0
              ? "No runs match your filters. Try adjusting your search criteria."
              : "Once your agents start running, you'll see their activity here."}
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
                  const duration = run.completedAt ? ((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000).toFixed(1) : null;
                  const toolCalls = run.logs?.filter((l) => l.message.includes("Tool call")) || [];
                  const steps = run.logs?.filter((l) => l.level === "INFO") || [];

                  return (
                    <div key={run.id} className="card p-0 overflow-hidden">
                      <button
                        onClick={() => setExpandedRun(isExpanded ? null : run.id)}
                        className="w-full flex items-center justify-between p-4 hover:bg-apex-surface/50 transition-colors"
                      >
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
                              {run.agent?.domain && (
                                <span className="px-1.5 py-0.5 rounded text-xs bg-apex-indigo/10 text-apex-indigo-light">{run.agent.domain}</span>
                              )}
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
                          {run.stepCount != null && run.stepCount > 0 && (
                            <span className="text-xs text-apex-muted">{run.stepCount} steps</span>
                          )}
                          <span className="text-xs text-apex-muted">{(run.tokensUsed || 0).toLocaleString()} tokens</span>
                          {duration !== null && <span className="text-xs text-apex-muted">{duration}s</span>}
                          {run.cost > 0 && <span className="text-xs text-apex-muted">${run.cost.toFixed(4)}</span>}
                        </div>
                      </button>

                      {isExpanded && (
                        <div className="p-4 pt-0 border-t border-apex-border">
                          {/* Steps & tool calls inline */}
                          {steps.length > 0 && (
                            <div className="mb-4">
                              <h4 className="text-xs font-medium text-apex-muted mb-2">Execution Steps ({steps.length})</h4>
                              <div className="space-y-1">
                                {steps.map((log) => (
                                  <div key={log.id} className="flex items-start gap-2 text-xs">
                                    <span className="text-apex-muted whitespace-nowrap">{new Date(log.createdAt).toLocaleTimeString()}</span>
                                    <span className={`font-medium ${
                                      log.message.includes("Tool call") ? "text-blue-400" :
                                      log.message.includes("completed") || log.message.includes("Final") ? "text-green-400" :
                                      "text-white"
                                    }`}>{log.message}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Tool calls summary */}
                          {toolCalls.length > 0 && (
                            <div className="mb-4">
                              <h4 className="text-xs font-medium text-apex-muted mb-2">Tools Used ({toolCalls.length})</h4>
                              <div className="flex flex-wrap gap-1">
                                {toolCalls.map((log, i) => {
                                  const match = log.message.match(/Tool call -> (\w+)/);
                                  return (
                                    <span key={i} className="px-2 py-0.5 rounded-full text-xs bg-blue-500/10 text-blue-400">
                                      {match ? match[1] : "tool"}
                                    </span>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {/* Output */}
                          {run.result && (
                            <div className="mb-4">
                              <h4 className="text-xs font-medium text-apex-muted mb-2">Output</h4>
                              <pre className="bg-apex-navy-dark p-3 rounded-lg text-xs overflow-x-auto max-h-48 overflow-y-auto text-green-300 font-mono">
                                {JSON.stringify(run.result, null, 2)}
                              </pre>
                            </div>
                          )}

                          {/* All logs */}
                          {run.logs && run.logs.length > 0 && (
                            <details className="text-xs">
                              <summary className="text-apex-muted cursor-pointer hover:text-white">All Logs ({run.logs.length})</summary>
                              <div className="mt-2 space-y-1">
                                {run.logs.map((log) => (
                                  <div key={log.id} className="flex items-start gap-2 font-mono">
                                    <span className="text-apex-muted whitespace-nowrap">{new Date(log.createdAt).toLocaleTimeString()}</span>
                                    <span className={`font-medium w-12 ${
                                      log.level === "ERROR" ? "text-red-400" :
                                      log.level === "WARN" ? "text-yellow-400" :
                                      log.level === "INFO" ? "text-blue-400" : "text-gray-400"
                                    }`}>[{log.level}]</span>
                                    <span className="text-white">{log.message}</span>
                                  </div>
                                ))}
                              </div>
                            </details>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Load More */}
          {hasMore && (
            <div className="text-center py-4">
              <button
                onClick={() => loadData(true)}
                disabled={loadingMore}
                className="btn-secondary px-6 py-2 text-sm"
              >
                {loadingMore ? (
                  <Loader2 size={14} className="animate-spin inline mr-2" />
                ) : null}
                Load More ({runs.length} of {total})
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
