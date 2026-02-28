"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Bot, Play, Pause, Clock, Activity, ArrowLeft, Loader2, CheckCircle, XCircle, Trash2, ChevronDown, ChevronRight, Search, Filter, Brain, Mail, FileText, BarChart3, Globe, Database, Wrench, Copy, TrendingUp } from "lucide-react";
import { api } from "@/lib/api";

// ─── Interfaces ─────────────────────────────────────────
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

interface Analytics {
  totalRuns: number;
  runsLast7Days: number;
  runsLast30Days: number;
  successRate: number;
  avgExecutionTime: number;
  avgTokensPerRun: number;
  totalTokens: number;
  totalCost: number;
  runsByDay: Array<{ date: string; total: number; completed: number; failed: number }>;
  memoryKeys: number;
  recentRuns: Array<{ id: string; status: string; startedAt: string; completedAt: string | null; tokensUsed: number; steps: number }>;
  toolUsage: Record<string, number>;
}

// ─── Helper functions ───────────────────────────────────
const logLevelColors: Record<string, string> = {
  DEBUG: "text-gray-400", INFO: "text-blue-400", WARN: "text-yellow-400", ERROR: "text-red-400",
};

const stepIcons: Record<string, typeof Wrench> = {
  web_search: Globe, web_scrape: Globe, company_research: Search,
  lead_score: BarChart3, send_email: Mail, hubspot: Database, memory: Brain,
};

function getStepIcon(message: string) {
  const toolMatch = message.match(/Tool call -> (\w+)/);
  if (toolMatch) return stepIcons[toolMatch[1]] || Wrench;
  if (message.includes("Starting")) return Play;
  if (message.includes("Final answer") || message.includes("completed")) return CheckCircle;
  return Activity;
}

function getStepColor(message: string, level: string) {
  if (level === "ERROR") return "border-red-500 bg-red-500/10";
  if (level === "WARN") return "border-yellow-500 bg-yellow-500/10";
  if (message.includes("completed") || message.includes("Final answer")) return "border-green-500 bg-green-500/10";
  if (message.includes("Tool call")) return "border-blue-500 bg-blue-500/10";
  return "border-apex-indigo bg-apex-indigo/10";
}

function formatDay(dateStr: string) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", { weekday: "short" });
}

function formatMs(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Output card components ─────────────────────────────
function EmailOutputCard({ result }: { result: Record<string, unknown> }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-apex-border bg-apex-surface p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2"><Mail size={16} className="text-apex-indigo" /><span className="text-sm font-medium">Email Draft</span></div>
          {result.leadScore != null && (
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${(result.leadScore as number) >= 70 ? "bg-green-500/10 text-green-400" : (result.leadScore as number) >= 40 ? "bg-yellow-500/10 text-yellow-400" : "bg-red-500/10 text-red-400"}`}>
              Score: {String(result.leadScore)}/100
            </span>
          )}
        </div>
        <div className="space-y-2 text-sm">
          <div className="flex gap-2"><span className="text-apex-muted w-16">To:</span><span>{String(result.to || "")}</span></div>
          <div className="flex gap-2"><span className="text-apex-muted w-16">Subject:</span><span className="font-medium">{String(result.subject || "")}</span></div>
          <div className="mt-3 p-3 bg-apex-navy-dark rounded-lg whitespace-pre-wrap text-sm">{String(result.body || "")}</div>
        </div>
        <div className="flex gap-2 mt-3">
          <button onClick={() => { navigator.clipboard.writeText(String(result.body || "")); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
            className="btn-secondary text-xs flex items-center gap-1"><Copy size={12} /> {copied ? "Copied!" : "Copy"}</button>
        </div>
      </div>
      {result.companyResearch != null && (
        <div className="rounded-lg border border-apex-border bg-apex-surface p-4">
          <div className="flex items-center gap-2 mb-2"><Search size={14} className="text-apex-indigo" /><span className="text-sm font-medium">Company Research</span></div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {Object.entries(result.companyResearch as Record<string, unknown>).map(([k, v]) => (
              <div key={k}><span className="text-apex-muted capitalize">{k}: </span><span>{Array.isArray(v) ? v.join(", ") : String(v)}</span></div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ContentOutputCard({ result }: { result: Record<string, unknown> }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border border-apex-border bg-apex-surface p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2"><FileText size={16} className="text-purple-400" /><span className="text-sm font-medium">Content: {String(result.platform || "")}</span></div>
      </div>
      <h4 className="font-medium mb-2">{String(result.title || "")}</h4>
      <div className="p-3 bg-apex-navy-dark rounded-lg whitespace-pre-wrap text-sm mb-2">{String(result.body || "")}</div>
      {Array.isArray(result.hashtags) && (
        <div className="flex flex-wrap gap-1 mb-3">
          {(result.hashtags as string[]).map((tag) => (
            <span key={tag} className="px-2 py-0.5 rounded-full text-xs bg-purple-500/10 text-purple-400">{tag}</span>
          ))}
        </div>
      )}
      <button onClick={() => { navigator.clipboard.writeText(String(result.body || "")); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
        className="btn-secondary text-xs flex items-center gap-1"><Copy size={12} /> {copied ? "Copied!" : "Copy to Clipboard"}</button>
    </div>
  );
}

function TriageOutputCard({ result }: { result: Record<string, unknown> }) {
  const emails = (result.emails || []) as Array<Record<string, unknown>>;
  return (
    <div className="rounded-lg border border-apex-border bg-apex-surface p-4">
      <div className="flex items-center gap-2 mb-3"><Mail size={16} className="text-orange-400" /><span className="text-sm font-medium">Email Triage</span></div>
      {result.summary != null && (
        <div className="grid grid-cols-4 gap-2 mb-3 text-xs">
          {Object.entries(result.summary as Record<string, unknown>).map(([k, v]) => (
            <div key={k} className="text-center p-2 bg-apex-navy-dark rounded"><div className="text-apex-muted capitalize">{k}</div><div className="font-medium text-lg">{String(v)}</div></div>
          ))}
        </div>
      )}
      <div className="space-y-2">
        {emails.map((email, i) => (
          <div key={i} className="flex items-center justify-between p-2 rounded bg-apex-navy-dark text-xs">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${(email.priority as number) <= 2 ? "bg-red-400" : (email.priority as number) <= 3 ? "bg-yellow-400" : "bg-gray-400"}`} />
              <span className="font-medium">{String(email.category || "")}</span>
              {email.from != null && <span className="text-apex-muted">{String(email.from)}</span>}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-apex-muted">P{String(email.priority)}</span>
              {email.suggestedReply != null && <span className="text-green-400 text-xs">Reply ready</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportOutputCard({ result }: { result: Record<string, unknown> }) {
  return (
    <div className="rounded-lg border border-apex-border bg-apex-surface p-4">
      <div className="flex items-center gap-2 mb-3"><BarChart3 size={16} className="text-cyan-400" /><span className="text-sm font-medium">{String(result.reportType || "Weekly")} Report</span></div>
      {result.period != null && <p className="text-xs text-apex-muted mb-3">{String(result.period)}</p>}
      {result.metrics != null && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
          {Object.entries(result.metrics as Record<string, unknown>).map(([k, v]) => (
            <div key={k} className="p-2 bg-apex-navy-dark rounded text-center"><div className="text-xs text-apex-muted capitalize">{k.replace(/([A-Z])/g, " $1")}</div><div className="font-medium">{Array.isArray(v) ? v.join(", ") : String(v)}</div></div>
          ))}
        </div>
      )}
      {result.summary != null && <div className="p-3 bg-apex-navy-dark rounded-lg text-sm">{String(result.summary)}</div>}
      {Array.isArray(result.recommendations) && (
        <div className="mt-3"><h5 className="text-xs font-medium text-apex-muted mb-1">Recommendations</h5><ul className="space-y-1 text-xs">{(result.recommendations as string[]).map((r, i) => <li key={i} className="flex gap-1"><span className="text-cyan-400">-</span> {r}</li>)}</ul></div>
      )}
    </div>
  );
}

function RunOutputCard({ result }: { result: Record<string, unknown> }) {
  const type = result.type as string;
  if (type === "email_draft") return <EmailOutputCard result={result} />;
  if (type === "content") return <ContentOutputCard result={result} />;
  if (type === "email_triage") return <TriageOutputCard result={result} />;
  if (type === "report") return <ReportOutputCard result={result} />;
  return (
    <div className="rounded-lg border border-apex-border bg-apex-surface p-4">
      <pre className="text-xs overflow-x-auto max-h-60 overflow-y-auto text-green-300 font-mono">{JSON.stringify(result, null, 2)}</pre>
    </div>
  );
}

// ─── Analytics Tab Component ────────────────────────────
function AnalyticsTab({ agentId }: { agentId: string }) {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.agents.analytics(agentId).then(setAnalytics).catch(() => {}).finally(() => setLoading(false));
  }, [agentId]);

  if (loading) return <div className="text-center py-12"><Loader2 className="animate-spin text-apex-indigo mx-auto" size={24} /></div>;
  if (!analytics) return <div className="text-center py-12 text-apex-muted">Failed to load analytics</div>;

  const maxRuns = Math.max(...analytics.runsByDay.map((d) => d.total), 1);
  const toolEntries = Object.entries(analytics.toolUsage).sort((a, b) => b[1] - a[1]);
  const maxToolUse = toolEntries.length > 0 ? toolEntries[0][1] : 1;

  return (
    <div className="space-y-6">
      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card"><p className="text-xs text-apex-muted mb-1">Total Runs</p><p className="text-2xl font-bold">{analytics.totalRuns}</p></div>
        <div className="card"><p className="text-xs text-apex-muted mb-1">Success Rate</p><p className={`text-2xl font-bold ${analytics.successRate >= 90 ? "text-green-400" : analytics.successRate >= 75 ? "text-yellow-400" : "text-red-400"}`}>{analytics.successRate}%</p></div>
        <div className="card"><p className="text-xs text-apex-muted mb-1">Avg Execution</p><p className="text-2xl font-bold">{formatMs(analytics.avgExecutionTime)}</p></div>
        <div className="card"><p className="text-xs text-apex-muted mb-1">Avg Tokens/Run</p><p className="text-2xl font-bold">{analytics.avgTokensPerRun.toLocaleString()}</p></div>
      </div>

      {/* 7-day chart */}
      <div className="card">
        <h3 className="text-sm font-semibold mb-4">Runs (Last 7 Days)</h3>
        <div className="flex items-end gap-2 h-32">
          {analytics.runsByDay.map((day) => (
            <div key={day.date} className="flex-1 flex flex-col justify-end group relative">
              <div className="absolute -top-12 left-1/2 -translate-x-1/2 bg-apex-surface border border-apex-border rounded-lg p-2 text-xs whitespace-nowrap z-10 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                <p className="text-green-400">{day.completed} ok</p>
                <p className="text-red-400">{day.failed} fail</p>
              </div>
              <div className="flex flex-col rounded-t overflow-hidden" style={{ minHeight: day.total > 0 ? 2 : 0 }}>
                {day.failed > 0 && <div className="bg-red-500/80" style={{ height: `${(day.failed / maxRuns) * 100}px` }} />}
                {day.completed > 0 && <div className="bg-green-500/80 rounded-t" style={{ height: `${(day.completed / maxRuns) * 100}px` }} />}
              </div>
              {day.total === 0 && <div className="bg-apex-border/30 rounded-t" style={{ height: 2 }} />}
              <span className="text-xs text-apex-muted text-center mt-1">{formatDay(day.date)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Tool usage breakdown */}
        <div className="card">
          <h3 className="text-sm font-semibold mb-4">Tool Usage</h3>
          {toolEntries.length === 0 ? (
            <p className="text-sm text-apex-muted">No tool usage recorded</p>
          ) : (
            <div className="space-y-2">
              {toolEntries.map(([tool, count]) => (
                <div key={tool} className="flex items-center gap-3">
                  <span className="text-sm w-32 truncate">{tool}</span>
                  <div className="flex-1 h-2 bg-apex-surface rounded-full overflow-hidden">
                    <div className="h-full bg-apex-indigo/60 rounded-full" style={{ width: `${(count / maxToolUse) * 100}%` }} />
                  </div>
                  <span className="text-xs text-apex-muted w-10 text-right">{count}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cost & tokens */}
        <div className="card">
          <h3 className="text-sm font-semibold mb-4">Cost Summary</h3>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-apex-muted">Total Tokens</span>
              <span className="font-medium">{analytics.totalTokens.toLocaleString()}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-apex-muted">Total Cost</span>
              <span className="font-medium">${analytics.totalCost.toFixed(4)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-apex-muted">Runs (7d)</span>
              <span className="font-medium">{analytics.runsLast7Days}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-apex-muted">Runs (30d)</span>
              <span className="font-medium">{analytics.runsLast30Days}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-apex-muted">Memory Keys</span>
              <span className="font-medium">{analytics.memoryKeys}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Run Comparison Component ───────────────────────────
function RunComparison({ currentRun, previousRun }: { currentRun: Run; previousRun: Run }) {
  return (
    <div className="border-t border-apex-border pt-4 mt-4">
      <h4 className="text-xs font-medium text-apex-muted mb-3">Comparison with Previous Run</h4>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs font-medium text-green-400 mb-2">Current Run</p>
          <div className="space-y-1 text-xs">
            <p>Status: <span className="font-medium">{currentRun.status}</span></p>
            <p>Tokens: <span className="font-medium">{currentRun.tokensUsed.toLocaleString()}</span></p>
            {currentRun.completedAt && <p>Duration: <span className="font-medium">{((new Date(currentRun.completedAt).getTime() - new Date(currentRun.startedAt).getTime()) / 1000).toFixed(1)}s</span></p>}
          </div>
          {currentRun.result && (
            <pre className="mt-2 text-xs bg-apex-navy-dark p-2 rounded-lg overflow-x-auto max-h-48 overflow-y-auto text-green-300 font-mono">
              {JSON.stringify(currentRun.result, null, 2)}
            </pre>
          )}
        </div>
        <div>
          <p className="text-xs font-medium text-blue-400 mb-2">Previous Run</p>
          <div className="space-y-1 text-xs">
            <p>Status: <span className="font-medium">{previousRun.status}</span></p>
            <p>Tokens: <span className="font-medium">{previousRun.tokensUsed.toLocaleString()}</span>
              {currentRun.tokensUsed !== previousRun.tokensUsed && (
                <span className={currentRun.tokensUsed < previousRun.tokensUsed ? "text-green-400 ml-1" : "text-red-400 ml-1"}>
                  ({currentRun.tokensUsed < previousRun.tokensUsed ? "-" : "+"}{Math.abs(currentRun.tokensUsed - previousRun.tokensUsed)})
                </span>
              )}
            </p>
            {previousRun.completedAt && <p>Duration: <span className="font-medium">{((new Date(previousRun.completedAt).getTime() - new Date(previousRun.startedAt).getTime()) / 1000).toFixed(1)}s</span></p>}
          </div>
          {previousRun.result && (
            <pre className="mt-2 text-xs bg-apex-navy-dark p-2 rounded-lg overflow-x-auto max-h-48 overflow-y-auto text-blue-300 font-mono">
              {JSON.stringify(previousRun.result, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────
export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [compareRun, setCompareRun] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<string>("ALL");
  const [logSearch, setLogSearch] = useState("");
  const [tab, setTab] = useState<"runs" | "analytics" | "config" | "memory" | "logs">("runs");
  const [deleting, setDeleting] = useState(false);
  const [memories, setMemories] = useState<Record<string, unknown>>({});
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadAgent = useCallback(async () => {
    try {
      const agentData = await api.agents.get(id);
      setAgent(agentData);
    } catch { /* */ }
  }, [id]);

  useEffect(() => {
    async function load() { setLoading(true); await loadAgent(); setLoading(false); }
    load();
  }, [loadAgent]);

  useEffect(() => {
    const hasRunningRun = agent?.runs.some((r) => r.status === "RUNNING" || r.status === "QUEUED");
    if (hasRunningRun) {
      pollingRef.current = setInterval(loadAgent, 2000);
    } else if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [agent?.runs, loadAgent]);

  useEffect(() => {
    if (tab === "memory" && id) {
      setMemoriesLoading(true);
      api.agents.getMemories(id).then(setMemories).catch(() => {}).finally(() => setMemoriesLoading(false));
    }
  }, [tab, id]);

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

  async function handleDeleteMemory(key: string) {
    if (!agent) return;
    try { await api.agents.deleteMemory(agent.id, key); const updated = { ...memories }; delete updated[key]; setMemories(updated); } catch { /* */ }
  }

  async function handleClearMemories() {
    if (!agent) return;
    try { await api.agents.clearMemories(agent.id); setMemories({}); } catch { /* */ }
  }

  if (loading) {
    return <div className="flex items-center justify-center min-h-[60vh]"><Loader2 className="animate-spin text-apex-indigo" size={32} /></div>;
  }

  if (!agent) {
    return <div className="card text-center py-16"><p className="text-apex-muted">Agent not found</p><Link href="/agents" className="text-apex-indigo mt-4 inline-block hover:underline">Back to agents</Link></div>;
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

  const hasRunning = agent.runs.some((r) => r.status === "RUNNING" || r.status === "QUEUED");

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
              {hasRunning && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 text-yellow-400"><Loader2 size={10} className="animate-spin" /> Running</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {agent.status === "ACTIVE" ? (
            <button onClick={handlePause} disabled={actionLoading} className="btn-secondary flex items-center gap-2"><Pause size={14} /> Pause</button>
          ) : (
            <button onClick={handleDeploy} disabled={actionLoading} className="btn-primary flex items-center gap-2"><Play size={14} /> Deploy</button>
          )}
          <button onClick={handleTriggerRun} disabled={actionLoading} className="btn-secondary flex items-center gap-2">
            {actionLoading ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />} Run Now
          </button>
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
        {(["runs", "analytics", "config", "memory", "logs"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 rounded-md text-sm font-medium transition-colors capitalize ${tab === t ? "bg-apex-indigo text-white" : "text-apex-muted hover:text-white"}`}>
            {t === "runs" ? `Runs (${agent.runs.length})` : t === "analytics" ? "Analytics" : t === "logs" ? `Logs (${allLogs.length})` : t === "memory" ? "Memory" : "Config"}
          </button>
        ))}
      </div>

      {tab === "runs" && (
        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Run History</h2>
          {agent.runs.length === 0 ? (
            <div className="text-center py-12"><Activity size={48} className="mx-auto text-apex-border mb-4" /><p className="text-apex-muted">No runs yet</p></div>
          ) : (
            <div className="space-y-3">
              {agent.runs.map((run, runIdx) => {
                const isExpanded = expandedRun === run.id;
                const isComparing = compareRun === run.id;
                const duration = run.completedAt ? Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000) : null;
                const isActive = run.status === "RUNNING" || run.status === "QUEUED";
                const meta = run.result?._meta as Record<string, unknown> | undefined;
                const toolsUsed = (meta?.toolsUsed || []) as string[];
                const stepCount = meta?.steps as number | undefined;
                const previousRun = runIdx < agent.runs.length - 1 ? agent.runs[runIdx + 1] : null;

                return (
                  <div key={run.id} className={`rounded-lg bg-apex-surface overflow-hidden ${isActive ? "ring-1 ring-yellow-500/30" : ""}`}>
                    <button onClick={() => setExpandedRun(isExpanded ? null : run.id)} className="w-full flex items-center justify-between p-4 hover:bg-apex-navy-light transition-colors">
                      <div className="flex items-center gap-3">
                        {isExpanded ? <ChevronDown size={16} className="text-apex-muted" /> : <ChevronRight size={16} className="text-apex-muted" />}
                        {run.status === "COMPLETED" ? <CheckCircle size={16} className="text-green-400" /> :
                         run.status === "FAILED" ? <XCircle size={16} className="text-red-400" /> :
                         <Loader2 size={16} className="text-yellow-400 animate-spin" />}
                        <div className="text-left">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium">{run.status}</p>
                            {stepCount && <span className="text-xs text-apex-muted">{stepCount} steps</span>}
                            {toolsUsed.length > 0 && <span className="text-xs text-apex-muted">{toolsUsed.length} tools</span>}
                          </div>
                          <p className="text-xs text-apex-muted">{new Date(run.startedAt).toLocaleString()}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        {isActive && <span className="text-xs text-yellow-400 flex items-center gap-1"><Loader2 size={10} className="animate-spin" />Live</span>}
                        <span className="text-xs text-apex-muted">{(run.tokensUsed || 0).toLocaleString()} tokens</span>
                        {duration !== null && <span className="text-xs text-apex-muted">{duration}s</span>}
                        {run.cost > 0 && <span className="text-xs text-apex-muted">${run.cost.toFixed(4)}</span>}
                      </div>
                    </button>
                    {isExpanded && (
                      <div className="p-4 pt-0 border-t border-apex-border space-y-4">
                        {/* Step Timeline */}
                        {run.logs.length > 0 && (
                          <div>
                            <h4 className="text-xs font-medium text-apex-muted mb-3">Execution Steps</h4>
                            <div className="space-y-0">
                              {run.logs.filter((l) => l.level === "INFO").map((log, idx, arr) => {
                                const Icon = getStepIcon(log.message);
                                const colorClass = getStepColor(log.message, log.level);
                                const isLast = idx === arr.length - 1;
                                return (
                                  <div key={log.id} className="flex gap-3">
                                    <div className="flex flex-col items-center">
                                      <div className={`w-7 h-7 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${colorClass}`}><Icon size={12} /></div>
                                      {!isLast && <div className="w-0.5 h-6 bg-apex-border" />}
                                    </div>
                                    <div className="pb-3 min-w-0">
                                      <p className="text-xs font-medium truncate">{log.message}</p>
                                      <p className="text-xs text-apex-muted">{new Date(log.createdAt).toLocaleTimeString()}</p>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Typed Output Card */}
                        {run.result && (
                          <div>
                            <h4 className="text-xs font-medium text-apex-muted mb-2">Output</h4>
                            <RunOutputCard result={run.result} />
                          </div>
                        )}

                        {/* Compare toggle */}
                        {previousRun && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setCompareRun(isComparing ? null : run.id); }}
                            className="text-xs text-apex-indigo-light hover:underline flex items-center gap-1"
                          >
                            <BarChart3 size={12} /> {isComparing ? "Hide Comparison" : "Compare with Previous Run"}
                          </button>
                        )}
                        {isComparing && previousRun && (
                          <RunComparison currentRun={run} previousRun={previousRun} />
                        )}

                        {/* Debug Logs (collapsed) */}
                        {run.logs.some((l) => l.level === "DEBUG") && (
                          <details className="text-xs">
                            <summary className="text-apex-muted cursor-pointer hover:text-white">Debug Logs ({run.logs.filter((l) => l.level === "DEBUG").length})</summary>
                            <div className="mt-2 space-y-1">
                              {run.logs.filter((l) => l.level === "DEBUG").map((log) => (
                                <div key={log.id} className="flex items-start gap-2 font-mono">
                                  <span className="text-apex-muted whitespace-nowrap">{new Date(log.createdAt).toLocaleTimeString()}</span>
                                  <span className="text-gray-400">{log.message}</span>
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
          )}
        </div>
      )}

      {tab === "analytics" && <AnalyticsTab agentId={id} />}

      {tab === "config" && (
        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Configuration</h2>
          {agent.config && Object.keys(agent.config).length > 0 ? (
            <div className="space-y-2">
              {Object.entries(agent.config).map(([key, val]) => (
                <div key={key} className="flex items-center justify-between py-3 border-b border-apex-border last:border-0">
                  <span className="text-sm text-apex-muted capitalize">{key.replace(/([A-Z])/g, " $1")}</span>
                  <span className="text-sm font-medium max-w-md truncate">{typeof val === "object" ? JSON.stringify(val) : String(val)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-apex-muted text-sm">No configuration set</p>
          )}
        </div>
      )}

      {tab === "memory" && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Brain size={18} className="text-apex-indigo" />
              <h2 className="text-lg font-semibold">Agent Memory</h2>
              <span className="text-xs text-apex-muted">({Object.keys(memories).length} entries)</span>
            </div>
            {Object.keys(memories).length > 0 && (
              <button onClick={handleClearMemories} className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1"><Trash2 size={12} /> Clear All</button>
            )}
          </div>
          {memoriesLoading ? (
            <div className="text-center py-8"><Loader2 className="animate-spin text-apex-indigo mx-auto" size={24} /></div>
          ) : Object.keys(memories).length === 0 ? (
            <div className="text-center py-12">
              <Brain size={48} className="mx-auto text-apex-border mb-4" />
              <p className="text-apex-muted text-sm">No memories stored yet</p>
              <p className="text-apex-muted text-xs mt-1">Memories are created automatically during agent runs</p>
            </div>
          ) : (
            <div className="space-y-3">
              {Object.entries(memories).map(([key, value]) => (
                <div key={key} className="rounded-lg bg-apex-surface p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-apex-indigo-light">{key}</span>
                    <button onClick={() => handleDeleteMemory(key)} className="text-xs text-red-400 hover:text-red-300"><Trash2 size={12} /></button>
                  </div>
                  <pre className="text-xs bg-apex-navy-dark p-3 rounded-lg overflow-x-auto max-h-40 overflow-y-auto text-gray-300 font-mono">
                    {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
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
